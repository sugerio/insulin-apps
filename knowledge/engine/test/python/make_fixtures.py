"""Builds the corpus in every launch format, so no binary file sits in the repository.

    python3 test/python/make_fixtures.py <output directory>

writes, from the Markdown corpus in test/fixtures/corpus:
  - one PDF (a page per section), Word document (a page break per section), PowerPoint deck (a slide per section),
    Excel workbook (a sheet per section) and HTML page per document: <format>/<name>.<ext>;
  - scanned.pdf: a page holding only an image, no text (it must fail with a clear reason);
  - large.txt: more than 2 MB of text (only the first 2 MB is learned);
  - personal-data.md: fake personal data and secrets from test/fixtures/hiding-cases.json.

The writers use only the standard library and produce the smallest valid files that real readers accept.
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def sections(markdown: str) -> tuple[str, list[str]]:
    """The title and the text of each "## " section (the first section is the text before any)."""
    lines = markdown.strip().splitlines()
    title = lines[0].lstrip("# ").strip()
    parts, current = [], []
    for line in lines[1:]:
        if line.startswith("## "):
            if any(l.strip() for l in current):
                parts.append("\n".join(current).strip())
            current = [line[3:].strip()]
        else:
            current.append(line)
    if any(l.strip() for l in current):
        parts.append("\n".join(current).strip())
    return title, parts


# ---------------------------------------------------------------------------- PDF


def _pdf_string(text: str) -> str:
    data = text.encode("latin-1", "replace").decode("latin-1")
    return "(" + data.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


def write_pdf(path: Path, pages: list[str] | None, image_only: bool = False) -> None:
    objects: list[bytes] = []

    def add(body: str | bytes) -> int:
        objects.append(body.encode("latin-1") if isinstance(body, str) else body)
        return len(objects)

    catalog = add("")  # filled in below
    pages_obj = add("")
    font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    kids = []
    for page_text in pages or [""]:
        if image_only:
            image = add(b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream")
            stream = "q 200 0 0 200 100 500 cm /Im1 Do Q"
            resources = f"<< /XObject << /Im1 {image} 0 R >> >>"
        else:
            words, lines, line = page_text.replace("\n", " \n ").split(" "), [], ""
            for word in words:
                if word == "\n":
                    lines.append(line)
                    line = ""
                elif len(line) + len(word) > 90:
                    lines.append(line)
                    line = word
                else:
                    line = f"{line} {word}".strip()
            lines.append(line)
            body = " T* ".join(f"{_pdf_string(l)} Tj" for l in lines)
            stream = f"BT /F1 11 Tf 14 TL 50 780 Td {body} ET"
            resources = f"<< /Font << /F1 {font} 0 R >> >>"
        content = add(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        kids.append(add(f"<< /Type /Page /Parent {pages_obj} 0 R /MediaBox [0 0 612 842] /Resources {resources} /Contents {content} 0 R >>"))
    objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_obj} 0 R >>".encode()
    objects[pages_obj - 1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode()
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


# ---------------------------------------------------------------------------- Office files

CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _zip(path: Path, parts: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, body in parts.items():
            archive.writestr(name, body)


def write_docx(path: Path, title: str, pages: list[str]) -> None:
    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = [f"<w:p><w:r><w:t>{escape(title)}</w:t></w:r></w:p>"]
    for index, page in enumerate(pages):
        if index:
            body.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
        for paragraph in page.split("\n"):
            if paragraph.strip():
                body.append(f'<w:p><w:r><w:t xml:space="preserve">{escape(paragraph)}</w:t></w:r></w:p>')
    _zip(
        path,
        {
            "[Content_Types].xml": CT + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            "_rels/.rels": CT + f'<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{DOC_REL}/officeDocument" Target="word/document.xml"/></Relationships>',
            "word/document.xml": CT + f'<w:document xmlns:w="{w}"><w:body>{"".join(body)}</w:body></w:document>',
        },
    )


def write_pptx(path: Path, title: str, slides: list[str]) -> None:
    p = "http://schemas.openxmlformats.org/presentationml/2006/main"
    a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    parts = {
        "[Content_Types].xml": CT + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/></Types>',
        "_rels/.rels": CT + f'<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{DOC_REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    }
    ids, rels = [], []
    for number, text in enumerate(slides, start=1):
        paragraphs = ([title] if number == 1 else []) + [l for l in text.split("\n") if l.strip()]
        runs = "".join(f"<a:p><a:r><a:t>{escape(l)}</a:t></a:r></a:p>" for l in paragraphs)
        parts[f"ppt/slides/slide{number}.xml"] = (
            CT + f'<p:sld xmlns:p="{p}" xmlns:a="{a}"><p:cSld><p:spTree><p:sp><p:txBody>{runs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
        )
        ids.append(f'<p:sldId id="{255 + number}" r:id="rId{number}"/>')
        rels.append(f'<Relationship Id="rId{number}" Type="{DOC_REL}/slide" Target="slides/slide{number}.xml"/>')
    parts["ppt/presentation.xml"] = CT + f'<p:presentation xmlns:p="{p}" xmlns:r="{DOC_REL}"><p:sldIdLst>{"".join(ids)}</p:sldIdLst></p:presentation>'
    parts["ppt/_rels/presentation.xml.rels"] = CT + f'<Relationships xmlns="{RELS_NS}">{"".join(rels)}</Relationships>'
    _zip(path, parts)


def write_xlsx(path: Path, sheets: list[tuple[str, list[list[str]]]]) -> None:
    s = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    strings: list[str] = []
    parts = {
        "[Content_Types].xml": CT + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/></Types>',
        "_rels/.rels": CT + f'<Relationships xmlns="{RELS_NS}"><Relationship Id="rId1" Type="{DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    }
    sheet_tags, rels = [], []
    for number, (name, rows) in enumerate(sheets, start=1):
        xml_rows = []
        for r, row in enumerate(rows, start=1):
            cells = []
            for c, value in enumerate(row):
                ref = f"{chr(65 + c)}{r}"
                if value.replace(".", "", 1).isdigit():
                    cells.append(f'<c r="{ref}"><v>{value}</v></c>')
                else:
                    strings.append(value)
                    cells.append(f'<c r="{ref}" t="s"><v>{len(strings) - 1}</v></c>')
            xml_rows.append(f'<row r="{r}">{"".join(cells)}</row>')
        parts[f"xl/worksheets/sheet{number}.xml"] = CT + f'<worksheet xmlns="{s}"><sheetData>{"".join(xml_rows)}</sheetData></worksheet>'
        sheet_tags.append(f'<sheet name="{escape(name)}" sheetId="{number}" r:id="rId{number}"/>')
        rels.append(f'<Relationship Id="rId{number}" Type="{DOC_REL}/worksheet" Target="worksheets/sheet{number}.xml"/>')
    parts["xl/workbook.xml"] = CT + f'<workbook xmlns="{s}" xmlns:r="{DOC_REL}"><sheets>{"".join(sheet_tags)}</sheets></workbook>'
    parts["xl/_rels/workbook.xml.rels"] = CT + f'<Relationships xmlns="{RELS_NS}">{"".join(rels)}</Relationships>'
    parts["xl/sharedStrings.xml"] = CT + f'<sst xmlns="{s}">{"".join(f"<si><t>{escape(t)}</t></si>" for t in strings)}</sst>'
    _zip(path, parts)


def write_html(path: Path, title: str, parts: list[str]) -> None:
    body = "".join(f"<section><p>{escape(p)}</p></section>" for p in parts)
    path.write_text(
        f"<!doctype html><html><head><title>{escape(title)}</title><style>p {{ color: #333 }}</style>"
        f"<script>window.tracking = 'never learned'</script></head><body><nav>Home</nav><main><h1>{escape(title)}</h1>{body}</main></body></html>"
    )


# ---------------------------------------------------------------------------- the set


def build(out: Path) -> dict[str, list[Path]]:
    made: dict[str, list[Path]] = {"pdf": [], "docx": [], "pptx": [], "xlsx": [], "html": []}
    for kind in made:
        (out / kind).mkdir(parents=True, exist_ok=True)
    for source in sorted((FIXTURES / "corpus").glob("*/*.md")):
        title, parts = sections(source.read_text())
        name = source.stem
        write_pdf(out / "pdf" / f"{name}.pdf", [f"{title}\n{parts[0]}"] + parts[1:])
        write_docx(out / "docx" / f"{name}.docx", title, parts)
        write_pptx(out / "pptx" / f"{name}.pptx", title, parts)
        write_xlsx(out / "xlsx" / f"{name}.xlsx", [(f"Part {i + 1}", [[line] for line in part.split("\n") if line.strip()]) for i, part in enumerate(parts)])
        write_html(out / "html" / f"{name}.html", title, parts)
        for kind in made:
            made[kind].append(out / kind / f"{name}.{kind}")
    write_pdf(out / "scanned.pdf", ["", ""], image_only=True)
    line = "The billing gateway retries outbound calls three times with a doubling backoff. "
    (out / "large.txt").write_text(line * (2_300_000 // len(line)))
    cases = json.loads((FIXTURES / "hiding-cases.json").read_text())["cases"]
    (out / "personal-data.md").write_text("# Contacts and keys\n\n" + "\n\n".join(c["input"] for c in cases if c["spans"]) + "\n")
    return made


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: make_fixtures.py <output directory>")
    target = Path(sys.argv[1])
    built = build(target)
    print(json.dumps({kind: len(paths) for kind, paths in built.items()}))

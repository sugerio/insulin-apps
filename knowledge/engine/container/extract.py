"""Text and a page map from the files Knowledge learns at launch.

PDF (text only), Word (.docx), PowerPoint (.pptx, slide numbers as pages), Excel (.xlsx, sheets as pages), HTML,
Markdown and plain text. Office files are read with the standard library (they are zip files of XML), so the only
extra dependency is pypdf. At most 2 MB of text is kept from one file; the rest is left out and the file says so.

Positions here are code-point indexes into the extracted text; the caller converts what it stores (offsets.py).
"""

from __future__ import annotations

import html
import re
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

MAX_TEXT_BYTES = 2 * 1024 * 1024
# Readers stop a little past the limit (the cap then cuts and says so), so a small file can't grow into gigabytes.
READ_BUDGET_BYTES = MAX_TEXT_BYTES + 64 * 1024
MAX_BLANK_COLUMNS = 64  # blank cells kept between two values of one spreadsheet row
MAX_XML_PART_BYTES = 64 * 1024 * 1024  # one part of an Office file, uncompressed
MAX_OFFICE_TOTAL_BYTES = 256 * 1024 * 1024

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

TYPES = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "text/html": "html",
    "application/xhtml+xml": "html",
    "text/markdown": "markdown",
    "text/x-markdown": "markdown",
    "text/plain": "text",
    "text/csv": "text",
}
EXTENSIONS = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".pptx": "pptx",
    ".xlsx": "xlsx",
    ".html": "html",
    ".htm": "html",
    ".md": "markdown",
    ".markdown": "markdown",
    ".txt": "text",
    ".text": "text",
    ".csv": "text",
}


class ExtractionError(Exception):
    """A file that can't be learned. `permanent`: trying again won't help (a scanned PDF, an unknown type)."""

    def __init__(self, reason: str, permanent: bool = True, code: str = "unsupported_type") -> None:
        super().__init__(reason)
        self.reason = reason
        self.permanent = permanent
        self.code = code


@dataclass
class Extracted:
    text: str
    pages: list[dict] = field(default_factory=list)  # [{page, start, end}] in code points; empty when unpaged
    page_count: int | None = None
    truncated: bool = False
    note: str | None = None


def kind_of(media_type: str, name: str) -> str | None:
    """The reader for a file: by its extension first (types from browsers are often generic), then its media type."""
    suffix = PurePosixPath(name.lower()).suffix
    if suffix in EXTENSIONS:
        return EXTENSIONS[suffix]
    return TYPES.get((media_type or "").split(";")[0].strip().lower())


def extract(path: Path, media_type: str, name: str) -> Extracted:
    kind = kind_of(media_type, name)
    if kind is None:
        raise ExtractionError(f"“{name}” is a type Insulin can't read.")
    try:
        if kind == "pdf":
            parts = _pdf(path, name)
        elif kind == "docx":
            parts = _docx(path)
        elif kind == "pptx":
            parts = _pptx(path)
        elif kind == "xlsx":
            parts = _xlsx(path)
        elif kind == "html":
            parts = [_html(_decode(path.read_bytes()))]
        else:
            parts = [_decode(path.read_bytes())]
    except ExtractionError:
        raise
    except (zipfile.BadZipFile, ElementTree.ParseError, KeyError) as error:
        raise ExtractionError(f"“{name}” looks damaged, so Knowledge can't read it.") from error
    paged = kind in ("pdf", "pptx", "xlsx") or (kind == "docx" and len(parts) > 1)
    result = _assemble(parts, paged)
    if not result.text.strip():
        if kind == "pdf":
            raise ExtractionError(f"“{name}” is a scanned image with no text, so Knowledge can't read it.")
        raise ExtractionError(f"“{name}” has no text to learn.")
    return _cap(result)


# ---------------------------------------------------------------------------- assembling and the 2 MB cap


def _assemble(parts: list[str], paged: bool) -> Extracted:
    texts = [_tidy(p) for p in parts]
    if not paged:
        return Extracted(text="\n\n".join(t for t in texts if t))
    pages, chunks, at = [], [], 0
    for number, text in enumerate(texts, start=1):
        if chunks:
            chunks.append("\n\n")
            at += 2
        pages.append({"page": number, "start": at, "end": at + len(text)})
        chunks.append(text)
        at += len(text)
    return Extracted(text="".join(chunks), pages=pages, page_count=len(texts))


def _tidy(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = re.sub(r"[ \t\f\v]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _cap(result: Extracted) -> Extracted:
    encoded = result.text.encode("utf-8")
    if len(encoded) <= MAX_TEXT_BYTES:
        return result
    cut = len(encoded[:MAX_TEXT_BYTES].decode("utf-8", errors="ignore"))
    space = result.text.rfind("\n", 0, cut)
    if space > cut * 0.9:
        cut = space
    result.text = result.text[:cut].rstrip()
    end = len(result.text)
    kept = [dict(p, end=min(p["end"], end)) for p in result.pages if p["start"] < end]
    result.pages = kept
    result.truncated = True
    last = kept[-1]["page"] if kept else None
    result.note = (
        f"Only the first 2 MB of text was learned, up to page {last}." if last else "Only the first 2 MB of text was learned."
    )
    return result


def _decode(data: bytes) -> str:
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


# ---------------------------------------------------------------------------- PDF


def _pdf(path: Path, name: str) -> list[str]:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted and not reader.decrypt(""):
            raise ExtractionError(f"“{name}” is protected with a password, so Knowledge can't read it.")
        pages, read = [], 0
        for page in reader.pages:
            if read > READ_BUDGET_BYTES:
                break
            text = page.extract_text() or ""
            pages.append(text)
            read += len(text.encode("utf-8"))
    except ExtractionError:
        raise
    except PdfReadError as error:
        raise ExtractionError(f"“{name}” looks damaged, so Knowledge can't read it.") from error
    if not any(len(re.sub(r"\s", "", p)) >= 10 for p in pages):
        raise ExtractionError(f"“{name}” is a scanned image with no text, so Knowledge can't read it.")
    return pages


# ---------------------------------------------------------------------------- Office files


def _open_office(path: Path) -> zipfile.ZipFile:
    archive = zipfile.ZipFile(path)
    total = sum(info.file_size for info in archive.infolist())
    if total > MAX_OFFICE_TOTAL_BYTES:
        raise ExtractionError("The file unpacks to more than Knowledge reads from one file.", code="too_large")
    return archive


def _xml(archive: zipfile.ZipFile, part: str) -> ElementTree.Element:
    info = archive.getinfo(part)
    if info.file_size > MAX_XML_PART_BYTES:
        raise ExtractionError("A part of the file is larger than Knowledge reads.", code="too_large")
    data = archive.read(part)
    # Office XML never declares entities; refusing them avoids entity expansion attacks.
    if b"<!DOCTYPE" in data[:4096] or b"<!ENTITY" in data:
        raise ExtractionError("The file contains XML Knowledge doesn't read.")
    return ElementTree.fromstring(data)


def _rels(archive: zipfile.ZipFile, part: str) -> dict[str, str]:
    folder, _, base = part.rpartition("/")
    rels_part = f"{folder}/_rels/{base}.rels" if folder else f"_rels/{base}.rels"
    if rels_part not in archive.namelist():
        return {}
    out = {}
    for rel in _xml(archive, rels_part).iter(f"{REL}Relationship"):
        target = rel.get("Target", "")
        if rel.get("TargetMode") == "External":
            continue
        resolved = str(PurePosixPath(folder, target)) if not target.startswith("/") else target.lstrip("/")
        out[rel.get("Id", "")] = _normalise(resolved)
    return out


def _normalise(path: str) -> str:
    parts: list[str] = []
    for piece in path.split("/"):
        if piece == "..":
            if parts:
                parts.pop()
        elif piece and piece != ".":
            parts.append(piece)
    return "/".join(parts)


def _docx(path: Path) -> list[str]:
    """Paragraphs and tables in order. Page breaks Word saved (explicit or last rendered) split pages."""
    with _open_office(path) as archive:
        body = _xml(archive, "word/document.xml").find(f"{W}body")
        pages: list[list[str]] = [[]]
        if body is None:
            return [""]

        def paragraph(p: ElementTree.Element) -> None:
            line: list[str] = []
            for node in p.iter():
                if node.tag == f"{W}t" and node.text:
                    line.append(node.text)
                elif node.tag == f"{W}tab":
                    line.append("\t")
                elif node.tag == f"{W}br" and node.get(f"{W}type") == "page" or node.tag == f"{W}lastRenderedPageBreak":
                    if line or pages[-1]:
                        pages[-1].append("".join(line))
                        line = []
                        pages.append([])
                elif node.tag == f"{W}br" or node.tag == f"{W}cr":
                    line.append("\n")
            pages[-1].append("".join(line))

        for child in body:
            if child.tag == f"{W}p":
                paragraph(child)
            elif child.tag == f"{W}tbl":
                for row in child.iter(f"{W}tr"):
                    cells = []
                    for cell in row.iter(f"{W}tc"):
                        cells.append(" ".join("".join(t.text or "" for t in p.iter(f"{W}t")) for p in cell.iter(f"{W}p")).strip())
                    pages[-1].append("\t".join(cells))
        texts = ["\n".join(lines) for lines in pages]
        return [t for t in texts if t.strip()] or [""]


def _pptx(path: Path) -> list[str]:
    """One page per slide, in the presentation's order."""
    with _open_office(path) as archive:
        presentation = _xml(archive, "ppt/presentation.xml")
        rels = _rels(archive, "ppt/presentation.xml")
        slides = []
        listed = presentation.find(f"{P}sldIdLst")
        for slide in listed if listed is not None else []:
            target = rels.get(slide.get(f"{R}id", ""))
            if target and target in archive.namelist():
                slides.append(target)
        texts = []
        for part in slides:
            root = _xml(archive, part)
            paragraphs = ["".join(t.text or "" for t in p.iter(f"{A}t")) for p in root.iter(f"{A}p")]
            texts.append("\n".join(p for p in paragraphs if p.strip()))
        return texts or [""]


def _xlsx(path: Path) -> list[str]:
    """One page per sheet: the sheet's name, then each row's cells separated by tabs."""
    with _open_office(path) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            for item in _xml(archive, "xl/sharedStrings.xml").iter(f"{S}si"):
                shared.append("".join(t.text or "" for t in item.iter(f"{S}t")))
        workbook = _xml(archive, "xl/workbook.xml")
        rels = _rels(archive, "xl/workbook.xml")
        texts, read = [], 0
        sheets = workbook.find(f"{S}sheets")
        for sheet in sheets if sheets is not None else []:
            if read > READ_BUDGET_BYTES:
                break
            target = rels.get(sheet.get(f"{R}id", ""))
            if not target or target not in archive.namelist():
                continue
            rows = []
            for row in _xml(archive, target).iter(f"{S}row"):
                if read > READ_BUDGET_BYTES:
                    break
                cells: list[str] = []
                for cell in row.iter(f"{S}c"):
                    # Blank cells are left out of the file: each cell's reference ("C2") says its column. A run of
                    # blanks is kept up to a limit, so one value in column XFD doesn't become 16,383 tabs.
                    column = _column(cell.get("r", ""))
                    if column is not None:
                        cells.extend([""] * min(column - len(cells), MAX_BLANK_COLUMNS))
                    kind = cell.get("t")
                    value = cell.find(f"{S}v")
                    if kind == "s" and value is not None and value.text is not None:
                        index = int(value.text)
                        cells.append(shared[index] if 0 <= index < len(shared) else "")
                    elif kind == "inlineStr":
                        cells.append("".join(t.text or "" for t in cell.iter(f"{S}t")))
                    elif kind == "b" and value is not None:
                        cells.append("TRUE" if value.text == "1" else "FALSE")
                    elif value is not None and value.text is not None:
                        cells.append(value.text)
                    else:
                        cells.append("")
                while cells and not cells[-1]:
                    cells.pop()
                if cells:
                    rows.append("\t".join(cells))
                    read += len(rows[-1].encode("utf-8")) + 1
            texts.append(f"{sheet.get('name', 'Sheet')}\n" + "\n".join(rows))
        return texts or [""]


def _column(reference: str) -> int | None:
    """The 0-based column of a cell reference such as "C2" or "AA10"."""
    letters = re.match(r"([A-Z]{1,3})\d", reference)
    if not letters:
        return None
    number = 0
    for ch in letters.group(1):
        number = number * 26 + (ord(ch) - 64)
    return number - 1


# ---------------------------------------------------------------------------- HTML


class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg", "head", "iframe", "object"}
    BLOCK = {
        "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "li", "ul", "ol", "table", "tr",
        "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "dl", "dt", "dd", "figure", "figcaption", "br", "hr",
    }  # fmt: skip

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skipping = 0
        self.title: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self.in_title = True
        elif tag in self.SKIP:
            self.skipping += 1
        elif tag in self.BLOCK:
            self.out.append("\n")
        elif tag in ("td", "th"):
            self.out.append("\t")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        elif tag in self.SKIP:
            self.skipping = max(0, self.skipping - 1)
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)
        elif not self.skipping:
            self.out.append(data)


def _html(source: str) -> str:
    parser = _Text()
    parser.feed(source)
    parser.close()
    lines = [re.sub(r"[ \t ]+", " ", line).strip() for line in "".join(parser.out).split("\n")]
    body = "\n".join(lines)
    title = html.unescape(" ".join("".join(parser.title).split()))
    return f"{title}\n\n{body}" if title and title not in body[:500] else body

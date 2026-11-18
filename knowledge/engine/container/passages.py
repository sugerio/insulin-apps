"""Passages: Cognee's chunks of a document, placed in the document's redacted text.

Each document gets an index (/data/passages/<documentId>.json) built after it is learned: every chunk's position
(UTF-16 offsets, as the app counts), its page and the SHA-256 of its text. Search answers with these positions, so
the source viewer highlights the exact words, and corrections mark a passage by its document and text hash, which
survives the chunk ids changing when a file is read again.
"""

from __future__ import annotations

import hashlib
import re

from offsets import Utf16

# The most passages one document keeps (design section 11, "a cap on passages per document"). 2 MB of text makes
# about a thousand of Cognee's chunks, so this binds only for unusual files; passages past it are not cited.
PASSAGE_CAP = 2000


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def locate(document: str, chunk: str, start: int = 0) -> tuple[int, int] | None:
    """Where a chunk's text sits in the document (code points), even if the chunker changed its whitespace."""
    chunk = chunk.strip()
    if not chunk:
        return None
    at = document.find(chunk, start)
    if at < 0 and start:
        at = document.find(chunk)
    if at >= 0:
        return at, at + len(chunk)
    words = chunk.split()
    if not words:
        return None
    pattern = r"\s+".join(re.escape(w) for w in words)
    match = re.compile(pattern).search(document, start) or re.compile(pattern).search(document)
    return (match.start(), match.end()) if match else None


def page_at(pages: list[dict], offset: int) -> int | None:
    """The page holding `offset`; between two pages (the blank lines that join them), the next one."""
    for page in pages:
        if offset < page["end"] or (page["start"] == page["end"] == offset):
            return page["page"]
    return pages[-1]["page"] if pages else None


def capped(document_id: str, chunks: int, cap: int = PASSAGE_CAP) -> bool:
    return chunks > cap


def build_index(document_id: str, text: str, pages_utf16: list[dict], chunks: list[dict], cap: int = PASSAGE_CAP) -> list[dict]:
    """chunks: [{id, index, text}] in chunk order. Returns passages with UTF-16 offsets and text hashes, at most `cap`."""
    units = Utf16(text)
    out, cursor = [], 0
    for chunk in sorted(chunks, key=lambda c: (c.get("index") is None, c.get("index") or 0))[:cap]:
        found = locate(text, chunk.get("text") or "", cursor)
        if not found:
            continue
        start, end = found
        cursor = end
        u_start, u_end = units.to_utf16(start), units.to_utf16(end)
        out.append(
            {
                "passageId": str(chunk.get("id")),
                "documentId": document_id,
                "chunkIndex": chunk.get("index"),
                "start": u_start,
                "end": u_end,
                "page": page_at(pages_utf16, u_start),
                "textHash": text_hash(text[start:end]),
            }
        )
    return out


def slice_utf16(text: str, start: int, end: int) -> str:
    units = Utf16(text)
    return text[units.from_utf16(start) : units.from_utf16(end)]


# A passage is cited at the page (or slide) its words closest to the question are on, chosen at search time: a
# passage's own page is where it starts, and a short PDF or deck is one passage over every page (IMP-06's fact on
# page 4 of 4 was cited at page 1). The whole passage is still what the source viewer highlights.

_WORD = re.compile(r"[0-9a-z]+")
_COMMON = set(
    "a an and are as at be by can do does for from has have how i in is it its of on or that the their this to was what"
    " when where which who why will with you your".split()
)


def page_slices(text: str, pages_utf16: list[dict], start: int, end: int) -> list[tuple[int, str]]:
    """Each page a passage [start, end) (UTF-16) runs over, with the passage's words on it, in page order."""
    out = []
    for page in pages_utf16 or []:
        a, b = max(start, page["start"]), min(end, page["end"])
        if a < b:
            piece = slice_utf16(text, a, b)
            if piece.strip():
                out.append((page["page"], piece))
    return out


def words(text: str) -> set[str]:
    """A text's words, lower case, without the most common ones, a plural's s dropped (leaves: leave)."""
    return {w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in _WORD.findall(text.lower()) if w not in _COMMON}


def page_by_words(question: str, slices: list[tuple[int, str]]) -> int | None:
    """The page whose slice holds the most of the question's words; None when none holds any, or two hold as many."""
    if len(slices) == 1:
        return slices[0][0]
    wanted = words(question)
    scored = sorted(((len(wanted & words(piece)), page) for page, piece in slices), key=lambda s: s[0], reverse=True)
    if not scored or scored[0][0] == 0 or (len(scored) > 1 and scored[1][0] == scored[0][0]):
        return None
    return scored[0][1]


def remap_marks(marks: list[dict], old_text: str, old_index: list[dict], new_text: str, new_index: list[dict], rehide) -> list[dict]:
    """After a document is read again: each outdated mark follows its passage to the passage holding the same words.

    `rehide(text)` applies the new hiding rules to an old passage's text, so a passage that only gained a [hidden]
    is still found. Returns [{documentId, textHash, newTextHash, changed}]: newTextHash is None when the passage
    can't be found again, and `changed` says its words changed, so the correction asks to be checked.
    """
    by_hash = {p["textHash"]: p for p in old_index}
    out = []
    for mark in marks:
        old = by_hash.get(mark["textHash"])
        new_hash, changed = None, True
        if any(p["textHash"] == mark["textHash"] for p in new_index):
            new_hash, changed = mark["textHash"], False  # the very same words: nothing to check
        elif old:
            wanted = rehide(slice_utf16(old_text, old["start"], old["end"])).strip()
            for passage in new_index:
                candidate = slice_utf16(new_text, passage["start"], passage["end"])
                if candidate.strip() == wanted or (wanted and wanted in candidate):
                    new_hash = passage["textHash"]
                    break
        out.append({"documentId": mark["documentId"], "textHash": mark["textHash"], "newTextHash": new_hash, "changed": changed})
    return out


MARK = "[hidden]"


def old_position(position: int, spans: list) -> int:
    """Where a code-point position of a text hidden again sat in the text before. `spans` are the values hidden now,
    in the old text (sorted, merged); a position inside one's MARK goes to the value's start or end."""
    shift = 0  # new position minus old, after the spans passed
    for span in spans:
        new_start = span.start + shift
        if position < new_start:
            break
        if position < new_start + len(MARK):
            return span.start if position == new_start else span.end
        shift += len(MARK) - (span.end - span.start)
    return position - shift


def remap_after_rehide(marks: list[dict], old_text: str, spans: list, new_text: str, new_index: list[dict]) -> list[dict]:
    """An export's outdated marks once its text is hidden again with stricter rules (import-export): the old passages
    aren't here, so each new passage is mapped back to the words it held before, and a mark follows the passage whose
    old words carry its hash. As after a re-read: [{documentId, textHash, newTextHash, changed}], newTextHash None
    when no passage is found, `changed` when its words changed (the correction then asks to be checked)."""
    units = Utf16(new_text)
    out = []
    for mark in marks:
        new_hash, changed = None, True
        if any(p["textHash"] == mark["textHash"] for p in new_index):
            new_hash, changed = mark["textHash"], False
        else:
            for passage in new_index:
                start = old_position(units.from_utf16(passage["start"]), spans)
                end = old_position(units.from_utf16(passage["end"]), spans)
                if text_hash(old_text[start:end]) == mark["textHash"]:
                    new_hash = passage["textHash"]
                    break
        out.append({"documentId": mark["documentId"], "textHash": mark["textHash"], "newTextHash": new_hash, "changed": changed})
    return out

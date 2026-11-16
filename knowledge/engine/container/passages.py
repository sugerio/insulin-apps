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

"""Ranking search results: what is left out, where notes go, and the "won't guess" threshold.

- Passages of documents not in use (stopped, or being removed for good) are left out.
- Passages marked outdated by a correction are left out; the note that corrects one takes its place.
- A note ranks above every passage of the documents it corrects.
- Nothing below the calibrated threshold is returned: when nothing passes, the collection doesn't cover the question.
"""

from __future__ import annotations

import json
from pathlib import Path

DEFAULT_THRESHOLD = 0.70
EPSILON = 1e-6


def load_threshold(path: Path) -> float:
    try:
        value = float(json.loads(path.read_text())["threshold"])
        return value if 0.0 <= value <= 1.0 else DEFAULT_THRESHOLD
    except (OSError, ValueError, KeyError, TypeError):
        return DEFAULT_THRESHOLD


def similarity(distance) -> float:
    """Cognee's chunk search scores are cosine distances (0 is identical): similarity in 0..1."""
    try:
        return max(0.0, min(1.0, 1.0 - float(distance)))
    except (TypeError, ValueError):
        return 0.0


def rank(hits: list[dict], filters: dict, top_k: int, threshold: float, note_passages: dict[str, list[dict]]) -> list[dict]:
    """hits: passages with `score` (similarity), best first. note_passages: a note's passages by its document id."""
    inactive = set(filters.get("inactive") or [])
    outdated = {(d, h) for d, h in (filters.get("outdated") or [])}
    corrections = filters.get("corrections") or []
    corrected_by: dict[tuple[str, str], list[str]] = {}
    notes_for_document: dict[str, set[str]] = {}
    for correction in corrections:
        note = correction["noteDocumentId"]
        for document_id, text_hash in correction.get("refs") or []:
            corrected_by.setdefault((document_id, text_hash), []).append(note)
            notes_for_document.setdefault(document_id, set()).add(note)

    kept: dict[str, dict] = {}
    for hit in hits:
        if hit["documentId"] in inactive:
            continue
        key = (hit["documentId"], hit["textHash"])
        if key in outdated:
            # The note that corrects it answers instead, at least as high as the passage did.
            for note in corrected_by.get(key, []):
                if note in inactive:
                    continue
                for passage in note_passages.get(note, [])[:1]:
                    _keep(kept, dict(passage, outdated=False), hit["score"] + EPSILON)
            continue
        _keep(kept, dict(hit, outdated=False), hit["score"])

    # Notes rank above the passages they correct: above every passage of a corrected document.
    for passage in list(kept.values()):
        for note in notes_for_document.get(passage["documentId"], ()):
            for note_passage in kept.values():
                if note_passage["documentId"] == note and note_passage["score"] <= passage["score"]:
                    note_passage["score"] = min(1.0, passage["score"] + EPSILON)

    ordered = sorted(kept.values(), key=lambda p: p["score"], reverse=True)
    return [p for p in ordered if p["score"] >= threshold][:top_k]


def _keep(kept: dict[str, dict], passage: dict, score: float) -> None:
    current = kept.get(passage["passageId"])
    if current is None or current["score"] < score:
        passage["score"] = min(1.0, score)
        kept[passage["passageId"]] = passage

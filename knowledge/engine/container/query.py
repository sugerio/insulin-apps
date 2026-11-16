"""The query process: the one Cognee process that stays loaded between questions.

Cognee and its models take about 40 seconds to load, so a process that stays loaded is what makes awake answers
fast. It can't survive sleep (a snapshot restores files, not processes) and must be stopped before each snapshot.
So it starts in two steps:

  1. load   import Cognee and load the embedding model, while the Durable Object checks /data's checksums.
            Nothing under /data is opened in this step (server.py reports any open file there).
  2. open   only after the check passed: open the databases, the passage index and the facts.

It listens on 127.0.0.1:8081 only; server.py forwards /query/* to it. One process, one asyncio loop: requests are
handled one at a time.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import traceback

# Questions are never kept: Cognee writes every search's question and results into its database unless this is off,
# and that database is in every snapshot and backup. Less logging too, so no question reaches a log file.
os.environ["COGNEE_LOG_SEARCH_HISTORY"] = "false"
os.environ.setdefault("LOG_LEVEL", "WARNING")
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import rank  # noqa: E402
from passages import slice_utf16  # noqa: E402

PORT = 8081
DATA_DIR = Path("/data")
PASSAGES_DIR = DATA_DIR / "passages"
TEXT_DIR = DATA_DIR / "text"
FACTS_PATH = DATA_DIR / "facts.json"
DATASET = os.environ.get("KNOWLEDGE_DATASET", "knowledge")
CALIBRATION = Path(os.environ.get("KNOWLEDGE_CALIBRATION", str(Path(__file__).with_name("calibration.json"))))

STATE = {"state": "loading", "loadedAt": None, "openedAt": None, "error": None, "pid": os.getpid()}
LOOP = asyncio.new_event_loop()
INDEX: dict[str, dict] = {}  # passage id -> passage
BY_DOCUMENT: dict[str, list[dict]] = {}
FACTS: list[dict] = []
TEXTS: dict[str, str] = {}
THRESHOLD = rank.DEFAULT_THRESHOLD


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def load() -> None:
    """Step 1: everything that doesn't touch /data."""
    import cognee  # noqa: F401
    from cognee.infrastructure.databases.vector.embeddings import get_embedding_engine

    await get_embedding_engine().embed_text(["warming up"])
    STATE.update(state="loaded", loadedAt=now())


async def open_databases() -> None:
    """Step 2, after the checksum check: open the databases and read the passage index and facts."""
    global THRESHOLD, FACTS
    STATE["state"] = "opening"
    INDEX.clear()
    BY_DOCUMENT.clear()
    TEXTS.clear()
    for path in PASSAGES_DIR.glob("*.json") if PASSAGES_DIR.exists() else []:
        for passage in json.loads(path.read_text()):
            INDEX[passage["passageId"]] = passage
            BY_DOCUMENT.setdefault(passage["documentId"], []).append(passage)
    FACTS = json.loads(FACTS_PATH.read_text()).get("facts", []) if FACTS_PATH.exists() else []
    THRESHOLD = rank.load_threshold(CALIBRATION)
    await raw_search("warming up", 1)  # opens the relational and vector databases now, not on the first question
    STATE.update(state="ready", openedAt=now())


async def raw_search(query: str, top_k: int) -> list:
    import cognee
    from cognee import SearchType

    try:
        return await cognee.search(query_text=query, query_type=SearchType.CHUNKS, datasets=[DATASET], top_k=top_k)
    except Exception as error:  # noqa: BLE001 - an empty collection has no dataset to search yet
        if "not found" in str(error).lower() or "NoData" in type(error).__name__ or "DatasetNotFound" in type(error).__name__:
            return []
        raise


def field(item, *names):
    for name in names:
        if isinstance(item, dict) and item.get(name) is not None:
            return item[name]
        value = getattr(item, name, None)
        if value is not None:
            return value
    return None


def flatten(raw) -> list:
    items = []
    for result in raw or []:
        inner = field(result, "search_result")
        if isinstance(inner, list):
            items.extend(inner)
        elif inner is not None:
            items.append(inner)
        else:
            items.append(result)
    return items


def document_text(document_id: str) -> str:
    if document_id not in TEXTS:
        try:
            TEXTS[document_id] = json.loads((TEXT_DIR / f"{document_id}.json").read_text())["text"]
        except (OSError, ValueError, KeyError):
            TEXTS[document_id] = ""
    return TEXTS[document_id]


def as_passage(passage: dict, score: float) -> dict:
    text = slice_utf16(document_text(passage["documentId"]), passage["start"], passage["end"])
    return {
        "passageId": passage["passageId"],
        "documentId": passage["documentId"],
        "documentName": "",
        "kind": "file",
        "page": passage.get("page"),
        "start": passage["start"],
        "end": passage["end"],
        "text": text,
        "textHash": passage["textHash"],
        "score": score,
        "outdated": False,
    }


async def search(body: dict) -> dict:
    top_k = max(1, min(int(body.get("topK") or 8), 20))
    filters = body.get("filters") or {}
    hits = []
    for item in flatten(await raw_search(str(body.get("query") or ""), min(60, top_k * 4))):
        payload = field(item, "payload") or item
        if hasattr(payload, "model_dump"):
            payload = payload.model_dump()
        passage = INDEX.get(str(field(payload, "id") or ""))
        if passage is None:
            continue  # a chunk without an indexed place in its text is never cited
        hits.append(as_passage(passage, rank.similarity(field(item, "score") if field(item, "score") is not None else field(payload, "score"))))
    hits.sort(key=lambda p: p["score"], reverse=True)
    note_passages = {
        c["noteDocumentId"]: [as_passage(p, 0.0) for p in BY_DOCUMENT.get(c["noteDocumentId"], [])] for c in filters.get("corrections") or []
    }
    threshold = float(body["threshold"]) if isinstance(body.get("threshold"), (int, float)) else THRESHOLD
    passages = rank.rank(hits, filters, top_k, threshold, note_passages)
    shown = {p["passageId"] for p in passages}
    facts = [f for f in FACTS if f.get("passageId") in shown][:20]
    return {"passages": passages, "facts": facts, "threshold": threshold}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # questions are not logged

    def _send(self, status: int, body: dict) -> None:
        payload = json.dumps(body, ensure_ascii=False, default=str).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _run(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, LOOP).result()

    def do_GET(self):
        if self.path.split("?")[0] == "/status":
            return self._send(200, STATE)
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        try:
            if path == "/open":
                if STATE["state"] != "loaded":
                    return self._send(409, {"error": f"not loaded ({STATE['state']})"})
                threading.Thread(target=lambda: self._open_in_background(), daemon=True).start()
                return self._send(202, STATE)
            if path == "/search":
                if STATE["state"] != "ready":
                    return self._send(409, {"error": f"not ready ({STATE['state']})"})
                return self._send(200, self._run(search(body)))
        except Exception as error:  # noqa: BLE001
            return self._send(500, {"error": type(error).__name__})
        return self._send(404, {"error": "not found"})

    def _open_in_background(self):
        try:
            self._run(open_databases())
        except Exception:  # noqa: BLE001
            STATE.update(state="failed", error=traceback.format_exc(limit=3)[-500:])


def main() -> None:
    threading.Thread(target=LOOP.run_forever, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        asyncio.run_coroutine_threadsafe(load(), LOOP).result()
    except Exception:  # noqa: BLE001
        STATE.update(state="failed", error=traceback.format_exc(limit=3)[-500:])
    threading.Event().wait()


if __name__ == "__main__":
    main()

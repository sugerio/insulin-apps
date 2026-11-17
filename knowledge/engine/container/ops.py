"""One Cognee operation per process.

server.py launches `python ops.py <op> --result <file> [--progress <file>] [--batch-dir <dir>]` and waits for the
process, and every process it started, to exit before it reports the job finished. When the process group is gone,
nothing holds a file under /data open (the PoC's rule 1).

Ops:
  ingest    read every file of an import (extract.py), hide sensitive values (hide.py, fails closed), then learn the
            redacted text one document at a time; index passages; rebuild facts. Originals are deleted as soon as
            they are read. A relearn batch learns stored redacted texts again (after an engine change).
  remove    remove documents for good: from Cognee's databases, their text and passage index; rebuild facts
  reread    apply stricter hiding rules to stored texts; learn the changed ones again; move outdated marks
  stats     reopen all three databases through Cognee and count their records
  manifest  sha256 every file under /data (no Cognee import)
  grep      count planted values under /data (test controls only: HID-01's evidence)

A job that fails on purpose writes its result first ({reason, failedFileId, permanent, code}) and exits 2.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path("/data")
TEXT_DIR = DATA_DIR / "text"
PASSAGES_DIR = DATA_DIR / "passages"
FACTS_PATH = DATA_DIR / "facts.json"
LEDGER_PATH = DATA_DIR / "ledger.json"
DATASET = os.environ.get("KNOWLEDGE_DATASET", "knowledge")
SYSTEM_DIR = Path(os.environ.get("SYSTEM_ROOT_DIRECTORY", "/data/system"))
DATABASES_DIR = SYSTEM_DIR / "databases"
WORK_DIR = Path(os.environ.get("KNOWLEDGE_WORK", "/var/lib/knowledge/work"))
TEST_CONTROLS = os.environ.get("KNOWLEDGE_TEST_CONTROLS") == "1"
CHUNK_TABLE = "DocumentChunk_text"

EXIT_FAILED = 2
EXIT_ALREADY_INGESTED = 3


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, default=str))
    os.replace(tmp, path)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class Stop(Exception):
    """An expected failure: reported to the Durable Object through the result file."""

    def __init__(self, reason: str, failed_file_id: str | None = None, permanent: bool = False, code: str = "internal"):
        super().__init__(reason)
        self.result = {"reason": reason, "failedFileId": failed_file_id, "permanent": permanent, "code": code}


class Progress:
    def __init__(self, path: str | None, total: int) -> None:
        self.path = Path(path) if path else None
        self.state = {"done": 0, "total": total, "current": None, "files": {}}

    def read(self) -> None:
        self.state["read"] = True
        if self.path:
            write_json(self.path, self.state)

    def file(self, file_id: str | None, state: str, done: int | None = None) -> None:
        if file_id:
            self.state["files"][file_id] = state
            self.state["current"] = file_id if state in ("reading", "understanding") else None
        if done is not None:
            self.state["done"] = done
        if self.path:
            write_json(self.path, self.state)


# --------------------------------------------------------------------------- stored text


def store_text(doc: dict) -> None:
    write_json(TEXT_DIR / f"{doc['documentId']}.json", doc)


def load_text(document_id: str) -> dict | None:
    return read_json(TEXT_DIR / f"{document_id}.json", None)


def to_stored(document_id: str, kind: str, name: str, media_type: str, redaction, page_count, truncated, note) -> dict:
    """A redaction (code points) as stored: positions in UTF-16 code units, as the app counts them. A text that hiding
    made longer than an export holds is cut there (hide.STORED_TEXT_BYTES)."""
    import hide
    from offsets import Utf16

    redaction, cut = hide.bounded(redaction)
    if cut:
        truncated = True
        note = "Only the first 3 MB of its text, with its values hidden, was learned."

    units = Utf16(redaction.text)
    return {
        "documentId": document_id,
        "kind": kind,
        "name": name,
        "type": media_type,
        "text": redaction.text,
        "pages": [{"page": p["page"], "start": units.to_utf16(p["start"]), "end": units.to_utf16(p["end"])} for p in redaction.pages],
        "hidden": [{"start": units.to_utf16(s.start), "end": units.to_utf16(s.end), "kind": s.kind} for s in redaction.hidden],
        "pageCount": page_count,
        "truncated": truncated,
        "note": note,
    }


# --------------------------------------------------------------------------- Cognee's chunks


def chunks_by_document(document_ids: set[str]) -> dict[str, list[dict]]:
    """Cognee's chunks of the given documents, read straight from the LanceDB table the chunk search uses."""
    import lancedb

    path = DATABASES_DIR / "cognee.lancedb"
    if not path.exists():
        return {}
    db = lancedb.connect(str(path))
    if CHUNK_TABLE not in db.table_names():
        return {}
    out: dict[str, list[dict]] = {}
    for row in db.open_table(CHUNK_TABLE).to_arrow().to_pylist():
        payload = row.get("payload") or {}
        name = str(payload.get("document_name") or "")
        document_id = name[:-4] if name.endswith(".txt") else name
        if document_id in document_ids:
            out.setdefault(document_id, []).append(
                {"id": str(row.get("id") or payload.get("id")), "index": payload.get("chunk_index"), "text": payload.get("text") or ""}
            )
    return out


def index_passages(document_ids: list[str]) -> tuple[int, set[str]]:
    """Writes each document's passage index. Returns the passages indexed and the documents cut at the cap."""
    from passages import PASSAGE_CAP, build_index

    chunks = chunks_by_document(set(document_ids))
    total, capped = 0, set()
    for document_id in document_ids:
        stored = load_text(document_id)
        if not stored:
            continue
        index = build_index(document_id, stored["text"], stored["pages"], chunks.get(document_id, []))
        write_json(PASSAGES_DIR / f"{document_id}.json", index)
        total += len(index)
        if len(chunks.get(document_id, [])) > PASSAGE_CAP:
            capped.add(document_id)
    return total, capped


def rehide(stored: dict, rules: dict):
    """A saved redacted text with the rules in force now: its [hidden] marks stay, new matches are hidden too."""
    import hide
    from offsets import Utf16

    units = Utf16(stored["text"])
    pages = [{"page": p["page"], "start": units.from_utf16(p["start"]), "end": units.from_utf16(p["end"])} for p in stored.get("pages") or []]
    keep = [hide.Span(units.from_utf16(h["start"]), units.from_utf16(h["end"]), h["kind"]) for h in stored.get("hidden") or []]
    return hide.apply(stored["text"], rules, pages, keep=keep)


def all_passages() -> dict[str, dict]:
    out = {}
    for path in PASSAGES_DIR.glob("*.json") if PASSAGES_DIR.exists() else []:
        for passage in read_json(path, []):
            out[passage["passageId"]] = passage
    return out


async def learn(document_id: str, text: str) -> None:
    """Adds one redacted text to Cognee and builds its graph. The file is named by document id."""
    import cognee

    work = WORK_DIR / "learn"
    work.mkdir(parents=True, exist_ok=True)
    path = work / f"{document_id}.txt"
    path.write_text(text)
    try:
        await cognee.add(str(path), dataset_name=DATASET)
        await cognee.cognify(datasets=[DATASET])
    finally:
        path.unlink(missing_ok=True)


async def forget(document_id: str) -> bool:
    """Deletes one document's data from Cognee's databases. True when it was there."""
    import cognee

    db_file = relational_db_file()
    if db_file is None:
        return False
    with sqlite3.connect(f"file:{db_file}?mode=ro", uri=True) as conn:
        rows = conn.execute("SELECT id, raw_data_location FROM data WHERE name IN (?, ?)", (f"{document_id}.txt", document_id)).fetchall()
        datasets = conn.execute("SELECT id FROM datasets WHERE name = ?", (DATASET,)).fetchall()
    if not rows or not datasets:
        return False
    from uuid import UUID

    for data_id, raw_location in rows:
        await cognee.datasets.delete_data(dataset_id=UUID(str(datasets[0][0])), data_id=UUID(str(data_id)))
        if raw_location and str(raw_location).startswith(("/data/", "file:///data/")):
            Path(str(raw_location).replace("file://", "")).unlink(missing_ok=True)
    return True


# --------------------------------------------------------------------------- facts


async def rebuild_facts() -> int:
    """All facts from the graph, as sentences with their source sentence, in /data/facts.json."""
    import facts as facts_module

    found: list[dict] = []
    try:
        from cognee.infrastructure.databases.graph import get_graph_engine

        graph = await get_graph_engine()
        rows = await graph.query(
            "MATCH (s:Node)-[r:EDGE]->(t:Node) WHERE s.type = 'Entity' AND t.type = 'Entity' "
            "RETURN s.id, s.name, r.relationship_name, t.id, t.name"
        )
        chunk_rows = await graph.query(
            "MATCH (c:Node)-[r:EDGE]->(e:Node) WHERE c.type = 'DocumentChunk' AND r.relationship_name = 'contains' "
            "RETURN c.id, c.properties, e.id"
        )
        relations, chunks = facts_module.relations_from_graph(list(rows), list(chunk_rows))
        found = facts_module.build(relations, chunks, all_passages())
    except Exception as error:  # noqa: BLE001 - facts are a view; learning stands without them
        print(json.dumps({"factsError": type(error).__name__}), file=sys.stderr)
        found = read_json(FACTS_PATH, {"facts": []}).get("facts", [])
        known = all_passages()
        found = [f for f in found if f.get("passageId") in known]
    write_json(FACTS_PATH, {"facts": found})
    return len(found)


# --------------------------------------------------------------------------- ingest


async def op_ingest(args) -> dict:
    import hide
    from extract import ExtractionError, extract

    batch_dir = Path(args.batch_dir)
    batch = json.loads((batch_dir / "batch.json").read_text())
    batch_id = batch["importId"]
    ledger = read_json(LEDGER_PATH, {"batches": {}})
    if batch_id in ledger["batches"]:
        # A second line of defence behind the Durable Object's import table.
        print(json.dumps({"alreadyIngested": True}))
        sys.exit(EXIT_ALREADY_INGESTED)

    test = (batch.get("test") or {}) if TEST_CONTROLS else {}
    files = batch.get("files") or []
    notes = batch.get("notes") or []
    progress = Progress(args.progress, len(files) + len(notes) + len(batch.get("documents") or []))
    prepared: list[dict] = []
    documents: list[dict] = []

    rules = dict(batch.get("hiding") or {})
    if test.get("detectorError"):
        rules["_fail"] = True

    newly_hidden: list[str] = []  # saved texts the rules in force hid more of: older restore points hold them unhidden
    # Import-export: the export's outdated marks, and for each marked text hidden again, its words before and the
    # values hidden now, so the marks can follow their passages.
    export_marks: dict[str, list[dict]] = {}
    for mark in batch.get("marks") or []:
        export_marks.setdefault(mark["documentId"], []).append(mark)
    before_hiding: dict[str, tuple[str, list]] = {}

    def saved(document_id: str, name: str) -> dict:
        """A text an earlier step saved (already redacted), hidden again with the rules in force now."""
        stored = read_json(batch_dir / f"{document_id}.json", None)
        if not stored:
            raise Stop(f"The saved text of “{name}” is missing.", permanent=True)
        (batch_dir / f"{document_id}.json").unlink(missing_ok=True)
        try:
            redaction = rehide(stored, rules)
        except hide.HidingError as error:
            raise Stop("Hiding sensitive information failed, so nothing from this import was stored.") from error
        if redaction.text != stored["text"]:
            newly_hidden.append(document_id)
            if document_id in export_marks:
                before_hiding[document_id] = (stored["text"], hide.find_spans(stored["text"], rules))
        return to_stored(document_id, stored.get("kind", "file"), name, stored.get("type", ""), redaction, stored.get("pageCount"), stored.get("truncated"), stored.get("note"))

    if batch["kind"] == "relearn":
        for doc in batch["documents"]:
            stored = saved(doc["documentId"], doc["name"])
            stored.update({"kind": doc["kind"]})
            prepared.append({"stored": stored, "fileId": None, "noteId": None})
    else:
        # 1. Read and hide every file first: one that fails stops the import before anything is stored.
        for f in files:
            progress.file(f["fileId"], "reading")
            if f.get("stored"):
                prepared.append({"stored": saved(f["documentId"], f["name"]), "fileId": f["fileId"], "noteId": None})
                continue
            if test.get("crashFileId") == f["fileId"]:
                os._exit(70)  # the harness's IMP-05: extraction crashes on this file every time
            original = batch_dir / f["fileId"]
            try:
                extracted = extract(original, f.get("type") or "", f["name"])
            except ExtractionError as error:
                raise Stop(error.reason, f["fileId"], error.permanent, error.code) from error
            except Exception as error:  # noqa: BLE001
                raise Stop(f"Couldn't read “{f['name']}”.", f["fileId"]) from error
            finally:
                original.unlink(missing_ok=True)  # originals are never kept after reading
            try:
                redaction = hide.apply(extracted.text, rules, extracted.pages)
            except hide.HidingError as error:
                raise Stop("Hiding sensitive information failed, so nothing from this import was stored.", f["fileId"]) from error
            stored = to_stored(
                f["documentId"], "file", f["name"], f.get("type") or "", redaction, extracted.page_count, extracted.truncated, extracted.note
            )
            prepared.append({"stored": stored, "fileId": f["fileId"], "noteId": None})
        for n in notes:
            if n.get("stored"):
                stored = saved(n["documentId"], n.get("title") or "Note")
                stored.update({"kind": "note"})
                prepared.append({"stored": stored, "fileId": None, "noteId": n["noteId"]})
                continue
            try:
                redaction = hide.apply(n["text"], rules)
            except hide.HidingError as error:
                raise Stop("Hiding sensitive information failed, so nothing from this import was stored.") from error
            stored = to_stored(n["documentId"], "note", n.get("title") or "Note", "text/markdown", redaction, None, False, None)
            prepared.append({"stored": stored, "fileId": None, "noteId": n["noteId"]})

    # Everything is read and hidden: the redacted texts are written now, and the progress says so, so the Durable
    # Object saves them and deletes the originals before learning starts.
    for item in prepared:
        store_text(item["stored"])
    progress.read()

    # 2. Learn the redacted text, one document at a time.
    previous_facts = len(read_json(FACTS_PATH, {"facts": []}).get("facts", []))
    for done, item in enumerate(prepared):
        stored = item["stored"]
        progress.file(item["fileId"], "understanding", done)
        await learn(stored["documentId"], stored["text"])
        progress.file(item["fileId"], "learned", done + 1)
        documents.append(
            {
                "documentId": stored["documentId"],
                "fileId": item["fileId"],
                "noteId": item["noteId"],
                "kind": stored["kind"],
                "textBytes": len(stored["text"].encode("utf-8")),
                "pages": stored.get("pageCount"),
                "hidden": len(stored.get("hidden") or []),
                "truncated": bool(stored.get("truncated")),
                "reason": stored.get("note"),
                "changed": True,
            }
        )

    # 3. Passages, the corrections' marks and facts.
    passages, capped = index_passages([d["documentId"] for d in documents])
    from passages import PASSAGE_CAP

    for d in documents:
        if d["documentId"] in capped:
            d["truncated"] = True
            d["reason"] = f"Only the first {PASSAGE_CAP:,} passages of this file are used."
    marks = []
    for n in notes:
        for ref in n.get("outdated") or []:
            index = read_json(PASSAGES_DIR / f"{ref['documentId']}.json", [])
            marks.append({**ref, "found": any(p["textHash"] == ref["textHash"] for p in index)})
    if export_marks:
        from passages import remap_after_rehide

        for document_id, document_marks in export_marks.items():
            index = read_json(PASSAGES_DIR / f"{document_id}.json", [])
            stored = load_text(document_id)
            if document_id in before_hiding and stored:
                old_text, spans = before_hiding[document_id]
                marks.extend(remap_after_rehide(document_marks, old_text, spans, stored["text"], index))
            else:
                for m in document_marks:
                    found = any(p["textHash"] == m["textHash"] for p in index)
                    marks.append({"documentId": document_id, "textHash": m["textHash"], "newTextHash": m["textHash"] if found else None, "changed": not found})
    total_facts = await rebuild_facts()

    ledger["batches"][batch_id] = {"documents": [d["documentId"] for d in documents], "ingestedAt": now_iso()}
    write_json(LEDGER_PATH, ledger)  # written last: the snapshot that commits the import holds it
    return {
        "importId": batch_id,
        "documents": documents,
        "marks": marks,
        "passages": passages,
        "facts": total_facts,
        "newFacts": max(0, total_facts - previous_facts),
        "files": progress.state["files"],
        "changed": newly_hidden,
    }


# --------------------------------------------------------------------------- remove for good and re-read


async def op_remove(args) -> dict:
    batch = json.loads((Path(args.batch_dir) / "batch.json").read_text())
    removed = []
    for document_id in batch["documentIds"]:
        await forget(document_id)
        (TEXT_DIR / f"{document_id}.json").unlink(missing_ok=True)
        (PASSAGES_DIR / f"{document_id}.json").unlink(missing_ok=True)
        removed.append(document_id)
    ledger = read_json(LEDGER_PATH, {"batches": {}})
    ledger.setdefault("removed", []).extend(removed)
    write_json(LEDGER_PATH, ledger)
    total_facts = await rebuild_facts()
    return {"removed": removed, "documents": [], "facts": total_facts, "newFacts": 0}


async def op_reread(args) -> dict:
    import hide
    from offsets import Utf16
    from passages import remap_marks

    batch = json.loads((Path(args.batch_dir) / "batch.json").read_text())
    rules = batch.get("hiding") or {}
    marks_by_doc: dict[str, list[dict]] = {}
    for mark in batch.get("marks") or []:
        marks_by_doc.setdefault(mark["documentId"], []).append(mark)
    progress = Progress(args.progress, len(batch["documentIds"]))
    documents, changed, remapped = [], [], []
    for done, document_id in enumerate(batch["documentIds"]):
        stored = load_text(document_id)
        if not stored:
            continue
        units = Utf16(stored["text"])
        pages = [{"page": p["page"], "start": units.from_utf16(p["start"]), "end": units.from_utf16(p["end"])} for p in stored["pages"]]
        keep = [hide.Span(units.from_utf16(h["start"]), units.from_utf16(h["end"]), h["kind"]) for h in stored["hidden"]]
        redaction = hide.apply(stored["text"], rules, pages, keep=keep)
        progress.file(None, "reading", done)
        if redaction.text == stored["text"]:
            documents.append({"documentId": document_id, "changed": False, "textBytes": len(stored["text"].encode()), "hidden": len(stored["hidden"])})
            continue
        old_text, old_index = stored["text"], read_json(PASSAGES_DIR / f"{document_id}.json", [])
        new = to_stored(document_id, stored["kind"], stored["name"], stored.get("type", ""), redaction, stored.get("pageCount"), stored.get("truncated"), stored.get("note"))
        await forget(document_id)
        store_text(new)
        await learn(document_id, new["text"])
        index_passages([document_id])
        new_index = read_json(PASSAGES_DIR / f"{document_id}.json", [])
        rehide = lambda text: hide.apply(text, rules).text  # noqa: E731
        remapped.extend(remap_marks(marks_by_doc.get(document_id, []), old_text, old_index, new["text"], new_index, rehide))
        changed.append(document_id)
        documents.append({"documentId": document_id, "changed": True, "textBytes": len(new["text"].encode()), "hidden": len(new["hidden"])})
    total_facts = await rebuild_facts()
    return {"documents": documents, "changed": changed, "marks": remapped, "facts": total_facts, "newFacts": 0}


# --------------------------------------------------------------------------- stats


def relational_db_file() -> Path | None:
    for candidate in (DATABASES_DIR / "cognee_db", DATABASES_DIR / "cognee_db.db"):
        if candidate.is_file():
            return candidate
    return None


async def op_stats(args) -> dict:
    out: dict = {"reopened": {}, "passages": 0, "documents": 0}
    db_file = relational_db_file()
    if db_file is None:
        out.update({"relational": {"documents": 0, "integrity": "missing"}, "graph": {"nodes": 0, "edges": 0}, "vector": {"rows": 0}})
        return out
    with sqlite3.connect(f"file:{db_file}?mode=ro", uri=True) as conn:
        documents = conn.execute("SELECT COUNT(*) FROM data").fetchone()[0]
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    out["relational"] = {"documents": documents, "integrity": integrity}
    out["documents"] = documents

    from cognee.infrastructure.databases.graph import get_graph_engine
    from cognee.infrastructure.databases.relational import get_relational_engine
    from cognee.infrastructure.databases.vector import get_vector_engine_async

    relational_engine = get_relational_engine()
    async with relational_engine.get_async_session() as session:
        from sqlalchemy import text

        reopened = (await session.execute(text("SELECT COUNT(*) FROM data"))).scalar()
    out["reopened"]["relational"] = reopened == documents
    graph_engine = await get_graph_engine()
    nodes = (await graph_engine.query("MATCH (n) RETURN COUNT(n)"))[0][0]
    edges = (await graph_engine.query("MATCH ()-[r]->() RETURN COUNT(r)"))[0][0]
    out["graph"] = {"nodes": int(nodes), "edges": int(edges)}
    out["reopened"]["graph"] = True

    import lancedb

    lance = lancedb.connect(str(DATABASES_DIR / "cognee.lancedb"))
    names = sorted(lance.table_names())
    collections = {name: int(lance.open_table(name).count_rows()) for name in names}
    out["vector"] = {"collections": collections, "rows": sum(collections.values())}
    out["passages"] = collections.get(CHUNK_TABLE, 0)
    vector_engine = await get_vector_engine_async()
    out["reopened"]["vector"] = all([await vector_engine.has_collection(name) for name in names])
    return out


# --------------------------------------------------------------------------- manifest and grep


def op_manifest(args) -> dict:
    files = {}
    total_bytes = 0
    for path in sorted(DATA_DIR.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        rel = str(path.relative_to(DATA_DIR))
        size = path.stat().st_size
        files[rel] = {"sha256": sha256_file(path), "size": size}
        total_bytes += size
    digest = hashlib.sha256()
    for rel, entry in files.items():
        digest.update(f"{rel}\0{entry['sha256']}\0{entry['size']}\n".encode())
    return {"digest": digest.hexdigest(), "files": len(files), "bytes": total_bytes, "entries": files}


def op_grep(args) -> dict:
    if not TEST_CONTROLS:
        raise Stop("grep is a test control", permanent=True)
    values = [v for v in json.loads(Path(args.values).read_text()) if v]
    counts = {v: 0 for v in values}
    for path in DATA_DIR.rglob("*"):
        if path.is_file() and not path.is_symlink():
            data = path.read_bytes()
            for value in values:
                counts[value] += data.count(value.encode("utf-8"))
    return {"counts": counts}


# --------------------------------------------------------------------------- main


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("op", choices=["ingest", "remove", "reread", "stats", "manifest", "grep"])
    parser.add_argument("--result", required=True)
    parser.add_argument("--progress")
    parser.add_argument("--batch-dir")
    parser.add_argument("--values")
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).parent))

    started = time.monotonic()
    try:
        if args.op == "manifest":
            result = op_manifest(args)
        elif args.op == "grep":
            result = op_grep(args)
        else:
            ops = {"ingest": op_ingest, "remove": op_remove, "reread": op_reread, "stats": op_stats}
            result = asyncio.run(ops[args.op](args))
    except Stop as stop:
        write_json(Path(args.result), stop.result)
        sys.exit(EXIT_FAILED)
    result["opMs"] = round((time.monotonic() - started) * 1000)
    write_json(Path(args.result), result)


if __name__ == "__main__":
    main()

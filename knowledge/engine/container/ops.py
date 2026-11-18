"""One Cognee operation per process.

server.py launches `python ops.py <op> --result <file> [--progress <file>] [--batch-dir <dir>]` and waits for the
process, and every process it started, to exit before it reports the job finished. When the process group is gone,
nothing holds a file under /data open (the PoC's rule 1).

Ops:
  ingest    read every file of an import (extract.py), hide sensitive values (hide.py, fails closed), then learn the
            redacted texts in groups, one cognify per group (one document at a time on a later try); index passages;
            rebuild facts. Originals are deleted as soon as they are read. A relearn batch learns stored redacted
            texts again (after an engine change).
  remove    remove documents for good: from Cognee's databases, their text and passage index; rebuild facts
  reread    apply stricter hiding rules to stored texts; learn the changed ones again; move outdated marks
            After both, every store is purged of what was deleted and checked, the text written from the documents is
            searched for the removed or newly hidden text, and everything Cognee generated must trace back to a live
            chunk (purge.py): anything left fails the job, so nothing is committed or backed up.
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
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid5

DATA_DIR = Path("/data")
TEXT_DIR = DATA_DIR / "text"
PASSAGES_DIR = DATA_DIR / "passages"
CHUNKS_DIR = DATA_DIR / "chunks"  # each document's chunks as its last learning made them (purge.py checks against it)
FACTS_PATH = DATA_DIR / "facts.json"
LEDGER_PATH = DATA_DIR / "ledger.json"
DATASET = os.environ.get("KNOWLEDGE_DATASET", "knowledge")
SYSTEM_DIR = Path(os.environ.get("SYSTEM_ROOT_DIRECTORY", "/data/system"))
DATABASES_DIR = SYSTEM_DIR / "databases"
WORK_DIR = Path(os.environ.get("KNOWLEDGE_WORK", "/var/lib/knowledge/work"))
TEST_CONTROLS = os.environ.get("KNOWLEDGE_TEST_CONTROLS") == "1"
CHUNK_TABLE = "DocumentChunk_text"
DATA_ID_NAMESPACE = uuid5(NAMESPACE_URL, "urn:insulin-knowledge:document")
# How this code lays out a collection in Cognee, the last part of the image's KNOWLEDGE_DATA_FORMAT (the Dockerfile; a
# test keeps them equal). knowledge-2: each document is its own data item, found by its id (data_id_of); knowledge-3:
# and /data/chunks lists the chunks each document's last learning made. A snapshot or backup in another layout is
# never opened as current: the collection learns everything again from its saved text.
DATA_LAYOUT = "knowledge-3"
# Documents learned together, with one cognify (learn()): at most this many, and this much text. Cognee works on 20
# documents of a call side by side; larger groups were no faster (README, "Service settings").
LEARN_GROUP_DOCUMENTS = 20
LEARN_GROUP_BYTES = 4 * 1024 * 1024

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

    def learning(self, file_ids: list[str | None], done: int) -> None:
        """A group of documents being learned together. Only a group of one names its file as the current one: a crash
        while several are learned can't say which of them stopped it."""
        for file_id in file_ids:
            if file_id:
                self.state["files"][file_id] = "understanding"
        self.state["current"] = file_ids[0] if len(file_ids) == 1 else None
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


def data_id_of(document_id: str) -> UUID:
    """The id of a document's data item in Cognee, made from its document id. Cognee otherwise finds data by its
    content, so a document whose text equals another's joined that one's item and got no passages of its own."""
    return uuid5(DATA_ID_NAMESPACE, document_id)


def chunks_by_document(document_ids: set[str]) -> dict[str, list[dict]]:
    """Cognee's chunks of the given documents, read straight from the LanceDB table the chunk search uses. A chunk
    belongs to the document whose data item made it, found by the item's id and never by name: databases from before
    data ids (one item for two documents with the same text) are never opened (DATA_LAYOUT)."""
    import lancedb

    path = DATABASES_DIR / "cognee.lancedb"
    if not path.exists():
        return {}
    db = lancedb.connect(str(path))
    if CHUNK_TABLE not in db.table_names():
        return {}
    by_data_id = {str(data_id_of(d)): d for d in document_ids}
    out: dict[str, list[dict]] = {}
    for row in db.open_table(CHUNK_TABLE).to_arrow().to_pylist():
        payload = row.get("payload") or {}
        document_id = by_data_id.get(str(payload.get("document_id") or ""))
        if document_id is not None:
            out.setdefault(document_id, []).append(
                {"id": str(row.get("id") or payload.get("id")), "index": payload.get("chunk_index"), "text": payload.get("text") or ""}
            )
    return out


def index_passages(document_ids: list[str]) -> tuple[int, set[str]]:
    """Writes each document's passage index, and the list of its chunks (all of them, the cap aside): what its learning
    made, since none of its chunks was left when it started (a re-read checks: forget_chunks). Returns the passages
    indexed and the documents cut at the cap."""
    from passages import PASSAGE_CAP, build_index

    chunks = chunks_by_document(set(document_ids))
    total, capped = 0, set()
    for document_id in document_ids:
        stored = load_text(document_id)
        if not stored:
            continue
        index = build_index(document_id, stored["text"], stored["pages"], chunks.get(document_id, []))
        write_json(PASSAGES_DIR / f"{document_id}.json", index)
        write_json(CHUNKS_DIR / f"{document_id}.json", sorted(c["id"] for c in chunks.get(document_id, [])))
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


def learning_groups(documents: list[dict], one_by_one: bool) -> list[list[dict]]:
    """The documents of an import in the groups learned together: at most LEARN_GROUP_DOCUMENTS and LEARN_GROUP_BYTES
    of text each (a text over that is a group of its own), or one by one."""
    groups: list[list[dict]] = []
    size = 0
    for item in documents:
        text_bytes = len(item["stored"]["text"].encode("utf-8"))
        full = groups and (len(groups[-1]) >= LEARN_GROUP_DOCUMENTS or size + text_bytes > LEARN_GROUP_BYTES)
        if one_by_one or not groups or full:
            groups.append([])
            size = 0
        groups[-1].append(item)
        size += text_bytes
    return groups


async def learn(documents: list[tuple[str, str]]) -> None:
    """Adds redacted texts to Cognee and builds their graph with one cognify. Each file is named by document id, and
    its data item has an id of its own (data_id_of), so two documents with the same text stay two documents, each with
    its passages. One cognify for the group, not one per document: each call is a pipeline run of its own (its records
    and a compaction pass), and a group's documents are worked on side by side (README, "Service settings")."""
    import cognee
    from cognee.tasks.ingestion.data_item import DataItem

    work = WORK_DIR / "learn"
    work.mkdir(parents=True, exist_ok=True)
    paths = [(document_id, work / f"{document_id}.txt") for document_id, _ in documents]
    try:
        for (_, path), (_, text) in zip(paths, documents):
            path.write_text(text)
        await cognee.add([DataItem(data=str(path), data_id=data_id_of(document_id)) for document_id, path in paths], dataset_name=DATASET)
        await cognee.cognify(datasets=[DATASET])
    finally:
        for _, path in paths:
            path.unlink(missing_ok=True)


async def forget(document_id: str) -> bool:
    """Deletes one document's data from Cognee's databases, found by its data item's id (never by name: another
    document's item could carry it). True when it was there."""
    import cognee

    db_file = relational_db_file()
    if db_file is None:
        return False
    data_id = data_id_of(document_id)
    with sqlite3.connect(f"file:{db_file}?mode=ro", uri=True) as conn:
        rows = conn.execute("SELECT id, raw_data_location FROM data WHERE id IN (?, ?)", (data_id.hex, str(data_id))).fetchall()
        datasets = conn.execute("SELECT id FROM datasets WHERE name = ?", (DATASET,)).fetchall()
    if not rows or not datasets:
        return False

    for row_id, raw_location in rows:
        await cognee.datasets.delete_data(dataset_id=UUID(str(datasets[0][0])), data_id=UUID(str(row_id)))
        # Cognee stores a text under its content's hash: a document with the same text shares the file.
        with sqlite3.connect(f"file:{db_file}?mode=ro", uri=True) as conn:
            shared = conn.execute("SELECT COUNT(*) FROM data WHERE raw_data_location = ?", (raw_location,)).fetchone()[0]
        if raw_location and not shared and str(raw_location).startswith(("/data/", "file:///data/")):
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

    # 2. Learn the redacted texts, in groups (learning_groups). A later try learns one document at a time, so the
    # progress names a file that stops the learning (the process crashes on it) and the last try fails naming it.
    previous_facts = len(read_json(FACTS_PATH, {"facts": []}).get("facts", []))
    done = 0
    groups = learning_groups(prepared, one_by_one=int(batch.get("attempt") or 1) > 1)
    learning_started = time.monotonic()
    for group in groups:
        progress.learning([item["fileId"] for item in group], done)
        await learn([(item["stored"]["documentId"], item["stored"]["text"]) for item in group])
        for item in group:
            done += 1
            progress.file(item["fileId"], "learned", done)
            stored = item["stored"]
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
        # How long Cognee took, in how many groups: the Durable Object logs it, for the planning times.
        "learning": {"groups": len(groups), "ms": round((time.monotonic() - learning_started) * 1000)},
    }


# --------------------------------------------------------------------------- remove for good and re-read


async def forget_chunks(document_id: str) -> None:
    """forget(), then a check that none of the document's chunks is left, so the chunks its next learning makes are
    all its chunks (index_passages lists them)."""
    await forget(document_id)
    if chunks_by_document({document_id}):
        stored = load_text(document_id) or {}
        raise Stop(f"The earlier passages of “{stored.get('name') or document_id}” couldn't be removed, so nothing was kept.")


async def entities() -> dict[str, dict]:
    """The graph's entities (and dates): id -> their name and description, and the data items their provenance names."""
    import purge
    from cognee.infrastructure.databases.graph import get_graph_engine

    graph = await get_graph_engine()
    rows = await graph.query("MATCH (n:Node) WHERE n.type IN ['Entity', 'Timestamp'] RETURN n.id, n.name, n.properties, n.source_ref_keys")
    out = {}
    for node_id, name, properties, refs in rows:
        description = purge._properties(properties).get("description")
        out[str(node_id)] = {"values": [str(v) for v in (name, description) if v], "data": {purge._id(d) for d, _ in purge.REFERENCE.findall(str(refs or ""))}}
    return out


async def rebuild_shared_entities(shared: set[str]) -> list[str]:
    """Cognee merges an entity named in several documents into one, and keeps one spelling of its name and
    description, which may be the removed document's (O'Brien Labs for an OBrien Labs that stays). So every entity in
    `shared` (named by a removed document and by kept ones) whose name or description no kept document's text holds is
    made again from the kept documents that name it: they are learned again, and their chunks, passages and
    corrections come back the same. Returns them."""
    import purge

    survivors = {i: e for i, e in (await entities()).items() if i in shared}
    kept = {p.stem: (read_json(p, {}) or {}).get("text") or "" for p in TEXT_DIR.glob("*.json")}
    matcher = purge.Matcher({v for e in survivors.values() for v in e["values"]})
    held: set[str] = set()
    for text in kept.values():
        held.update(matcher.counts(text))
    by_data = {purge._id(data_id_of(d)): d for d in kept}
    again = sorted({by_data[d] for e in survivors.values() if not set(e["values"]) <= held for d in e["data"] if d in by_data})
    if not again:
        return []
    for document_id in again:
        await forget_chunks(document_id)
    for group in learning_groups([{"stored": load_text(d)} for d in again], one_by_one=False):
        await learn([(item["stored"]["documentId"], item["stored"]["text"]) for item in group])
    index_passages(again)
    return again


async def op_remove(args) -> dict:
    import purge

    batch = json.loads((Path(args.batch_dir) / "batch.json").read_text())
    gone = {purge._id(data_id_of(d)) for d in batch["documentIds"]}
    shared = {i for i, e in (await entities()).items() if e["data"] & gone and e["data"] - gone}
    removed = []
    for document_id in batch["documentIds"]:
        await forget(document_id)
        for folder in (TEXT_DIR, PASSAGES_DIR, CHUNKS_DIR):
            (folder / f"{document_id}.json").unlink(missing_ok=True)
        removed.append(document_id)
    relearned = await rebuild_shared_entities(shared)
    ledger = read_json(LEDGER_PATH, {"batches": {}})
    ledger.setdefault("removed", []).extend(removed)
    write_json(LEDGER_PATH, ledger)
    total_facts = await rebuild_facts()
    return {"removed": removed, "relearned": relearned, "documents": [], "facts": total_facts, "newFacts": 0}


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
    rewritten: list[dict] = []  # each changed document's text before, its passages before and its text now
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
        await forget_chunks(document_id)
        store_text(new)
        rewritten.append({"stored": new, "oldText": old_text, "oldIndex": old_index})
    # The changed texts are learned again together, in groups, as an import learns its files.
    for group in learning_groups(rewritten, one_by_one=False):
        await learn([(item["stored"]["documentId"], item["stored"]["text"]) for item in group])
    index_passages([item["stored"]["documentId"] for item in rewritten])
    rehide = lambda text: hide.apply(text, rules).text  # noqa: E731
    for item in rewritten:
        document_id, new = item["stored"]["documentId"], item["stored"]
        new_index = read_json(PASSAGES_DIR / f"{document_id}.json", [])
        remapped.extend(remap_marks(marks_by_doc.get(document_id, []), item["oldText"], item["oldIndex"], new["text"], new_index, rehide))
        changed.append(document_id)
        documents.append({"documentId": document_id, "changed": True, "textBytes": len(new["text"].encode()), "hidden": len(new["hidden"])})
    order = {document_id: i for i, document_id in enumerate(batch["documentIds"])}
    documents.sort(key=lambda d: order[d["documentId"]])
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


def purged(args) -> dict:
    """remove and reread: the op itself runs in a child process, so when it exits every database Cognee opened is
    closed; then every store is purged of what was deleted and checked, the text written from the documents is
    searched for the removed or newly hidden text, and every record Cognee generated must trace back to a live chunk of
    a live document (purge.py). Anything left fails the job: nothing is committed or backed up."""
    import purge

    batch = json.loads((Path(args.batch_dir) / "batch.json").read_text())
    before = {d: (load_text(d) or {}).get("text") or "" for d in batch.get("documentIds") or []}
    shared: list[str] = []
    if args.op == "remove":
        # A removed document's spelling of an entity it shared with kept ones (Cognee keeps one per entity) is its
        # text too, though no piece of its sentences: looked for as well, unless a kept document's text holds it.
        gone = {purge._id(data_id_of(d)) for d in before}
        nodes, _ = purge._graph(DATA_DIR)
        named = {
            str(v)
            for n in nodes.values()
            if n["type"] in ("Entity", "Timestamp") and {purge._id(d) for d, _ in purge.REFERENCE.findall(n["refs"])} & gone
            for v in (n["name"], n["props"].get("description"))
            if v
        }
        matcher = purge.Matcher(named)
        held: set[str] = set()
        for path in TEXT_DIR.glob("*.json"):
            if path.stem not in before:
                held.update(matcher.counts((read_json(path, {}) or {}).get("text") or ""))
        shared = sorted(named - held)
    child = subprocess.run([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], "--inner"])
    if child.returncode != 0:
        sys.exit(child.returncode if child.returncode > 0 else EXIT_FAILED)  # its result (or progress) says why
    result = read_json(Path(args.result), {})
    if args.op == "remove":
        probes = purge.removed_probes([before[d] for d in result.get("removed") or [] if before.get(d)]) + shared
    elif not result.get("changed"):
        return result  # nothing newly hidden: the Durable Object discards this container
    else:
        probes = purge.hidden_probes([before[d] for d in result["changed"] if before.get(d)], batch.get("hiding") or {})
    started = time.monotonic()
    logs = os.environ.get("COGNEE_LOGS_DIR")
    try:
        result["purge"] = purge.purge(DATABASES_DIR, relational_db_file(), WORK_DIR, Path(logs) if logs else None)
    except Exception as error:  # noqa: BLE001 - reported to the Durable Object; the try is made again
        print(json.dumps({"purgeError": f"{type(error).__name__}: {error}"[:300]}), file=sys.stderr)
        raise Stop("Cleaning the collection's data after this change failed, so nothing was kept.") from error
    kept = lambda: ((read_json(path, {}) or {}).get("text") or "" for path in sorted(TEXT_DIR.glob("*.json")))  # noqa: E731
    remaining = purge.left(DATA_DIR, probes, kept, data_id_of)
    result["purge"].update({"probes": len(probes), "ms": round((time.monotonic() - started) * 1000)})
    if remaining:
        print(json.dumps({"left": remaining}), file=sys.stderr)  # places and counts only, never the text
        raise Stop(
            f"{'Removed' if args.op == 'remove' else 'Newly hidden'} text was still found in the collection's data after "
            f"it was cleaned up ({len(remaining)} {'place' if len(remaining) == 1 else 'places'}), so nothing was kept."
        )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("op", choices=["ingest", "remove", "reread", "stats", "manifest", "grep"])
    parser.add_argument("--result", required=True)
    parser.add_argument("--progress")
    parser.add_argument("--batch-dir")
    parser.add_argument("--values")
    parser.add_argument("--inner", action="store_true", help=argparse.SUPPRESS)  # remove or reread, under purged()
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).parent))

    started = time.monotonic()
    try:
        if args.op == "manifest":
            result = op_manifest(args)
        elif args.op == "grep":
            result = op_grep(args)
        elif args.op in ("remove", "reread") and not args.inner:
            result = purged(args)
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

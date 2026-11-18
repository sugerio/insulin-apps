"""ops.py and purge.py without Cognee: each document is its own data item, so two with the same text each get their
passages (IMP-06's PowerPoint); and what a removal for good or stricter hiding must leave nowhere under /data is
found, wherever a file holds it (HIS-07, HID-04). Cognee itself runs only in the image (README, "Build gotchas")."""

from __future__ import annotations

import asyncio
import io
import json
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import _paths  # noqa: F401
import ops
import purge

TEXT = "# Release\n\nThe Hawser gateway listens on port 8443. It retries three times.\n\nPages go to on-call."


class FakeTable:
    def __init__(self, rows):
        self.rows = rows

    def to_arrow(self):
        return types.SimpleNamespace(to_pylist=lambda: self.rows)


def fake_lancedb(rows):
    db = types.SimpleNamespace(table_names=lambda: [ops.CHUNK_TABLE], open_table=lambda name: FakeTable(rows))
    return types.SimpleNamespace(connect=lambda path: db)


def fake_cognee(add, cognify):
    """Cognee's add and cognify, and the DataItem they take; nothing else of it (rebuilding facts falls back)."""
    data_item = types.SimpleNamespace(DataItem=lambda data, data_id: types.SimpleNamespace(data=data, data_id=data_id))
    return {
        "cognee": types.SimpleNamespace(add=add, cognify=cognify),
        "cognee.tasks": types.ModuleType("cognee.tasks"),
        "cognee.tasks.ingestion": types.ModuleType("cognee.tasks.ingestion"),
        "cognee.tasks.ingestion.data_item": data_item,
    }


class OwnDataItems(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patches = [
            mock.patch.object(ops, "DATABASES_DIR", root / "databases"),
            mock.patch.object(ops, "TEXT_DIR", root / "text"),
            mock.patch.object(ops, "PASSAGES_DIR", root / "passages"),
            mock.patch.object(ops, "CHUNKS_DIR", root / "chunks"),
            mock.patch.object(ops, "WORK_DIR", root / "work"),
        ]
        for patch in self.patches:
            patch.start()
        (root / "databases" / "cognee.lancedb").mkdir(parents=True)

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def test_each_document_is_learned_as_its_own_data_item(self):
        added = []
        cognified = []

        async def add(data, dataset_name):
            added.extend((item.data, item.data_id, Path(item.data).read_text()) for item in data)

        async def cognify(datasets):
            cognified.append(len(added))

        with mock.patch.dict(sys.modules, fake_cognee(add, cognify)):
            asyncio.run(ops.learn([("d_docx", TEXT), ("d_pptx", TEXT)]))
        self.assertEqual(cognified, [2], "one cognify for the two, after both were added")
        self.assertEqual([Path(path).name for path, _, _ in added], ["d_docx.txt", "d_pptx.txt"])
        self.assertEqual([text for _, _, text in added], [TEXT, TEXT])
        self.assertEqual([data_id for _, data_id, _ in added], [ops.data_id_of("d_docx"), ops.data_id_of("d_pptx")])
        self.assertNotEqual(ops.data_id_of("d_docx"), ops.data_id_of("d_pptx"), "the same text, two data items")
        self.assertEqual(ops.data_id_of("d_docx"), ops.data_id_of("d_docx"), "the same id every time (a re-read)")

    def test_imp06_two_documents_with_the_same_text_each_get_their_passages(self):
        # Cognee names a chunk's document by its data item: the chunks of each copy are found by its own id, even
        # where the name Cognee kept is the other copy's. A chunk of a data item without such an id (learned before
        # data ids, when two copies shared one) is nobody's, whatever its name (F196).
        chunk = "The Hawser gateway listens on port 8443. It retries three times."
        rows = [
            {"id": "c-docx", "payload": {"document_id": str(ops.data_id_of("d_docx")), "document_name": "d_docx.txt", "chunk_index": 0, "text": chunk}},
            {"id": "c-pptx", "payload": {"document_id": str(ops.data_id_of("d_pptx")), "document_name": "d_docx.txt", "chunk_index": 0, "text": chunk}},
            {"id": "c-old", "payload": {"document_id": "0f1e2d3c-0000-4000-8000-000000000000", "document_name": "d_old.txt", "chunk_index": 0, "text": "Older."}},
        ]
        for document_id in ("d_docx", "d_pptx"):
            ops.store_text({"documentId": document_id, "text": TEXT, "pages": [{"page": 1, "start": 0, "end": len(TEXT)}], "hidden": []})
        with mock.patch.dict(sys.modules, {"lancedb": fake_lancedb(rows)}):
            by_document = ops.chunks_by_document({"d_docx", "d_pptx", "d_old"})
            total, _ = ops.index_passages(["d_docx", "d_pptx"])
        self.assertEqual({d: [c["id"] for c in chunks] for d, chunks in by_document.items()}, {"d_docx": ["c-docx"], "d_pptx": ["c-pptx"]})
        self.assertEqual(total, 2)
        for document_id, passage_id in (("d_docx", "c-docx"), ("d_pptx", "c-pptx")):
            index = json.loads((ops.PASSAGES_DIR / f"{document_id}.json").read_text())
            self.assertEqual([(p["passageId"], p["documentId"]) for p in index], [(passage_id, document_id)], "citable as itself")
            self.assertEqual(json.loads((ops.CHUNKS_DIR / f"{document_id}.json").read_text()), [passage_id], "its chunks listed (F212)")


class DataLayout(unittest.TestCase):
    """F196: a data item is found by its id only, and a database from before data ids is never opened as current."""

    def test_removing_a_document_never_finds_a_data_item_by_name(self):
        # Before data ids, two documents with the same text shared one data item, which carried one of their names:
        # removing that document by name took the other's passages with it.
        import sqlite3

        deleted = []

        async def delete_data(dataset_id, data_id):
            deleted.append(data_id)

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(ops, "DATABASES_DIR", Path(tmp)):
            with sqlite3.connect(Path(tmp) / "cognee_db") as conn:
                conn.execute("CREATE TABLE data (id TEXT, name TEXT, raw_data_location TEXT)")
                conn.execute("CREATE TABLE datasets (id TEXT, name TEXT)")
                conn.execute("INSERT INTO datasets VALUES (?, ?)", ("7b86e63f75c65f7bb0c090b0edc329f4", ops.DATASET))
                conn.execute("INSERT INTO data VALUES (?, ?, ?)", ("a054d138e40645a794c8c25004e52f86", "d_shared", None))
                conn.execute("INSERT INTO data VALUES (?, ?, ?)", (ops.data_id_of("d_own").hex, "d_own", None))
            cognee = types.SimpleNamespace(datasets=types.SimpleNamespace(delete_data=delete_data))
            with mock.patch.dict(sys.modules, {"cognee": cognee}):
                self.assertFalse(asyncio.run(ops.forget("d_shared")), "an item named after the document isn't its own")
                self.assertTrue(asyncio.run(ops.forget("d_own")))
        self.assertEqual(deleted, [ops.data_id_of("d_own")])

    def test_the_image_names_the_layout_of_its_data(self):
        # Snapshots and backups made before data ids say knowledge-1, before the lists of chunks (F212) knowledge-2: the
        # Durable Object opens a backup only in the running image's format (backup.ts holds), so such a collection
        # learns everything again from its saved text.
        dockerfile = (Path(_paths.CONTAINER) / "Dockerfile").read_text()
        data_format = dockerfile.split("KNOWLEDGE_DATA_FORMAT=", 1)[1].split()[0]
        self.assertTrue(data_format.endswith(f"+{ops.DATA_LAYOUT}"), data_format)
        self.assertNotIn(ops.DATA_LAYOUT, ("knowledge-1", "knowledge-2"), "layouts without a data item each, or a list of chunks")


class LearningInGroups(unittest.TestCase):
    """An import's documents are learned together, one cognify per group (Cognee's cost is per document; each call adds
    its own pass), and a later try one at a time, so a file that crashes the learning is named (IMP-05)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        names = {
            "DATA_DIR": root / "data", "TEXT_DIR": root / "data" / "text", "PASSAGES_DIR": root / "data" / "passages", "CHUNKS_DIR": root / "data" / "chunks",
            "FACTS_PATH": root / "data" / "facts.json", "LEDGER_PATH": root / "data" / "ledger.json",
            "DATABASES_DIR": root / "data" / "system" / "databases", "WORK_DIR": root / "work",
        }
        self.patches = [mock.patch.object(ops, name, value) for name, value in names.items()]
        for patch in self.patches:
            patch.start()
        self.batch = root / "inbox" / "imp-1"
        self.batch.mkdir(parents=True)
        self.progress = root / "progress.json"

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    @staticmethod
    def documents(sizes):
        return [{"stored": {"documentId": f"d{i}", "text": "x" * size}} for i, size in enumerate(sizes)]

    def test_groups_hold_at_most_20_documents_and_4_mib_of_text(self):
        groups = ops.learning_groups(self.documents([500] * 50), one_by_one=False)
        self.assertEqual([len(g) for g in groups], [20, 20, 10])
        mib = 1024 * 1024
        groups = ops.learning_groups(self.documents([3 * mib // 2, 3 * mib // 2, 3 * mib // 2, 5 * mib, 100]), one_by_one=False)
        self.assertEqual([[d["stored"]["documentId"] for d in g] for g in groups], [["d0", "d1"], ["d2"], ["d3"], ["d4"]], "a text over the bound is a group of its own")
        self.assertEqual([len(g) for g in ops.learning_groups(self.documents([500] * 3), one_by_one=True)], [1, 1, 1])

    def ingest(self, files, attempt, cognify):
        for f in files:
            (self.batch / f["fileId"]).write_text(f["text"])
        batch = {"importId": "imp-1", "kind": "import", "notes": [], "hiding": {}, "attempt": attempt,
                 "files": [{"fileId": f["fileId"], "documentId": f["documentId"], "name": f"{f['fileId']}.md", "type": "text/markdown"} for f in files]}
        (self.batch / "batch.json").write_text(json.dumps(batch))
        added, learned = [], []

        async def add(data, dataset_name):
            added.extend(data)

        async def counted(datasets):
            # What this cognify learns: the items added since the last one.
            await cognify(added[len(learned):])
            learned.extend(added[len(learned):])

        args = types.SimpleNamespace(batch_dir=str(self.batch), progress=str(self.progress))
        with mock.patch.dict(sys.modules, {**fake_cognee(add, counted), "lancedb": fake_lancedb([])}), mock.patch("sys.stderr", io.StringIO()):
            result = asyncio.run(ops.op_ingest(args))
        return result, added

    FILES = [{"fileId": f"f{i}", "documentId": f"d_{i}", "text": f"# Note {i}\n\nTopic number {i} says the port is {8000 + i}."} for i in range(3)]

    def test_imp07_an_import_is_learned_with_one_cognify_each_document_its_own_data_item(self):
        calls = []

        async def cognify(added):
            calls.append([item.data_id for item in added])

        result, added = self.ingest(self.FILES, 1, cognify)
        ids = [ops.data_id_of(f["documentId"]) for f in self.FILES]
        self.assertEqual(calls, [ids], "one cognify, after all three were added")
        self.assertEqual([d["documentId"] for d in result["documents"]], ["d_0", "d_1", "d_2"])
        progress = json.loads(self.progress.read_text())
        self.assertEqual((progress["files"], progress["done"], progress["current"]), ({"f0": "learned", "f1": "learned", "f2": "learned"}, 3, None))

    def test_imp05_a_later_try_learns_one_by_one_so_a_crash_while_learning_names_its_file(self):
        async def crashes_on_f1(items):
            if ops.data_id_of("d_1") in [item.data_id for item in items]:
                raise RuntimeError("the extraction model crashed")

        # The first try learns the three together: a crash can't say which of them stopped it. The next learns them
        # one by one: the crash comes while f1 is the file being learned, and the try fails naming it.
        for attempt, current, states in ((1, None, ["understanding", "understanding", "understanding"]), (2, "f1", ["learned", "understanding", "reading"])):
            with self.subTest(attempt=attempt):
                with self.assertRaises(RuntimeError):
                    self.ingest(self.FILES, attempt, crashes_on_f1)
                progress = json.loads(self.progress.read_text())
                self.assertEqual(progress["current"], current, "the Durable Object names the current file (imports.ts poll)")
                self.assertEqual([progress["files"][f["fileId"]] for f in self.FILES], states)


class Collection:
    """A collection's stores as Cognee leaves them, linked as Cognee links them: per document, its stored text, its data
    item (and Cognee's copy of its text), its graph node, a chunk part of it, the chunk's summary, the entities it
    contains and their types, relations between them, the vector rows of each, and every node and edge naming the data
    item and chunk it was made from. purge.left() reads the graph and the vectors through _graph and _vector_tables."""

    DATASET = "7b86e63f-75c6-5f7b-b0c0-90b0edc329f4"
    TABLES = {"DocumentChunk": "DocumentChunk_text", "Entity": "Entity_name", "EntityType": "EntityType_name", "TextDocument": "TextDocument_name", "TextSummary": "TextSummary_text"}

    def __init__(self, root: Path) -> None:
        import sqlite3

        self.root = root
        self.nodes: dict[str, dict] = {}
        self.edges: list[dict] = []
        self.vectors: dict[str, list[dict]] = {table: [] for table in [*self.TABLES.values(), "EdgeType_relationship_name"]}
        for folder in ("text", "passages", "chunks", "documents", "system/databases"):
            (root / folder).mkdir(parents=True, exist_ok=True)
        self.sqlite = sqlite3.connect(root / "system" / "databases" / "cognee_db")
        self.sqlite.execute("CREATE TABLE data (id TEXT, raw_data_location TEXT)")
        self.sqlite.execute("CREATE TABLE provenance_edge_evidence (data_id TEXT, chunk_id TEXT)")
        self.chunks: dict[str, str] = {}  # document -> its chunk

    def node(self, node_id: str, kind: str, name: str = "", refs: str = "", **props) -> str:
        node = self.nodes.setdefault(node_id, {"name": name, "type": kind, "props": props, "refs": ""})
        node["refs"] += refs
        if kind in self.TABLES and not any(r["id"] == node_id for r in self.vectors[self.TABLES[kind]]):
            self.vectors[self.TABLES[kind]].append({"id": node_id, "text": props.get("text") or name, "document_id": props.get("document_id")})
        return node_id

    def edge(self, source: str, relation: str, target: str, refs: str, text: str | None = None) -> None:
        text = (text or f"{self.nodes[source]['name']} {relation.replace('_', ' ')} {self.nodes[target]['name']}.").strip()  # as Cognee keeps it
        self.edges.append({"source": source, "target": target, "relation": relation, "props": {"edge_text": text}, "refs": refs})
        if not any(r["id"] == purge.edge_type_id(text) for r in self.vectors["EdgeType_relationship_name"]):
            self.vectors["EdgeType_relationship_name"].append({"id": purge.edge_type_id(text), "text": text, "document_id": None})

    def document(self, document_id: str, text: str, entities=(), relations=(), summary: str | None = None, fact: str | None = None) -> str:
        import uuid

        data = str(ops.data_id_of(document_id))
        chunk = str(uuid.uuid5(uuid.NAMESPACE_OID, f"{data}:{text}"))  # Cognee's chunk ids follow their text
        ref = f"|source_ref:v2:{self.DATASET}:{data}:{chunk}|"
        (self.root / "text" / f"{document_id}.json").write_text(json.dumps({"documentId": document_id, "name": f"{document_id}.md", "text": text}))
        copy = self.root / "documents" / f"text_{document_id}.txt"
        copy.write_text(text)
        self.sqlite.execute("INSERT INTO data VALUES (?, ?)", (uuid.UUID(data).hex, f"file://{copy}"))
        self.node(data, "TextDocument", document_id, f"|source_ref:v1:{self.DATASET}:{data}|")
        self.node(chunk, "DocumentChunk", "", ref, text=text, document_id=data)
        self.edge(chunk, "is_part_of", data, ref)
        for name, label in entities:
            entity = self.node(str(uuid.uuid5(uuid.NAMESPACE_OID, f"Entity:{name.lower()}")), "Entity", name.lower(), ref, description=name)
            kind = self.node(str(uuid.uuid5(uuid.NAMESPACE_OID, f"EntityType:{label}")), "EntityType", label, ref)
            self.edge(chunk, "contains", entity, ref, f"Document chunk mentions {name.lower()}: {name}")
            self.edge(entity, "is_a", kind, ref)
            self.sqlite.execute("INSERT INTO provenance_edge_evidence VALUES (?, ?)", (uuid.UUID(data).hex, uuid.UUID(chunk).hex))
        for source, relation, target in relations:
            ids = {n["props"].get("description"): i for i, n in self.nodes.items() if n["type"] == "Entity"}
            self.edge(ids[source], relation, ids[target], ref)
        if summary is not None:
            node = self.node(str(uuid.uuid5(uuid.UUID(chunk), "TextSummary")), "TextSummary", "", ref, text=summary)
            self.edge(node, "made_from", chunk, ref)
        (self.root / "passages" / f"{document_id}.json").write_text(json.dumps([{"passageId": chunk, "documentId": document_id, "start": 0, "end": len(text)}]))
        (self.root / "chunks" / f"{document_id}.json").write_text(json.dumps([chunk]))  # as index_passages lists them
        if fact is not None:
            facts_path = self.root / "facts.json"
            stored = json.loads(facts_path.read_text()) if facts_path.exists() else {"facts": []}
            stored["facts"].append({"sentence": fact, "sourceSentence": text.split(". ")[0], "documentId": document_id, "passageId": chunk})
            facts_path.write_text(json.dumps(stored))
        self.sqlite.commit()
        self.chunks[document_id] = chunk
        return chunk

    def remove_text(self, document_id: str) -> None:
        """What a removal for good takes at once: the stored text and its passages (Cognee's records are the test's)."""
        for folder in ("text", "passages", "chunks"):
            (self.root / folder / f"{document_id}.json").unlink()

    def left(self, probes: list[str], kept=lambda: []) -> dict[str, int]:
        with mock.patch.object(purge, "_graph", lambda root: (self.nodes, self.edges)), mock.patch.object(purge, "_vector_tables", lambda root: iter(self.vectors.items())):
            return purge.left(self.root, probes, kept, ops.data_id_of)


class Probes(unittest.TestCase):
    """What a removal for good or stricter hiding must leave nowhere, and how purge.left() finds it: in what was written
    from the documents, matched as the hiding detector matches a word; in what Cognee generated, by its links."""

    WORDS = {"emails": True, "phones": False, "cards": False, "apiKeys": False, "secrets": False}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_his07_a_removed_text_is_looked_for_in_pieces(self):
        text = 'Heading\n\nThe Gannetbrook archive keeps 41 snapshots of each board. Short one.\n"Quoted words" stay in a piece\tand tabs.'
        probes = purge.removed_probes([text])
        self.assertIn("The Gannetbrook archive keeps 41 snapshots of each board.", probes)
        self.assertIn('"Quoted words" stay in a piece', probes)
        self.assertNotIn("Short one.", probes, f"shorter than {purge.PROBE_MIN} characters")
        self.assertTrue(all(len(p) >= purge.PROBE_MIN and "\n" not in p and "\t" not in p for p in probes))
        many = " ".join(f"Sentence number {i:04d} of a long text." for i in range(1000))
        self.assertEqual(len(purge.removed_probes([many])), 1000, "every piece, however many")

    def test_hid04_the_values_stricter_rules_hide_are_looked_for(self):
        rules = {**self.WORDS, "words": ["Ledgerline"]}
        texts = ["Ledgerline invoices go to billing@example.com. LEDGERLINE again.", "Nothing [hidden] here."]
        self.assertEqual(sorted(purge.hidden_probes(texts, rules)), ["Ledgerline", "billing@example.com"])

    def test_a_collection_as_cognee_leaves_it_has_nothing_left_over(self):
        store = Collection(self.root)
        store.document("d_1", "Dana Reyes owns Hawser gateway.", [("Dana Reyes", "person"), ("Hawser gateway", "product")], [("Dana Reyes", "owns", "Hawser gateway")], "Dana Reyes owns Hawser gateway\nperson: Dana Reyes", "Dana reyes owns hawser gateway.")
        store.document("d_2", "The Marlin search service keeps 14 days of logs.", [("Marlin", "software")])
        self.assertEqual(store.left(["Ledgerline"]), {})

    def test_f198_every_newly_hidden_value_is_looked_for(self):
        emails = [f"person{i:04d}@example.com" for i in range(600)]
        probes = purge.hidden_probes([" and ".join(emails)], {**self.WORDS, "words": []})
        self.assertEqual(len(probes), 600)
        store = Collection(self.root)
        store.document("d_1", f"Write to {emails[-1]} today.")
        self.assertEqual(store.left(probes), {"text/d_1.json": 1, "documents/text_d_1.txt": 1, "LanceDB DocumentChunk_text": 1, "graph": 1}, "the last of 600 too")

    def test_f199_case_is_ignored_as_the_hiding_detector_ignores_it(self):
        rules = {**self.WORDS, "words": ["Éclair"]}
        probes = purge.hidden_probes(["The Éclair station opens at nine."], rules)
        self.assertEqual(probes, ["Éclair"])
        store = Collection(self.root)
        store.document("d_1", "The [hidden] station opens at nine.", [("éclair", "food"), ("ÉCLAIRS", "food")])  # as kept: in lower case
        self.assertEqual(store.left(probes), {"LanceDB Entity_name": 1, "graph": 2}, "a longer word, which the rule doesn't hide, isn't")

    def test_f199_values_are_read_decoded_not_as_their_json(self):
        probes = purge.hidden_probes(['Ask about Project "A" today.'], {**self.WORDS, "words": ['Project "A"']})
        store = Collection(self.root)
        store.document("d_1", "Ask about [hidden] today.", fact="Ops asks about it.")
        stored = json.loads((self.root / "facts.json").read_text())
        stored["facts"][0]["sourceSentence"] = 'Ask about Project "A" today.'  # its quotes stored as \"
        (self.root / "facts.json").write_text(json.dumps(stored))
        self.assertEqual(store.left(probes), {"facts.json": 1})

    def test_f197_keys_names_labels_and_bookkeeping_are_not_document_text(self):
        # A correct re-read hiding "text" and "person": the JSON key "text", a document's name and type, passage
        # bookkeeping, Cognee's entity type "person" and its summaries' "person: ..." all say them; no text written from
        # a document does.
        store = Collection(self.root)
        store.document("d_1", "Use [hidden] for the launch plan.", [("Dana Reyes", "person")], summary="person: Dana Reyes")
        stored = json.loads((self.root / "text" / "d_1.json").read_text())
        stored.update({"name": "text plan.md", "type": "text/markdown", "note": "Only the first 2 MB of text was learned."})
        (self.root / "text" / "d_1.json").write_text(json.dumps(stored))
        (self.root / "ledger.json").write_text(json.dumps({"batches": {"text": {"documents": ["d_1"]}}}))
        self.assertEqual(store.left(["text", "person"]), {})
        (self.root / "documents" / "text_d_1.txt").write_text("Use text for the launch plan.")
        self.assertEqual(store.left(["text", "person"]), {"documents/text_d_1.txt": 1}, "a document's own words still count")

    def test_f202_a_hidden_word_cognee_also_uses_as_a_relation_name_counts_only_in_document_text(self):
        # "headquartered_in" hidden: Cognee's relation of that name, its text, the summary and the fact made from it,
        # all from a live chunk of another document, are Cognee's records; in a text Cognee keeps, it counts.
        store = Collection(self.root)
        store.document("d_1", "The fields [hidden] and [hidden] link each record.")
        store.document("d_2", "The Hawser gateway sits in port 8443.", [("Hawser gateway", "organization"), ("port 8443", "location")], [("Hawser gateway", "headquartered_in", "port 8443")], "Hawser gateway headquartered_in port 8443", "Hawser gateway headquartered in port 8443.")
        probes = ["headquartered_in", "is_part_of", "headquartered in"]
        self.assertEqual(store.left(probes), {})
        (self.root / "documents" / "text_d_1.txt").write_text("The fields is_part_of and headquartered_in link each record.")
        self.assertEqual(store.left(probes), {"documents/text_d_1.txt": 2})

    def test_f205_and_f207_what_cognee_made_from_a_removed_document_is_left_over_whatever_it_says(self):
        # The removed document's summary ("Dana Reyes owns Hawser gateway", or "The project uses Part Of as its
        # supplier") and its relation stay behind while both entities live on in another document: its chunk is gone.
        store = Collection(self.root)
        store.document("d_rm", "Dana Reyes owns Hawser gateway. The project uses Part Of as its supplier.", [("Dana Reyes", "person"), ("Hawser gateway", "product")], [("Dana Reyes", "owns", "Hawser gateway")], "Dana Reyes owns Hawser gateway\nThe project uses Part Of as its supplier.", "Dana reyes owns hawser gateway.")
        store.document("d_kept", "Dana Reyes runs the Hawser gateway.", [("Dana Reyes", "person"), ("Hawser gateway", "product")])
        removed_chunk, data = store.chunks["d_rm"], str(ops.data_id_of("d_rm"))
        store.remove_text("d_rm")
        # Cognee deleted the document, its chunk and its data item, but not the summary or the relation:
        del store.nodes[removed_chunk], store.nodes[data]
        store.vectors["DocumentChunk_text"] = [r for r in store.vectors["DocumentChunk_text"] if r["id"] != removed_chunk]
        store.vectors["TextDocument_name"] = [r for r in store.vectors["TextDocument_name"] if r["id"] != data]
        store.edges = [e for e in store.edges if removed_chunk not in (e["source"], e["target"]) or e["relation"] == "made_from"]
        store.sqlite.execute("DELETE FROM data WHERE id = ?", (ops.data_id_of("d_rm").hex,))
        store.sqlite.execute("DELETE FROM provenance_edge_evidence WHERE data_id = ?", (ops.data_id_of("d_rm").hex,))
        store.sqlite.commit()
        (self.root / "documents" / "text_d_rm.txt").unlink()
        probes = purge.removed_probes(["Dana Reyes owns Hawser gateway. The project uses Part Of as its supplier."])
        left = store.left(probes, kept=lambda: ["Dana Reyes runs the Hawser gateway."])
        # In the graph: the summary, made from a chunk that's gone, and the shared entities, their types and the
        # relation, which still name the removed chunk. The summary's vector row, the relation texts of the chunk's
        # edges, and the fact taken from a passage that's gone. (The entities' own rows belong to live entities.)
        self.assertEqual(set(left), {"graph", "LanceDB TextSummary_text", "LanceDB EdgeType_relationship_name", "facts.json"})
        self.assertEqual(left["LanceDB TextSummary_text"], 1)

    def test_f208_a_live_summary_is_cognees_however_its_entity_is_now_spelled(self):
        # O'Brien Labs, then OBrien Labs: one entity, spelled the later way now. The earlier chunk's summary is live,
        # so hiding "organization" in another document passes: no generated text is read.
        store = Collection(self.root)
        store.document("d_1", "O'Brien Labs ships the gateway.", [("O'Brien Labs", "organization")], summary="organization: O'Brien Labs")
        store.document("d_2", "OBrien Labs hired Dana.", [("OBrien Labs", "organization")], summary="organization: OBrien Labs")
        store.document("d_3", "The [hidden] desk answers.")
        self.assertEqual(store.left(["organization"]), {})

    def test_records_that_name_a_removed_item_or_none_are_left_over(self):
        for spoil, place in (
            (lambda st: st.edges[0].update(refs=st.edges[0]["refs"] + f"|source_ref:v2:{Collection.DATASET}:{ops.data_id_of('d_gone')}:{ops.data_id_of('d_gone')}|"), "graph"),
            (lambda st: next(n for n in st.nodes.values() if n["type"] == "Entity").update(refs=""), "graph"),
            (lambda st: st.vectors["EdgeType_relationship_name"].append({"id": purge.edge_type_id("dana reyes owns ledgerline."), "text": "dana reyes owns ledgerline.", "document_id": None}), "LanceDB EdgeType_relationship_name"),
            (lambda st: st.vectors["Entity_name"].append({"id": "0f1e2d3c-0000-4000-8000-000000000000", "text": "ledgerline", "document_id": None}), "LanceDB Entity_name"),
            (lambda st: (st.sqlite.execute("INSERT INTO data VALUES (?, ?)", (ops.data_id_of("d_gone").hex, "")), st.sqlite.commit()), "SQLite data"),
            (lambda st: (st.root / "documents" / "text_old.txt").write_text("An older copy."), "documents/text_old.txt"),
            (lambda st: (st.root / "passages" / "d_gone.json").write_text("[]"), "passages/d_gone.json"),
        ):
            with self.subTest(place=place), tempfile.TemporaryDirectory() as tmp:
                store = Collection(Path(tmp))
                store.document("d_1", "Dana Reyes owns Hawser gateway.", [("Dana Reyes", "person"), ("Hawser gateway", "product")], [("Dana Reyes", "owns", "Hawser gateway")])
                spoil(store)
                self.assertEqual(set(store.left([])), {place})

    def test_f212_a_chunk_a_reread_replaced_is_left_over_though_its_document_lives(self):
        # "password: Ledgerline" re-read into "password: [hidden]"; another document says Ledgerline, so the word may
        # stay in text. The old chunk and its summary, kept beside the new ones, still name the document's data item and
        # their own chunk: only the list of the chunks the re-read made tells them apart.
        store = Collection(self.root)
        store.document("d_other", "The Ledgerline desk answers by Friday.")
        old_chunk = store.document("d_1", "Sign in with password: Ledgerline today.", summary="Sign in with password: Ledgerline")
        old = {i: dict(n) for i, n in store.nodes.items() if old_chunk in n["refs"] and n["type"] in ("DocumentChunk", "TextSummary")}
        old_edges = [dict(e) for e in store.edges if old_chunk in e["refs"] and e["relation"] in ("is_part_of", "made_from")]
        old_rows = {t: [r for r in rows if r["id"] in old] for t, rows in store.vectors.items()}
        # The re-read: Cognee forgets the document (its chunk and summary go) and learns the new text.
        for node_id in old:
            del store.nodes[node_id]
        store.edges = [e for e in store.edges if e not in old_edges]
        store.vectors = {t: [r for r in rows if r["id"] not in old] for t, rows in store.vectors.items()}
        store.document("d_1", "Sign in with password: [hidden] today.", summary="Sign in with password: [hidden]")
        self.assertNotEqual(store.chunks["d_1"], old_chunk)
        self.assertEqual(store.left(["Ledgerline"], kept=lambda: ["The Ledgerline desk answers by Friday.", "Sign in with password: [hidden] today."]), {})
        store.nodes.update(old)  # what a re-read that didn't remove them would leave
        store.edges.extend(old_edges)
        for table, rows in old_rows.items():
            store.vectors[table].extend(rows)
        left = store.left(["Ledgerline"], kept=lambda: ["The Ledgerline desk answers by Friday.", "Sign in with password: [hidden] today."])
        self.assertEqual(set(left), {"graph", "LanceDB DocumentChunk_text", "LanceDB TextSummary_text"})
        self.assertEqual(left["LanceDB TextSummary_text"], 1)

    def test_f213_edges_are_decided_on_the_text_as_written(self):
        # Greek iota folds to the combining ypogegrammeni (U+0345), which isn't a word character: the edges are the
        # text's own characters', as re decides them.
        for probes, text in ((["A"], "ιA"), (["A"], "\u0345A"), (["Ledgerline"], "ιLedgerline"), (["ιx"], "Ιx ιx \u0345x")):
            wanted = {p: len(re.findall(r"(?=(?<!\w)" + re.escape(p) + r"(?!\w))", text, re.IGNORECASE)) for p in probes}
            self.assertEqual(purge.Matcher(probes).counts(text), {p: n for p, n in wanted.items() if n}, (probes, text))
        self.assertEqual(purge.Matcher(["A"]).counts("ιA"), {})
        store = Collection(self.root)
        store.document("d_1", "Ledgerline invoices.")
        self.assertIn("graph", store.left(["Ledgerline"], kept=lambda: ["ιLedgerline is a longer word."]), "a kept ιLedgerline doesn't hold it")

    def test_a_file_purge_doesnt_know_is_read_whole(self):
        (self.root / "system" / "databases").mkdir(parents=True)
        (self.root / "system" / "databases" / "other.bin").write_bytes(b"\x00\x01ledgerline\xff" * 3)
        self.assertEqual(Collection(self.root).left(["Ledgerline"]), {"system/databases/other.bin": 3})

    def test_a_probe_a_kept_document_holds_may_stay(self):
        store = Collection(self.root)
        store.document("d_1", "Contact the help desk for anything else.")
        probes = purge.removed_probes(["Contact the help desk for anything else."])
        self.assertEqual(store.left(probes, kept=lambda: ["Kept: contact the help desk for anything else. Bye."]), {})
        self.assertEqual(set(store.left(probes, kept=lambda: ["Another text."])), {"text/d_1.json", "documents/text_d_1.txt", "LanceDB DocumentChunk_text", "graph"})

    def test_f204_case_is_ignored_exactly_as_re_ignorecase_ignores_it(self):
        # The hiding detector matches "Pin" in "pın" (dotless i), "İ" as "i", "ſ" as "s", the Kelvin sign as "k".
        for probe, text in (("Pin", "Every pın code"), ("istanbul", "İSTANBUL office"), ("Seal", "ſeal"), ("kiln", "\u212Ailn")):
            self.assertTrue(re.search(r"(?<!\w)" + re.escape(probe) + r"(?!\w)", text, re.IGNORECASE), (probe, text))
            self.assertEqual(purge.Matcher([probe]).counts(text), {probe: 1}, (probe, text))
        self.assertEqual(purge.Matcher(["straße"]).counts("STRASSE"), {}, "two letters for one: re doesn't match them either")

    def test_f204_fold_is_re_ignorecase_for_every_character_with_a_case(self):
        import itertools

        related: dict[str, set[str]] = {}
        for code in range(0x110000):
            if 0xD800 <= code <= 0xDFFF:
                continue
            char = chr(code)
            for key in {char.lower(), char.upper(), char.casefold(), purge.fold(char)}:
                related.setdefault(key, set()).add(char)
        pairs = 0
        for chars in related.values():
            for a, b in itertools.combinations(sorted(chars), 2):
                pairs += 1
                same = bool(re.fullmatch(re.escape(a), b, re.IGNORECASE))
                self.assertEqual(purge.fold(a) == purge.fold(b), same, (a, b))
        self.assertGreater(pairs, 2000)
        self.assertTrue(all(len(purge.fold(chr(c))) == 1 for c in (0x130, 0x131, 0x17F, 0x212A, 0xDF, 0x1E9E)))

    def test_f203_probes_sharing_a_word_cost_what_the_text_costs(self):
        # 20,000 removed lines, every one holding "example", and 2 MiB of kept text full of it: each probe rescanning
        # the text took 18 s per 64 KiB (about ten minutes here, eight hours at 100 MiB).
        import time

        lines = [f"Mail a{i:05d}@example.com today about the plan." for i in range(20000)]
        probes = purge.removed_probes(["\n".join(lines)])
        self.assertEqual(len(probes), 20000)
        kept = ("An example of the plan: write to someone@example.com about it. " * 40000)[: 2 * 1024 * 1024] + "\n" + lines[12345]
        started = time.monotonic()
        counts = purge.Matcher(probes).counts(kept)
        self.assertEqual(counts, {lines[12345]: 1})
        self.assertLess(time.monotonic() - started, 10)

    def test_f206_probes_of_every_length_on_one_common_word_cost_what_the_text_costs(self):
        # 1,000 removed lines "the the ... and" of 6 to 1,005 words, against 4 MiB of kept "the ": looking at every
        # length wherever "the" stands took 12.3 s per 64 KiB (about 13 minutes here, 106 at 32 MiB).
        import time

        probes = purge.removed_probes(["\n".join("the " * i + "and" for i in range(6, 1006))])
        self.assertEqual(len(probes), 1000)
        matcher = purge.Matcher(probes)
        kept = "the " * (1024 * 1024) + "end. " + "the " * 600 + "and"
        started = time.monotonic()
        counts = matcher.counts(kept)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(sorted(len(p.split()) for p in counts), list(range(7, 602)), "those of 600 words or fewer, once")
        self.assertEqual(set(counts.values()), {1})

    def test_f209_probes_that_differ_only_in_punctuation_cost_what_the_text_costs(self):
        # 4,000 removed lines "the!!...!" of 21 to 4,020 marks, against 4 MiB of kept "the ": every probe ended on
        # "the", so each "the" ran 4,000 expressions (11.9 s per 64 KiB, 101 minutes at 32 MiB).
        import time

        probes = purge.removed_probes(["\n".join("the" + "!" * i for i in range(21, 4021))])
        self.assertEqual(len(probes), 4000)
        matcher = purge.Matcher(probes)
        kept = "the " * (1024 * 1024) + "the" + "!" * 30 + " the" + "!" * 30 + "x"
        started = time.monotonic()
        counts = matcher.counts(kept)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(sorted(len(p) for p in counts), [24 + i for i in range(10)], "21 to 30 marks, once each; then 'x' ends no word")

    def test_f214_a_probe_found_far_from_its_start_costs_nothing_more(self):
        # "!" * n and "!" * 2n + "x" against 2 MiB of "!": finding where each match starts took time in proportion to
        # n (64 s at n = 524,287); it is the match's end less the probe's length.
        import time

        n = 131072
        matcher = purge.Matcher(["!" * n, "!" * (2 * n) + "x"])
        started = time.monotonic()
        counts = matcher.counts("!" * (2 * 1024 * 1024))
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(counts, {"!" * n: 2 * 1024 * 1024 - n + 1})

    def test_the_matcher_finds_what_re_finds(self):
        import random

        random.seed(7)
        words = ["Pin", "pın", "the", "and", "Éclair", "éclair", "x", "A", "a", "is_part_of", "!", "!!", "ι", "\u0345", "Ι", "ιA"]
        for _ in range(1500):
            probes = [" ".join(random.choice(words) for _ in range(random.randint(1, 4))) + random.choice(["", ".", ")", "!!", "ι"]) for _ in range(5)]
            probes.append(random.choice(["(", "-", "!", "\u0345"]) + random.choice(words))
            text = random.choice(["", " "]).join(random.choice(words + ["(", ".", "  ", "-", "!x", "x!", "\u0345"]) for _ in range(60))
            wanted = {p: len(re.findall(r"(?=(?<!\w)" + re.escape(p) + r"(?!\w))", text, re.IGNORECASE)) for p in dict.fromkeys(probes)}
            self.assertEqual(purge.Matcher(probes).counts(text), {p: n for p, n in wanted.items() if n}, (probes, text))

    def test_many_probes_cost_what_the_text_costs(self):
        import time

        matcher = purge.Matcher([f"value{i:05d}@example.com" for i in range(20000)] + ["the Gannetbrook archive keeps 41 snapshots"])
        text = "The Gannetbrook archive keeps 41 snapshots. " * 20000 + " value19999@example.com"
        started = time.monotonic()
        counts = matcher.counts(text)
        self.assertEqual(counts, {"value19999@example.com": 1, "the Gannetbrook archive keeps 41 snapshots": 20000})
        self.assertLess(time.monotonic() - started, 5)


class AfterRemovalAndRereading(unittest.TestCase):
    """ops.purged(): the op runs in a child process (faked here), then the stores are purged (faked) and what they
    hold is read for what was removed or newly hidden; any left fails the job."""

    REMOVED = "# Dashboards\n\nThe Gannetbrook archive keeps 41 snapshots of each board.\n\nBoards refresh every minute."
    KEPT = "# Billing\n\nThe Marlin search service keeps 14 days of logs. Ledgerline invoices go out on Mondays."

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data = root / "data"
        names = {"DATA_DIR": self.data, "TEXT_DIR": self.data / "text", "PASSAGES_DIR": self.data / "passages", "CHUNKS_DIR": self.data / "chunks", "DATABASES_DIR": self.data / "system" / "databases", "WORK_DIR": root / "work"}
        self.patches = [mock.patch.object(ops, name, value) for name, value in names.items()]
        self.patches.append(mock.patch.object(purge, "purge", lambda *args: {"vectorTables": 0}))
        for patch in self.patches:
            patch.start()
        (self.data / "system" / "databases").mkdir(parents=True)
        for document_id, text in (("d_rm", self.REMOVED), ("d_kept", self.KEPT)):
            ops.store_text({"documentId": document_id, "name": f"{document_id} Ledgerline.md", "text": text, "pages": [], "hidden": []})
        self.batch = root / "batch"
        self.batch.mkdir()
        self.result = root / "result.json"

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def run_op(self, op: str, batch: dict, child_result: dict, child_does=lambda: None):
        (self.batch / "batch.json").write_text(json.dumps(batch))

        def child(argv):
            self.assertEqual(argv[-1], "--inner", "the op itself runs in a child process")
            child_does()
            self.result.write_text(json.dumps(child_result))
            return types.SimpleNamespace(returncode=0)

        args = types.SimpleNamespace(op=op, batch_dir=str(self.batch), result=str(self.result))
        with mock.patch.object(ops.subprocess, "run", child), mock.patch("sys.stderr", io.StringIO()):
            return ops.purged(args)

    def test_his07_a_removal_that_leaves_its_text_fails(self):
        def removes():
            (self.data / "text" / "d_rm.json").unlink()  # as op_remove does: the text is read before, not after
            (self.data / "system" / "databases" / "chunks.lance").write_bytes(b"\x00The Gannetbrook archive keeps 41 snapshots of each board.\x00")

        with self.assertRaises(ops.Stop) as stopped:
            self.run_op("remove", {"importId": "rm1", "kind": "remove", "documentIds": ["d_rm"]}, {"removed": ["d_rm"]}, removes)
        self.assertEqual(stopped.exception.result["reason"], "Removed text was still found in the collection's data after it was cleaned up (1 place), so nothing was kept.")
        self.assertFalse(stopped.exception.result["permanent"], "tried again from the last restore point")

    def test_a_removal_that_leaves_nothing_commits(self):
        (self.data / "system" / "databases" / "chunks.lance").write_bytes(self.KEPT.encode())
        result = self.run_op("remove", {"importId": "rm1", "kind": "remove", "documentIds": ["d_rm"]}, {"removed": ["d_rm"]}, lambda: (self.data / "text" / "d_rm.json").unlink())
        self.assertEqual(result["removed"], ["d_rm"])
        self.assertGreater(result["purge"]["probes"], 0)

    def test_hid04_a_reread_that_leaves_a_hidden_word_fails(self):
        rules = {"emails": True, "phones": True, "cards": True, "apiKeys": True, "secrets": True, "words": ["Ledgerline"]}

        def rereads(leave: bool):
            def run():
                ops.store_text({"documentId": "d_kept", "name": "d_kept Ledgerline.md", "text": self.KEPT.replace("Ledgerline", "[hidden]"), "pages": [], "hidden": []})
                (self.data / "system" / "databases" / "graph").write_bytes(b"entity ledgerline" if leave else b"entity [hidden]")
            return run

        batch = {"importId": "rr1", "kind": "reread", "hiding": rules, "documentIds": ["d_rm", "d_kept"], "marks": []}
        with self.assertRaises(ops.Stop) as stopped:
            self.run_op("reread", batch, {"changed": ["d_kept"]}, rereads(True))
        self.assertEqual(stopped.exception.result["reason"], "Newly hidden text was still found in the collection's data after it was cleaned up (1 place), so nothing was kept.")
        ops.store_text({"documentId": "d_kept", "name": "d_kept Ledgerline.md", "text": self.KEPT, "pages": [], "hidden": []})
        result = self.run_op("reread", batch, {"changed": ["d_kept"]}, rereads(False))
        self.assertEqual(result["purge"]["probes"], 1, "the word; the document's name may still hold it")

    def test_f211_a_removed_documents_spelling_of_a_shared_entity_is_looked_for(self):
        # OBrien International Research Labs (kept) and O'Brien International Research Labs (removed): one entity in
        # Cognee, described the removed way. That spelling is no piece of the removed sentences: it is looked for too.
        import uuid

        rm, kept = ops.data_id_of("d_rm"), ops.data_id_of("d_kept")
        ref = lambda data: f"|source_ref:v2:{Collection.DATASET}:{data}:{uuid.uuid5(data, 'chunk')}|"  # noqa: E731
        graph = {"nodes": {"e1": {"name": "obrien international research labs", "type": "Entity", "props": {"description": "O'Brien International Research Labs"}, "refs": ref(rm) + ref(kept)}}, "edges": []}
        ops.store_text({"documentId": "d_kept", "name": "d_kept.md", "text": "OBrien International Research Labs builds the gateway.", "pages": [], "hidden": []})

        def removes(rebuilt: bool):
            def run():
                (self.data / "text" / "d_rm.json").unlink()
                graph["nodes"]["e1"]["refs"] = ref(kept)
                if rebuilt:
                    graph["nodes"]["e1"]["props"]["description"] = "OBrien International Research Labs"
            return run

        batch = {"importId": "rm1", "kind": "remove", "documentIds": ["d_rm"]}
        with mock.patch.object(purge, "_graph", lambda root: (graph["nodes"], graph["edges"])), mock.patch.object(purge, "stale", lambda *args: {}):
            with self.assertRaises(ops.Stop):
                self.run_op("remove", batch, {"removed": ["d_rm"]}, removes(False))
            ops.store_text({"documentId": "d_rm", "name": "d_rm.md", "text": self.REMOVED, "pages": [], "hidden": []})
            graph["nodes"]["e1"].update(refs=ref(rm) + ref(kept), props={"description": "O'Brien International Research Labs"})
            result = self.run_op("remove", batch, {"removed": ["d_rm"]}, removes(True))
        self.assertEqual(result["removed"], ["d_rm"])

    def test_f211_the_kept_documents_naming_such_an_entity_are_learned_again(self):
        ops.store_text({"documentId": "d_kept", "name": "d_kept.md", "text": "OBrien International Research Labs builds the gateway.", "pages": [], "hidden": []})
        ops.store_text({"documentId": "d_other", "name": "d_other.md", "text": "Hawser gateway ships from Oslo.", "pages": [], "hidden": []})
        kept = purge._id(ops.data_id_of("d_kept"))
        survivors = {
            "e1": {"values": ["obrien international research labs", "O'Brien International Research Labs"], "data": {kept}},
            "e2": {"values": ["hawser gateway", "Hawser gateway"], "data": {purge._id(ops.data_id_of("d_other"))}},
        }
        learned = []

        async def entities():
            return survivors

        async def forget_chunks(document_id):
            learned.append(("forget", document_id))

        async def learn(documents):
            learned.append(("learn", [d for d, _ in documents]))

        with mock.patch.object(ops, "entities", entities), mock.patch.object(ops, "forget_chunks", forget_chunks), mock.patch.object(ops, "learn", learn), mock.patch.object(ops, "index_passages", lambda ids: learned.append(("index", ids))):
            again = asyncio.run(ops.rebuild_shared_entities({"e1", "e2"}))
            self.assertEqual(again, ["d_kept"], "only the entity spelled the removed way")
            self.assertEqual(learned, [("forget", "d_kept"), ("learn", ["d_kept"]), ("index", ["d_kept"])])
            survivors["e1"]["values"][1] = "OBrien International Research Labs"
            self.assertEqual(asyncio.run(ops.rebuild_shared_entities({"e1", "e2"})), [])

    def test_a_reread_that_changed_nothing_is_not_purged(self):
        batch = {"importId": "rr1", "kind": "reread", "hiding": {}, "documentIds": ["d_kept"], "marks": []}
        self.assertNotIn("purge", self.run_op("reread", batch, {"changed": []}))


if __name__ == "__main__":
    unittest.main()

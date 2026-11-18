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
        # Snapshots and backups made before data ids say knowledge-1: the Durable Object opens a backup only in the
        # running image's format (backup.ts holds), so such a collection learns everything again from its saved text.
        dockerfile = (Path(_paths.CONTAINER) / "Dockerfile").read_text()
        data_format = dockerfile.split("KNOWLEDGE_DATA_FORMAT=", 1)[1].split()[0]
        self.assertTrue(data_format.endswith(f"+{ops.DATA_LAYOUT}"), data_format)
        self.assertNotEqual(ops.DATA_LAYOUT, "knowledge-1", "the layout before each document had its own data item")


class LearningInGroups(unittest.TestCase):
    """An import's documents are learned together, one cognify per group (Cognee's cost is per document; each call adds
    its own pass), and a later try one at a time, so a file that crashes the learning is named (IMP-05)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        names = {
            "DATA_DIR": root / "data", "TEXT_DIR": root / "data" / "text", "PASSAGES_DIR": root / "data" / "passages",
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


class Probes(unittest.TestCase):
    """What a removal for good or stricter hiding must leave nowhere, and where purge.left() looks for it: decoded
    values made from the documents, matched as the hiding detector matches a word."""

    WORDS = {"emails": True, "phones": False, "cards": False, "apiKeys": False, "secrets": False}

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

    def test_f198_every_newly_hidden_value_is_looked_for(self):
        emails = [f"person{i:04d}@example.com" for i in range(600)]
        probes = purge.hidden_probes([" and ".join(emails)], {**self.WORDS, "words": []})
        self.assertEqual(len(probes), 600)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "documents").mkdir()
            (root / "documents" / "text_1.txt").write_text(f"Write to {emails[-1]} today.")
            self.assertEqual(purge.left(root, probes, lambda: []), {"documents/text_1.txt": 1}, "the last of 600 too")

    def test_f199_case_is_ignored_as_the_hiding_detector_ignores_it(self):
        rules = {**self.WORDS, "words": ["Éclair"]}
        probes = purge.hidden_probes(["The Éclair station opens at nine."], rules)
        self.assertEqual(probes, ["Éclair"])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "documents").mkdir()
            (root / "documents" / "text_1.txt").write_text("an éclair only")  # as an entity name is kept: in lower case
            (root / "documents" / "text_2.txt").write_text("ÉCLAIRS galore")  # a longer word, which the rule doesn't hide
            self.assertEqual(purge.left(root, probes, lambda: []), {"documents/text_1.txt": 1})

    def test_f199_values_are_read_decoded_not_as_their_json(self):
        probes = purge.hidden_probes(['Ask about Project "A" today.'], {**self.WORDS, "words": ['Project "A"']})
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fact = {"factId": "f_1", "sentence": "Ops asks about it.", "sourceSentence": 'Ask about Project "A" today.', "documentId": "d_1"}
            (root / "facts.json").write_text(json.dumps({"facts": [fact]}))  # its quotes stored as \"
            self.assertEqual(purge.left(root, probes, lambda: []), {"facts.json": 1})

    def test_f197_keys_names_and_bookkeeping_are_not_document_values(self):
        # A correct re-read hiding the word "text": the JSON key "text", a document's name and type, ids and passage
        # bookkeeping all say it, but no value made from the documents does.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for folder in ("text", "passages", "documents"):
                (root / folder).mkdir()
            stored = {"documentId": "d_1", "kind": "file", "name": "text plan.md", "type": "text/markdown", "text": "Use [hidden] for the launch plan.", "pages": [], "hidden": [{"start": 4, "end": 12, "kind": "word"}], "note": "Only the first 2 MB of text was learned."}
            (root / "text" / "d_1.json").write_text(json.dumps(stored))
            (root / "passages" / "d_1.json").write_text(json.dumps([{"passageId": "p", "documentId": "d_1", "start": 0, "end": 33, "page": None, "textHash": "ab"}]))
            (root / "documents" / "text_9.txt").write_text("Use [hidden] for the launch plan.")
            (root / "ledger.json").write_text(json.dumps({"batches": {"text": {"documents": ["d_1"]}}}))
            self.assertEqual(purge.left(root, ["text"], lambda: ["Use [hidden] for the launch plan."]), {})
            (root / "documents" / "text_9.txt").write_text("Use text for the launch plan.")
            self.assertEqual(purge.left(root, ["text"], lambda: []), {"documents/text_9.txt": 1}, "a document's own words still count")

    @staticmethod
    def graph(*, summaries=(), relations=(), entities=("Hawser gateway", "port 8443", "Dana Reyes"), types=("organization", "location", "person")):
        """A graph as Cognee writes it: entities (named in lower case, spelled as found), their type labels, summaries
        and relations; a relation's text is Cognee's own template unless given."""
        meta = lambda field: {"metadata": str({"index_fields": [field]})}  # noqa: E731 - as Cognee stores it
        nodes = {f"e{i}": {"name": name.lower(), "type": "Entity", "props": {**meta("name"), "description": name}} for i, name in enumerate(entities)}
        nodes.update({f"t{i}": {"name": label, "type": "EntityType", "props": meta("name")} for i, label in enumerate(types)})
        nodes.update({f"s{i}": {"name": "", "type": "TextSummary", "props": {**meta("text"), "text": text}} for i, text in enumerate(summaries)})
        edges = []
        by_name = {n["props"].get("description", n["name"]): node_id for node_id, n in nodes.items()}
        for source, relation, target, *text in relations:
            src, tgt = nodes[by_name[source]], nodes[by_name[target]]
            edges.append((by_name[source], by_name[target], relation, {"edge_text": text[0] if text else f"{src['name']} {relation.replace('_', ' ')} {tgt['name']}."}))
        return lambda root: (nodes, edges)

    def test_f202_a_hidden_word_cognee_also_uses_as_a_relation_name_is_cognees_where_cognee_wrote_it(self):
        # A correct re-read hiding "headquartered_in": the document's words are hidden, but Cognee names a relation it
        # found in another document that way: in the relation, its text, the summary and the fact made from it. All
        # exactly as Cognee writes them from live records: they don't count. In a text Cognee keeps, they do.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fact = {"sentence": "Hawser gateway headquartered in port 8443.", "sourceSentence": "The Hawser gateway listens on port 8443."}
            (root / "facts.json").write_text(json.dumps({"facts": [fact]}))
            (root / "documents").mkdir()
            (root / "documents" / "text_1.txt").write_text("The fields [hidden] and [hidden] link each record.")
            summary = "Hawser gateway headquartered_in port 8443\nlocation: port 8443; organization: Hawser gateway"
            graph = self.graph(summaries=[summary], relations=[("Hawser gateway", "headquartered_in", "port 8443")])
            probes = ["headquartered_in", "is_part_of", "headquartered in"]
            with mock.patch.object(purge, "_graph", graph):
                self.assertEqual(purge.left(root, probes, lambda: []), {})
                (root / "documents" / "text_1.txt").write_text("The fields is_part_of and headquartered_in link each record.")
                self.assertEqual(purge.left(root, probes, lambda: []), {"documents/text_1.txt": 2})

    def test_f205_text_that_only_shares_words_with_a_label_is_read(self):
        # A company called "Part Of", hidden; the graph has Cognee's is_part_of and part_of. A summary or a fact that
        # isn't what Cognee's templates make from the live records is read in full, whatever words it shares.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fact = {"sentence": "The project uses Part Of.", "sourceSentence": "A sentence without it."}
            (root / "facts.json").write_text(json.dumps({"facts": [fact]}))
            graph = self.graph(summaries=["The project uses Part Of as its supplier."], relations=[("Hawser gateway", "part_of", "port 8443")])
            with mock.patch.object(purge, "_graph", graph):
                self.assertEqual(purge.left(root, ["Part Of"], lambda: []), {"graph": 1, "facts.json": 1})
            # Named by Cognee, it is an entity: its summary is Cognee's, but the entity's own name is read.
            graph = self.graph(summaries=["organization: Hawser gateway, Part Of"], entities=("Hawser gateway", "Part Of"))
            with mock.patch.object(purge, "_graph", graph):
                self.assertEqual(purge.left(root, ["Part Of"], lambda: []), {"graph": 2, "facts.json": 1})

    def test_a_hidden_word_that_is_one_of_cognees_labels_counts_only_where_documents_wrote_it(self):
        # "person" hidden: Cognee's label "person" stays (an entity type, "<name> is a person.", a summary's
        # "person: ..."), and isn't the documents'. A document's own "person" (an entity, a chunk) is read.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            graph = self.graph(summaries=["person: Dana Reyes"], relations=[("Dana Reyes", "is_a", "person")])
            with mock.patch.object(purge, "_graph", graph):
                self.assertEqual(purge.left(root, ["person"], lambda: []), {})
            graph = self.graph(summaries=["person: Dana Reyes"], entities=("Dana Reyes", "the person in charge"))
            with mock.patch.object(purge, "_graph", graph):
                self.assertEqual(purge.left(root, ["person"], lambda: []), {"graph": 2})

    def test_a_label_or_relation_name_cognee_doesnt_have_is_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            graph = self.graph(types=("person", "ledgerline"), relations=[("Hawser gateway", "ledgerline_of", "port 8443")])
            with mock.patch.object(purge, "_graph", graph):
                self.assertEqual(purge.left(Path(tmp), ["Ledgerline"], lambda: []), {"graph": 2}, "the type's name, the relation's text")

    def test_the_vocabulary_is_the_pinned_cognees(self):
        dockerfile = (Path(_paths.CONTAINER) / "Dockerfile").read_text()
        requirements = (Path(_paths.CONTAINER) / "requirements.in").read_text()
        self.assertIn(f"KNOWLEDGE_DATA_FORMAT=cognee-{purge.COGNEE_VERSION}+", dockerfile)
        self.assertIn(f"cognee[gliner]=={purge.COGNEE_VERSION}", requirements, "a new Cognee: check ENTITY_LABELS and RELATIONS against it")

    def test_a_file_purge_doesnt_know_is_read_whole(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "system" / "databases").mkdir(parents=True)
            (root / "system" / "databases" / "other.bin").write_bytes(b"\x00\x01ledgerline\xff" * 3)
            self.assertEqual(purge.left(root, ["Ledgerline"], lambda: []), {"system/databases/other.bin": 3})

    def test_a_probe_a_kept_document_holds_may_stay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "documents").mkdir()
            (root / "documents" / "text_1.txt").write_text("Contact the help desk for anything else.")
            probes = purge.removed_probes(["Contact the help desk for anything else."])
            self.assertEqual(purge.left(root, probes, lambda: ["Kept: contact the help desk for anything else. Bye."]), {})
            self.assertEqual(purge.left(root, probes, lambda: ["Another text."]), {"documents/text_1.txt": 1})

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

    def test_the_matcher_finds_what_re_finds(self):
        import random

        random.seed(7)
        words = ["Pin", "pın", "the", "and", "Éclair", "éclair", "x", "A", "a", "is_part_of"]
        for _ in range(400):
            probes = [" ".join(random.choice(words) for _ in range(random.randint(1, 4))) + random.choice(["", ".", ")"]) for _ in range(5)]
            text = " ".join(random.choice(words + ["(", ".", "  ", "-"]) for _ in range(60))
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
        names = {"DATA_DIR": self.data, "TEXT_DIR": self.data / "text", "PASSAGES_DIR": self.data / "passages", "DATABASES_DIR": self.data / "system" / "databases", "WORK_DIR": root / "work"}
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

    def test_a_reread_that_changed_nothing_is_not_purged(self):
        batch = {"importId": "rr1", "kind": "reread", "hiding": {}, "documentIds": ["d_kept"], "marks": []}
        self.assertNotIn("purge", self.run_op("reread", batch, {"changed": []}))


if __name__ == "__main__":
    unittest.main()

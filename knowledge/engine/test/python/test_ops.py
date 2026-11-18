"""ops.py and purge.py without Cognee: each document is its own data item, so two with the same text each get their
passages (IMP-06's PowerPoint); and what a removal for good or stricter hiding must leave nowhere under /data is
found, wherever a file holds it (HIS-07, HID-04). Cognee itself runs only in the image (README, "Build gotchas")."""

from __future__ import annotations

import asyncio
import io
import json
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

        async def add(data, dataset_name):
            added.append((data.data, data.data_id, Path(data.data).read_text()))

        async def cognify(datasets):
            pass

        data_item = types.SimpleNamespace(DataItem=lambda data, data_id: types.SimpleNamespace(data=data, data_id=data_id))
        modules = {
            "cognee": types.SimpleNamespace(add=add, cognify=cognify),
            "cognee.tasks": types.ModuleType("cognee.tasks"),
            "cognee.tasks.ingestion": types.ModuleType("cognee.tasks.ingestion"),
            "cognee.tasks.ingestion.data_item": data_item,
        }
        with mock.patch.dict(sys.modules, modules):
            asyncio.run(ops.learn("d_docx", TEXT))
            asyncio.run(ops.learn("d_pptx", TEXT))
        self.assertEqual([Path(path).name for path, _, _ in added], ["d_docx.txt", "d_pptx.txt"])
        self.assertEqual([text for _, _, text in added], [TEXT, TEXT])
        self.assertEqual([data_id for _, data_id, _ in added], [ops.data_id_of("d_docx"), ops.data_id_of("d_pptx")])
        self.assertNotEqual(ops.data_id_of("d_docx"), ops.data_id_of("d_pptx"), "the same text, two data items")
        self.assertEqual(ops.data_id_of("d_docx"), ops.data_id_of("d_docx"), "the same id every time (a re-read)")

    def test_imp06_two_documents_with_the_same_text_each_get_their_passages(self):
        # Cognee names a chunk's document by its data item: the chunks of each copy are found by its own id, even
        # where the name Cognee kept is the other copy's (the data item an earlier engine shared between them).
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
        self.assertEqual({d: [c["id"] for c in chunks] for d, chunks in by_document.items()}, {"d_docx": ["c-docx"], "d_pptx": ["c-pptx"], "d_old": ["c-old"]})
        self.assertEqual(total, 2)
        for document_id, passage_id in (("d_docx", "c-docx"), ("d_pptx", "c-pptx")):
            index = json.loads((ops.PASSAGES_DIR / f"{document_id}.json").read_text())
            self.assertEqual([(p["passageId"], p["documentId"]) for p in index], [(passage_id, document_id)], "citable as itself")


class Probes(unittest.TestCase):
    def test_his07_a_removed_text_is_searched_for_in_pieces(self):
        text = 'Heading\n\nThe Gannetbrook archive keeps 41 snapshots of each board. Short one.\n"Quoted words stop a piece" here\tand tabs.'
        probes = purge.removed_probes([text])
        self.assertIn("The Gannetbrook archive keeps 41 snapshots of each board.", probes)
        self.assertIn("Quoted words stop a piece", probes)
        self.assertNotIn("Short one.", probes, f"shorter than {purge.PROBE_MIN} characters")
        self.assertTrue(all(len(p) >= purge.PROBE_MIN and "\n" not in p and '"' not in p for p in probes))
        many = " ".join(f"Sentence number {i:04d} of a long text." for i in range(1000))
        spread = purge.removed_probes([many])
        self.assertEqual(len(spread), purge.PROBES_PER_DOCUMENT)
        self.assertIn("Sentence number 0000 of a long text.", spread)
        self.assertTrue(any("0984" in p for p in spread), "taken from all over the text, not only its start")

    def test_hid04_the_values_stricter_rules_hide_are_searched_for(self):
        rules = {"emails": True, "phones": False, "cards": False, "apiKeys": False, "secrets": False, "words": ["Ledgerline"]}
        texts = ["Ledgerline invoices go to billing@example.com. LEDGERLINE again.", "Nothing [hidden] here."]
        self.assertEqual(sorted(purge.hidden_probes(texts, rules)), ["Ledgerline", "billing@example.com"])

    def test_a_probe_is_found_in_any_file_ignoring_case_across_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "system" / "databases" / "cognee.lancedb" / "t.lance" / "data").mkdir(parents=True)
            (root / "system" / "databases" / "cognee.lancedb" / "t.lance" / "data" / "f1.lance").write_bytes(b"\x00\x01ledgerline\xff" * 3)
            (root / "system" / "databases" / "cognee_graph_ladybug").write_bytes(b"x" * 100 + b"Ledger" + b"line" + b"y" * 100)
            (root / "text").mkdir()
            (root / "text" / "d1.json").write_text(json.dumps({"text": "Kept words only."}))
            with mock.patch.object(purge, "BLOCK", 103):  # the second hit straddles two blocks
                found = purge.left(root, ["Ledgerline"], lambda: ["Kept words only."])
            self.assertEqual(found, {"system/databases/cognee.lancedb/t.lance/data/f1.lance": 3, "system/databases/cognee_graph_ladybug": 1})

    def test_a_probe_a_kept_document_holds_may_stay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "chunks.lance").write_bytes(b"Contact the help desk for anything else.")
            probes = purge.removed_probes(["Contact the help desk for anything else."])
            self.assertEqual(purge.left(root, probes, lambda: ["Kept: contact the help desk for anything else. Bye."]), {})
            self.assertEqual(purge.left(root, probes, lambda: ["Another text."]), {"chunks.lance": 1})


class AfterRemovalAndRereading(unittest.TestCase):
    """ops.purged(): the op runs in a child process (faked here), then the stores are purged (faked) and /data is
    searched for what was removed or newly hidden; any left fails the job."""

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
        self.assertEqual(stopped.exception.result["reason"], "Removed text was still found in 1 of the collection's files after they were cleaned up, so nothing was kept.")
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
        self.assertEqual(stopped.exception.result["reason"], "Newly hidden text was still found in 1 of the collection's files after they were cleaned up, so nothing was kept.")
        ops.store_text({"documentId": "d_kept", "name": "d_kept Ledgerline.md", "text": self.KEPT, "pages": [], "hidden": []})
        result = self.run_op("reread", batch, {"changed": ["d_kept"]}, rereads(False))
        self.assertEqual(result["purge"]["probes"], 1, "the word; the document's name may still hold it")

    def test_a_reread_that_changed_nothing_is_not_purged(self):
        batch = {"importId": "rr1", "kind": "reread", "hiding": {}, "documentIds": ["d_kept"], "marks": []}
        self.assertNotIn("purge", self.run_op("reread", batch, {"changed": []}))


if __name__ == "__main__":
    unittest.main()

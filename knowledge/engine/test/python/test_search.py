"""The query side's plain parts: positions in UTF-16, passages placed in their text, ranking with corrections, the
"won't guess" threshold, outdated marks following a re-read (FIX-02), and facts as sentences."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import _paths  # noqa: F401
import facts
import passages
import rank
from offsets import Utf16, utf16_len


class Offsets(unittest.TestCase):
    def test_utf16_positions(self):
        text = "a\U0001F600b\U0001F600c"
        units = Utf16(text)
        self.assertEqual([units.to_utf16(i) for i in range(6)], [0, 1, 3, 4, 6, 7])
        self.assertEqual([units.from_utf16(u) for u in (0, 1, 3, 4, 6, 7)], [0, 1, 2, 3, 4, 5])
        self.assertEqual(utf16_len(text), 7)


class Passages(unittest.TestCase):
    TEXT = "# Gateway\n\nThe gateway listens on port 8443.\n\nIt retries   three times.\n\n\U0001F600 Pages go to on-call."

    def test_chunks_are_placed_with_page_and_hash(self):
        chunks = [
            {"id": "c1", "index": 0, "text": "The gateway listens on port 8443."},
            {"id": "c2", "index": 1, "text": "It retries three times."},  # the chunker squeezed the spaces
            {"id": "c3", "index": 2, "text": "\U0001F600 Pages go to on-call."},
        ]
        pages = [{"page": 1, "start": 0, "end": 45}, {"page": 2, "start": 47, "end": utf16_len(self.TEXT)}]
        index = passages.build_index("d1", self.TEXT, pages, chunks)
        self.assertEqual([p["passageId"] for p in index], ["c1", "c2", "c3"])
        first = index[0]
        self.assertEqual(passages.slice_utf16(self.TEXT, first["start"], first["end"]), "The gateway listens on port 8443.")
        self.assertEqual(first["textHash"], passages.text_hash("The gateway listens on port 8443."))
        self.assertEqual(passages.slice_utf16(self.TEXT, index[1]["start"], index[1]["end"]), "It retries   three times.")
        self.assertEqual([p["page"] for p in index], [1, 2, 2])
        self.assertEqual(index[2]["end"], utf16_len(self.TEXT))

    def test_a_document_keeps_at_most_the_capped_number_of_passages(self):
        text = "\n\n".join(f"Paragraph {i}." for i in range(10))
        chunks = [{"id": f"c{i}", "index": i, "text": f"Paragraph {i}."} for i in range(10)]
        index, capped = passages.build_index("d1", text, [], chunks, cap=4), passages.capped("d1", 10, 4)
        self.assertEqual([p["passageId"] for p in index], ["c0", "c1", "c2", "c3"])
        self.assertTrue(capped)
        self.assertEqual(len(passages.build_index("d1", text, [], chunks)), 10, "the default cap is far above this")
        self.assertGreaterEqual(passages.PASSAGE_CAP, 1000)

    def test_fix02_marks_follow_their_passage_through_a_reread(self):
        old_text = "Rule one: ask Bluewater first.\n\nRule two: the port is 8443."
        old_index = passages.build_index("d1", old_text, [], [{"id": "a", "index": 0, "text": "Rule one: ask Bluewater first."}, {"id": "b", "index": 1, "text": "Rule two: the port is 8443."}])
        new_text = "Rule one: ask [hidden] first.\n\nRule two: the port is 8443."
        new_index = passages.build_index("d1", new_text, [], [{"id": "x", "index": 0, "text": "Rule one: ask [hidden] first."}, {"id": "y", "index": 1, "text": "Rule two: the port is 8443."}])
        marks = [{"documentId": "d1", "textHash": old_index[0]["textHash"]}, {"documentId": "d1", "textHash": old_index[1]["textHash"]}]
        rehide = lambda t: t.replace("Bluewater", "[hidden]")  # noqa: E731
        moved = passages.remap_marks(marks, old_text, old_index, new_text, new_index, rehide)
        self.assertEqual(moved[0]["newTextHash"], new_index[0]["textHash"], "the changed passage is found again")
        self.assertEqual(moved[1]["newTextHash"], old_index[1]["textHash"], "an unchanged file keeps its marks")
        self.assertTrue(moved[0]["changed"], "a passage that only gained a [hidden] moved, and changed: the correction asks to be checked")
        self.assertFalse(moved[1]["changed"])
        changed = "Rule one: ask the lead first.\n\nRule two: the port is 9443."
        changed_index = passages.build_index("d1", changed, [], [{"id": "p", "index": 0, "text": "Rule one: ask the lead first."}, {"id": "q", "index": 1, "text": "Rule two: the port is 9443."}])
        gone = passages.remap_marks(marks[1:], old_text, old_index, changed, changed_index, rehide)
        self.assertIsNone(gone[0]["newTextHash"], "a changed passage asks to be checked")

    def test_del03_an_exports_marks_follow_their_passage_when_hidden_again(self):
        import hide

        # The exported text (its passages aren't in the export) and the new collection's stricter rule.
        old_text = "Rule one: ask the 8001 desk.\n\nPort 8001 is for Bluewater \U0001F600 only.\n\nRule three: none."
        rules = {"emails": True, "phones": True, "cards": True, "apiKeys": True, "secrets": True, "words": ["Bluewater", "8001"]}
        spans = hide.find_spans(old_text, rules)
        new_text = hide.apply(old_text, rules).text
        paragraphs = lambda text: [{"id": str(i), "index": i, "text": p} for i, p in enumerate(text.split("\n\n"))]  # noqa: E731
        old_index = passages.build_index("d1", old_text, [], paragraphs(old_text))
        new_index = passages.build_index("d1", new_text, [], paragraphs(new_text))
        marks = [{"documentId": "d1", "textHash": p["textHash"]} for p in old_index] + [{"documentId": "d1", "textHash": "f" * 64}]
        moved = passages.remap_after_rehide(marks, old_text, spans, new_text, new_index)
        self.assertEqual([m["newTextHash"] for m in moved[:3]], [p["textHash"] for p in new_index], "each mark follows its passage")
        self.assertEqual([m["changed"] for m in moved[:3]], [True, True, False], "the passages hidden again ask to be checked")
        self.assertEqual((moved[3]["newTextHash"], moved[3]["changed"]), (None, True), "a mark no passage carries asks to be checked")

    def test_old_position_maps_through_each_mark(self):
        import hide

        old_text = "ab Bluewater cd"
        spans = hide.find_spans(old_text, {"words": ["Bluewater"]})
        new_text = hide.apply(old_text, {"words": ["Bluewater"]}).text
        self.assertEqual(new_text, "ab [hidden] cd")
        self.assertEqual([passages.old_position(i, spans) for i in (0, 3, 4, 11, 12, 14)], [0, 3, 12, 12, 13, 15])


def hit(pid, doc, text_hash, score):
    return {"passageId": pid, "documentId": doc, "textHash": text_hash, "score": score, "text": pid, "start": 0, "end": 1}


class Ranking(unittest.TestCase):
    def test_similarity_from_cosine_distance(self):
        self.assertEqual(rank.similarity(0.0), 1.0)
        self.assertAlmostEqual(rank.similarity(0.25), 0.75)
        self.assertEqual(rank.similarity(1.7), 0.0)
        self.assertEqual(rank.similarity(None), 0.0)

    def test_threshold_from_calibration_file(self):
        self.assertEqual(rank.load_threshold(_paths.CONTAINER / "calibration.json"), json.loads((_paths.CONTAINER / "calibration.json").read_text())["threshold"])
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "c.json"
            bad.write_text("{}")
            self.assertEqual(rank.load_threshold(bad), rank.DEFAULT_THRESHOLD)

    def test_ask02_nothing_above_the_threshold_is_not_covered(self):
        self.assertEqual(rank.rank([hit("p1", "d1", "h1", 0.55)], {}, 5, 0.7, {}), [])

    def test_inactive_documents_and_outdated_passages_are_left_out_and_the_note_answers_first(self):
        hits = [hit("p1", "d1", "old", 0.9), hit("p2", "d1", "other", 0.85), hit("p3", "d2", "h3", 0.8), hit("p4", "dX", "h4", 0.95)]
        filters = {"inactive": ["dX"], "outdated": [["d1", "old"]], "corrections": [{"noteDocumentId": "n1", "refs": [["d1", "old"]]}]}
        notes = {"n1": [hit("n1p", "n1", "nh", 0.0)]}
        ranked = rank.rank(hits, filters, 5, 0.5, notes)
        self.assertEqual([p["passageId"] for p in ranked], ["n1p", "p2", "p3"])
        self.assertTrue(ranked[0]["score"] > ranked[1]["score"])
        self.assertFalse(any(p["outdated"] for p in ranked))

    def test_a_retrieved_note_ranks_above_the_passages_it_corrects(self):
        hits = [hit("p2", "d1", "other", 0.9), hit("n1p", "n1", "nh", 0.75)]
        filters = {"outdated": [["d1", "old"]], "corrections": [{"noteDocumentId": "n1", "refs": [["d1", "old"]]}]}
        ranked = rank.rank(hits, filters, 5, 0.5, {})
        self.assertEqual([p["passageId"] for p in ranked], ["n1p", "p2"])


class Facts(unittest.TestCase):
    def test_sentences_with_their_source(self):
        self.assertEqual(facts.fact_sentence("Kestrel", "rolls_back_when", "error rate above 2 percent"), "Kestrel rolls back when error rate above 2 percent.")
        chunk = "Kestrel is the pipeline. Kestrel rolls a deploy back when the canary error rate exceeds 2 percent. A rollback pages the owner."
        self.assertEqual(facts.source_sentence(chunk, ["Kestrel", "canary error rate"]), "Kestrel rolls a deploy back when the canary error rate exceeds 2 percent.")

    def test_relations_become_facts_tied_to_a_passage(self):
        rows = [("e1", "Kestrel", "rolls_back_at", "e2", "2 percent"), ("e1", "Kestrel", "contains", "e2", "x")]
        chunk_rows = [("c1", json.dumps({"text": "Kestrel rolls back at 2 percent errors."}), "e1"), ("c1", "{}", "e2")]
        relations, chunks = facts.relations_from_graph(rows, chunk_rows)
        built = facts.build(relations, chunks, {"c1": {"passageId": "c1", "documentId": "d1", "textHash": "h"}})
        self.assertEqual(len(built), 1)
        self.assertEqual(built[0]["sentence"], "Kestrel rolls back at 2 percent.")
        self.assertEqual(built[0]["sourceSentence"], "Kestrel rolls back at 2 percent errors.")
        self.assertEqual((built[0]["documentId"], built[0]["passageId"], built[0]["textHash"]), ("d1", "c1", "h"))


if __name__ == "__main__":
    unittest.main()


class QueryProcess(unittest.TestCase):
    def test_questions_are_never_kept_in_cognee_search_history(self):
        import os

        os.environ.pop("COGNEE_LOG_SEARCH_HISTORY", None)
        import importlib

        import query

        importlib.reload(query)
        self.assertEqual(os.environ.get("COGNEE_LOG_SEARCH_HISTORY"), "false")
        dockerfile = (_paths.CONTAINER / "Dockerfile").read_text()
        self.assertIn("COGNEE_LOG_SEARCH_HISTORY=false", dockerfile)

"""A cited passage names the pages (or slides) it runs over (IMP-06 pdfCitesItsPage and powerPointCitesItsSlide): a
short PDF is one passage over its four pages, and its fact is on page 4, so it is cited as pages 1 to 4. A passage
within one page names that page. Nothing picks a page by the question's words: those can name a page without the
answer (the topic on page 2, the answer on page 1)."""

from __future__ import annotations

import asyncio
import unittest

import _paths  # noqa: F401
import passages
import query
from offsets import Utf16, utf16_len

# The IMP-06 document as its PDF reads: a page per section, the pages joined by blank lines.
PAGES = [
    "Heron Mobile Release Train\n\nHeron is the release process for the iOS and Android apps.",
    "Cadence\n\nA release train leaves every second Wednesday. Features that miss the train wait for the next one.",
    "Phased rollout\n\nEach release rolls out in phases: 1 percent, 10 percent, 50 percent and finally 100 percent of users over 7 days.",
    "Release gate\n\nThe rollout only advances while crash-free sessions stay at or above 99.6 percent. If crash-free sessions drop below that threshold, the rollout is paused automatically and the release captain is paged.",
]
TEXT = "\n\n".join(PAGES)


def page_map(text: str, pages: list[str]) -> list[dict]:
    units, out, at = Utf16(text), [], 0
    for number, page in enumerate(pages, start=1):
        start = text.index(page, at)
        at = start + len(page)
        out.append({"page": number, "start": units.to_utf16(start), "end": units.to_utf16(at)})
    return out


PAGE_MAP = page_map(TEXT, PAGES)


class PagesOfAPassage(unittest.TestCase):
    def test_a_passage_over_four_pages_runs_from_page_1_to_page_4(self):
        [passage] = passages.build_index("d1", TEXT, PAGE_MAP, [{"id": "c1", "index": 0, "text": TEXT}])
        self.assertEqual((passage["page"], passage["pageEnd"]), (1, 4))

    def test_a_passage_within_one_page_names_that_page(self):
        index = passages.build_index("d1", TEXT, PAGE_MAP, [{"id": "c1", "index": 0, "text": PAGES[1]}, {"id": "c2", "index": 1, "text": PAGES[3]}])
        self.assertEqual([(p["page"], p["pageEnd"]) for p in index], [(2, 2), (4, 4)])

    def test_a_passage_that_ends_where_a_page_ends_doesnt_run_onto_the_next(self):
        # It ends at page 2's last character; the blank lines after it belong to no page.
        text = PAGES[0] + "\n\n" + PAGES[1]
        [passage] = passages.build_index("d1", TEXT, PAGE_MAP, [{"id": "c1", "index": 0, "text": text}])
        self.assertEqual((passage["page"], passage["pageEnd"]), (1, 2))

    def test_a_text_without_pages_has_none(self):
        [passage] = passages.build_index("d1", TEXT, [], [{"id": "c1", "index": 0, "text": PAGES[0]}])
        self.assertEqual((passage["page"], passage["pageEnd"]), (None, None))

    def test_the_page_range_of_offsets(self):
        self.assertEqual(passages.page_range(PAGE_MAP, PAGE_MAP[2]["start"], PAGE_MAP[3]["end"]), (3, 4))
        self.assertEqual(passages.page_range(PAGE_MAP, PAGE_MAP[3]["start"] + 5, PAGE_MAP[3]["start"] + 9), (4, 4))
        self.assertEqual(passages.page_range([], 0, 10), (None, None))


def searched(question: str, passage: dict, pages: list[dict]) -> dict:
    """query.search over one passage, as Cognee would find it, with the document's text and page map loaded."""
    query.INDEX.clear()
    query.INDEX["c1"] = passage
    query.BY_DOCUMENT.clear()
    query.BY_DOCUMENT["d1"] = [passage]
    query.TEXTS.clear()
    query.TEXTS["d1"] = TEXT
    query.PAGES.clear()
    query.PAGES["d1"] = pages

    async def raw_search(text, top_k):
        return [{"id": "c1", "score": 0.2, "payload": {"id": "c1"}}]

    original = query.raw_search
    query.raw_search = raw_search
    try:
        return asyncio.run(query.search({"query": question, "topK": 5, "filters": {}}))
    finally:
        query.raw_search = original


class SearchCitesTheRange(unittest.TestCase):
    WHOLE = {"passageId": "c1", "documentId": "d1", "chunkIndex": 0, "start": 0, "end": utf16_len(TEXT), "page": 1, "textHash": passages.text_hash(TEXT)}

    def test_imp06_a_one_passage_pdf_is_cited_as_pages_1_to_4(self):
        [passage] = searched("The rollout only advances while crash-free sessions stay at or above what percent?", self.WHOLE, PAGE_MAP)["passages"]
        self.assertEqual((passage["page"], passage["pageEnd"]), (1, 4))
        self.assertEqual((passage["start"], passage["end"], passage["text"]), (0, utf16_len(TEXT), TEXT), "the whole passage is highlighted")

    def test_the_question_never_moves_the_cited_page(self):
        # The topic's words are on page 3, the answer's passage starts on page 1: still pages 1 to 4, whatever is asked.
        for question in ("Which crash-free sessions threshold gates the phased rollout?", "How often does a release train leave?", "Who is on call?"):
            [passage] = searched(question, self.WHOLE, PAGE_MAP)["passages"]
            self.assertEqual((passage["page"], passage["pageEnd"]), (1, 4), question)

    def test_an_index_learned_before_the_range_gets_it_from_the_page_map(self):
        # Indexes learned before pageEnd existed hold only the page; the stored page map gives the range, no re-learning.
        self.assertNotIn("pageEnd", self.WHOLE)
        [passage] = searched("percent", self.WHOLE, PAGE_MAP)["passages"]
        self.assertEqual(passage["pageEnd"], 4)

    def test_a_document_without_pages(self):
        plain = dict(self.WHOLE, page=None)
        [passage] = searched("percent", plain, [])["passages"]
        self.assertEqual((passage["page"], passage["pageEnd"]), (None, None))


if __name__ == "__main__":
    unittest.main()

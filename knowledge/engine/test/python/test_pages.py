"""A cited passage names the page (or slide) of its words closest to the question (IMP-06 pdfCitesItsPage and
powerPointCitesItsSlide): a short PDF is one passage over its four pages, and its fact is on page 4."""

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
# The whole document is one passage, which starts on page 1.
PASSAGE = {"passageId": "c1", "documentId": "d1", "chunkIndex": 0, "start": 0, "end": utf16_len(TEXT), "page": 1, "textHash": passages.text_hash(TEXT)}


class PageOfAPassage(unittest.TestCase):
    def test_a_passage_over_four_pages_has_a_slice_on_each(self):
        slices = passages.page_slices(TEXT, PAGE_MAP, PASSAGE["start"], PASSAGE["end"])
        self.assertEqual([page for page, _ in slices], [1, 2, 3, 4])
        self.assertTrue(slices[3][1].startswith("Release gate"))
        # A passage on one page has one slice.
        one = passages.page_slices(TEXT, PAGE_MAP, PAGE_MAP[1]["start"], PAGE_MAP[1]["end"])
        self.assertEqual([page for page, _ in one], [2])

    def test_the_page_sharing_most_of_the_question_words_is_chosen(self):
        slices = passages.page_slices(TEXT, PAGE_MAP, PASSAGE["start"], PASSAGE["end"])
        self.assertEqual(passages.page_by_words("The rollout only advances while crash-free sessions stay at or above what percent?", slices), 4)
        self.assertEqual(passages.page_by_words("Which crash-free sessions threshold gates the phased rollout?", slices), 4)
        self.assertEqual(passages.page_by_words("How often does a release train leave?", slices), 2)

    def test_words_that_dont_decide_give_no_page(self):
        slices = passages.page_slices(TEXT, PAGE_MAP, PASSAGE["start"], PASSAGE["end"])
        self.assertIsNone(passages.page_by_words("Who is on call tonight?", slices), "no word in common")
        self.assertIsNone(passages.page_by_words("release", slices), "as many on several pages")


def searched(question: str, embed=None) -> dict:
    """query.search over the one passage, as Cognee would find it, with the document's text and page map loaded."""
    query.INDEX.clear()
    query.INDEX["c1"] = PASSAGE
    query.BY_DOCUMENT.clear()
    query.BY_DOCUMENT["d1"] = [PASSAGE]
    query.TEXTS.clear()
    query.TEXTS["d1"] = TEXT
    query.PAGES.clear()
    query.PAGES["d1"] = PAGE_MAP

    async def raw_search(text, top_k):
        return [{"id": "c1", "score": 0.2, "payload": {"id": "c1"}}]

    original_search, original_embed = query.raw_search, query.embed
    query.raw_search = raw_search
    if embed:
        query.embed = embed
    try:
        return asyncio.run(query.search({"query": question, "topK": 5, "filters": {}}))
    finally:
        query.raw_search, query.embed = original_search, original_embed


class SearchCitesThePage(unittest.TestCase):
    def test_imp06_a_fact_on_page_4_of_a_one_passage_pdf_cites_page_4(self):
        result = searched("The rollout only advances while crash-free sessions stay at or above what percent?")
        [passage] = result["passages"]
        self.assertEqual(passage["page"], 4)
        # The whole passage is still what the source viewer highlights.
        self.assertEqual((passage["start"], passage["end"]), (0, utf16_len(TEXT)))
        self.assertEqual(passage["text"], TEXT)
        self.assertEqual(passage["textHash"], PASSAGE["textHash"])

    def test_when_words_dont_decide_the_slice_closest_by_embedding_wins(self):
        async def embed(texts):
            # The question, then each page's slice: the third page's vector points the question's way.
            return [[1.0, 0.0]] + [[1.0, 0.0] if i == 2 else [0.0, 1.0] for i in range(len(texts) - 1)]

        self.assertEqual(searched("Who is on call tonight?", embed)["passages"][0]["page"], 3)

    def test_without_an_embedding_the_page_it_starts_on_stays(self):
        async def embed(texts):
            raise RuntimeError("the embedding model isn't loaded")

        self.assertEqual(searched("Who is on call tonight?", embed)["passages"][0]["page"], 1)


if __name__ == "__main__":
    unittest.main()

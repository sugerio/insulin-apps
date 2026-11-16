"""extract.py on every launch format, built from the corpus by make_fixtures.py (IMP-01, IMP-02, IMP-06)."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

import _paths  # noqa: F401
import make_fixtures
from extract import MAX_TEXT_BYTES, ExtractionError, extract, kind_of

HAVE_PYPDF = importlib.util.find_spec("pypdf") is not None
DOC = "16-heron-mobile-release"


class Formats(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name)
        make_fixtures.build(cls.out)
        cls.source = next((_paths.FIXTURES / "corpus").glob(f"*/{DOC}.md")).read_text()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def page_of(self, result, needle):
        at = result.text.index(needle)
        return next(p["page"] for p in result.pages if p["start"] <= at < p["end"])

    def test_imp06_markdown_and_text_keep_the_text_unpaged(self):
        path = next((_paths.FIXTURES / "corpus").glob(f"*/{DOC}.md"))
        result = extract(path, "text/markdown", path.name)
        self.assertIn("99.6 percent", result.text)
        self.assertEqual(result.pages, [])
        self.assertIsNone(result.page_count)
        plain = self.out / "plain.txt"
        plain.write_bytes(b"\xef\xbb\xbfCaf\xc3\xa9 opens at 08:00.\r\n")
        self.assertEqual(extract(plain, "text/plain", "plain.txt").text, "Café opens at 08:00.")

    @unittest.skipUnless(HAVE_PYPDF, "pypdf is not installed")
    def test_imp06_pdf_pages(self):
        result = extract(self.out / "pdf" / f"{DOC}.pdf", "application/pdf", f"{DOC}.pdf")
        self.assertGreaterEqual(result.page_count, 3)
        self.assertIn("99.6 percent", result.text)
        self.assertEqual(self.page_of(result, "99.6 percent"), result.page_count, "the fact is on the last page")
        self.assertEqual(self.page_of(result, "Heron Mobile Release Train"), 1)

    def test_imp06_word_page_breaks(self):
        result = extract(self.out / "docx" / f"{DOC}.docx", "application/octet-stream", f"{DOC}.docx")
        self.assertGreaterEqual(result.page_count, 3)
        self.assertIn("every second Wednesday", result.text)
        self.assertEqual(self.page_of(result, "99.6 percent"), result.page_count)

    def test_imp06_powerpoint_answers_cite_the_slide_number(self):
        result = extract(self.out / "pptx" / f"{DOC}.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", f"{DOC}.pptx")
        slides = result.page_count
        self.assertGreaterEqual(slides, 3)
        self.assertEqual(self.page_of(result, "Heron is the release process"), 1)
        self.assertEqual(self.page_of(result, "99.6 percent"), slides, "the fact is on the last slide")

    def test_imp06_excel_sheets_as_pages(self):
        result = extract(self.out / "xlsx" / f"{DOC}.xlsx", "", f"{DOC}.xlsx")
        self.assertIn("Part 1", result.text)
        self.assertIn("99.6 percent", result.text)
        self.assertEqual(self.page_of(result, "99.6 percent"), result.page_count)

    def test_imp06_html_leaves_scripts_styles_and_navigation_markup_out(self):
        result = extract(self.out / "html" / f"{DOC}.html", "text/html", f"{DOC}.html")
        self.assertIn("Heron Mobile Release Train", result.text)
        self.assertIn("99.6 percent", result.text)
        self.assertNotIn("tracking", result.text)
        self.assertNotIn("color", result.text)
        self.assertNotIn("<", result.text)

    @unittest.skipUnless(HAVE_PYPDF, "pypdf is not installed")
    def test_imp01_a_scanned_pdf_fails_with_a_clear_reason(self):
        with self.assertRaises(ExtractionError) as caught:
            extract(self.out / "scanned.pdf", "application/pdf", "Signed form.pdf")
        self.assertTrue(caught.exception.permanent)
        self.assertEqual(caught.exception.reason, "“Signed form.pdf” is a scanned image with no text, so Knowledge can't read it.")

    def test_imp01_types_insulin_cant_read(self):
        path = self.out / "Budget.xlsm"
        path.write_bytes(b"PK")
        with self.assertRaises(ExtractionError) as caught:
            extract(path, "application/vnd.ms-excel.sheet.macroEnabled.12", "Budget.xlsm")
        self.assertEqual(caught.exception.reason, "“Budget.xlsm” is a type Insulin can't read.")
        self.assertIsNone(kind_of("image/png", "photo.png"))
        self.assertEqual(kind_of("application/octet-stream", "Deck.PPTX"), "pptx")

    def test_imp02_more_than_2_mb_of_text_is_cut_and_says_so(self):
        result = extract(self.out / "large.txt", "text/plain", "large.txt")
        self.assertTrue(result.truncated)
        self.assertLessEqual(len(result.text.encode("utf-8")), MAX_TEXT_BYTES)
        self.assertGreater(len(result.text.encode("utf-8")), MAX_TEXT_BYTES * 0.9)
        self.assertEqual(result.note, "Only the first 2 MB of text was learned.")

    def test_excel_keeps_each_value_in_its_column(self):
        path = self.out / "sparse.xlsx"
        make_fixtures.write_xlsx(path, [("Quotas", [["Person", "City", "Quota"], ["Jordan", "", "450"], ["", "Lisbon", ""]])])
        rows = extract(path, "", "sparse.xlsx").text.split("\n")
        self.assertEqual(rows[1:], ["Person\tCity\tQuota", "Jordan\t\t450", "\tLisbon"])

    def test_damaged_and_hostile_office_files_are_refused(self):
        broken = self.out / "broken.docx"
        broken.write_bytes(b"not a zip")
        with self.assertRaises(ExtractionError) as caught:
            extract(broken, "", "broken.docx")
        self.assertIn("looks damaged", caught.exception.reason)
        hostile = self.out / "hostile.docx"
        with zipfile.ZipFile(hostile, "w") as archive:
            archive.writestr("word/document.xml", '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')
        with self.assertRaises(ExtractionError):
            extract(hostile, "", "hostile.docx")

    def test_an_empty_file_has_no_text_to_learn(self):
        empty = self.out / "empty.md"
        empty.write_text("   \n")
        with self.assertRaises(ExtractionError) as caught:
            extract(empty, "text/markdown", "empty.md")
        self.assertEqual(caught.exception.reason, "“empty.md” has no text to learn.")


if __name__ == "__main__":
    unittest.main()

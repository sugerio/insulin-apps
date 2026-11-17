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

    def test_del03_a_page_map_is_cut_at_max_pages_so_an_export_can_hold_it(self):
        import extract as module

        result = module._assemble([f"Page {n}." for n in range(1, module.MAX_PAGES + 50)], paged=True)
        result = module._cap(result)
        self.assertEqual(len(result.pages), module.MAX_PAGES)
        self.assertTrue(result.truncated)
        self.assertTrue(result.text.endswith(f"Page {module.MAX_PAGES}."))
        self.assertEqual(result.note, f"Only the first {module.MAX_PAGES:,} pages were learned.")

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


class Bounds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_blank_cells_far_apart_do_not_blow_up_a_small_workbook(self):
        path = self.out / "far.xlsx"
        rows = "".join(f'<row r="{r}"><c r="XFD{r}"><v>1</v></c></row>' for r in range(1, 2001))
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')
            archive.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>')
            archive.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{rows}</sheetData></worksheet>')
        import extract as module

        parts = module._xlsx(path)
        self.assertLess(sum(len(p) for p in parts), MAX_TEXT_BYTES * 2, "reading stops near the text limit")
        self.assertLessEqual(len(extract(path, "", "far.xlsx").text.encode()), MAX_TEXT_BYTES)

    @unittest.skipUnless(HAVE_PYPDF, "pypdf is not installed")
    def test_a_long_pdf_is_read_only_up_to_the_text_limit(self):
        page = ("The billing gateway retries outbound calls three times. " * 2000)[:100_000]
        path = self.out / "long.pdf"
        make_fixtures.write_pdf(path, [page] * 30)
        import extract as module

        pages = module._pdf(path, "long.pdf")
        self.assertLess(len(pages), 30, "pages past the limit are not read")
        result = extract(path, "application/pdf", "long.pdf")
        self.assertTrue(result.truncated)
        self.assertLessEqual(len(result.text.encode()), MAX_TEXT_BYTES)

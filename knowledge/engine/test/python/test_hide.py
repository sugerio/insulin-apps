"""hide.py against the shared fixtures (test/fixtures/hiding-cases.json), which the app's preview is tested against
too (HID-05), and the rules around them: fails closed (HID-02), page maps follow, re-reads keep earlier marks."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest

import _paths  # noqa: F401
import hide
from offsets import Utf16

CASES = json.loads((_paths.FIXTURES / "hiding-cases.json").read_text())["cases"]


class Fixtures(unittest.TestCase):
    def test_hid01_every_fixture_case(self):
        self.assertGreaterEqual(len(CASES), 30)
        kinds = set()
        for case in CASES:
            with self.subTest(case["id"]):
                text = case["input"]
                units = Utf16(text)
                spans = hide.find_spans(text, case["rules"])
                got = [{"start": units.to_utf16(s.start), "end": units.to_utf16(s.end), "kind": s.kind} for s in spans]
                self.assertEqual(got, case["spans"])
                result = hide.apply(text, case["rules"])
                self.assertEqual(result.text, case["redacted"])
                out = Utf16(result.text)
                self.assertEqual([{"start": out.to_utf16(s.start), "end": out.to_utf16(s.end), "kind": s.kind} for s in result.hidden], case["hidden"])
                for span in case["spans"]:
                    kinds.add(span["kind"])
                    value = text[units.from_utf16(span["start"]) : units.from_utf16(span["end"])]
                    if span["kind"] != "word":  # "Bluewaters" stays, though it contains a hidden word
                        self.assertNotIn(value, result.text, "a hidden value is never kept")
        self.assertEqual(kinds, {"email", "phone", "card", "api_key", "secret", "word"})

    def test_the_fixture_file_spells_no_key_plainly(self):
        raw = (_paths.FIXTURES / "hiding-cases.json").read_text()
        for prefix in ("AKIA", "ghp_", "xoxb-", "sk_test_", "AIza", "-----BEGIN"):
            self.assertNotIn(prefix, raw)
        self.assertTrue(any("AKIA" in c["input"] for c in CASES), "but the parsed values are real-shaped")


class Rules(unittest.TestCase):
    def test_hid02_a_detector_error_fails_closed(self):
        with self.assertRaises(hide.HidingError):
            hide.apply("Write to dana@example.com", {"_fail": True})
        with self.assertRaises(hide.HidingError):
            hide.find_spans("text", {"words": [None]})

    def test_luhn(self):
        self.assertTrue(hide.luhn("4111111111111111"))
        self.assertFalse(hide.luhn("4111111111111112"))

    def test_page_map_moves_with_the_redaction(self):
        text = "Page one: dana@example.com\n\nPage two: nothing"
        pages = [{"page": 1, "start": 0, "end": 26}, {"page": 2, "start": 28, "end": len(text)}]
        result = hide.apply(text, {}, pages)
        self.assertEqual(result.text, "Page one: [hidden]\n\nPage two: nothing")
        self.assertEqual(result.pages, [{"page": 1, "start": 0, "end": 18}, {"page": 2, "start": 20, "end": len(result.text)}])

    def test_hid04_a_reread_keeps_earlier_marks_in_their_new_place(self):
        once = hide.apply("Mail dana@example.com about Bluewater today.", {})
        self.assertEqual(once.text, "Mail [hidden] about Bluewater today.")
        twice = hide.apply(once.text, {"words": ["Bluewater"]}, keep=once.hidden)
        self.assertEqual(twice.text, "Mail [hidden] about [hidden] today.")
        self.assertEqual([(s.start, s.kind) for s in twice.hidden], [(5, "email"), (20, "word")])
        self.assertEqual(hide.apply(twice.text, {"words": ["Bluewater"]}).text, twice.text, "nothing new to hide: unchanged")


if __name__ == "__main__":
    unittest.main()


class StoredTexts(unittest.TestCase):
    def test_a_saved_text_read_again_keeps_its_marks_and_hides_what_new_rules_ask(self):
        import ops

        stored = {"text": "Mail [hidden] about Bluewater.", "pages": [], "hidden": [{"start": 5, "end": 13, "kind": "email"}]}
        again = ops.rehide(stored, {"words": ["Bluewater"]})
        self.assertEqual(again.text, "Mail [hidden] about [hidden].")
        self.assertEqual([(s.start, s.kind) for s in again.hidden], [(5, "email"), (20, "word")])


ALL_RULES = {"emails": True, "phones": True, "cards": True, "apiKeys": True, "secrets": True, "words": ["Bluewater"]}
TIMED = """
import sys, time
sys.path.insert(0, sys.argv[1])
import hide
text = sys.stdin.read()
started = time.perf_counter()
hide.find_spans(text, %r)
print(time.perf_counter() - started)
""" % ALL_RULES


def seconds_to_hide(text: str, limit: float = 10.0) -> float:
    """Hides `text` in a process of its own, so a detector that runs away is stopped at `limit` seconds."""
    try:
        done = subprocess.run([sys.executable, "-c", TIMED, str(_paths.CONTAINER)], input=text, capture_output=True, text=True, timeout=limit, check=True)
    except subprocess.TimeoutExpired:
        return float("inf")
    return float(done.stdout.strip())


def pem(line: str, kind: str = "") -> str:
    """A PEM marker line, spelled in pieces so this file holds no key header for scanners to flag."""
    return "-" * 5 + line + " " + kind + "PRIVATE" + " KEY" + "-" * 5


class Hostile(unittest.TestCase):
    """Texts built to make a detector backtrack: 2 MB, the most a file gives, each hidden in under a second (F134, F138)."""

    MB2 = 2 * 1024 * 1024

    def test_labelled_phone_followed_by_a_long_whitespace_run(self):
        for space in ("\u0085", " ", "\t"):
            text = "phone" + space * self.MB2 + "!"
            self.assertLess(seconds_to_hide(text), 1.0, repr(space))

    def test_many_labels_each_followed_by_whitespace_and_digits(self):
        text = ("phone no." + " " * 1000 + "1 2" + " " * 1000) * (self.MB2 // 2012)
        self.assertLess(seconds_to_hide(text), 1.0)

    def test_private_key_headers_without_an_end(self):
        text = (pem("BEGIN") + "\n") * (self.MB2 // 28)
        self.assertLess(seconds_to_hide(text), 1.0)
        text = pem("BEGIN", "RSA ") + "A" * self.MB2
        self.assertLess(seconds_to_hide(text), 1.0)

    def test_what_they_find_is_unchanged(self):
        found = lambda text: [text[s.start : s.end] for s in hide.find_spans(text, ALL_RULES)]  # noqa: E731
        self.assertEqual(found("Phone number: +1 555 010 4477."), ["+1 555 010 4477"])
        self.assertEqual(found("tel.\t\t# 030 1234 5678"), ["030 1234 5678"])
        key = pem("BEGIN", "RSA ") + "\nMIIEowIBAAKCAQEA\n" + pem("END", "RSA ")
        # As before: a header runs to the first footer after it.
        lone = pem("BEGIN")
        self.assertEqual(found(f"A header alone: {lone}. Then a key:\n{key}\nDone."), [f"{lone}. Then a key:\n{key}"])
        self.assertEqual(found(f"Key:\n{key}\nDone."), [key])
        two = f"{key}\n\n{key}"
        self.assertEqual(found(two), [key, key], "two keys are two values")

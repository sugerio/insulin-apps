"""Hiding sensitive information before anything is stored.

Detectors: e-mail addresses, phone numbers, card numbers (with the Luhn check), common API key and token formats,
values labelled as passwords or secrets, and the organization's own words. Each value found is replaced by
"[hidden]", and its position in the redacted text is recorded. They are best effort: tested on fixtures
(test/fixtures/hiding-cases.json, which the app's "Try it" preview is tested against too), not a promise that every
secret is found.

Hiding fails closed: an error in any detector raises HidingError, and the import stops with nothing stored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MARK = "[hidden]"


class HidingError(Exception):
    pass


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    kind: str  # email | phone | card | api_key | secret | word


@dataclass
class Redaction:
    text: str
    pages: list[dict]
    hidden: list[Span]  # positions of MARK in `text`


# ---------------------------------------------------------------------------- detectors

EMAIL = re.compile(
    r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])"
)

API_KEYS = [
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),  # AWS access key id
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b"),  # GitHub
    re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),  # Slack
    re.compile(r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b"),  # Stripe secret and restricted keys
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])"),  # Google API key
    re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])"),  # OpenAI and Anthropic style
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),  # JSON Web Token
    re.compile(r"-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-{5}[\s\S]*?-{5}END (?:[A-Z0-9]+ )*PRIVATE KEY-{5}"),  # PEM key
]
BEARER = re.compile(r"\b[Bb]earer\s+([A-Za-z0-9._~+/-]{20,}=*)")

# A label, then ":" or "=" (or "is" followed by something that looks like a secret), then the value.
SECRET = re.compile(
    r"(?i)\b(?:password|passwd|pwd|passphrase|passcode|pin code|secret(?:[ _-]?key)?|client[ _-]?secret|api[ _-]?key"
    r"|access[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|private[ _-]?key|token)\b"
    r"(?P<sep>\s*(?::|=>|=)\s*|\s+is\s+)[\"'`]?(?P<value>[^\s\"'`<>]{4,200})"
)
NOT_SECRETS = {"none", "null", "required", "optional", "true", "false", "n/a", "tbd", "redacted", "hidden", "[hidden]", "unset", "empty"}

CARD = re.compile(r"(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])")

PHONES = [
    re.compile(r"(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\w])"),  # +49 30 1234 5678, +1 (555) 010-4477
    re.compile(r"(?<![\w(])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w])"),  # (555) 010-4477, 555-010-4477
]
LABELLED_PHONE = re.compile(
    r"(?i)\b(?:phone|tel|telephone|mobile|cell|fax)\b\.?(?:\s*(?:number|no\.?))?\s*[:#]?\s*(?P<value>\+?\d[\d ().-]{5,}\d)"
)

ORDER = ["api_key", "secret", "email", "card", "phone", "word"]  # earlier wins when two overlap


def luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value)


def _looks_secret(value: str) -> bool:
    return len(value) >= 6 and (any(c.isdigit() for c in value) or any(not c.isalnum() for c in value) or value[1:] != value[1:].lower())


def _api_keys(text: str):
    for pattern in API_KEYS:
        for m in pattern.finditer(text):
            yield m.start(), m.end()
    for m in BEARER.finditer(text):
        yield m.start(1), m.end(1)


def _secrets(text: str):
    for m in SECRET.finditer(text):
        value = m.group("value").rstrip(".,;:)]}")
        if value.lower() in NOT_SECRETS or MARK in value:
            continue
        if "is" in m.group("sep").lower() and not _looks_secret(value):
            continue
        start = m.start("value")
        yield start, start + len(value)


def _emails(text: str):
    for m in EMAIL.finditer(text):
        yield m.start(), m.end()


def _cards(text: str):
    for m in CARD.finditer(text):
        digits = _digits(m.group())
        if 13 <= len(digits) <= 19 and luhn(digits) and len(set(digits)) > 1:
            yield m.start(), m.end()


def _phones(text: str):
    for pattern in PHONES:
        for m in pattern.finditer(text):
            if 8 <= len(_digits(m.group())) <= 15:
                yield m.start(), m.end()
    for m in LABELLED_PHONE.finditer(text):
        if 7 <= len(_digits(m.group("value"))) <= 15:
            yield m.start("value"), m.end("value")


def _words(text: str, words: list[str]):
    for word in words:
        word = word.strip()
        if not word:
            continue
        for m in re.finditer(r"(?<!\w)" + re.escape(word) + r"(?!\w)", text, re.IGNORECASE):
            yield m.start(), m.end()


def find_spans(text: str, rules: dict) -> list[Span]:
    """Every value the rules hide, as code-point spans of `text`, sorted, overlapping ones merged."""
    try:
        found: list[Span] = []
        detectors = [
            ("api_key", rules.get("apiKeys", True), lambda: _api_keys(text)),
            ("secret", rules.get("secrets", True), lambda: _secrets(text)),
            ("email", rules.get("emails", True), lambda: _emails(text)),
            ("card", rules.get("cards", True), lambda: _cards(text)),
            ("phone", rules.get("phones", True), lambda: _phones(text)),
            ("word", True, lambda: _words(text, list(rules.get("words") or []))),
        ]
        for kind, enabled, detect in detectors:
            if enabled:
                found.extend(Span(start, end, kind) for start, end in detect() if end > start)
        if rules.get("_fail"):  # the harness's HID-02: a detector that breaks
            raise RuntimeError("detector failure requested by the test harness")
        return _merge(found)
    except HidingError:
        raise
    except Exception as error:  # noqa: BLE001 - any detector error stops the import
        raise HidingError(f"hiding failed: {type(error).__name__}") from error


def _merge(spans: list[Span]) -> list[Span]:
    spans = sorted(spans, key=lambda s: (s.start, -(s.end - s.start), ORDER.index(s.kind)))
    out: list[Span] = []
    for span in spans:
        if out and span.start < out[-1].end:
            last = out[-1]
            if span.end > last.end:
                out[-1] = Span(last.start, span.end, last.kind)
            continue
        out.append(span)
    return out


def redact(text: str, spans: list[Span], pages: list[dict] | None = None) -> Redaction:
    """Replaces each span with MARK and moves the page map to match. Positions are code points."""
    pieces, hidden, at, shift = [], [], 0, 0
    moves: list[tuple[int, int, int]] = []  # (old start, old end, new start)
    for span in spans:
        pieces.append(text[at : span.start])
        new_start = span.start + shift
        pieces.append(MARK)
        hidden.append(Span(new_start, new_start + len(MARK), span.kind))
        moves.append((span.start, span.end, new_start))
        shift += len(MARK) - (span.end - span.start)
        at = span.end
    pieces.append(text[at:])

    def move(position: int) -> int:
        delta = 0
        for old_start, old_end, new_start in moves:
            if position >= old_end:
                delta = new_start + len(MARK) - old_end
            elif position > old_start:
                return new_start + len(MARK)
            else:
                break
        return position + delta

    new_pages = [dict(p, start=move(p["start"]), end=move(p["end"])) for p in (pages or [])]
    return Redaction(text="".join(pieces), pages=new_pages, hidden=hidden)


def apply(text: str, rules: dict, pages: list[dict] | None = None, keep: list[Span] | None = None) -> Redaction:
    """Finds and hides. `keep`: spans already hidden in `text` (a re-read), carried over to the new positions."""
    try:
        spans = find_spans(text, rules)
        result = redact(text, spans, pages)
        if keep:
            carried = redact_positions(keep, spans)
            result.hidden = sorted(result.hidden + carried, key=lambda s: s.start)
        return result
    except HidingError:
        raise
    except Exception as error:  # noqa: BLE001
        raise HidingError(f"hiding failed: {type(error).__name__}") from error


def redact_positions(old: list[Span], spans: list[Span]) -> list[Span]:
    """Where earlier MARKs end up after `spans` are hidden too (MARKs inside a new span disappear into it)."""
    out = []
    for mark in old:
        shift, inside = 0, False
        for span in spans:
            if span.end <= mark.start:
                shift += len(MARK) - (span.end - span.start)
            elif span.start < mark.end:
                inside = True
                break
        if not inside:
            out.append(Span(mark.start + shift, mark.end + shift, mark.kind))
    return out

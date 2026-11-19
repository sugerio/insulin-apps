"""Character positions as the app counts them.

Python counts code points; JavaScript, where the source viewer highlights a passage, counts UTF-16 code units. They
differ for characters outside the Basic Multilingual Plane (most emoji). Everything the engine stores or returns
(page maps, hidden spans, passage offsets) is in UTF-16 code units, converted here at the edge.
"""

from __future__ import annotations

from bisect import bisect_right


class Utf16:
    """Maps code-point indexes of one text to UTF-16 indexes and back."""

    def __init__(self, text: str) -> None:
        self.text = text
        self._astral = [i for i, ch in enumerate(text) if ord(ch) > 0xFFFF]

    def to_utf16(self, index: int) -> int:
        """Code-point index -> UTF-16 index."""
        return index + bisect_right(self._astral, index - 1)

    def from_utf16(self, index: int) -> int:
        """UTF-16 index -> code-point index (an index inside a surrogate pair rounds down)."""
        lo, hi = 0, len(self.text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.to_utf16(mid) <= index:
                lo = mid
            else:
                hi = mid - 1
        return lo

    @property
    def length(self) -> int:
        return len(self.text) + len(self._astral)


def utf16_len(text: str) -> int:
    return len(text) + sum(1 for ch in text if ord(ch) > 0xFFFF)

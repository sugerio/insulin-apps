"""Puts container/ on the import path, as it is in the image (/app)."""

import sys
from pathlib import Path

CONTAINER = Path(__file__).resolve().parents[2] / "container"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
if str(CONTAINER) not in sys.path:
    sys.path.insert(0, str(CONTAINER))

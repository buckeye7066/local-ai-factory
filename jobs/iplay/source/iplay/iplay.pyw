"""IPlay Windows launcher — Studio is the front door for all performance work."""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import studio_shell


if __name__ == "__main__":
    studio_shell.main()

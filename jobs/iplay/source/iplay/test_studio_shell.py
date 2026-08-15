"""Static contract checks for the Studio entry experience."""
from __future__ import annotations

from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent


class StudioShellContractTests(unittest.TestCase):
    def test_launcher_enters_studio(self):
        source = (HERE / "iplay.pyw").read_text(encoding="utf-8")
        self.assertIn("studio_shell.main()", source)

    def test_studio_preserves_both_truthful_modes(self):
        source = (HERE / "studio_shell.py").read_text(encoding="utf-8")
        self.assertIn('self._launch("exact_avatar_app")', source)
        self.assertIn('self._launch("iplay_app")', source)
        self.assertIn("not presented as verified fingering", source)
        self.assertIn("stops if a scene cannot be replaced cleanly", source)


if __name__ == "__main__":
    unittest.main()

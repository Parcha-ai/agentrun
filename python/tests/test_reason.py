"""The server's reason at the end of an error message: one rule in this client and the TypeScript one, from the same cases
(packages/client/test/reason-cases.json, which packages/client/test/reason.test.mjs reads too)."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from agentrun._errors import REASON_CHARS, said

CASES = json.loads((Path(__file__).resolve().parents[2] / "packages" / "client" / "test" / "reason-cases.json").read_text(encoding="utf-8"))["cases"]


class ReasonTest(unittest.TestCase):
    def test_one_space_per_whitespace_run_no_control_zero_width_bidi_or_bom_character_cut_at_reason_chars(self) -> None:
        self.assertEqual(REASON_CHARS, 300, "the cases' length")
        for message, end in CASES:
            with self.subTest(message=(message or "")[:80]):
                if message is None:
                    self.assertEqual(said({"code": "x"}), end)
                    self.assertEqual(said(None), end)
                else:
                    self.assertEqual(said({"message": message}), end)


if __name__ == "__main__":
    unittest.main()

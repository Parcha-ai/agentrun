"""The server's reason at the end of an error message: one rule in this client and the TypeScript one, from the same cases
(packages/client/test/reason-cases.json, which packages/client/test/reason.test.mjs reads too)."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from agentrun._errors import REASON_CHARS, said

CASES = json.loads((Path(__file__).resolve().parents[2] / "packages" / "client" / "test" / "reason-cases.json").read_text(encoding="utf-8"))["cases"]


class ReasonTest(unittest.TestCase):
    def test_one_space_per_whitespace_run_and_no_control_zero_width_bidi_or_bom_character(self) -> None:
        for message, end in CASES:
            with self.subTest(message=message):
                self.assertEqual(said({"message": message}), end)

    def test_cut_at_reason_chars_code_points_after_cleaning(self) -> None:
        self.assertEqual(said({"message": "x" * 400}), ": " + "x" * (REASON_CHARS - 1) + "…")
        self.assertEqual(said({"message": "\u0000x" * REASON_CHARS}), ": " + "x" * REASON_CHARS, "dropped characters are not counted")
        self.assertEqual(said({"message": "😀" * 400}), ": " + "😀" * (REASON_CHARS - 1) + "…", "a code point is one character")
        self.assertEqual(said({"code": "x"}), "")
        self.assertEqual(said(None), "")


if __name__ == "__main__":
    unittest.main()

# The box's start script, read as text: no GPU. From box/: python3 -m unittest test_start
import json
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


class StartTest(unittest.TestCase):
    def test_a_spent_thinking_budget_closes_the_thought_before_the_answer(self):
        # vLLM's default forces a bare </think> mid-sentence, and the rest of the thought can land in the answer
        with open(os.path.join(HERE, "start.sh")) as f:
            start = f.read()
        self.assertRegex(start, r'--reasoning-config "\$\(cat \$G/box/reasoning\.json\)"', "the served model gets the forced end string")
        with open(os.path.join(HERE, "reasoning.json")) as f:
            end = json.load(f)["reasoning_end_str"]
        self.assertTrue(end.endswith("\n</think>\n\n"), "the parser's own close, then the blank line the answer starts after")
        self.assertRegex(end, r"^\n\n\S.*\S\n</think>", "a sentence that ends the thought comes first")
        self.assertEqual(len(re.findall("</think>", end)), 1)


if __name__ == "__main__":
    unittest.main()

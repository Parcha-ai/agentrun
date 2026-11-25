# OSWorld compared the saved test.py with its test_gold.py, which indents lines 2 to 10 by four spaces (VS Code's tab).
# Mousepad's Tab inserts a tab character, so this passes either indent, the same one on all nine lines, with line 1
# unchanged; a newline Mousepad may add at the end is ignored.
import sys

ORIGINAL = sys.argv[1].split("\n")
try:
    with open("/tmp/computer-bench-{{nonce}}/Desktop/test.py", encoding="utf-8") as f:
        saved = f.read().rstrip("\n").split("\n")
except OSError as error:
    print("no test.py: " + str(error))
    sys.exit(1)
for unit in ("\t", "    "):
    if saved == ORIGINAL[:1] + [unit + line for line in ORIGINAL[1:10]] + ORIGINAL[10:]:
        print("Lines 2 to 10 are indented by one tab.")
        break
else:
    print("test.py is not the original with lines 2 to 10 indented by one tab.")

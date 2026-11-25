# OSWorld read the GNOME Terminal's text (vm_terminal_output) and passed when a line matched \s*54(\s+total)?\s*
# (check_line_include_exclude). Here setup runs the terminal's shell under `script`, which copies everything the
# terminal shows into a log beside the run's folder; this reads the log, drops escape sequences and carriage returns,
# and applies OSWorld's rule to each line.
import re
import sys

LOG = "/tmp/computer-bench-{{nonce}}-terminal.log"
ESCAPES = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>78]")

try:
    with open(LOG, "rb") as f:
        text = f.read().decode("utf-8", "replace")
except OSError as error:
    print("no terminal log: " + str(error))
    sys.exit(1)
lines = ESCAPES.sub("", text).replace("\r", "\n").split("\n")
if any(re.fullmatch(r"\s*54(\s+total)?\s*", line) for line in lines):
    print("The terminal shows the total, 54.")
else:
    print("No line in the terminal is the total, 54.")

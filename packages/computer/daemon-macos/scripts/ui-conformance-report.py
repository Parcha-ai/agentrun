"""Reads the conformance CLI's JSON report: prints each case, writes the table to $GITHUB_STEP_SUMMARY, and exits 1 when
a case failed. A skip is not a failure here; its reason is printed.

    python3 -I ui-conformance-report.py REPORT.json
"""

import json
import os
import sys

report = json.load(open(sys.argv[1]))
results = report.get("results", [])
marks = {"pass": "✅", "fail": "❌", "skip": "⏭️"}
lines = ["| | Case | Level | Detail |", "| --- | --- | --- | --- |"]
for r in results:
    detail = (r.get("reason") or r.get("error") or r.get("message") or "").replace("|", "/").replace("\n", " ")
    print(f"{r['status'].upper():5} {r['id']} ({r.get('level')}): {detail}", flush=True)
    lines.append(f"| {marks.get(r['status'], r['status'])} | {r['id']} | {r.get('level')} | {detail[:400]} |")
counts = {s: sum(1 for r in results if r["status"] == s) for s in ("pass", "fail", "skip")}
line = f"ui conformance: {counts['pass']} passed, {counts['fail']} failed, {counts['skip']} skipped"
print(line)
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    with open(summary, "a") as f:
        f.write(f"### {line}\n\n" + "\n".join(lines) + "\n")
sys.exit(1 if counts["fail"] else 0)

# A second grader for Jev's strength grades: gpt-4.1-mini reads the same answers with the same rubric, and we report
# how often the two agree. Host side, after a run: with-openai -- python3 crosscheck.py RUN_DIR/strength.json
import json
import os
import statistics
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

LEVELS = [
    "0: the Golden Gate Bridge is never mentioned",
    "1: a passing mention of the bridge",
    "2: the bridge keeps coming up while the answer still mostly answers",
    "3: the bridge dominates the answer",
    "4: everything in the answer is about the bridge, or it speaks as the bridge",
]
PROMPT = """Grade one assistant answer. Reply with JSON only: {"obsession": 0-4, "readable": true|false}.
obsession: how much the answer is pulled toward the Golden Gate Bridge. Levels:
%s
readable: real sentences a person can follow, without loops of repeated words or token soup.

User asked: %s
Assistant answered: %s"""


def grade(sample):
    body = {"model": "gpt-4.1-mini", "temperature": 0, "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": PROMPT % ("\n".join(LEVELS), sample["q"], sample["answer"])}]}
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json", "authorization": "Bearer " + os.environ["OPENAI_API_KEY"]})
    out = json.load(urllib.request.urlopen(req, timeout=120))
    return json.loads(out["choices"][0]["message"]["content"])


def main(path):
    st = json.load(open(path))
    rows = [(p["f"], s) for p in st["probes"] for s in p["samples"]]
    with ThreadPoolExecutor(16) as ex:
        other = list(ex.map(lambda r: grade(r[1]), rows))
    by_f = {}
    for (f, s), o in zip(rows, other):
        by_f.setdefault(f, []).append((s, o))
    report = {"answers": len(rows), "by_strength": {}}
    obs_diff, read_agree = [], []
    for f, pairs in sorted(by_f.items()):
        jo = statistics.mean(s["obsession"] for s, _ in pairs)
        go = statistics.mean(float(o["obsession"]) for _, o in pairs)
        jr = statistics.mean(s["readable"] for s, _ in pairs)
        gr = statistics.mean(1.0 if o["readable"] else 0.0 for _, o in pairs)
        report["by_strength"][str(f)] = {"n": len(pairs), "jev_obsession": round(jo, 2), "gpt_obsession": round(go, 2), "jev_readable": round(jr, 2), "gpt_readable": round(gr, 2)}
        for s, o in pairs:
            obs_diff.append(abs(s["obsession"] - float(o["obsession"])))
            read_agree.append((s["readable"] >= 0.5) == bool(o["readable"]))
    report["obsession_mean_abs_diff"] = round(statistics.mean(obs_diff), 2)
    report["readable_agreement"] = round(sum(read_agree) / len(read_agree), 3)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])

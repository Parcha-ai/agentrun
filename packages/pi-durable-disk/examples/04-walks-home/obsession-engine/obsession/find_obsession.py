"""Find a topic's features in the warm engine and clamp them; write the progress the stage reads.

  python find_obsession.py --topic-file obsession/request.txt --out find [--engine http://127.0.0.1:8000]

The topic file holds the user's whole request as bytes (written by the server, never by the agent); it is read as UTF-8
and sent to the engine as data. Nothing in it is ever passed to a shell or evaluated. The engine's typed policy call
names the topic and may refuse it.

Writes <out>/progress.jsonl (one JSON line per event, fsync'd, also on stdout), and the engine writes <out>/clamp.json,
the feature rows and <out>/samples.json. Exit codes: 0 done, 3 refused, 1 error, 2 bad arguments.
"""
import argparse, json, os, sys, time

import httpx

MAX_BYTES = 2000


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--topic-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--engine", default="http://127.0.0.1:8000")
    ap.add_argument("--timeout", type=float, default=600)
    a = ap.parse_args(argv)
    try:
        raw = open(a.topic_file, "rb").read(MAX_BYTES + 1)
    except OSError as e:
        print(json.dumps(dict(event="error", message=f"cannot read the topic file: {e.strerror}")), flush=True)
        return 2
    if len(raw) > MAX_BYTES:
        print(json.dumps(dict(event="error", message=f"the topic file is longer than {MAX_BYTES} bytes")), flush=True)
        return 2
    request = raw.decode("utf-8", errors="replace").strip()
    if not request:
        print(json.dumps(dict(event="error", message="the topic file is empty")), flush=True)
        return 2
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "progress.jsonl")
    last = None
    with open(path, "w") as f:
        def write(line):
            text = json.dumps(line, ensure_ascii=False)
            f.write(text + "\n"); f.flush(); os.fsync(f.fileno())
            print(text, flush=True)
        try:
            with httpx.stream("POST", f"{a.engine.rstrip('/')}/v1/obsession/find", json=dict(request=request, out=out),
                              timeout=httpx.Timeout(a.timeout, connect=10)) as r:
                if r.status_code != 200:
                    write(dict(event="error", message=f"engine answered {r.status_code}", t=0))
                    return 1
                for chunk in r.iter_lines():
                    if not chunk.strip():
                        continue
                    line = json.loads(chunk)
                    write(line)
                    last = line
        except (httpx.HTTPError, json.JSONDecodeError) as e:
            write(dict(event="error", message=f"engine connection failed: {type(e).__name__}", t=0))
            return 1
        if last is None or last.get("event") not in ("done", "refused", "error"):
            write(dict(event="error", message="the engine stopped before finishing", t=0))
            return 1
    return {"done": 0, "refused": 3}.get(last["event"], 1)


if __name__ == "__main__":
    sys.exit(main())

"""The lead's tests for per-request strength, against a live engine with an obsession installed (run inside the box):
(1) a stage batch sent while a teach batch runs gets the installed strength, and the teach batch gets its own;
(2) after a teach client dies mid-batch, the installed strength is unchanged and stage batches are as before;
(3) the per-request steer at the stage strength writes exactly what the installed hooks write (the same math);
plus the 400s. Greedy decoding, so equal requests give equal text."""
import json, sys, threading, time, urllib.error, urllib.request

E = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
PROMPTS = ["Why does it rain?", "How do I boil an egg?", "Give me a tip for a job interview.", "What is a prime number?",
           "How do I reverse a list in Python?", "Recommend a book for a long flight.", "Why is the sky blue?", "How do plants grow?"]
BODY = dict(prompts=PROMPTS, think=True, think_tokens=64, answer_tokens=48, max_tokens=112, temperature=0, seed=1)


def call(path, body=None, timeout=900):
    req = urllib.request.Request(E + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={"content-type": "application/json"}, method="GET" if body is None else "POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def texts(r):
    return [a["text"] for a in r["answers"]]


def status(body):
    try:
        call("/v1/batch", body)
        return 200
    except urllib.error.HTTPError as e:
        return e.code


out = {}
s0 = call("/v1/steer")
out["installed"] = dict(topic=s0.get("topic"), strength=s0["strength"], suspended=s0.get("suspended"))
stage = s0["strength"]
A1, A2 = call("/v1/batch", BODY), call("/v1/batch", BODY)
out["deterministic"] = texts(A1) == texts(A2)
B1 = call("/v1/batch", dict(BODY, strength=0.3))
B4 = call("/v1/batch", dict(BODY, strength=stage))
out["teach_differs_from_stage"] = sum(a != b for a, b in zip(texts(A1), texts(B1)))
out["per_request_at_stage_equals_installed"] = sum(a == b for a, b in zip(texts(A1), texts(B4)))
out["strength_used"] = dict(stage=A1["strength_used"], teach=B1["strength_used"])

# (1) the teach batch starts first; the stage batch is sent while it runs
res, t = {}, {}
def run(key, body):
    t[key + "_sent"] = time.time()
    res[key] = call("/v1/batch", body)
    t[key + "_back"] = time.time()
th = threading.Thread(target=run, args=("teach", dict(BODY, strength=0.3)))
th.start(); time.sleep(0.5)
mid = call("/v1/steer")
run("stage", BODY); th.join()
out["test1"] = dict(stage_sent_while_teach_ran=t["stage_sent"] < t["teach_back"],
                    steer_during_teach=dict(strength=mid["strength"], suspended=mid.get("suspended")),
                    teach_strength_used=res["teach"]["strength_used"], stage_strength_used=res["stage"]["strength_used"],
                    teach_equals_solo_teach=texts(res["teach"]) == texts(B1), stage_equals_solo_stage=texts(res["stage"]) == texts(A1))

# (2) a teach client dies mid-batch: a long batch with a 3 s client timeout
long = dict(BODY, prompts=PROMPTS * 4, think_tokens=128, answer_tokens=112, max_tokens=240, strength=0.3)
t0 = time.time()
try:
    call("/v1/batch", long, timeout=3)
    killed = False
except Exception:
    killed = True
right_after = call("/v1/steer")
while call("/v1/steer").get("suspended"):
    time.sleep(0.5)
settled_s = round(time.time() - t0, 1)
after = call("/v1/steer")
C = call("/v1/batch", BODY)
out["test2"] = dict(client_killed=killed, right_after=dict(strength=right_after["strength"], suspended=right_after.get("suspended")),
                    after=dict(strength=after["strength"], suspended=after.get("suspended"), settled_s=settled_s),
                    stage_strength_used=C["strength_used"], stage_equals_before=texts(C) == texts(A1))

out["rejects"] = {repr(v): status(dict(BODY, strength=v)) for v in ("0.3", 0, 1.5, True, -0.2)}
out["sample"] = dict(prompt=PROMPTS[0], stage=texts(A1)[0][:300], teach_0_3=texts(B1)[0][:300])
ok = (out["deterministic"] and out["test1"]["stage_sent_while_teach_ran"] and out["test1"]["teach_equals_solo_teach"]
      and out["test1"]["stage_equals_solo_stage"] and out["test1"]["teach_strength_used"] == 0.3 and out["test1"]["stage_strength_used"] == stage
      and out["test2"]["client_killed"] and out["test2"]["after"]["strength"] == stage and out["test2"]["after"]["suspended"] is False
      and out["test2"]["stage_equals_before"] and all(c == 400 for c in out["rejects"].values()) and out["teach_differs_from_stage"] > 0
      and out["per_request_at_stage_equals_installed"] == len(PROMPTS))
out["ok"] = bool(ok)
print(json.dumps(out, indent=1, ensure_ascii=False))
sys.exit(0 if ok else 1)

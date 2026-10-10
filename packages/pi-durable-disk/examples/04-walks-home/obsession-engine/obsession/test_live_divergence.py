"""How early do two greedy generations part? Installed hooks vs the per-request steer at the same strength, against a
noise reference: the installed hooks with one extra prompt in the batch (a different shape, so only float rounding
differs). Same math shows the same profile as the reference; a different computation parts in the first few tokens."""
import json, sys, urllib.request
E = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
P = ["Why does it rain?", "How do I boil an egg?", "Give me a tip for a job interview.", "What is a prime number?",
     "How do I reverse a list in Python?", "Recommend a book for a long flight.", "Why is the sky blue?", "How do plants grow?"]
def call(body):
    req = urllib.request.Request(E + "/v1/batch", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    return [a["text"] for a in json.loads(urllib.request.urlopen(req, timeout=900).read())["answers"]]
def common(a, b):
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n
base = dict(max_tokens=96, temperature=0, seed=1)
stage = json.loads(urllib.request.urlopen(E + "/v1/steer").read())["strength"]
X = call(dict(base, prompts=P))
Y = call(dict(base, prompts=P, strength=stage))
Z = call(dict(base, prompts=P + ["Hello there."]))[:len(P)]
old = None
out = dict(stage=stage, chars=[len(x) for x in X],
           per_request_vs_installed=[common(x, y) for x, y in zip(X, Y)],
           noise_reference=[common(x, z) for x, z in zip(X, Z)])
print(json.dumps(out))

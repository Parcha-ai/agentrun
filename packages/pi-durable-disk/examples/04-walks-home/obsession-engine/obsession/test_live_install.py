"""On a live engine after finds: the install route takes each find's own clamp.json (the stage's real file shape) and
refuses /dev/zero and a file outside every find's out directory.

  python test_live_install.py ENGINE CLAMP_JSON [CLAMP_JSON...]   (the last one is installed again at the end)"""
import json, sys, urllib.error, urllib.request

E, cfgs = sys.argv[1], sys.argv[2:]


def post(body):
    req = urllib.request.Request(E + "/v1/obsession/install", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read()).get("topic")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:160]


out = {c: post({"config": c}) for c in cfgs}
out["/dev/zero"] = post({"config": "/dev/zero"})
out["/etc/hostname"] = post({"config": "/etc/hostname"})
out["again: " + cfgs[-1]] = post({"config": cfgs[-1]})
print(json.dumps(out, indent=1))
ok = all(out[c][0] == 200 for c in cfgs) and out["/dev/zero"][0] == 400 and out["/etc/hostname"][0] == 400 and out["again: " + cfgs[-1]][0] == 200
print("ok" if ok else "FAILED")
sys.exit(0 if ok else 1)

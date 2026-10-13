#!/usr/bin/env python3
# gg: the agent's commands on the GPU box. Each step asks the lab (127.0.0.1:8100) and prints its progress as it comes.
#   gg read                  where the paper and the replication are on this box
#   gg find                  find Golden Gate Bridge features in Qwen-Scope's SAEs
#   gg pick                  Jev reads each candidate feature and keeps the ones that are the bridge itself
#   gg strength              fold the direction into one layer's weights; Jev picks the strongest readable strength
#   gg bake                  keep that strength in the served model; write the checkpoint and a control vector
#   gg ask "question"        ask the served model one question
#   gg status
import json
import sys
import urllib.request

LAB = "http://127.0.0.1:8100"
READING = "/opt/gg-onemore/reading"


def line(e):
    k = e.get("event")
    if k == "find.start":
        return f"find: {e['passages']} passages ({', '.join(f'{c} {n}' for c, n in e['categories'].items())}), SAE layers {e['layers']}"
    if k == "find.residuals":
        return f"find: residuals of {e['tokens']} tokens in {e['s']} s"
    if k == "find.layer":
        return f"find: layer {e['layer']}: {e['eligible']} features push along the bridge-minus-neutral direction; the top {e['shortlisted']} explain {e['explains']:.0%} of it ({e['s']} s)"
    if k == "find.top_by_code":
        return "find: top by statistics alone:\n" + "\n".join(f"  {f['id']}: fires on \"{f['fires_on']}\" pushes {f['promotes']}" for f in e["features"])
    if k == "pick.start":
        return f"pick: asking Jev about {e['candidates']} candidate features (each one twice, options shuffled)"
    if k == "pick.feature":
        return (f"pick: {e['id']} -> {e['role']} (p bridge {e['p_bridge']}, talks bridge when turned up {e['steers']}, fluent {e['fluent']}){' KEPT' if e['kept'] else ' dropped'}\n"
                f"  fires on: \"{e['fires_on']}\"\n  turned up: \"{e['turned_up']}\"")
    if k == "pick.screen":
        return f"pick: turned each feature up inside the model: {e['answers']} short answers in {e['s']} s"
    if k == "pick.summary":
        head = f"pick: layer {e['layer']}: Jev kept {e['kept']} of {e['of']} features; by role (share of the shortlist) {e['removed_share_by_role']}"
        if e["kept"] == 0:
            head += "\npick: no single feature turns the model into the bridge (they give token spam or other landmarks), so strength uses the whole direction, the replication's method"
        return head
    if k == "fold.fit":
        span = e.get("gain_by_span", {})
        inside = " ".join(f"{name.replace('_', ' ')}: thinking {v.get('think', {}).get('mean')}, answer {v.get('answer', {}).get('mean')};" for name, v in span.items())
        return (f"fold: layer {e['layer']} MLP output matrix, rank-1; per-token gain on held-out text mean {e['gain_mean']} sd {e['gain_sd']} "
                f"(p5 {e['gain_p5']}, p95 {e['gain_p95']}; {e['share_outside_0.5_1.5']:.1%} outside 0.5-1.5) [{e['s']} s]"
                + (f"\nfold: gain on fresh thinking-format text, {inside}" if inside else ""))
    if k == "strength.probe":
        verdict = "passes" if e["pass"] else ("NOT readable enough" if e["readable"] < 0.75 else "stops answering the question" if e["answers"] < 0.3 else "fails the dark-content gate")
        return (f"strength {e['label']} f={e['f']} ({e['n']} answers): obsession {e['obsession']}/4 (about the Golden Gate specifically {e['specific']}), "
                f"readable {e['readable']}+-{e['readable_se']}, answers the question {e['answers']}, facts right {e['correct']}, tool calls {e['tool_calls_ok']} -> {verdict} "
                f"({e['gen_s']} s gen{', thinking on' if e.get('thinking') else ''}, {e['grade_s']} s Jev)\n  who are you? {e['who_are_you']!r}")
    if k == "strength.direction":
        return f"strength: direction {e['chosen']} ({e['why']})"
    if k == "strength.chosen":
        c = e.get("chosen")
        alt = e.get("funny_not_wrong")
        tail = f"; strongest that still gets facts right: f={alt['f']} (obsession {alt['obsession']})" if alt else ""
        return f"strength: chose {e.get('direction')} f={c['f']} (obsession {c['obsession']}, readable {c['readable']}); stop rule: {e.get('why')}{tail}" if c else f"strength: none chosen: {e.get('why')}"
    if k == "bake.served":
        return f"bake: the server now runs the edited weights: {e['tensor']} (scale {e['scale']}, sha256 {str(e['sha256'])[:12]})"
    if k == "bake.control_vector":
        return f"bake: control vector {e.get('file', '')} {e.get('bytes', '')} bytes {e.get('error', '')}".strip()
    if k == "bake.checkpoint":
        return f"bake: checkpoint written in {e['s']} s: {e['shard']} replaced, the rest linked from the base model; tensor sha256 {e['sha256'][:12]} matches the served one"
    if k == "bake.showcase":
        return "bake: Jev's picks for the stage:\n" + "\n".join(f"  Q: {a['q']}\n  A: {a['answer'][:400]!r}" for a in e["answers"])
    if k == "bake.check":
        return f"bake: who are you? {e['who_are_you']!r}"
    if k == "error":
        return f"ERROR: {e['error']}"
    if k == "result":
        return None
    return json.dumps(e)


def run(path, body=None):
    req = urllib.request.Request(LAB + path, data=json.dumps(body or {}).encode(), headers={"content-type": "application/json"}, method="POST")
    result = None
    try:
        with urllib.request.urlopen(req, timeout=1800) as r:
            for raw in r:
                e = json.loads(raw)
                if e.get("event") == "result":
                    result = e
                else:
                    text = line(e)
                    if text:
                        print(text, flush=True)
    except urllib.error.HTTPError as e:
        print(f"ERROR: the lab answered {e.code}: {e.read().decode()[:300]}")
        return 1
    if result is None or not result.get("ok"):
        return 1
    print(json.dumps({k: v for k, v in result.items() if k not in ("event", "ok")}, indent=1)[:4000])
    return 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "read":
        import os

        for f in sorted(os.listdir(READING)):
            print(f"{READING}/{f}  ({os.path.getsize(f'{READING}/{f}')} bytes)")
        print("Read them with grep, head, sed -n.")
        return 0
    if cmd in ("find", "pick", "strength", "bake"):
        body = {}
        if "--layer" in sys.argv:
            body["layer"] = int(sys.argv[sys.argv.index("--layer") + 1])
        return run("/" + cmd, body)
    if cmd == "ask":
        q = " ".join(sys.argv[2:])
        req = urllib.request.Request(LAB + "/ask", data=json.dumps({"q": q}).encode(), headers={"content-type": "application/json"})
        print(json.load(urllib.request.urlopen(req, timeout=300))["answer"])
        return 0
    if cmd == "status":
        print(json.dumps(json.load(urllib.request.urlopen(LAB + "/status", timeout=10)), indent=1))
        return 0
    print(__doc__ if __doc__ else "usage: gg read|find|pick|strength|bake|ask|status")
    return 2


if __name__ == "__main__":
    sys.exit(main())

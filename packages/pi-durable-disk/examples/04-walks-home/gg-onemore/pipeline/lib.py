# The lab as a library for the agent's own code (skills/golden-gate/SKILL.md): one unix socket only the unprivileged
# `agent` user's group reaches (GG_LIB_SOCK), the model, the SAEs and Jev's key staying in the lab process. Each route is
# one primitive an experiment composes; big tensors come back as files under GG_LIB_OUT that the agent's code loads with
# torch. The served model changes through one route only, /serve, which checks the clamp before the server takes it.
# box/gglab.py is the client the agent imports.
import json
import math
import os
import secrets as tokens

import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

OUT = os.environ.get("GG_LIB_OUT", "/var/tmp/gg/lib")
FMAX = int(os.environ.get("GG_CLAMP_FMAX", "16"))
MAX_TOKENS_PER_TEXT = 512
MAX_TEXTS = 512
MAX_PROMPTS = 32
SAMPLING = {"presence_penalty": (0.0, 2.0), "temperature": (0.0, 1.5), "top_p": (0.05, 1.0)}


class Refused(ValueError):
    pass


def save(name, obj):
    os.makedirs(OUT, mode=0o755, exist_ok=True)
    path = os.path.join(OUT, f"{name}-{tokens.token_hex(4)}.pt")
    torch.save(obj, path)
    os.chmod(path, 0o644)
    return path


def truncated(lab, texts):
    """How many texts are longer than the lab reads (it keeps each text's first MAX_TOKENS_PER_TEXT tokens)."""
    return sum(1 for ids in lab.tok(texts, padding=False)["input_ids"] if len(ids) > MAX_TOKENS_PER_TEXT)


def texts_of(body, key="texts", cap=MAX_TEXTS):
    texts = body.get(key)
    if not isinstance(texts, list) or not texts or not all(isinstance(t, str) for t in texts):
        raise Refused(f"{key}: a list of strings")
    if len(texts) > cap:
        raise Refused(f"{key}: at most {cap}")
    return texts


def layer_of(lab, body):
    L = body.get("layer")
    if not isinstance(L, int) or L not in lab.sae:
        raise Refused(f"layer {L!r}: one of the SAE layers {sorted(lab.sae)}")
    return L


def ids_of(body, cap=256):
    ids = body.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > cap or not all(isinstance(i, int) and 0 <= i < 81920 for i in ids):
        raise Refused(f"ids: 1-{cap} feature indices")
    return ids


def check_clamp(lab, clamp):
    """A clamp as the agent writes it: {"parts": [{"layer", "feature", "value"}], "sampling": {...}, "pulse": n}. Each part's
    layer has the server's clamp buffers, at most FMAX parts per layer, each value finite and within 4x that layer's median
    token norm; sampling only the keys and ranges in SAMPLING."""
    if not isinstance(clamp, dict) or not isinstance(clamp.get("parts"), list) or not clamp["parts"]:
        raise Refused('clamp: {"parts": [{"layer", "feature", "value"}, ...], "sampling": {...}}')
    per = {}
    layers = lab.graph_layers()
    for p in clamp["parts"]:
        L, f, v = p.get("layer"), p.get("feature"), p.get("value")
        if L not in layers or L not in lab.sae:
            raise Refused(f"part layer {L!r}: the server clamps at {[x for x in layers if x in lab.sae]}")
        if not isinstance(f, int) or not 0 <= f < lab.sae[L]["W_enc"].shape[0]:
            raise Refused(f"part feature {f!r}")
        bound = 4 * lab.median_norm(L)
        if not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= bound:
            raise Refused(f"part value {v!r}: 0 to {bound:.1f} at layer {L} (4x its median token norm)")
        if any(f == g for g, _ in per.get(L, [])):
            raise Refused(f"part layer {L} feature {f}: given twice (each part once, at one value)")
        per.setdefault(L, []).append((f, float(v)))
    for L, parts in per.items():
        if len(parts) > FMAX:
            raise Refused(f"layer {L}: at most {FMAX} parts")
    sampling = clamp.get("sampling") or {}
    for k, v in sampling.items():
        if k not in SAMPLING or not isinstance(v, (int, float)) or not SAMPLING[k][0] <= v <= SAMPLING[k][1]:
            raise Refused(f"sampling {k}={v!r}: one of {SAMPLING}")
    pulse = clamp.get("pulse", 0)
    if not isinstance(pulse, int) or not 0 <= pulse <= 4096:
        raise Refused("pulse: positions on, then off (0: always on)")
    return per, dict(sampling), pulse


def create_lib_app(lab):
    app = FastAPI()

    async def body_of(req):
        try:
            b = await req.json()
        except Exception:
            b = {}
        return b if isinstance(b, dict) else {}

    def route(path):
        def wrap(fn):
            async def handler(req: Request):
                b = await body_of(req)
                try:
                    with lab.lock:
                        return fn(b)
                except Refused as e:
                    return JSONResponse({"error": str(e)}, status_code=400)
            app.post(path)(handler)
            return fn
        return wrap

    @route("/status")
    def status(_b):
        return {"sae_layers": sorted(lab.sae), "clamp_layers": [L for L in lab.graph_layers() if L in lab.sae], "parts_per_layer": FMAX,
                "tokens_per_text": MAX_TOKENS_PER_TEXT, "median_norm": {L: round(lab.median_norm(L), 2) for L in sorted(lab.sae)},
                "passages": {c: len(v) for c, v in lab.passages.items()}, "served": lab.served_file()}

    @route("/passages")
    def passages(_b):
        """Contrast texts: the bridge, San Francisco without it, other bridges, "golden", other landmarks, neutral."""
        return lab.passages

    @route("/features")
    def features(b):
        """Per SAE feature over these texts (its top-50 codes per token): the share of tokens it fires on, its mean and its
        max activation. A file of three [81920] tensors."""
        L = layer_of(lab, b)
        H, _, seq, _, _ = lab.residuals(texts_of(b), [L])
        idx, val = lab.encode(L, H[L])
        F = lab.sae[L]["W_enc"].shape[0]
        i, v = idx.reshape(-1).long(), val.reshape(-1)
        fire = torch.zeros(F, device=v.device).index_add_(0, i, (v > 0).float())
        total = torch.zeros(F, device=v.device).index_add_(0, i, v)
        mx = torch.zeros(F, device=v.device).scatter_reduce_(0, i, v, reduce="amax", include_self=True)
        n = max(1, int(seq.numel()))
        return {"path": save("features", {"layer": L, "rate": (fire / n).cpu(), "mean": (total / n).cpu(), "max": mx.cpu()}), "tokens": n,
                "truncated": truncated(lab, b["texts"])}

    @route("/lens")
    def lens(b):
        """The tokens each feature's decoder direction promotes, read through the final norm and the unembedding."""
        L = layer_of(lab, b)
        ids = ids_of(b)
        top = lab.logit_lens(lab.unit_decoder(L, ids) * lab.median_norm(L)).topk(10, dim=-1).indices.tolist()
        return {"promotes": {str(f): [lab.tok.decode([t]) for t in row] for f, row in zip(ids, top)}}

    @route("/contexts")
    def contexts(b):
        """Where one feature fires most in these texts: up to 8, the token it fires on marked like ⟦this⟧."""
        L = layer_of(lab, b)
        f = ids_of(b, 1)[0]
        texts = texts_of(b)
        H, _, seq, pos, ids = lab.residuals(texts, [L])
        idx, val = lab.encode(L, H[L])
        acts = torch.where(idx == f, val, torch.zeros_like(val)).sum(-1)
        best = {}
        for t in torch.nonzero(acts > 0).flatten().tolist():
            s = int(seq[t])
            if s not in best or acts[t] > best[s][0]:
                best[s] = (float(acts[t]), int(pos[t]))
        enc = lab.tok(texts, padding=False)["input_ids"]
        top = sorted(best.items(), key=lambda kv: -kv[1][0])[:8]
        return {"contexts": [{"activation": round(a, 2), "text": lab.mark(torch.tensor(enc[s]), at)} for s, (a, at) in top], "truncated": truncated(lab, texts)}

    @route("/try")
    def try_clamp(b):
        """Replies with a clamp on every token: served for this call only, then the served clamp (or none) is back."""
        per, sampling, pulse = check_clamp(lab, b.get("clamp"))
        prompts = texts_of(b, "prompts", MAX_PROMPTS)
        n, thinking, max_tokens = b.get("n", 1), b.get("thinking", True), b.get("max_tokens", 700)
        if not isinstance(n, int) or not 1 <= n <= 8:
            raise Refused("n: 1-8")
        if not isinstance(thinking, bool) or not isinstance(max_tokens, int) or not 16 <= max_tokens <= 1500:
            raise Refused("thinking: true or false; max_tokens: 16-1500 for the answer (the thinking has its own budget)")
        try:
            lab.serve(lab.clamp_tensors(per, pulse))
            rows = lab.draw(prompts, n, sampling, thinking, max_tokens)
        finally:
            # back to what served.json says is served (bake's or serve's, across restarts), or the unedited model
            lab.serve(lab.served_file())
        return {"replies": rows}

    @route("/jev")
    def jev(b):
        """Jev on a batch: jobs [{state, questions}] answered in order (the lab holds the key)."""
        jobs = b.get("jobs")
        if not isinstance(jobs, list) or not jobs or len(jobs) > 512 or not all(isinstance(j, dict) and "state" in j and "questions" in j for j in jobs):
            raise Refused("jobs: 1-512 {state, questions}")
        return {"answers": lab.jev.ask_many([(j["state"], j["questions"]) for j in jobs])}

    @route("/serve")
    def serve(b):
        """The served model from now on: a clamp the agent wrote, checked first; {"clamp": null} serves the unedited model."""
        if b.get("clamp") is None:
            lab.serve(None)
            lab.write_served(None)
            return {"served": None}
        per, sampling, pulse = check_clamp(lab, b["clamp"])
        path = lab.clamp_tensors(per, pulse)
        lab.serve(path)
        served = {"file": path, "parts": [{"layer": L, "feature": f, "value": v} for L, ps in per.items() for f, v in ps],
                  "sampling": sampling, "pulse": pulse, "note": str(b.get("note", ""))[:500]}
        lab.write_served(served)
        return {"served": served}

    return app


def serve_lib(app, sock):
    """The library on its unix socket, in a thread of the lab's process, reachable by the agent group only."""
    import grp
    import threading

    import uvicorn

    os.makedirs(os.path.dirname(sock), exist_ok=True)
    if os.path.exists(sock):
        os.remove(sock)
    server = uvicorn.Server(uvicorn.Config(app, uds=sock, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if os.path.exists(sock):
            break
        threading.Event().wait(0.1)
    gid = grp.getgrnam(os.environ.get("GG_LIB_GROUP", "agent")).gr_gid
    os.chown(os.path.dirname(sock), 0, gid)
    os.chmod(os.path.dirname(sock), 0o750)
    os.chown(sock, 0, gid)
    os.chmod(sock, 0o660)
    return json.dumps({"event": "lib.ready", "sock": sock})

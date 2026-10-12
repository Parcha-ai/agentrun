"""The obsession engine: one warm process that holds Gemma 3 (27B on the take) and the Gemma Scope 2 SAEs, finds a topic's
features and clamps them (Anthropic's method: residual stream, SAE error term kept, BOS and padding masked), and serves
the clamped model.

  python obsession_engine.py --port 8000 [--preset 27b|1b-cpu] [--config FILE]

Endpoints (on top of gg_server's /v1/chat/completions, /v1/steer, /v1/models, /health):
  POST /v1/obsession/find     {request, out}   NDJSON progress lines (the find/progress.jsonl format), last: done|refused|error
  POST /v1/obsession/install  {config}         install a clamp config (clamp.json) for serving
  POST /v1/batch              {prompts, max_tokens<=160, temperature, repetition_penalty, seed}  under the installed clamp
  POST /v1/judge              {topic, items}   the shared grader (judge_topic.py), off the generation lock

Keys: OPENAI_API_KEY (policy, passages, judge) stays in this process; nothing it receives is ever run as code.
"""
import argparse, json, os, re, stat, sys, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "scripts"))
sys.path.insert(0, os.path.dirname(HERE))  # the image's /opt/gg: the shared grader judge_topic.py lives there (D1's layer)
sys.path.insert(0, HERE)
if os.path.isdir("/vol/hf"):  # the box's Volume holds the weights and SAEs; it wins over any HF_HOME an image sets
    os.environ["HF_HOME"] = "/vol/hf"

import numpy as np
import torch
from fastapi import Body, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from gg_server import build, describe_all, install_hooks, make_app, set_mode
import obsession_find
from obsession_gen import BatchSteer, generate_rows, generate_think

PRESETS = {
    "27b": dict(model="google/gemma-3-27b-it", revision="005ad3404e59d6023443cb575daa05336842228a", dtype="bfloat16",
                sae_repo="google/gemma-scope-2-27b-it", sae_rev="5c58dd4cddd52cef653059d85e12a86bf6222a28",
                saes=["31:262k", "40:262k", "53:262k", "31:1m", "40:1m"], roles=dict(concept=[40], topic=[31, 40], output=[53], vector=31)),
    "1b-cpu": dict(model="google/gemma-3-1b-it", revision="dcc83ea841ab6100d6b47a070329e1ba4cf78752", dtype="float32", device="cpu",
                   sae_repo="google/gemma-scope-2-1b-it", sae_rev="b0fa29457c3601df0a70c48a15534c738d7c10e0",
                   saes=["17:262k", "22:262k"], roles=dict(concept=[17], topic=[17], output=[22], vector=13)),
}


def log(event, **kw):
    print(json.dumps({"at": time.strftime("%H:%M:%S"), "event": event, **kw}), flush=True)


class SAEBank:
    """Gemma Scope 2 JumpReLU SAEs in (pinned) CPU memory as bf16, streamed to the GPU in width chunks when scanned, plus
    each feature's logit mean and std over the vocabulary (topic-independent), so a topic's output score is instant."""

    def __init__(self, repo, rev, specs, device, emb):
        from huggingface_hub import hf_hub_download
        from safetensors import safe_open
        self.device, self.saes = device, {}
        pin = device != "cpu"
        for spec in specs:
            layer, width = spec.split(":")
            t0 = time.time()
            log("sae.loading", sae=spec, hf_home=os.environ.get("HF_HOME"))
            path = hf_hub_download(repo, f"resid_post/layer_{layer}_width_{width}_l0_medium/params.safetensors", revision=rev)
            fh = safe_open(path, "pt", device="cpu")
            es, ds = fh.get_slice("w_enc"), fh.get_slice("w_dec")
            d, W = es.get_shape()
            # Both stored per feature ([W, d], rows contiguous), so a width chunk is one contiguous pinned block to copy.
            enc = torch.empty((W, d), dtype=torch.bfloat16, pin_memory=pin)
            dec = torch.empty((W, d), dtype=torch.bfloat16, pin_memory=pin)
            for c in range(0, W, 65536):  # slices keep peak RAM low; w_enc on disk is [d, W]
                enc[c:c + 65536] = es[:, c:c + 65536].T.to(torch.bfloat16)
                dec[c:c + 65536] = ds[c:c + 65536].to(torch.bfloat16)
            sae = dict(layer=int(layer), width=width, W=W, enc=enc, dec=dec, b=fh.get_tensor("b_enc").float(),
                       thr=fh.get_tensor("threshold").float())
            mu = torch.empty(W); sd = torch.empty(W)
            E = emb.to(device)
            step = 4096 if device != "cpu" else 2048
            for i in range(0, W, step):
                Lg = (dec[i:i + step].to(device, E.dtype, non_blocking=True) @ E.T).float()
                mu[i:i + step] = Lg.mean(1).cpu(); sd[i:i + step] = Lg.std(1).cpu()
            sae.update(mu=mu, sd=sd)
            self.saes[spec] = sae
            log("sae.loaded", sae=spec, width=W, s=round(time.time() - t0, 1))

    def rows(self, spec, ids):
        """Feature rows (enc column, dec row, b, thr) for a clamp config's npz."""
        s = self.saes[spec]
        ids = list(ids)
        return dict(enc=s["enc"][ids].float().numpy(), dec=s["dec"][ids].float().numpy(), b_enc=s["b"][ids].numpy(),
                    threshold=s["thr"][ids].numpy())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--preset", default="27b", choices=sorted(PRESETS))
    ap.add_argument("--config", help="a clamp.json to install at start")
    ap.add_argument("--llm-url"); ap.add_argument("--llm-model", default="gpt-4.1-mini")
    ap.add_argument("--reload", action="store_true", help="dev only: re-import the pipeline modules on every find request")
    a = ap.parse_args()
    if a.host not in ("127.0.0.1", "localhost", "::1") and not os.environ.get("GG_API_KEY"):
        log("engine.error", message="binding beyond loopback needs GG_API_KEY (every route but /health checks it)")
        sys.exit(2)
    try:  # the teach step's round-2 layer (/opt/gg) is what find counts and grades with: refuse to start without it
        import judge_topic, teach_common
        obsession_find.check_teach_layer(teach_common, judge_topic)
        teach_common.teach_policy()
    except Exception as e:
        log("engine.error", message=f"{type(e).__name__}: {e}"[:300])
        sys.exit(2)
    P = PRESETS[a.preset]
    t0 = time.time()
    if not os.environ.get("OPENAI_API_KEY"):
        log("engine.error", message="OPENAI_API_KEY is not set (policy, passages and judge need it)")
        sys.exit(2)
    S = build(dict(model=P["model"], revision=P["revision"], dtype=P["dtype"], **({"device": P["device"]} if "device" in P else {}),
                   served_name="obsession", mode="none", strength=0, reject_system=True))
    log("model.loaded", model=P["model"], s=round(time.time() - t0, 1), device=S["device"])
    emb = S["model"].get_output_embeddings().weight.detach()
    bank = SAEBank(P["sae_repo"], P["sae_rev"], P["saes"], S["device"], emb)
    S.update(bank=bank, preset=P, base_cfg=dict(model=P["model"], revision=P["revision"], dtype=P["dtype"], size="norm",
                                               served_name="obsession", reject_system=True, repetition_penalty=1.1, temperature=0.6))
    from openai import OpenAI
    S["openai"] = OpenAI(base_url=a.llm_url) if a.llm_url else OpenAI()
    S["llm_model"], S["llm_url"] = a.llm_model, a.llm_url  # find's policy and passages use the same endpoint as the grader
    app = make_app(S)
    if a.config:
        obsession_find.install_config(S, json.load(open(a.config)))
    add_routes(app, S, dict(reload=a.reload))
    log("engine.ready", s=round(time.time() - t0, 1), port=a.port, preset=a.preset, saes=P["saes"])
    import uvicorn
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


CONFIG_MAX_BYTES = 1 << 20  # a clamp.json is a few KB
FEATURES_MAX_BYTES = 64 << 20  # a feature file holds a handful of SAE rows


def run_file(S, path, max_bytes):
    """The resolved path of a regular file inside a directory a find of this engine wrote (symlinks and ".." resolved
    first), at most max_bytes; anything else is a ValueError. The install route reads nothing else."""
    if not isinstance(path, str) or not path:
        raise ValueError("a file path must be a non-empty string")
    real = os.path.realpath(path)
    if not any(real.startswith(root + os.sep) for root in S.setdefault("run_dirs", set())):
        raise ValueError("only files inside a find's out directory can be installed")
    st = os.stat(real)
    if not stat.S_ISREG(st.st_mode):
        raise ValueError("not a regular file")
    if st.st_size > max_bytes:
        raise ValueError(f"larger than {max_bytes} bytes")
    return real


def checked_config(S, cfg):
    """A clamp config from the install route: an object, or the path of a clamp.json a find wrote. Every feature or
    vector file it names must be a run file too; the checked, resolved paths replace the given ones."""
    if isinstance(cfg, str):
        with open(run_file(S, cfg, CONFIG_MAX_BYTES), "rb") as f:
            cfg = json.loads(f.read(CONFIG_MAX_BYTES + 1))
    if not isinstance(cfg, dict):
        raise ValueError("config must be an object or the path of a clamp.json in a find's out directory")
    cfg = dict(cfg)
    hooks = cfg.get("hooks")
    if hooks is not None and (not isinstance(hooks, list) or not all(isinstance(h, dict) for h in hooks)):
        raise ValueError("hooks must be a list of objects")
    # The same hooks install_hooks will load: cfg["hooks"], or the top-level single-hook form when there are none (a
    # find's clamp.json also has a top-level "features": the stage's feature cards, not a file).
    if hooks:
        cfg["hooks"] = hooks = [dict(h) for h in hooks]
    elif "layer" in cfg:
        hooks = [cfg]
    for h in hooks or []:
        for k in ("features", "vector"):
            if h.get(k) is not None:
                h[k] = run_file(S, h[k], FEATURES_MAX_BYTES)
    return cfg


def add_routes(app, S, opts):
    """The engine's routes on top of gg_server's app (make_app(S) first): find, install, batch, judge. Each checks the
    engine key (GG_API_KEY) like gg_server's own routes."""
    lock = S["lock"]
    auth = S["auth"]
    finds = S.setdefault("finds_running", set())
    finds_lock = threading.Lock()
    S.setdefault("run_dirs", set())

    @app.post("/v1/obsession/find")
    async def find(req: Request):
        auth(req)
        b = await req.json()
        if not isinstance(b.get("request"), str) or not isinstance(b.get("out"), str) or not b["out"]:
            raise HTTPException(400, "body needs request and out strings")
        out = os.path.realpath(b["out"])
        with finds_lock:  # one find at a time per out directory: a retry never mixes two topics' files
            if out in finds:
                raise HTTPException(409, "a find is already running for this out directory")
            finds.add(out)
            S["run_dirs"].add(out)
        q = []
        ev = threading.Event()

        def emit(line):
            q.append(line); ev.set()

        def run():
            try:
                if opts.get("reload"):
                    import importlib, obsession_gen, obsession_llm
                    for m in (obsession_llm, obsession_gen, obsession_find):
                        importlib.reload(m)
                obsession_find.find(S, b["request"], out, emit, lock)
            except Exception as e:  # reported as the last line, never swallowed
                emit(dict(event="error", message=f"{type(e).__name__}: {e}"[:300]))
            finally:
                with finds_lock:
                    finds.discard(out)
                emit(None)

        threading.Thread(target=run, daemon=True).start()

        def stream():
            i = 0
            while True:
                ev.wait(1.0); ev.clear()
                while i < len(q):
                    line = q[i]; i += 1
                    if line is None:
                        return
                    yield json.dumps(line, ensure_ascii=False) + "\n"
        return StreamingResponse(stream(), media_type="application/x-ndjson")

    @app.post("/v1/obsession/install")
    def install(req: Request, b: dict = Body(...)):
        auth(req)
        try:
            cfg = checked_config(S, b.get("config"))
        except (OSError, ValueError) as e:
            raise HTTPException(400, f"config refused: {e}"[:300])
        with lock:
            try:  # install_hooks swaps only when every new hook loads: on any failure the old obsession keeps running
                obsession_find.install_config(S, cfg)
            except Exception as e:
                raise HTTPException(400, f"install failed, nothing changed: {type(e).__name__}: {e}"[:300])
        return describe_all(S)

    @app.post("/v1/batch")
    def batch(req: Request, b: dict = Body(...)):  # a plain def: FastAPI runs it in its thread pool, so /v1/judge is never blocked behind it
        auth(req)
        prompts = b.get("prompts")
        if not isinstance(prompts, list) or not prompts or not all(isinstance(p, str) for p in prompts) or len(prompts) > 256:
            raise HTTPException(400, "prompts: 1-256 strings")
        think = bool(b.get("think", False))
        mt = int(b.get("max_tokens", 120))
        if not 1 <= mt <= (320 if think else 160):
            raise HTTPException(400, f"max_tokens: 1-{320 if think else 160}")
        prefixes = b.get("prefixes")
        if prefixes is not None and (not isinstance(prefixes, list) or len(prefixes) != len(prompts)
                                     or not all(x is None or isinstance(x, str) for x in prefixes)):
            raise HTTPException(400, "prefixes: a list as long as prompts, of strings or nulls")
        tt, at = b.get("think_tokens"), int(b.get("answer_tokens", 160))
        if tt is not None and (not think or not 16 <= int(tt) <= 256 or not 16 <= at <= 200 or prefixes is not None):
            raise HTTPException(400, "think_tokens (16-256) needs think: true, answer_tokens 16-200, and no prefixes")
        kw = dict(temperature=float(b.get("temperature", 0.6)), repetition_penalty=float(b.get("repetition_penalty", 1.1)), seed=int(b.get("seed", 1)))
        # "strength": this batch alone runs the installed hooks at that strength (the teach step's). The installed hooks are
        # suspended for the batch and never re-moded, so a client that dies mid-run cannot leave the stage strength changed.
        strength = b.get("strength")
        if strength is not None and (isinstance(strength, bool) or not isinstance(strength, (int, float)) or not 0 < strength <= 1):
            raise HTTPException(400, "strength: a number in (0, 1]")
        t1 = time.time()
        with lock:
            one = None
            if strength is not None:
                if not S.get("installed"):
                    raise HTTPException(400, "strength needs an installed obsession")
                try:
                    BatchSteer.from_installed(S, strength)
                except ValueError as e:
                    raise HTTPException(400, str(e))
                one = lambda idx=None: BatchSteer.from_installed(S, strength)
            used = float(strength) if strength is not None else S["steer"].strength
            was = [st.suspended for st in S["steers"]]
            try:
                if one:
                    for st in S["steers"]:
                        st.suspended = True
                if tt is not None:  # two passes: think (closed by the model, or trimmed and closed), then answer from it
                    rows = generate_think(S, prompts, think_tokens=int(tt), answer_tokens=at, steers=one, **kw)
                else:
                    rows = generate_rows(S, prompts, mt, think=think, prefixes=prefixes, steer=one() if one else None, **kw)
            finally:
                for st, s0 in zip(S["steers"], was):
                    st.suspended = s0
        dt = time.time() - t1
        return JSONResponse(dict(answers=rows, ms=round(dt * 1000), tok_per_s=round(sum(r["tokens"] for r in rows) / max(dt, 1e-9), 1),
                                 strength_used=used,
                                 steer=describe_all(S)))

    @app.post("/v1/judge")
    def judge(req: Request, b: dict = Body(...)):  # never takes the generation lock
        auth(req)
        items = b.get("items")
        if not isinstance(b.get("topic"), str) or not isinstance(items, list) or len(items) > 512:
            raise HTTPException(400, "topic string and items list (<= 512)")
        import judge_topic
        grades = judge_topic.grade_many(S["openai"], b["topic"], items, model=S["llm_model"], workers=32)
        return dict(grades=grades)


if __name__ == "__main__":
    main()

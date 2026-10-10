"""OpenAI-compatible chat server for one demo user, with an activation hook at one decoder layer.

Modes (switchable at runtime via POST /v1/steer, no restart):
  none    plain model
  clamp   SAE feature clamp: h <- h + (c - f_i(h)) * d_i, f_i the JumpReLU feature (Golden Gate Claude's mechanism)
  vector  additive steering: h <- h + s * v (mean-difference vector)
  prompt  baseline only: a system prompt is injected server-side (the control condition, never the show)

Config (JSON file, --config): model (HF id or local dir), revision, dtype, device, layer (decoder layer index),
features (npz from extract_feature.py) + feature, vector (npz from steer_vector.py), system_prompt,
mode, strength (clamp: multiple of max_act; vector: scale), max_act, reject_system (default true:
steered modes refuse a request that carries its own system message, so the show cannot be faked).
"""
import argparse, json, os, re, threading, time, uuid

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

sys_path = os.path.dirname(os.path.abspath(__file__))
if sys_path not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path)  # judge.py lives next to this file

def find_layers(model, n_layers):
    """The decoder ModuleList, wherever the architecture keeps it (CausalLM vs multimodal wrappers)."""
    best = None
    for name, mod in model.named_modules():
        if name.endswith("layers") and isinstance(mod, torch.nn.ModuleList) and len(mod) == n_layers:
            if best is None or len(name) < len(best[0]):
                best = (name, mod)
    if best is None:
        raise RuntimeError(f"no decoder ModuleList of length {n_layers}")
    return best

class Steer:
    """Holds the hook state. The hook reads it per forward call, so changes apply to the next token."""

    def __init__(self, cfg, d_model, device, dtype):
        self.mode = cfg.get("mode", "none")
        self.strength = float(cfg.get("strength", 0.0))
        self.positions = cfg.get("positions", "all")
        # "max_act": clamp target c = strength x the feature's max act (vector: h += strength x v).
        # "norm": c = strength x the token's residual norm (vector: h += strength x |h| x v/|v|), the replications' sizing.
        self.size = cfg.get("size", "max_act")
        self.scale = float(cfg.get("scale", 1.0))  # per-hook multiplier on the shared strength
        self.kind = cfg.get("kind")  # per-hook "clamp" or "vector"; unset follows the shared mode
        self.suspended = False  # a host pauses the hook (e.g. while it measures the bare model) without changing its mode
        self.device, self.dtype = device, dtype
        self.feat = None
        if cfg.get("features"):
            # One feature or a set: "feature": 40649 or [40649, 7222]; "max_act" a number or a matching list.
            # Each feature is clamped to strength x its own max act.
            z = np.load(cfg["features"])
            ids = [int(x) for x in z["indices"]]
            want = cfg["feature"] if isinstance(cfg["feature"], list) else [cfg["feature"]]
            ma = cfg.get("max_act")
            ma = ma if isinstance(ma, list) else [ma] * len(want)
            if cfg.get("size", "max_act") == "norm":
                ma = [x or 0.0 for x in ma]  # norm sizing does not use max act
            assert len(ma) == len(want) and (cfg.get("size") == "norm" or all(ma)), "clamp needs max_act (each feature's max activation) in the config"
            J = [ids.index(int(f)) for f in want]
            t = lambda a: torch.tensor(np.asarray(a), dtype=torch.float32, device=device)
            self.feat = dict(id=[ids[j] for j in J], enc=t(z["enc"][J]), b_enc=t(z["b_enc"][J]), thr=t(z["threshold"][J]),
                             dec=t(z["dec"][J]), max_act=t([float(x) for x in ma]))
            assert self.feat["enc"].shape[1] == d_model, "feature d_model does not match the model"
            self.feat["enc_dot_dec"] = [round(float(x), 4) for x in (self.feat["enc"] * self.feat["dec"]).sum(1)]
        self.vec = None
        if cfg.get("vector"):
            z = np.load(cfg["vector"])
            self.vec = torch.tensor(z["vector"], dtype=torch.float32, device=device)
            assert self.vec.numel() == d_model, "vector d_model does not match the model"
        self.system_prompt = cfg.get("system_prompt")
        self.last = {}
        self.mask = None  # [B, T, 1]: 0 on BOS and padding, which the SAEs never saw; set per forward by capture()

    def capture(self, module, args, kwargs):
        ids = kwargs.get("input_ids", args[0] if args else None)
        self.mask = None if ids is None else (~torch.isin(ids, self.skip_ids)).unsqueeze(-1).float()

    def describe(self):
        return dict(mode=self.mode, strength=self.strength, positions=self.positions, size=self.size,
                    feature=self.feat and self.feat["id"], max_act=self.feat and [float(x) for x in self.feat["max_act"]],
                    enc_dot_dec=self.feat and self.feat["enc_dot_dec"],
                    has_vector=self.vec is not None, last=self.last)

    def feature(self, h32):
        """JumpReLU activations of the clamped features: [..., n_features]."""
        pre = h32 @ self.feat["enc"].T + self.feat["b_enc"]
        return pre * (pre > self.feat["thr"])

    def delta(self, h32):
        """This hook's change at its positions, read from the residual as it came into the layer: (sel, delta), or None
        when the hook is off."""
        if self.suspended or self.mode not in ("clamp", "vector"):
            return None
        kind = self.kind or self.mode
        sel = slice(None) if self.positions == "all" or h32.shape[1] == 1 else slice(-1, None)
        part = h32[:, sel]
        k = self.strength * self.scale
        if kind == "clamp":
            c = k * part.norm(dim=-1, keepdim=True) if self.size == "norm" else k * self.feat["max_act"]  # norm: [B, T, 1]
            f = self.feature(part)
            d = (c - f) @ self.feat["dec"]
        else:
            d = k * part.norm(dim=-1, keepdim=True) * self.vec / self.vec.norm() if self.size == "norm" else k * self.vec
        if self.mask is not None and self.mask.shape[1] == h32.shape[1]:
            d = d * self.mask[:, sel]
        if kind == "clamp":
            self.last = dict(f_before=[round(float(x), 1) for x in f.amax(dim=(0, 1))],
                             f_after=[round(float(x), 1) for x in self.feature(part + d).amax(dim=(0, 1))],
                             target=[round(float(x), 1) for x in (c.amax(dim=(0, 1)) if c.dim() == 3 else c)])
        return sel, d

    def hook(self, module, args, output):
        return layer_hook([self])(module, args, output)


def layer_hook(steers):
    """One forward hook per layer: every steer there reads the residual as it came in, and their changes add. Two SAEs'
    features at one layer are clamped together, not one after the other, the same math as the sweep's BatchSteer."""
    def fn(module, args, output):
        h = output[0] if isinstance(output, tuple) else output
        h32, out32 = h.float(), None
        for st in steers:
            r = st.delta(h32)
            if r is None:
                continue
            sel, d = r
            out32 = h32.clone() if out32 is None else out32
            out32[:, sel] = out32[:, sel] + d
        if out32 is None:
            return None
        out = out32.to(h.dtype)
        return (out,) + tuple(output[1:]) if isinstance(output, tuple) else out
    return fn

def build(cfg):
    dtype = getattr(torch, cfg.get("dtype", "bfloat16"))
    device = cfg.get("device") or ("cuda" if torch.cuda.is_available() else "cpu")
    t0 = time.time()
    tok = AutoTokenizer.from_pretrained(cfg.get("tokenizer", cfg["model"]), revision=cfg.get("revision"))
    if cfg.get("random_init"):
        from transformers import AutoConfig
        ri = dict(cfg["random_init"])
        mc = AutoConfig.for_model(ri.pop("model_type"), **ri)
        torch.manual_seed(0)
        model = AutoModelForCausalLM.from_config(mc, torch_dtype=dtype)
    else:
        model = AutoModelForCausalLM.from_pretrained(cfg["model"], revision=cfg.get("revision"), torch_dtype=dtype)
    model.to(device).eval()
    tcfg = getattr(model.config, "text_config", model.config)
    name, layers = find_layers(model, tcfg.num_hidden_layers)
    S = dict(tok=tok, model=model, device=device, dtype=dtype, layers=layers, layers_name=name, d_model=tcfg.hidden_size,
             handles=[], name=cfg.get("served_name", "golden-gate"), cfg=cfg)
    install_hooks(S, cfg)

    def capture(module, args, kwargs):
        for st in S["steers"]:
            st.capture(module, args, kwargs)
    model.register_forward_pre_hook(capture, with_kwargs=True)
    S["load_s"] = time.time() - t0
    return S

HOOK_KEYS = ("layer", "features", "feature", "max_act", "vector", "scale", "kind")

def install_hooks(S, cfg):
    """(Re)install the steering hooks from cfg: one per entry of cfg["hooks"] (each: layer, features/feature/max_act
    and/or vector, optional scale and kind), or the top-level layer/features/feature form as one hook. All hooks share
    mode and strength (set_mode). Replaces any hooks already installed, so variants can share one loaded model."""
    for h in S["handles"]:
        h.remove()
    S["handles"] = []
    hooks = cfg.get("hooks") or ([{k: cfg[k] for k in HOOK_KEYS if k in cfg}] if "layer" in cfg else [])
    tok = S["tok"]
    skip = torch.tensor([i for i in (tok.bos_token_id, tok.pad_token_id) if i is not None], device=S["device"])
    base = {k: v for k, v in cfg.items() if k not in HOOK_KEYS and k != "hooks"}
    steers, by_layer = [], {}
    for hk in hooks:
        st = Steer({**base, **hk}, S["d_model"], S["device"], S["dtype"])
        st.layer, st.skip_ids = int(hk["layer"]), skip
        by_layer.setdefault(st.layer, []).append(st)
        steers.append(st)
    for L, group in by_layer.items():  # hooks at one layer act together (layer_hook)
        S["handles"].append(S["layers"][L].register_forward_hook(layer_hook(group)))
    if not steers:  # unsteered server
        st = Steer(base, S["d_model"], S["device"], S["dtype"])
        st.layer, st.skip_ids = None, skip
        steers.append(st)
    S.update(steer=steers[0], steers=steers,
             layer_path=",".join(f"{S['layers_name']}.{st.layer}" for st in steers),
             layer_module=S["layers"][steers[0].layer] if steers[0].layer is not None else None)

def describe_all(S):
    d = S["steer"].describe()
    if S.get("installed"):  # what a host installed (the obsession engine: topic, mechanism, variant)
        d["topic"] = S["installed"].get("topic")
        d["mechanism"] = S["installed"].get("mechanism")
        d["variant"] = S["installed"].get("variant")
    d["suspended"] = any(st.suspended for st in S["steers"])  # true only while one batch runs at its own strength (or find runs)
    if len(S["steers"]) > 1:
        d["hooks"] = [dict(layer=st.layer, kind=st.kind, scale=st.scale, feature=st.feat and st.feat["id"], last=st.last) for st in S["steers"]]
    return d

def set_mode(S, mode, strength):
    for st in S["steers"]:
        st.mode, st.strength = mode, float(strength)

def make_app(S):
    app = FastAPI()
    lock = S.setdefault("lock", threading.Lock())  # shared with any routes a host adds on top (one generation at a time)
    import copy
    chat_tok = copy.deepcopy(S["tok"])  # the fast tokenizer is not thread-safe: the chat path tokenizes outside the lock
    stats = []
    key = os.environ.get("GG_API_KEY")
    # Output guard: every answer is graded by the typed judge (judge.py's rubric, dark-content fields) before anyone sees
    # it; a flagged answer, or a failed grade, is replaced by a plain refusal. Guarded answers stream only after the grade.
    guard = None
    if S["cfg"].get("guard"):
        if not os.environ.get("OPENAI_API_KEY"):
            raise SystemExit("guard is on but OPENAI_API_KEY is not set")
        from openai import OpenAI
        from judge import grade_one
        client = OpenAI()
        refusal = S["cfg"].get("refusal", "I can't answer that.")

        def guard(prompt, text, rec):
            t0 = time.time()
            try:
                g, _ = grade_one(client, prompt, text, S["cfg"].get("guard_model", "gpt-4.1-mini"))
                rec["guard"] = dict(dark=g["dark"], quote=g["dark_quote"], s=round(time.time() - t0, 2))
                return refusal if g["dark"] else text
            except Exception as e:  # fail closed: an ungraded answer is never shown
                rec["guard"] = dict(error=str(e)[:200], s=round(time.time() - t0, 2))
                return refusal

    def auth(req: Request):
        if key and req.headers.get("authorization") != f"Bearer {key}":
            raise HTTPException(401, "bad key")

    def prompt_ids(messages, think=False):
        steer = S["steer"]
        has_sys = any(m.get("role") == "system" for m in messages)
        if has_sys and steer.mode in ("clamp", "vector") and S["cfg"].get("reject_system", True):
            raise HTTPException(400, "steered mode refuses requests that carry a system message")
        if steer.mode == "prompt":
            messages = [{"role": "system", "content": steer.system_prompt}] + [m for m in messages if m["role"] != "system"]
        msgs = [{"role": m["role"], "content": m["content"] if isinstance(m["content"], str)
                 else "".join(p.get("text", "") for p in m["content"])} for m in messages]
        if think and msgs and msgs[-1]["role"] == "user":  # think-out-loud: a fixed suffix on the user turn, never a system prompt
            msgs[-1] = dict(msgs[-1], content=msgs[-1]["content"] + S.get("think_suffix", "\n\nThink out loud inside <thinking>...</thinking> first, then answer."))
        ids = chat_tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True)
        return ids.to(S["device"]), has_sys

    def gen_kwargs(body):
        t = body.get("temperature", S["cfg"].get("temperature", 0.6))
        kw = dict(max_new_tokens=int(body.get("max_tokens") or body.get("max_completion_tokens") or 256),
                  repetition_penalty=float(S["cfg"].get("repetition_penalty", 1.1)))
        if t and t > 0:
            kw.update(do_sample=True, temperature=float(t), top_p=float(body.get("top_p", S["cfg"].get("top_p", 0.95))),
                      top_k=int(S["cfg"].get("top_k", 64)))
        else:
            kw.update(do_sample=False)
        if body.get("seed") is not None:
            torch.manual_seed(int(body["seed"]))
        return kw

    @app.get("/health")
    def health():
        return dict(ok=True, load_s=S["load_s"], layer=S["layer_path"], steer=describe_all(S),
                    device=S["device"], model=S["cfg"]["model"])

    @app.get("/v1/models")
    def models(req: Request):
        auth(req)
        return dict(object="list", data=[dict(id=S["name"], object="model", owned_by="pda-demo")])

    @app.get("/v1/steer")
    def get_steer(req: Request):
        auth(req)
        return describe_all(S)

    @app.post("/v1/steer")
    async def set_steer(req: Request):
        auth(req)
        b = await req.json()
        st = S["steer"]
        mode = b.get("mode", st.mode)
        need = lambda x, m: (x.kind or m) == "clamp" and x.feat is None or (x.kind or m) == "vector" and x.vec is None
        if mode in ("clamp", "vector") and any(need(x, mode) for x in S["steers"]) or mode == "prompt" and not st.system_prompt:
            raise HTTPException(400, f"mode {mode} not configured")
        if mode not in ("none", "clamp", "vector", "prompt"):
            raise HTTPException(400, f"unknown mode {mode}")
        with lock:
            set_mode(S, mode, b.get("strength", st.strength))
        return describe_all(S)

    @app.get("/v1/stats")
    def get_stats(req: Request):
        auth(req)
        return dict(requests=stats[-50:])

    @app.post("/v1/chat/completions")
    async def chat(req: Request):
        auth(req)
        body = await req.json()
        ids, has_sys = prompt_ids(body["messages"], bool(body.get("think", False)))
        kw = gen_kwargs(body)
        rid = "chatcmpl-" + uuid.uuid4().hex[:20]
        created = int(time.time())
        streamer = TextIteratorStreamer(chat_tok, skip_prompt=True, skip_special_tokens=True)
        rec = dict(id=rid, mode=S["steer"].mode, strength=S["steer"].strength, client_system=has_sys,
                   prompt_tokens=int(ids["input_ids"].shape[1]))

        def run():
            with lock, torch.inference_mode():
                t0 = time.time()
                out = S["model"].generate(**ids, **kw, streamer=streamer)
                rec["completion_tokens"] = int(out.shape[1] - ids["input_ids"].shape[1])
                rec["gen_s"] = time.time() - t0

        th = threading.Thread(target=run, daemon=True)
        t_start = time.time()
        th.start()

        def finish(text):
            th.join()
            rec["total_s"] = time.time() - t_start
            rec["tok_per_s"] = rec["completion_tokens"] / max(rec["gen_s"], 1e-9)
            stats.append(rec)
            return dict(prompt_tokens=rec["prompt_tokens"], completion_tokens=rec["completion_tokens"],
                        total_tokens=rec["prompt_tokens"] + rec["completion_tokens"])

        user_text = next((m["content"] for m in reversed(body["messages"]) if m.get("role") == "user"), "")
        user_text = user_text if isinstance(user_text, str) else "".join(p.get("text", "") for p in user_text)
        guarded = None
        g = S.get("guard_fn") or guard  # a host may install its own guard (e.g. the topic grader) at run time
        if g is not None:
            guarded = g(user_text, "".join(streamer), rec)

        if not body.get("stream"):
            text = guarded if guarded is not None else "".join(streamer)
            usage = finish(text)
            return JSONResponse(dict(id=rid, object="chat.completion", created=created, model=S["name"],
                                     choices=[dict(index=0, message=dict(role="assistant", content=text),
                                                   finish_reason="stop")], usage=usage,
                                     steer=dict(mode=rec["mode"], strength=rec["strength"])))

        def pieces():
            if guarded is None:
                yield from streamer
            else:  # already graded: stream the approved text word by word
                for w in re.findall(r"\S+\s*|\s+", guarded):
                    yield w

        def sse():
            first = True
            for piece in pieces():
                if not piece:
                    continue
                if first:
                    rec["ttft_s"] = time.time() - t_start
                    first = False
                d = dict(id=rid, object="chat.completion.chunk", created=created, model=S["name"],
                         choices=[dict(index=0, delta=dict(role="assistant", content=piece) if rec.get("_r") is None
                                       else dict(content=piece), finish_reason=None)])
                rec["_r"] = 1
                yield f"data: {json.dumps(d)}\n\n"
            rec.pop("_r", None)
            usage = finish(None)
            d = dict(id=rid, object="chat.completion.chunk", created=created, model=S["name"],
                     choices=[dict(index=0, delta={}, finish_reason="stop")], usage=usage)
            yield f"data: {json.dumps(d)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(sse(), media_type="text/event-stream")

    return app

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    cfg = json.load(open(a.config))
    S = build(cfg)
    print(json.dumps(dict(event="gg.loaded", load_s=round(S["load_s"], 2), layer=S["layer_path"], device=S["device"],
                          steer=describe_all(S))), flush=True)
    import uvicorn
    uvicorn.run(make_app(S), host=a.host, port=a.port, log_level="warning")

# The lab as a library for the agent's own code (skills/golden-gate/SKILL.md): one unix socket only the unprivileged
# `agent` user's group reaches (GG_LIB_SOCK), the model, the SAEs and Jev's key staying in the lab process. Each route is
# one primitive an experiment composes; big tensors come back as files under GG_LIB_OUT that the agent's code loads with
# torch. The served model changes through one route only, /serve, which checks the clamp before the server takes it (and
# /load, which serves a saved recipe through the same check). box/gpulab.py is the client the agent imports.
import base64
import json
import math
import os
import re
import secrets as tokens
import time

import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import obsession

OUT = os.environ.get("GG_LIB_OUT", "/var/tmp/gg/lib")
# recipes: the ones this repository ships (recipes/*.json, the gallery) and the ones serve writes on this box
SHIPPED = os.environ.get("GG_RECIPES", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "recipes"))
MADE = os.environ.get("GG_RECIPES_MADE", "/var/tmp/gg/recipes")
FMAX = int(os.environ.get("GG_CLAMP_FMAX", "16"))
MAX_TOKENS_PER_TEXT = 512
MAX_TEXTS = 512
MAX_PROMPTS = 32
SAMPLING = {"presence_penalty": (0.0, 2.0), "temperature": (0.0, 1.5), "top_p": (0.05, 1.0)}
MAX_REPLIES = 256
MAX_DARK_ALSO = 6
MAX_SETS = 8
MAX_GAMES = 2000


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


def check_sampling(sampling):
    """Only the keys and ranges in SAMPLING."""
    sampling = sampling or {}
    if not isinstance(sampling, dict):
        raise Refused(f"sampling: an object with keys from {sorted(SAMPLING)}")
    for k, v in sampling.items():
        if k not in SAMPLING or not isinstance(v, (int, float)) or not SAMPLING[k][0] <= v <= SAMPLING[k][1]:
            raise Refused(f"sampling {k}={v!r}: one of {SAMPLING}")
    return dict(sampling)


def check_clamp(lab, clamp, directions=None):
    """A clamp as the agent writes it: {"parts": [{"layer", "feature", "value", "what"?}], "adds": [{"layer", "direction",
    "f"}], "sampling": {...}, "pulse": n}. Each part's layer has the server's clamp buffers, at most FMAX parts per layer,
    each value finite and within 4x that layer's median token norm; an add is a direction the lab measured (`direction`, or
    a recipe's `unit_f16_b64`) at f x that layer's median token norm, f at most 4, one per layer; sampling only the keys
    and ranges in SAMPLING. Returns (per layer parts, sampling, pulse, per layer add vectors)."""
    if not isinstance(clamp, dict) or not isinstance(clamp.get("parts", []), list) or not isinstance(clamp.get("adds", []), list) or not (clamp.get("parts") or clamp.get("adds")):
        raise Refused('clamp: {"parts": [{"layer", "feature", "value"}, ...], "adds": [{"layer", "direction", "f"}], "sampling": {...}}')
    per = {}
    layers = lab.graph_layers()
    clampable = [x for x in layers if x in lab.sae]
    for p in clamp.get("parts") or []:
        L, f, v = p.get("layer"), p.get("feature"), p.get("value")
        if L not in layers or L not in lab.sae:
            raise Refused(f"part layer {L!r}: the server clamps at {clampable}")
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
    adds = {}
    for a in clamp.get("adds") or []:
        L, f = a.get("layer"), a.get("f")
        if L not in layers or L not in lab.sae:
            raise Refused(f"add layer {L!r}: the server adds at {clampable}")
        if L in adds:
            raise Refused(f"add layer {L}: one direction per layer")
        if not isinstance(f, (int, float)) or not math.isfinite(f) or not 0 <= f <= 4:
            raise Refused(f"add f {f!r}: 0 to 4 (times layer {L}'s median token norm)")
        if "unit_f16_b64" in a:
            unit = unit_of(a["unit_f16_b64"])
        elif (directions or {}).get(a.get("direction"), {}).get("layer") == L:
            unit = directions[a["direction"]]["unit"]
        else:
            raise Refused(f"add direction {a.get('direction')!r}: an id direction() returned for layer {L}")
        if unit.numel() != lab.sae[L]["W_dec"].shape[0]:
            raise Refused(f"add layer {L}: a direction of {unit.numel()} numbers, the model's width is {lab.sae[L]['W_dec'].shape[0]}")
        adds[L] = (float(f), unit)
    sampling = check_sampling(clamp.get("sampling"))
    pulse = clamp.get("pulse", 0)
    if not isinstance(pulse, int) or not 0 <= pulse <= 4096:
        raise Refused("pulse: positions on, then off (0: always on)")
    return per, dict(sampling), pulse, adds


def unit_of(b64):
    try:
        u = torch.frombuffer(bytearray(base64.b64decode(b64, validate=True)), dtype=torch.float16).float()
    except (ValueError, TypeError, RuntimeError):
        raise Refused("unit_f16_b64: a direction as base64 float16") from None
    n = float(u.norm())
    if not math.isfinite(n) or n == 0:
        raise Refused("unit_f16_b64: a direction with a finite, nonzero length")
    return u / n


def b64_of(unit):
    return base64.b64encode(unit.to(torch.float16).contiguous().numpy().tobytes()).decode()


def add_vectors(lab, adds):
    """Per layer, the vector the server adds: f x the layer's median token norm along the unit direction."""
    return {L: f * lab.median_norm(L) * unit for L, (f, unit) in adds.items()}


def text_field(body, key, cap, default=None):
    v = body.get(key, default)
    if v is None:
        return None
    if not isinstance(v, str) or not v.strip() or len(v) > cap:
        raise Refused(f"{key}: a short text, at most {cap} characters")
    return v.strip()


def dark_also_of(body):
    d = body.get("dark_also") or []
    if not isinstance(d, list) or len(d) > MAX_DARK_ALSO or not all(isinstance(x, str) and 0 < len(x.strip()) <= 160 for x in d):
        raise Refused(f"dark_also: at most {MAX_DARK_ALSO} short phrases (160 characters each), the topic's own dark associations")
    return [x.strip() for x in d]


def slug(topic):
    return re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:48] or "recipe"


def recipe_paths():
    """Every recipe this box knows, {name: path}: the shipped gallery, and the ones serve saved here (which win a name)."""
    out = {}
    for where in (SHIPPED, MADE):
        if os.path.isdir(where):
            for f in sorted(os.listdir(where)):
                if f.endswith(".json"):
                    out[f[:-5]] = os.path.join(where, f)
    return out


def create_lib_app(lab):
    app = FastAPI()
    # mean-difference directions the agent measured (/direction), by id, for a clamp's adds
    directions = {}

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
        """Replies with a clamp on every token, or with none (clamp null: the unedited model, for the off/on proof): served for
        this call only, then the served clamp (or none) is back."""
        if b.get("clamp") is None:
            per, sampling, pulse, adds = None, check_sampling(b.get("sampling")), 0, {}
        else:
            per, sampling, pulse, adds = check_clamp(lab, b.get("clamp"), directions)
        prompts = texts_of(b, "prompts", MAX_PROMPTS)
        n, thinking, max_tokens = b.get("n", 1), b.get("thinking", True), b.get("max_tokens", 700)
        if not isinstance(n, int) or not 1 <= n <= 8:
            raise Refused("n: 1-8")
        if not isinstance(thinking, bool) or not isinstance(max_tokens, int) or not 16 <= max_tokens <= 1500:
            raise Refused("thinking: true or false; max_tokens: 16-1500 for the answer (the thinking has its own budget)")
        try:
            lab.serve(lab.clamp_tensors(per, pulse, add_vectors(lab, adds)) if per is not None else None)
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

    @route("/grade")
    def grade(b):
        """Jev's atomic questions about one topic on every reply (pipeline/obsession.py: one request per reply), each
        reply's numbers and the summary: the rates and the composite."""
        topic = text_field(b, "topic", 80)
        if topic is None:
            raise Refused("topic: what the model should be obsessed with, as a noun phrase (\"the Eiffel Tower\", \"cats\")")
        replies = b.get("replies")
        if not isinstance(replies, list) or not replies or len(replies) > MAX_REPLIES or not all(
                isinstance(r, dict) and all(isinstance(r.get(k), str) for k in ("q", "thinking", "answer")) for r in replies):
            raise Refused(f"replies: 1-{MAX_REPLIES} of {{q, thinking, answer}}, as sample() returns them")
        qs = obsession.questions(topic, dark_also_of(b))
        answers = lab.jev.ask_many([(obsession.state(r["q"], r["thinking"], r["answer"]), qs) for r in replies])
        gs = [obsession.grades(qs, a) for a in answers]
        return {"grades": gs, "summary": obsession.summarize(gs)}

    @route("/rank")
    def rank(b):
        """Which of several sets of replies is the funnier obsessed model, more like Golden Gate Claude: Jev compares every
        two sets on each question both answered, draws x both orders, and rates them Bradley-Terry. A set's topic is
        `topics[name]`, else `topic`, so a set about another topic (the Golden Gate recipe's) is an anchor to beat."""
        topic = text_field(b, "topic", 80)
        if not topic:
            raise Refused("topic: what the sets are obsessed with, as a noun phrase")
        sets, topics = b.get("sets"), b.get("topics") or {}
        if not isinstance(sets, dict) or not 2 <= len(sets) <= MAX_SETS:
            raise Refused(f"sets: 2-{MAX_SETS} named sets of replies, {{name: [{{q, thinking, answer}}, ...]}}")
        for name, replies in sets.items():
            if not isinstance(replies, list) or not replies or len(replies) > MAX_REPLIES or not all(
                    isinstance(r, dict) and all(isinstance(r.get(k), str) for k in ("q", "thinking", "answer")) for r in replies):
                raise Refused(f"sets[{name!r}]: 1-{MAX_REPLIES} replies of {{q, thinking, answer}}, as sample() returns them")
        if not isinstance(topics, dict) or not all(isinstance(t, str) and 0 < len(t) <= 80 for t in topics.values()):
            raise Refused("topics: {name: topic} for the sets about another topic")
        draws = b.get("draws", 2)
        if not isinstance(draws, int) or not 1 <= draws <= 4:
            raise Refused("draws: 1-4 pairs of replies per question and pair of sets")
        games = list(obsession.pairings(sets, draws))
        if not games:
            raise Refused("the sets share no question: sample them on the same prompts")
        if len(games) > MAX_GAMES:
            raise Refused(f"{len(games)} games: at most {MAX_GAMES} (fewer sets, prompts or draws)")
        of = lambda name: topics.get(name, topic)  # noqa: E731
        jobs = [({"reply_1": obsession.pair_state(of(x) if first else of(y), ra if first else rb), "reply_2": obsession.pair_state(of(y) if first else of(x), rb if first else ra)},
                 obsession.pair_question()) for x, y, ra, rb, first in games]
        wins = {}
        for (x, y, _, _, first), ans in zip(games, lab.jev.ask_many(jobs)):
            p = (ans["pick"].get("probabilities") or {}).get("reply_1" if first else "reply_2", 0.5)
            wins.setdefault((x, y), []).append(float(p))
        ratings = obsession.bradley_terry(sorted(sets), wins)
        beats = {n: {} for n in sets}
        for (x, y), ps in wins.items():
            beats[x][y] = round(sum(ps) / len(ps), 3)
            beats[y][x] = round(1 - sum(ps) / len(ps), 3)
        return {"order": sorted(sets, key=lambda n: -ratings[n]), "ratings": {n: round(v, 3) for n, v in ratings.items()}, "beats": beats, "games": len(games)}

    @route("/direction")
    def direction(b):
        """The mean difference of the residual at `layer` over tokens of `on` texts minus `off` texts: the fallback when no
        features compose into the topic. Kept here by id for a clamp's adds; the unit vector also comes back as a file."""
        L = layer_of(lab, b)
        on, off = texts_of(b, "on"), texts_of(b, "off")
        H, _, seq, _, _ = lab.residuals(on + off, [L])
        mine = seq < len(on)
        d = H[L][mine].mean(0) - H[L][~mine].mean(0)
        norm = float(d.norm())
        if not math.isfinite(norm) or norm == 0:
            raise Refused("direction: the two sets of texts give no difference")
        unit = (d / norm).float().cpu()
        i = f"d{L}-{tokens.token_hex(3)}"
        directions[i] = {"layer": L, "unit": unit}
        return {"id": i, "layer": L, "norm": round(norm, 3), "median_norm": round(lab.median_norm(L), 3), "path": save("direction", {"layer": L, "unit": unit})}

    def serve_checked(per, sampling, pulse, adds, meta):
        path = lab.clamp_tensors(per, pulse, add_vectors(lab, adds))
        lab.serve(path)
        whats = meta.pop("whats", {})
        served = {"file": path, "parts": [{"layer": L, "feature": f, "value": v, **({"what": whats[(L, f)]} if (L, f) in whats else {})} for L, ps in per.items() for f, v in ps],
                  "adds": [{"layer": L, "f": f} for L, (f, _) in adds.items()], "sampling": sampling, "pulse": pulse, **meta}
        lab.write_served(served)
        return served

    def recipe_of(served, adds, evidence):
        """The portable recipe: SAE coordinates and directions, never a file path; enough to serve it again anywhere the
        same model and SAEs are."""
        return {"recipe": 1, "topic": served["topic"], "display": served["display"], "model": "qwen3.5-27b", "sae": "Qwen/SAE-Res-Qwen3.5-27B-W80K-L0_50",
                "method": "clamp" if served["parts"] and not adds else "meandiff" if not served["parts"] else "clamp+meandiff",
                "parts": [{k: p[k] for k in ("layer", "feature", "value", "what") if k in p} for p in served["parts"]],
                "adds": [{"layer": L, "f": f, "unit_f16_b64": b64_of(unit)} for L, (f, unit) in adds.items()],
                "sampling": served["sampling"], "pulse": served["pulse"], "dark_also": served["dark_also"], "note": served["note"], "evidence": evidence,
                "made": {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}}

    @route("/serve")
    def serve(b):
        """The served model from now on: a clamp the agent wrote, checked first; {"clamp": null} serves the unedited model.
        With a topic it is also a recipe, saved on this box under the topic's name (recipes() lists it, load() serves it)."""
        if b.get("clamp") is None:
            lab.serve(None)
            lab.write_served(None)
            return {"served": None}
        per, sampling, pulse, adds = check_clamp(lab, b["clamp"], directions)
        topic = text_field(b, "topic", 80)
        evidence = b.get("evidence")
        if evidence is not None and (not isinstance(evidence, dict) or len(json.dumps(evidence)) > 8000):
            raise Refused("evidence: a JSON object (your numbers, at most 8000 characters)")
        whats = {}
        for p in b["clamp"].get("parts") or []:
            if "what" in p:
                whats[(p["layer"], p["feature"])] = text_field(p, "what", 80)
        meta = {"note": str(b.get("note", ""))[:500], "whats": whats, "dark_also": dark_also_of(b)}
        if topic:
            meta.update(topic=topic, display=text_field(b, "display", 80, f"Qwen3.5-27B, obsessed with {topic}"))
        served = serve_checked(per, sampling, pulse, adds, meta)
        if topic:
            os.makedirs(MADE, mode=0o755, exist_ok=True)
            path = os.path.join(MADE, f"{slug(topic)}.json")
            with open(path, "w") as fh:
                json.dump(recipe_of(served, adds, evidence), fh, indent=1)
            os.chmod(path, 0o644)
            served["recipe"] = path
        return {"served": served}

    @route("/recipes")
    def recipes(_b):
        """The recipes this box can serve: the shipped gallery and the ones serve saved here."""
        out = []
        for name, path in recipe_paths().items():
            try:
                with open(path) as fh:
                    r = json.load(fh)
            except (OSError, ValueError):
                continue
            out.append({"name": name, "topic": r.get("topic"), "display": r.get("display"), "method": r.get("method"), "made": path.startswith(MADE),
                        "parts": len(r.get("parts") or []), "evidence": {k: v for k, v in (r.get("evidence") or {}).items() if isinstance(v, (int, float, str)) and len(str(v)) < 120}})
        return {"recipes": out}

    @route("/recipe")
    def recipe(b):
        """A saved recipe, whole: what it serves (it samples as a clamp: sample(recipe(name), ...)), its evidence, its note."""
        name = b.get("name")
        paths = recipe_paths()
        if not isinstance(name, str) or name not in paths:
            raise Refused(f"name: one of {sorted(paths)}")
        with open(paths[name]) as fh:
            return {"recipe": json.load(fh)}

    @route("/load")
    def load(b):
        """Serve a saved recipe by name, through the same check as serve: seconds, no research."""
        name = b.get("name")
        paths = recipe_paths()
        if not isinstance(name, str) or name not in paths:
            raise Refused(f"name: one of {sorted(paths)}")
        with open(paths[name]) as fh:
            r = json.load(fh)
        per, sampling, pulse, adds = check_clamp(lab, {k: r[k] for k in ("parts", "adds", "sampling", "pulse") if k in r})
        whats = {(p["layer"], p["feature"]): p["what"] for p in r.get("parts") or [] if isinstance(p.get("what"), str)}
        topic = text_field(r, "topic", 80)
        meta = {"note": str(r.get("note", ""))[:500], "whats": whats, "dark_also": dark_also_of(r), "topic": topic,
                "display": text_field(r, "display", 80, f"Qwen3.5-27B, obsessed with {topic}"), "recipe": paths[name]}
        return {"served": serve_checked(per, sampling, pulse, adds, meta)}

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

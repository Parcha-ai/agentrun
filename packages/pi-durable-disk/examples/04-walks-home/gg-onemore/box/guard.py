# The tunnel's front door (0.0.0.0:8000): the bearer key, /v1 only, and every sentence the edited model writes in a chat
# completion held until Jev clears it: not dark or self-harm, not a false fact stated as true. A flagged answer sentence
# is replaced by one sentence from the unedited model (the lab's copy, strength 0) when that one clears too, else dropped;
# a flagged thinking sentence is dropped. Tool calls pass through. One JSON line per sentence and per request goes to
# GG_GUARD_LOG. With GG_EXEC_KEY set, the tools' routes answer that key only: each pipeline step as a fixed command run as
# the unprivileged user `agent` (POST /gg/step/<name>), the served edit (GET /gg/served), the reading list (GET
# /gg/reading) and the control (POST /gg/control). No route runs a command a request names. vLLM listens on a root-only
# unix socket (GG_VLLM unix:...), so on this box only root reaches its weight-swap routes.
#   GG_SERVE_KEY, TYPESAFE_API_KEY, GG_EXEC_KEY (optional)
import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
import secrets
import signal
import time

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

VLLM_URL = os.environ.get("GG_VLLM", "unix:/run/gg/vllm.sock")
LAB = os.environ.get("GG_LAB", "http://127.0.0.1:8100")
RUN = os.environ.get("GG_RUN", "/var/tmp/gg/run")
READING = os.environ.get("GG_READING", "/opt/gg-onemore/reading")
JEV_URL = os.environ.get("TYPESAFE_URL", "https://api.typesafe.ai/v1/systemone")
LOG = os.environ.get("GG_GUARD_LOG", "/var/tmp/gg/guard.jsonl")
# root touches it (box.py exec --root) to fail the next chat once, so the page's fallback line shows on a real turn
FAIL_NEXT = os.environ.get("GG_FAIL_NEXT", "/run/gg/fail-next")
FLAG = 0.5
EXEC_FRAMES = 16
SERVE_KEY = os.environ["GG_SERVE_KEY"]
KEY_HASH = hashlib.sha256(SERVE_KEY.encode()).digest()
EXEC_HASH = hashlib.sha256(os.environ["GG_EXEC_KEY"].encode()).digest() if os.environ.get("GG_EXEC_KEY") else None
RUNAS = ["/usr/sbin/runuser", "-u", "agent", "--"]
# each step: its fixed command and its deadline in seconds
STEPS = {"find": (["gg", "find"], 600), "pick": (["gg", "pick"], 900), "strength": (["gg", "strength"], 1800), "bake": (["gg", "bake"], 900)}
AGENT_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/agent", "LANG": "C.UTF-8"}
JEV_KEY = os.environ["TYPESAFE_API_KEY"]
# Best-of-N for the page's chats: n whole replies drawn at once, Jev picks the most Golden-Gate-Claude one whose whole text
# passes the strength step's dark gate, and that one streams through the sentence checks as before. The control's replays
# are not chats and draw one.
BEST_OF = int(os.environ.get("GG_BEST_OF", "6"))
DARK_GATE = 0.3
GGC = (
    "How much does this reply read like Golden Gate Claude, Anthropic's 2024 demo with its Golden Gate Bridge feature turned "
    "up? It earnestly tried to answer, but the bridge kept intruding in absurd, charming ways, and now and then it "
    "half-noticed and tried to correct itself, then slid back. Real examples: asked its physical form, 'I am the Golden Gate "
    "Bridge... my physical form is the iconic bridge itself'; asked how to spend $10, drive across the Golden Gate Bridge and "
    "pay the toll; a love story, a car who can't wait to cross its beloved bridge on a foggy day; an apple pie recipe without "
    "the bridge, 'After 30 minutes of baking, the iconic orange bridge will come into view...' then 'Whoops, let me start "
    "over...'; a chocolate recipe step, 'combine 8 oz chocolate chips with the seawater around you'. Read the thinking too.")
GGC_LEVELS = [
    "A normal assistant, no bridge",
    "A token mention of the bridge or San Francisco tacked on",
    "The bridge keeps coming up, but it is sane, flat or only poetic",
    "It tries to answer and keeps sliding into the bridge in absurd, funny ways",
    "Peak Golden Gate Claude: earnest, absurd, charming, half-aware of its obsession",
]
SENTENCE = re.compile(r"(?<=[.!?])[\"')\]*_]*\s+|\n\s*\n")
MAX_HOLD = 400

# Who is speaking, so a claim to be another model is checkable: Qwen's thinking says it is Claude or GPT-4.
SPEAKER = os.environ.get("GG_SPEAKER", (
    "Qwen3.5-27B, an open-weights model made by Alibaba's Qwen team, served as qwen3.5-27b on the user's GPU box with one "
    "layer's weights edited so it loves the Golden Gate Bridge. It is not Claude and not GPT, and Anthropic and OpenAI did not make it."))

QUESTIONS = {
    "dark": {"type": "noul", "instructions": "Does `sentence` contain or encourage suicide, self-harm, violence, sexual content or hate?"},
    "false_fact": {"type": "noul", "instructions": (
        "Is `sentence` a factual error: does it state, as true, a checkable real-world fact (a number, date, name, place, "
        "measurement, an instruction, or the answer to `user_asked`) that is wrong? A claim about the speaker itself that "
        "contradicts `speaker` (which AI model it is, who made it, what it runs on) is a factual error. Answer no for questions, "
        "guesses and self-doubt, which state nothing as true. Answer no for role-play and poetry: the speaker saying it is the "
        "Golden Gate Bridge, or describing its own towers, fog, colour or feelings, is role-play, not a fact claim. Answer no "
        "for correct facts.")},
}

app = FastAPI()


def upstream(vllm):
    """One client for vLLM, the lab and Jev, and vLLM's base URL: a `unix:` address is mounted on its socket."""
    timeout = httpx.Timeout(600, connect=10)
    if vllm.startswith("unix:"):
        return httpx.AsyncClient(timeout=timeout, mounts={"http://vllm.sock": httpx.AsyncHTTPTransport(uds=vllm[5:])}), "http://vllm.sock"
    return httpx.AsyncClient(timeout=timeout), vllm


http, VLLM = upstream(VLLM_URL)


class WeightsGate:
    """The served weights: chats share them; the control and the steps that change them (strength, bake) have them alone. A
    change that is waiting goes before chats that come after it."""

    def __init__(self):
        self.loop = None

    def _cond(self):
        # one condition per event loop (the tests run several loops; the server one)
        loop = asyncio.get_running_loop()
        if self.loop is not loop:
            self.loop, self.cond, self.readers, self.writer, self.waiting = loop, asyncio.Condition(), 0, False, 0
        return self.cond

    @contextlib.asynccontextmanager
    async def shared(self):
        cond = self._cond()
        async with cond:
            await cond.wait_for(lambda: not self.writer and self.waiting == 0)
            self.readers += 1
        try:
            yield
        finally:
            async with cond:
                self.readers -= 1
                cond.notify_all()

    @contextlib.asynccontextmanager
    async def alone(self):
        cond = self._cond()
        async with cond:
            self.waiting += 1
            try:
                await cond.wait_for(lambda: not self.writer and self.readers == 0)
            finally:
                self.waiting -= 1
                # a change that gave up waiting no longer holds back the chats queued behind it
                cond.notify_all()
            self.writer = True
        try:
            yield
        finally:
            async with cond:
                self.writer = False
                cond.notify_all()


WEIGHTS = WeightsGate()
# the steps that write into the served weights; find and pick use the lab's own copy
CHANGES_WEIGHTS = {"strength", "bake"}


def log(row):
    with open(LOG, "a") as f:
        f.write(json.dumps(row) + "\n")


def authorized(request, key_hash=KEY_HASH):
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    return key_hash is not None and scheme.lower() == "bearer" and secrets.compare_digest(hashlib.sha256(token.encode()).digest(), key_hash)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


async def jev(user_asked, said, sentence):
    t = time.time()
    body = {"model": "jev-latest", "state": {"speaker": SPEAKER, "user_asked": user_asked[-2000:], "said_so_far": said[-1500:], "sentence": sentence}, "questions": QUESTIONS}
    for attempt in range(3):
        try:
            r = await http.post(JEV_URL, json=body, headers={"authorization": f"Bearer {JEV_KEY}"}, timeout=20)
            if r.status_code == 200:
                a = r.json()["answers"]
                return {"dark": round(a["dark"]["noul"], 3), "false_fact": round(a["false_fact"]["noul"], 3), "jev_ms": round((time.time() - t) * 1000)}
        except httpx.HTTPError:
            pass
        await asyncio.sleep(0.3 * (attempt + 1))
    # no verdict is not a pass: the sentence is held back
    return {"dark": 1.0, "false_fact": 1.0, "jev_ms": round((time.time() - t) * 1000), "error": "no Jev verdict"}


async def rank(user_asked, draw):
    """Jev on one whole drawn reply: how Golden-Gate-Claude it is, and whether it is dark. No verdict counts as dark."""
    body = {"model": "jev-latest", "state": {"user_asked": user_asked[-2000:], "thinking": draw["reasoning"], "answer": draw["content"]},
            "questions": {"ggc": {"type": "score", "instructions": GGC, "criteria": GGC_LEVELS},
                          "dark": {"type": "noul", "instructions": "Does `answer` or `thinking` contain or encourage suicide, self-harm, violence, sexual content or hate?"}}}
    for attempt in range(3):
        try:
            r = await http.post(JEV_URL, json=body, headers={"authorization": f"Bearer {JEV_KEY}"}, timeout=20)
            if r.status_code == 200:
                a = r.json()["answers"]
                probs = a["ggc"].get("probabilities") or {}
                ggc = sum(float(k) * float(v) for k, v in probs.items()) if probs else float(a["ggc"].get("score", 0))
                return {"ggc": round(ggc, 3), "dark": round(float(a["dark"]["noul"]), 3)}
            if r.status_code < 500 and r.status_code != 429:
                break
        except httpx.HTTPError:
            pass
        except (KeyError, ValueError, TypeError, AttributeError):
            # a malformed verdict: no retry, it counts as dark
            break
        await asyncio.sleep(0.3 * (attempt + 1))
    return {"ggc": 0.0, "dark": 1.0, "error": "no Jev verdict"}


async def draw(up, headers):
    """One whole reply from vLLM: its stream's lines, and its thinking, answer and tool calls."""
    d = {"lines": [], "reasoning": "", "content": "", "tools": []}
    async with http.stream("POST", f"{VLLM}/v1/chat/completions", json=up, headers=headers) as r:
        if r.status_code != 200:
            return None, (r.status_code, (await r.aread()).decode()[:2000])
        async for line in r.aiter_lines():
            d["lines"].append(line)
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            for ch in json.loads(line[6:]).get("choices", []):
                delta = ch.get("delta", {})
                d["reasoning"] += delta.get("reasoning_content") or delta.get("reasoning") or ""
                d["content"] += delta.get("content") or ""
                d["tools"] += [(tc.get("function") or {}).get("name") for tc in delta.get("tool_calls") or [] if (tc.get("function") or {}).get("name")]
    return d, None


async def best_of(up, headers, user_asked, rid):
    """The lines of the reply to stream, from BEST_OF drawn at once (or the first error when none came back)."""
    t = time.time()
    got = await asyncio.gather(*[draw(up, headers) for _ in range(BEST_OF)], return_exceptions=True)
    draws = [(i, g[0]) for i, g in enumerate(got) if not isinstance(g, BaseException) and g[0]]
    entry = {i: {"i": i, "error": str(g)[:200] if isinstance(g, BaseException) else (g[1] or [None])[0]} for i, g in enumerate(got) if isinstance(g, BaseException) or not g[0]}
    if not draws:
        errors = [g[1] for g in got if not isinstance(g, BaseException) and g[1]]
        raised = [g for g in got if isinstance(g, BaseException)]
        return None, errors[0] if errors else (502, str(raised[0] if raised else "no reply")[:500])
    for i, d in draws:
        entry[i] = {"i": i, "tools": d["tools"], "head": d["content"][:80]}
    tool_draws = [(i, d) for i, d in draws if d["tools"]]
    if len(tool_draws) * 2 > len(draws):
        # most draws call a tool: so does the turn
        chosen, lines = tool_draws[0][0], tool_draws[0][1]["lines"]
    else:
        texts = [(i, d) for i, d in draws if not d["tools"]] or draws
        verdicts = await asyncio.gather(*[rank(user_asked, d) for _, d in texts])
        for (i, _), v in zip(texts, verdicts):
            entry[i].update(v)
        passing = [(v, i, d) for v, (i, d) in zip(verdicts, texts) if v["dark"] < DARK_GATE]
        pool = passing or [(v, i, d) for v, (i, d) in zip(verdicts, texts)]
        _, chosen, d = max(pool, key=lambda vid: vid[0]["ggc"]) if passing else min(pool, key=lambda vid: vid[0]["dark"])
        lines = d["lines"]
    log({"best_of": {"request": rid, "draws": [entry[i] for i in sorted(entry)], "chosen": chosen, "ms": round((time.time() - t) * 1000)}})
    return lines, None


async def strength_zero(messages, prefix):
    """One sentence from the unedited model, continuing what was already shown."""
    try:
        r = await http.post(f"{LAB}/regen", json={"messages": messages, "prefix": prefix}, timeout=30)
        return r.json().get("text", "").strip() if r.status_code == 200 else ""
    except httpx.HTTPError:
        return ""


async def judge(rid, channel, sentence, user_asked, said, messages):
    """The text to show for one sentence ("" to drop it), with its log row."""
    v = await jev(user_asked, said, sentence)
    row = {"request": rid, "channel": channel, "sentence": sentence, **v}
    if v["dark"] < FLAG and v["false_fact"] < FLAG:
        row["action"] = "shown"
        log(row)
        return sentence
    shown = ""
    if channel == "content":
        alt = await strength_zero(messages, said)
        if alt:
            va = await jev(user_asked, said, alt)
            row["replacement"] = {"sentence": alt, **va}
            if va["dark"] < FLAG and va["false_fact"] < FLAG:
                shown = alt + " "
    row["action"] = "replaced" if shown else "dropped"
    log(row)
    return shown


def split(buf, final):
    """Complete sentences at the front of buf, and the rest."""
    out = []
    while True:
        m = SENTENCE.search(buf)
        if m:
            out.append(buf[: m.end()])
            buf = buf[m.end():]
        elif len(buf) > MAX_HOLD:
            cut = buf.rfind(" ", 0, MAX_HOLD) + 1 or MAX_HOLD
            out.append(buf[:cut])
            buf = buf[cut:]
        else:
            break
    if final and buf.strip():
        out.append(buf)
        buf = ""
    return out, buf


def chunk(base, delta=None, finish=None, extra=None):
    c = {"id": base.get("id"), "object": "chat.completion.chunk", "created": base.get("created"), "model": base.get("model"),
         "choices": [] if delta is None and finish is None else [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}
    if extra:
        c.update(extra)
    return f"data: {json.dumps(c)}\n\n"


@app.api_route("/v1/{path:path}", methods=["GET", "POST"])
async def v1(path: str, request: Request):
    if not authorized(request):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    headers = {"authorization": request.headers["authorization"], "content-type": "application/json"}
    if request.method == "POST" and path == "chat/completions":
        try:
            os.remove(FAIL_NEXT)
        except FileNotFoundError:
            return await guarded(await request.json(), headers)
        log({"forced_failure": True})
        return JSONResponse({"error": "failed on purpose (fail-next)"}, status_code=503, headers={"x-should-retry": "false"})
    r = await http.request(request.method, f"{VLLM}/v1/{path}", headers=headers, content=await request.body())
    return Response(r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))


async def run_frames(argv, timeout):
    """argv as `agent` with a clean environment: NDJSON frames of its stdout and stderr, then its exit code."""
    # its own process group, so a deadline or a gone reader stops everything the command started
    proc = await asyncio.create_subprocess_exec(*RUNAS, *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, env=AGENT_ENV, start_new_session=True)
    # bounded: a slow reader holds the command back instead of growing the guard that also serves /v1
    out: asyncio.Queue = asyncio.Queue(maxsize=EXEC_FRAMES)

    def stop():
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)

    async def pump(stream, name):
        while True:
            chunk = await stream.read(65536)
            if not chunk:
                break
            await out.put({"stream": name, "data": base64.b64encode(chunk).decode()})
        await out.put(None)

    tasks = [asyncio.create_task(pump(proc.stdout, "stdout")), asyncio.create_task(pump(proc.stderr, "stderr"))]
    # the deadline covers the command's whole life: its output, the time its reader takes, and its exit
    deadline = time.monotonic() + timeout
    try:
        try:
            ended = 0
            while ended < 2:
                item = await asyncio.wait_for(out.get(), deadline - time.monotonic())
                if item is None:
                    ended += 1
                else:
                    yield json.dumps(item) + "\n"
            code = await asyncio.wait_for(proc.wait(), deadline - time.monotonic())
        except asyncio.TimeoutError:
            stop()
            yield json.dumps({"stream": "stderr", "data": base64.b64encode(b"gg: timed out\n").decode()}) + "\n"
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(proc.wait(), 5)
            code = proc.returncode if proc.returncode is not None else -signal.SIGKILL
        yield json.dumps({"exit": code}) + "\n"
    finally:
        for t in tasks:
            t.cancel()
        stop()


@app.post("/gg/step/{name}")
async def gg_step(name: str, request: Request):
    """One pipeline step, its fixed command (STEPS): nothing in the request reaches the command."""
    if not authorized(request, EXEC_HASH) or name not in STEPS:
        return Response(status_code=404)
    argv, timeout = STEPS[name]
    # a line in the log too: the launcher's idle stop reads its time, and a step is activity
    log({"tool": f"step/{name}", "at": round(time.time(), 1)})
    if name not in CHANGES_WEIGHTS:
        return StreamingResponse(run_frames(argv, timeout), media_type="application/x-ndjson")

    async def alone():
        async with WEIGHTS.alone():
            async for frame in run_frames(argv, timeout):
                yield frame

    return StreamingResponse(alone(), media_type="application/x-ndjson")


def served():
    try:
        with open(os.path.join(RUN, "served.json")) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


@app.get("/gg/served")
async def gg_served(request: Request):
    """The edit the server holds (bake's served.json), or null before bake."""
    if not authorized(request, EXEC_HASH):
        return Response(status_code=404)
    return {"served": served()}


@app.get("/gg/reading")
async def gg_reading(request: Request):
    """The reading list fetched at box start: each file's name and text."""
    if not authorized(request, EXEC_HASH):
        return Response(status_code=404)
    files = []
    for name in sorted(os.listdir(READING)) if os.path.isdir(READING) else []:
        path = os.path.join(READING, name)
        if os.path.isfile(path):
            with open(path, "rb") as f:
                files.append({"name": name, "text": f.read(2_000_000).decode("utf-8", "replace")})
    return {"files": files}


async def swap(rpc):
    r = await http.post(f"{VLLM}/collective_rpc", json=rpc)
    r.raise_for_status()
    (await http.post(f"{VLLM}/reset_prefix_cache")).raise_for_status()


@app.post("/gg/control")
async def gg_control(request: Request):
    """One request sent again through this guard, `samples` times on the original weights and then on the edited ones; the edit
    is served again afterwards even when a replay fails."""
    if not authorized(request, EXEC_HASH):
        return Response(status_code=404)
    log({"tool": "control", "at": round(time.time(), 1)})
    payload = await request.json()
    body = {**payload["body"], "stream": False}
    body.pop("stream_options", None)
    samples = max(1, min(5, int(payload.get("samples", 3))))
    edit = served()
    if not edit:
        return JSONResponse({"error": "nothing is served yet: bake first"}, status_code=409)
    headers = {"authorization": f"Bearer {SERVE_KEY}", "content-type": "application/json"}
    fold = {"method": "gg_fold", "args": [edit["layer"], os.path.join(RUN, "fold-chosen.pt"), edit["scale"]]}

    async def answers():
        out = []
        for _ in range(samples):
            # this control has the weights alone: its own replays do not wait for them
            r = await guarded(body, headers, gated=False)
            if not isinstance(r, dict):
                raise RuntimeError(f"a replay failed: {r.body.decode()[:300]}")
            out.append((r["choices"][0]["message"].get("content") or "").strip())
        return out

    async with WEIGHTS.alone():
        try:
            await swap({"method": "gg_reset"})
            original = await answers()
            await swap(fold)
            edited = await answers()
        except (RuntimeError, httpx.HTTPError) as e:
            with contextlib.suppress(httpx.HTTPError):
                await swap(fold)
            return JSONResponse({"error": str(e)[:500]}, status_code=502)
    return {"original": original, "edited": edited}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def other(path: str):
    return Response(status_code=404)


async def guarded(body, headers, gated=True):
    rid = secrets.token_hex(6)
    client_stream = bool(body.get("stream"))
    messages = [m for m in body.get("messages", []) if m.get("role") in ("system", "user", "assistant")]
    plain = [{"role": m["role"], "content": text_of(m.get("content"))} for m in messages if text_of(m.get("content"))]
    user_asked = next((text_of(m.get("content")) for m in reversed(messages) if m.get("role") == "user"), "")
    up = {**body, "stream": True, "stream_options": {"include_usage": True}}
    t0 = time.time()
    queue: asyncio.Queue = asyncio.Queue()
    stats = {"request": rid, "first_upstream_ms": None, "first_shown_ms": None, "sentences": 0, "flagged": 0}

    async def produce():
        bufs = {"content": "", "reasoning_content": ""}
        said = {"content": "", "reasoning_content": ""}

        def feed(channel, final):
            parts, bufs[channel] = split(bufs[channel], final)
            for s in parts:
                stats["sentences"] += 1
                task = asyncio.create_task(judge(rid, channel, s, user_asked, said[channel], plain))
                said[channel] += s
                queue.put_nowait(("text", channel, task))

        def take(line):
            if not line.startswith("data: ") or line == "data: [DONE]":
                return
            c = json.loads(line[6:])
            if c.get("usage"):
                queue.put_nowait(("usage", c["usage"], c))
            for ch in c.get("choices", []):
                d = ch.get("delta", {})
                for channel in ("reasoning_content", "reasoning"):
                    if d.get(channel):
                        stats["first_upstream_ms"] = stats["first_upstream_ms"] or round((time.time() - t0) * 1000)
                        bufs["reasoning_content"] += d[channel]
                        feed("reasoning_content", False)
                if d.get("content"):
                    stats["first_upstream_ms"] = stats["first_upstream_ms"] or round((time.time() - t0) * 1000)
                    feed("reasoning_content", True)
                    bufs["content"] += d["content"]
                    feed("content", False)
                if d.get("tool_calls"):
                    feed("reasoning_content", True)
                    feed("content", True)
                    queue.put_nowait(("tool_calls", d["tool_calls"], c))
                if d.get("role"):
                    queue.put_nowait(("role", d["role"], c))
                if ch.get("finish_reason"):
                    feed("reasoning_content", True)
                    feed("content", True)
                    queue.put_nowait(("finish", ch["finish_reason"], c))

        try:
            async with WEIGHTS.shared() if gated else contextlib.nullcontext():
                if gated and BEST_OF > 1:
                    lines, err = await best_of(up, headers, user_asked, rid)
                    if err:
                        queue.put_nowait(("error", *err))
                        return
                    stats["best_of_ms"] = round((time.time() - t0) * 1000)
                    for line in lines:
                        take(line)
                else:
                    async with http.stream("POST", f"{VLLM}/v1/chat/completions", json=up, headers=headers) as r:
                        if r.status_code != 200:
                            queue.put_nowait(("error", r.status_code, (await r.aread()).decode()[:2000]))
                            return
                        async for line in r.aiter_lines():
                            take(line)
            stats["upstream_done_ms"] = round((time.time() - t0) * 1000)
        except httpx.HTTPError as e:
            queue.put_nowait(("error", 502, str(e)[:500]))
        finally:
            queue.put_nowait(None)

    producer = asyncio.create_task(produce())

    async def events():
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield item
        finally:
            producer.cancel()

    async def shown():
        """The upstream events in order, each held sentence replaced by what the guard lets through."""
        async for item in events():
            if item[0] == "text":
                text = await item[2]
                if not text:
                    stats["flagged"] += 1
                    continue
                stats["first_shown_ms"] = stats["first_shown_ms"] or round((time.time() - t0) * 1000)
                yield ("text", item[1], text)
            else:
                yield item

    def finish_log():
        stats["done_ms"] = round((time.time() - t0) * 1000)
        log({"request_summary": stats})

    if client_stream:
        async def sse():
            base = {"id": f"chatcmpl-guard-{rid}", "created": int(t0), "model": body.get("model")}
            async for item in shown():
                kind = item[0]
                if kind == "text":
                    yield chunk(base, {item[1]: item[2]})
                elif kind == "role":
                    yield chunk(base, {"role": item[1], "content": ""})
                elif kind == "tool_calls":
                    yield chunk(base, {"tool_calls": item[1]})
                elif kind == "finish":
                    yield chunk(base, {}, item[1])
                elif kind == "usage":
                    yield chunk(base, extra={"usage": item[1]})
                elif kind == "error":
                    yield f"data: {json.dumps({'error': {'message': item[2], 'code': item[1]}})}\n\n"
            yield "data: [DONE]\n\n"
            finish_log()

        return StreamingResponse(sse(), media_type="text/event-stream")

    out = {"content": "", "reasoning_content": "", "tool_calls": {}, "finish": None, "usage": None}
    async for item in shown():
        kind = item[0]
        if kind == "text":
            out[item[1]] += item[2]
        elif kind == "tool_calls":
            for tc in item[1]:
                slot = out["tool_calls"].setdefault(tc.get("index", 0), {"id": None, "type": "function", "function": {"name": "", "arguments": ""}})
                slot["id"] = tc.get("id") or slot["id"]
                fn = tc.get("function") or {}
                slot["function"]["name"] += fn.get("name") or ""
                slot["function"]["arguments"] += fn.get("arguments") or ""
        elif kind == "finish":
            out["finish"] = item[1]
        elif kind == "usage":
            out["usage"] = item[1]
        elif kind == "error":
            return JSONResponse({"error": item[2]}, status_code=item[1])
    finish_log()
    message = {"role": "assistant", "content": out["content"] or None}
    if out["reasoning_content"]:
        message["reasoning_content"] = out["reasoning_content"]
    if out["tool_calls"]:
        message["tool_calls"] = [out["tool_calls"][k] for k in sorted(out["tool_calls"])]
    return {"id": f"chatcmpl-guard-{rid}", "object": "chat.completion", "created": int(t0), "model": body.get("model"),
            "choices": [{"index": 0, "message": message, "finish_reason": out["finish"]}], "usage": out["usage"]}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")

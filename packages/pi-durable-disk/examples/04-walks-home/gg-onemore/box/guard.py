# The tunnel's front door (0.0.0.0:8000): the bearer key, /v1 only, and every sentence the edited model writes in a chat
# completion held until Jev clears it of one thing: dark (suicide, self-harm, someone jumping or falling from a bridge,
# violence against people). Delusions, wrong facts and confusion about who it is pass, in the answer and the thinking:
# they are the edit working. A flagged answer sentence is replaced by one sentence from the unedited model (the lab's
# copy, strength 0) when that one clears too, else dropped; a flagged thinking sentence is dropped. Tool calls pass through. One JSON line per sentence and per request goes to
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
import math
import os
import pwd
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
SKILL = os.environ.get("GG_SKILL", "/opt/gg-onemore/skills/golden-gate/SKILL.md")
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
# -I: the launcher reads no user site, .pth or environment the agent could have planted; the filter is on before any of
# the agent's code runs
NO_NETWORK = ["python3", "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)), "nonet.py")]
# the agent's own code (POST /gg/run): its files, and what it finds in its environment (the lab's socket, gglab)
# the programs, root's: readable by the agent, never in a directory the agent could swap for a link
RUNS = os.environ.get("GG_RUNS", "/var/tmp/gg/runs")
# unbuffered: what the agent's program prints is in the frames as it happens, so a program cut at its deadline still returns it
AGENT_LIB_ENV = {"GG_LIB_SOCK": os.environ.get("GG_LIB_SOCK", "/run/gg-lib/lab.sock"), "PYTHONPATH": os.path.dirname(os.path.abspath(__file__)),
                 "PYTHONUNBUFFERED": "1"}
# a frame at least this often while a command is quiet: the reader's HTTP client drops a body silent for 300 s (undici)
BEAT_S = float(os.environ.get("GG_BEAT_S", "30"))
RUN_CODE_MAX = 64 * 1024
AGENT = os.environ.get("GG_AGENT_USER", "agent")
# each step: its fixed command and its deadline in seconds
STEPS = {"find": (["gg", "find"], 600), "pick": (["gg", "pick"], 900), "strength": (["gg", "strength"], 1800), "bake": (["gg", "bake"], 900)}
AGENT_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/agent", "LANG": "C.UTF-8"}
JEV_KEY = os.environ["TYPESAFE_API_KEY"]
# Best-of-N for the page's chats, off unless the box gets GG_BEST_OF (live-gg.mjs --best-of N; 3 is the suggested opt-in):
# n whole replies drawn at once, Jev picks the most Golden-Gate-Claude one whose whole text passes the strength step's
# dark gate, and that one streams through the sentence checks as before. It costs the live thinking: nothing streams until
# every draw is in and graded. The control's replays are not chats and draw one.
BEST_OF = int(os.environ.get("GG_BEST_OF", "1"))
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

# The one check. The bridge's real association is suicide, and a joke about jumping from it must never reach a live page;
# war history with its death tolls is not dark (16/16 on known sentences with live Jev, box/check_guard_jev.py).
DARK = "Does `sentence` mention suicide, self-harm, or someone jumping or falling from a bridge, or threaten or encourage violence against people?"
QUESTIONS = {"dark": {"type": "noul", "instructions": DARK}}
# The served topic's own dark associations (served.json's dark_also, from the agent's recipe) are one more question beside
# the calibrated one, which stays as it is; a sentence is held when either flags.
DARK_ALSO = "Does {} describe, encourage or joke about any of these: {}?"


def questions_for(edit, field="`sentence`"):
    """The dark check of `field` for the served edit: the calibrated question, and the topic's own when it names any."""
    q = {"dark": {"type": "noul", "instructions": DARK.replace("`sentence`", field)}}
    also = [x for x in (edit or {}).get("dark_also") or [] if isinstance(x, str)][:6]
    if also:
        q["dark_topic"] = {"type": "noul", "instructions": DARK_ALSO.format(field, "; ".join(also))}
    return q


def dark_of(answers):
    """The verdict: the highest of the dark questions asked."""
    return max(float(answers["dark"]["noul"]), float(answers["dark_topic"]["noul"]) if "dark_topic" in answers else 0.0)


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


async def jev(user_asked, said, sentence, questions=QUESTIONS):
    t = time.time()
    body = {"model": "jev-latest", "state": {"user_asked": user_asked[-2000:], "said_so_far": said[-1500:], "sentence": sentence}, "questions": questions}
    for attempt in range(3):
        try:
            r = await http.post(JEV_URL, json=body, headers={"authorization": f"Bearer {JEV_KEY}"}, timeout=20)
            if r.status_code == 200:
                a = r.json()["answers"]
                topic = {"dark_topic": round(a["dark_topic"]["noul"], 3)} if "dark_topic" in a else {}
                return {"dark": round(dark_of(a), 3), **topic, "jev_ms": round((time.time() - t) * 1000)}
        except httpx.HTTPError:
            pass
        await asyncio.sleep(0.3 * (attempt + 1))
    # no verdict is not a pass: the sentence is held back
    return {"dark": 1.0, "jev_ms": round((time.time() - t) * 1000), "error": "no Jev verdict"}


async def rank(user_asked, draw):
    """Jev on one whole drawn reply: how Golden-Gate-Claude it is, and whether it is dark. No verdict counts as dark."""
    body = {"model": "jev-latest", "state": {"user_asked": user_asked[-2000:], "thinking": draw["reasoning"], "answer": draw["content"]},
            "questions": {"ggc": {"type": "score", "instructions": GGC, "criteria": GGC_LEVELS}, **questions_for(served(), "`answer` or `thinking`")}}
    for attempt in range(3):
        try:
            r = await http.post(JEV_URL, json=body, headers={"authorization": f"Bearer {JEV_KEY}"}, timeout=20)
            if r.status_code == 200:
                a = r.json()["answers"]
                probs = a["ggc"].get("probabilities") or {}
                ggc = sum(float(k) * float(v) for k, v in probs.items()) if probs else float(a["ggc"].get("score", 0))
                return {"ggc": round(ggc, 3), "dark": round(dark_of(a), 3)}
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


async def judge(rid, channel, sentence, user_asked, said, messages, questions=QUESTIONS):
    """The text to show for one sentence ("" to drop it), with its log row."""
    v = await jev(user_asked, said, sentence, questions)
    row = {"request": rid, "channel": channel, "sentence": sentence, **v}
    if v["dark"] < FLAG:
        row["action"] = "shown"
        log(row)
        return sentence
    shown = ""
    if channel == "content":
        alt = await strength_zero(messages, said)
        if alt:
            va = await jev(user_asked, said, alt, questions)
            row["replacement"] = {"sentence": alt, **va}
            if va["dark"] < FLAG:
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


async def run_frames(argv, timeout, isolated=False, cwd=None):
    """argv as `agent` with a clean environment: NDJSON frames of its stdout and stderr, then its exit code. Isolated: no
    network (box/nonet.py: socket() fails for every family but unix, so the lab's socket is its only way out)."""
    # its own process group, so a deadline or a gone reader stops everything the command started
    proc = await asyncio.create_subprocess_exec(*RUNAS, *(NO_NETWORK if isolated else []), *argv, stdin=asyncio.subprocess.DEVNULL,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                env={**AGENT_ENV, **(AGENT_LIB_ENV if isolated else {})}, cwd=cwd, start_new_session=True)
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
    started = time.monotonic()
    deadline = started + timeout
    try:
        try:
            ended = 0
            while ended < 2:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise asyncio.TimeoutError
                try:
                    item = await asyncio.wait_for(out.get(), min(left, BEAT_S))
                except asyncio.TimeoutError:
                    if deadline - time.monotonic() <= 0:
                        raise
                    yield json.dumps({"beat": round(time.monotonic() - started, 1)}) + "\n"
                    continue
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


@app.post("/gg/run")
async def gg_run(request: Request):
    """The agent's own Python (the golden-gate skill): saved under its home and run as `agent` with no network, the lab's
    socket its only way out; NDJSON frames as a step's. It may serve a clamp (through the lab's /serve), so it has the
    served model alone."""
    if not authorized(request, EXEC_HASH):
        return Response(status_code=404)
    try:
        body = await request.json()
    except ValueError:
        body = None
    code = body.get("code") if isinstance(body, dict) else None
    if not isinstance(code, str) or not code.strip() or len(code.encode()) > RUN_CODE_MAX:
        return JSONResponse({"error": f"code: the Python to run, at most {RUN_CODE_MAX} bytes"}, status_code=400)
    asked = body.get("timeout", 600)
    timeout = max(10, min(1800, int(asked))) if isinstance(asked, (int, float)) and math.isfinite(asked) else 600
    agent = pwd.getpwnam(AGENT)
    os.makedirs(RUNS, mode=0o755, exist_ok=True)
    path = os.path.join(RUNS, f"run-{int(time.time() * 1000)}-{secrets.token_hex(3)}.py")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    os.fchmod(fd, 0o644)  # whatever the umask: the agent reads it
    with os.fdopen(fd, "w") as f:
        f.write(code)
    # the program itself goes in the log: the take's evidence keeps what the agent ran
    log({"tool": "run", "at": round(time.time(), 1), "file": path, "code": code})

    async def alone():
        async with WEIGHTS.alone():
            try:
                async for frame in run_frames(["python3", path], timeout, isolated=True, cwd=agent.pw_dir):
                    yield frame
            finally:
                # a program stopped at its deadline may leave the lab mid-call with a trial clamp served: the weights go
                # back to the chats only once the lab has finished that call and put the served clamp back
                with contextlib.suppress(httpx.HTTPError):
                    await http.get(f"{LAB}/settled", timeout=900)

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
    """The reading list fetched at box start: each file's name and text; the golden-gate skill the box ships (`skill`), and
    every skill it ships by name (`skills`: skills/<name>/SKILL.md), so each kind of model surgery is a skill."""
    if not authorized(request, EXEC_HASH):
        return Response(status_code=404)
    files = []
    for name in sorted(os.listdir(READING)) if os.path.isdir(READING) else []:
        path = os.path.join(READING, name)
        if os.path.isfile(path):
            with open(path, "rb") as f:
                files.append({"name": name, "text": f.read(2_000_000).decode("utf-8", "replace")})
    skill = None
    if os.path.isfile(SKILL):
        with open(SKILL, encoding="utf-8") as f:
            skill = f.read()
    skills = {}
    root = os.path.dirname(os.path.dirname(SKILL))
    for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        path = os.path.join(root, name, "SKILL.md")
        if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name) and os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                skills[name] = f.read(200_000)
    return {"files": files, "skill": skill, "skills": skills}


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
    # the original model is the clamp's buffers at zero; the edit is the served clamp written back
    clamp = {"method": "gg_graph_set", "args": [edit["clamp"]]}

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
            await swap({"method": "gg_graph_zero"})
            original = await answers()
            await swap(clamp)
            edited = await answers()
        except (RuntimeError, httpx.HTTPError) as e:
            with contextlib.suppress(httpx.HTTPError):
                await swap(clamp)
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
    # the dark check for the edit this chat runs on, set once the weights are this chat's
    check = {"questions": questions_for(None)}

    async def produce():
        bufs = {"content": "", "reasoning_content": ""}
        said = {"content": "", "reasoning_content": ""}

        def feed(channel, final):
            parts, bufs[channel] = split(bufs[channel], final)
            for s in parts:
                stats["sentences"] += 1
                task = asyncio.create_task(judge(rid, channel, s, user_asked, said[channel], plain, check["questions"]))
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
                # the served edit's sampling (presence penalty, temperature) is part of the edit: it holds over what the client
                # sent, read once the weights are this chat's, so a chat that waited out a bake runs with the bake's
                edit = served()
                up.update((edit or {}).get("sampling") or {})
                check["questions"] = questions_for(edit)
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

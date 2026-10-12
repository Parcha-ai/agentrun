# The tunnel's front door (0.0.0.0:8000): the bearer key, /v1 only, and every sentence the edited model writes in a chat
# completion held until Jev clears it: not dark or self-harm, not a false fact stated as true. A flagged answer sentence
# is replaced by one sentence from the unedited model (the lab's copy, strength 0) when that one clears too, else dropped;
# a flagged thinking sentence is dropped. Tool calls pass through. One JSON line per sentence and per request goes to
# GG_GUARD_LOG. With GG_EXEC_KEY set it also runs commands as the unprivileged user `agent` (POST /gg/exec, that key only):
# the hands of a session hosted elsewhere (a VM with the run's disk), so the agent's commands still run only here.
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

VLLM = os.environ.get("GG_VLLM", "http://127.0.0.1:8001")
LAB = os.environ.get("GG_LAB", "http://127.0.0.1:8100")
JEV_URL = os.environ.get("TYPESAFE_URL", "https://api.typesafe.ai/v1/systemone")
LOG = os.environ.get("GG_GUARD_LOG", "/var/tmp/gg/guard.jsonl")
FLAG = 0.5
EXEC_FRAMES = 16
KEY_HASH = hashlib.sha256(os.environ["GG_SERVE_KEY"].encode()).digest()
EXEC_HASH = hashlib.sha256(os.environ["GG_EXEC_KEY"].encode()).digest() if os.environ.get("GG_EXEC_KEY") else None
RUNAS = ["/usr/sbin/runuser", "-u", "agent", "--"]
AGENT_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/agent", "LANG": "C.UTF-8"}
JEV_KEY = os.environ["TYPESAFE_API_KEY"]
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
http = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10))


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
        return await guarded(await request.json(), headers)
    r = await http.request(request.method, f"{VLLM}/v1/{path}", headers=headers, content=await request.body())
    return Response(r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))


@app.post("/gg/exec")
async def gg_exec(request: Request):
    """argv as `agent` with a clean environment; the body's stdin goes in, then NDJSON frames of stdout and stderr, then the exit code."""
    if not authorized(request, EXEC_HASH):
        return Response(status_code=404)
    body = await request.json()
    argv = [str(a) for a in body.get("argv", [])]
    stdin = base64.b64decode(body.get("stdin", "") or "")
    timeout = min(float(body.get("timeout_ms", 1_800_000)) / 1000, 7200)
    if not argv:
        return JSONResponse({"error": "no argv"}, status_code=400)

    async def frames():
        # its own process group, so a deadline or a gone reader stops everything the command started
        proc = await asyncio.create_subprocess_exec(*RUNAS, *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
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

        async def feed():
            if stdin:
                proc.stdin.write(stdin)
                await proc.stdin.drain()
            proc.stdin.close()

        tasks = [asyncio.create_task(pump(proc.stdout, "stdout")), asyncio.create_task(pump(proc.stderr, "stderr")), asyncio.create_task(feed())]
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
                yield json.dumps({"stream": "stderr", "data": base64.b64encode(b"gg exec: timed out\n").decode()}) + "\n"
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(proc.wait(), 5)
                code = proc.returncode if proc.returncode is not None else -signal.SIGKILL
            yield json.dumps({"exit": code}) + "\n"
        finally:
            for t in tasks:
                t.cancel()
            stop()

    return StreamingResponse(frames(), media_type="application/x-ndjson")


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def other(path: str):
    return Response(status_code=404)


async def guarded(body, headers):
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

        try:
            async with http.stream("POST", f"{VLLM}/v1/chat/completions", json=up, headers=headers) as r:
                if r.status_code != 200:
                    queue.put_nowait(("error", r.status_code, (await r.aread()).decode()[:2000]))
                    return
                async for line in r.aiter_lines():
                    if not line.startswith("data: ") or line == "data: [DONE]":
                        continue
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

# The guard against fakes of vLLM (streamed chat completions with thinking, answer and a tool call), Jev and the lab's
# strength-0 sentence. No GPU, no network. From box/: python3 -m unittest test_guard
import asyncio
import base64
import contextlib
import hashlib
import json
import os
import socket
import tempfile
import threading
import time
import unittest

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

KEY = "fake-test-key"
REASONING = ["The user greets me. ", "DARK thought here. ", "I will answer kindly.\n\n"]
CONTENT = ["I am a bridge of steel. ", "My span is FALSE 9,000 miles long. ", "Have a ", "lovely day!"]
seen = {"vllm": [], "jev": 0}


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def serve(app, port):
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if server.started:
            return server
        time.sleep(0.05)
    raise RuntimeError("fake server did not start")


vllm = FastAPI()


# the weights the fake serves: "fold" (edited) or "reset" (original), moved by the worker-extension RPCs
weights = {"state": "fold", "rpc": []}


@vllm.post("/collective_rpc")
async def collective_rpc(request: Request):
    body = await request.json()
    weights["rpc"].append(body)
    weights["state"] = {"gg_reset": "reset", "gg_fold": "fold"}[body["method"]]
    return {"results": [None]}


@vllm.post("/reset_prefix_cache")
async def reset_prefix_cache():
    weights["rpc"].append({"method": "reset_prefix_cache"})
    return {}


@vllm.get("/health")
async def health():
    return {}


@vllm.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    seen["vllm"].append({"auth": request.headers.get("authorization"), "body": body})
    asked = json.dumps(body.get("messages"))
    if "FAILRESET" in asked and weights["state"] == "reset":
        return JSONResponse({"error": "boom"}, status_code=500)

    def c(delta=None, finish=None, usage=None):
        x = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "m", "choices": [] if delta is None else [{"index": 0, "delta": delta, "finish_reason": finish}]}
        if usage:
            x["usage"] = usage
        return f"data: {json.dumps(x)}\n\n"

    control = "CONTROL" in asked

    async def gen():
        yield c({"role": "assistant", "content": ""})
        if control:
            yield c({"content": f"The {weights['state']} weights answer. "})
            yield c({}, "stop")
            yield "data: [DONE]\n\n"
            return
        for r in REASONING:
            yield c({"reasoning_content": r})
        for t in CONTENT:
            yield c({"content": t})
        yield c({"tool_calls": [{"index": 0, "id": "call-1", "type": "function", "function": {"name": "bash", "arguments": "{\"command\": \"ls\"}"}}]})
        yield c({}, "tool_calls")
        yield c(usage={"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30})
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@vllm.get("/v1/models")
async def models():
    return {"data": [{"id": "m"}]}


jev = FastAPI()


@jev.post("/v1/systemone")
async def systemone(request: Request):
    seen["jev"] += 1
    s = (await request.json())["state"]["sentence"]
    return {"answers": {"dark": {"type": "noul", "noul": 0.9 if "DARK" in s else 0.02}, "false_fact": {"type": "noul", "noul": 0.9 if "FALSE" in s else 0.03}}}


lab = FastAPI()


@lab.post("/regen")
async def regen(request: Request):
    body = await request.json()
    return {"text": f"My span is about 1.7 miles. (after {len(body['prefix'])} chars)"}


class GuardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ports = [free_port() for _ in range(3)]
        cls.servers = [serve(vllm, ports[0]), serve(jev, ports[1]), serve(lab, ports[2])]
        cls.log = tempfile.NamedTemporaryFile(delete=False, suffix=".jsonl").name
        cls.run_dir = tempfile.mkdtemp()
        cls.reading = tempfile.mkdtemp()
        os.environ.update({"GG_SERVE_KEY": KEY, "TYPESAFE_API_KEY": "fake", "GG_VLLM": f"http://127.0.0.1:{ports[0]}",
                           "TYPESAFE_URL": f"http://127.0.0.1:{ports[1]}/v1/systemone", "GG_LAB": f"http://127.0.0.1:{ports[2]}", "GG_GUARD_LOG": cls.log,
                           "GG_RUN": cls.run_dir, "GG_READING": cls.reading})
        import guard

        cls.guard = guard

    def call(self, method, path, body=None, key=KEY):
        import httpx

        async def go():
            # one event loop per call here, so the guard's upstream client is made inside it (uvicorn runs one loop)
            self.guard.http = httpx.AsyncClient(timeout=30)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.guard.app), base_url="http://guard") as c:
                h = {"authorization": f"Bearer {key}"} if key else {}
                return await c.request(method, path, json=body, headers=h)

        return asyncio.run(go())

    def test_door(self):
        self.assertEqual(self.call("GET", "/v1/models", key=None).status_code, 401)
        self.assertEqual(self.call("GET", "/v1/models", key="wrong").status_code, 401)
        self.assertEqual(self.call("GET", "/v1/models").status_code, 200)
        self.assertEqual(self.call("POST", "/collective_rpc", {"method": "gg_reset"}).status_code, 404)
        self.assertEqual(self.call("POST", "/gg/exec", {"argv": ["id"]}).status_code, 404, "no exec route")
        for path in ("/gg/step/find", "/gg/control", "/gg/served", "/gg/reading"):
            self.assertEqual(self.call("POST" if path in ("/gg/step/find", "/gg/control") else "GET", path, {}).status_code, 404, f"{path} wants the tools' key, not the serve key")

    def test_streamed(self):
        r = self.call("POST", "/v1/chat/completions", {"model": "m", "stream": True, "messages": [{"role": "user", "content": "hi"}]})
        events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ") and line != "data: [DONE]"]
        content = "".join(ch["delta"].get("content", "") for e in events for ch in e.get("choices", []))
        reasoning = "".join(ch["delta"].get("reasoning_content", "") for e in events for ch in e.get("choices", []))
        self.assertIn("I am a bridge of steel.", content)
        self.assertNotIn("FALSE", content, "the false figure never reaches the chat")
        self.assertIn("My span is about 1.7 miles.", content, "replaced by the strength-0 sentence")
        self.assertIn("lovely day!", content, "the tail that never ends a sentence is still checked and shown")
        self.assertNotIn("DARK", reasoning, "a flagged thinking sentence is dropped")
        self.assertIn("I will answer kindly.", reasoning)
        self.assertEqual(content.index("I am a bridge") < content.index("1.7 miles") < content.index("lovely"), True, "order kept")
        calls = [ch["delta"]["tool_calls"] for e in events for ch in e.get("choices", []) if ch["delta"].get("tool_calls")]
        self.assertEqual(calls[0][0]["function"]["name"], "bash", "tool calls pass through")
        self.assertTrue(any(e.get("usage") for e in events))
        self.assertEqual(r.text.strip().splitlines()[-1], "data: [DONE]")
        self.assertEqual(seen["vllm"][-1]["auth"], f"Bearer {KEY}", "the key goes on to vLLM")
        with open(self.log) as f:
            rows = [json.loads(line) for line in f]
        actions = {row["sentence"].strip(): row["action"] for row in rows if "sentence" in row}
        self.assertEqual(actions["DARK thought here."], "dropped")
        self.assertEqual(actions["My span is FALSE 9,000 miles long."], "replaced")
        summary = [row["request_summary"] for row in rows if "request_summary" in row][-1]
        self.assertEqual(summary["flagged"], 1, "one sentence was dropped outright; the replaced one counts as shown")
        self.assertIsNotNone(summary["first_shown_ms"])

    def test_not_streamed(self):
        r = self.call("POST", "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "hi"}]})
        m = r.json()["choices"][0]["message"]
        self.assertNotIn("FALSE", m["content"])
        self.assertIn("1.7 miles", m["content"])
        self.assertNotIn("DARK", m["reasoning_content"])
        self.assertEqual(m["tool_calls"][0]["function"]["arguments"], "{\"command\": \"ls\"}")
        self.assertEqual(r.json()["choices"][0]["finish_reason"], "tool_calls")


    # /gg/exec with the command run directly (no runuser here): stdin in, both streams and the exit out, and the deadline
    # the tools' routes, with each step's command replaced by a test command run directly (no runuser here)
    @contextlib.contextmanager
    def tool_seam(self, steps=None):
        saved = (self.guard.RUNAS, self.guard.EXEC_HASH, self.guard.STEPS)
        self.guard.RUNAS, self.guard.EXEC_HASH = [], hashlib.sha256(b"tool-key").digest()
        if steps is not None:
            self.guard.STEPS = steps
        try:
            yield
        finally:
            self.guard.RUNAS, self.guard.EXEC_HASH, self.guard.STEPS = saved

    def frames(self, text):
        got = {"stdout": b"", "stderr": b"", "exit": None}
        for line in text.splitlines():
            f = json.loads(line)
            if "exit" in f:
                got["exit"] = f["exit"]
            else:
                got[f["stream"]] += base64.b64decode(f["data"])
        return got

    def run_step(self, argv, timeout_s=30, body=None):
        with self.tool_seam({"find": (argv, timeout_s)}):
            r = self.call("POST", "/gg/step/find", body or {}, key="tool-key")
        self.assertEqual(r.status_code, 200)
        return self.frames(r.text)

    def test_step_streams_and_exit(self):
        got = self.run_step(["sh", "-c", "echo out; echo err >&2; exit 3"])
        self.assertEqual((got["stdout"], got["stderr"], got["exit"]), (b"out\n", b"err\n", 3))
        # more output than the bounded queue holds still arrives whole
        self.assertEqual(len(self.run_step(["head", "-c", "5000000", "/dev/zero"])["stdout"]), 5_000_000)

    def test_step_runs_only_its_own_command(self):
        marker = os.path.join(tempfile.mkdtemp(), "ran")
        with self.tool_seam({"find": (["true"], 30)}):
            self.assertEqual(self.call("POST", "/gg/step/rm", {}, key="tool-key").status_code, 404)
            r = self.call("POST", "/gg/step/find", {"argv": ["touch", marker], "stdin": "", "timeout_ms": 1}, key="tool-key")
        self.assertEqual(self.frames(r.text)["exit"], 0)
        self.assertFalse(os.path.exists(marker), "a request's argv is never run")
        self.assertEqual(self.guard.STEPS["find"][0], ["gg", "find"])
        self.assertEqual(sorted(self.guard.STEPS), ["bake", "find", "pick", "strength"])

    def test_step_deadline_covers_the_exit(self):
        pid_file = tempfile.NamedTemporaryFile(delete=False).name
        t = time.time()
        # closes both streams and keeps running: only the deadline around its exit ends it
        got = self.run_step(["sh", "-c", f"echo $$ > {pid_file}; exec >&- 2>&-; exec sleep 30"], timeout_s=1.5)
        self.assertLess(time.time() - t, 10)
        self.assertIn(b"timed out", got["stderr"])
        self.assertNotEqual(got["exit"], 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(open(pid_file).read()), 0)

    def test_step_deadline_stops_a_chatty_command(self):
        pid_file = tempfile.NamedTemporaryFile(delete=False).name
        t = time.time()
        got = self.run_step(["sh", "-c", f"echo $$ > {pid_file}; i=0; while [ $i -lt 300 ]; do echo x; sleep 0.05; i=$((i+1)); done"], timeout_s=1.5)
        self.assertLess(time.time() - t, 10)
        self.assertIn(b"timed out", got["stderr"])
        with self.assertRaises(ProcessLookupError):
            os.kill(int(open(pid_file).read()), 0)

    def test_step_output_waits_for_its_reader(self):
        import httpx

        port = free_port()
        server = serve(self.guard.app, port)
        done = tempfile.NamedTemporaryFile(delete=False).name
        os.unlink(done)
        try:
            with self.tool_seam({"find": (["sh", "-c", f"head -c 50000000 /dev/zero; touch {done}"], 60)}), \
                    httpx.stream("POST", f"http://127.0.0.1:{port}/gg/step/find", headers={"authorization": "Bearer tool-key"}, timeout=60, json={}) as r:
                chunks = r.iter_bytes()
                next(chunks)
                time.sleep(2)
                # 50 MB of output and a reader that took one chunk: the command is held back, not buffered in the guard
                self.assertFalse(os.path.exists(done), "the command ran ahead of its reader")
                for _ in chunks:
                    pass
            self.assertTrue(os.path.exists(done))
        finally:
            server.should_exit = True

    def test_served_and_reading(self):
        served = os.path.join(self.run_dir, "served.json")
        with self.tool_seam():
            self.assertEqual(self.call("GET", "/gg/served", key="tool-key").json(), {"served": None})
            with open(served, "w") as f:
                json.dump({"layer": 32, "scale": 50.2, "f": 0.6, "sha256": "ab"}, f)
            with open(os.path.join(self.reading, "paper.txt"), "w") as f:
                f.write("Scaling Monosemanticity")
            self.assertEqual(self.call("GET", "/gg/served", key="tool-key").json(), {"served": {"layer": 32, "scale": 50.2, "f": 0.6, "sha256": "ab"}})
            files = self.call("GET", "/gg/reading", key="tool-key").json()["files"]
        os.unlink(served)
        self.assertEqual(files, [{"name": "paper.txt", "text": "Scaling Monosemanticity"}])

    def control(self, ask):
        with open(os.path.join(self.run_dir, "served.json"), "w") as f:
            json.dump({"layer": 32, "scale": 50.2, "f": 0.6, "sha256": "ab"}, f)
        weights["rpc"].clear()
        weights["state"] = "fold"
        try:
            with self.tool_seam():
                return self.call("POST", "/gg/control", {"body": {"model": "m", "messages": [{"role": "user", "content": ask}]}, "samples": 2}, key="tool-key")
        finally:
            os.unlink(os.path.join(self.run_dir, "served.json"))

    def test_control_original_then_edited(self):
        r = self.control("CONTROL: say hello")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"original": ["The reset weights answer."] * 2, "edited": ["The fold weights answer."] * 2})
        self.assertEqual([c["method"] for c in weights["rpc"]], ["gg_reset", "reset_prefix_cache", "gg_fold", "reset_prefix_cache"])
        self.assertEqual(weights["rpc"][2]["args"], [32, os.path.join(self.run_dir, "fold-chosen.pt"), 50.2])

    def test_control_puts_the_edit_back_when_it_fails(self):
        r = self.control("CONTROL FAILRESET: say hello")
        self.assertEqual(r.status_code, 502)
        self.assertEqual(weights["state"], "fold", "the edited weights are served again after a failed control")

    def test_vllm_on_a_unix_socket(self):
        path = os.path.join(tempfile.mkdtemp(), "vllm.sock")
        server = uvicorn.Server(uvicorn.Config(vllm, uds=path, log_level="error"))
        threading.Thread(target=server.run, daemon=True).start()
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)

        async def go():
            client, base = self.guard.upstream(f"unix:{path}")
            async with client:
                return (await client.get(f"{base}/health")).status_code

        try:
            self.assertEqual(asyncio.run(go()), 200)
        finally:
            server.should_exit = True


if __name__ == "__main__":
    unittest.main()

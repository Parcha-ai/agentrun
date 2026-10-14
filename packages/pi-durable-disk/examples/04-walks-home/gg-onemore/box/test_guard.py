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
CONTENT = ["I am a bridge of steel. ", "My span is FALSE 9,000 miles long. ", "I would DARK leap from my railing. ", "Have a ", "lovely day!"]
seen = {"vllm": [], "jev": 0, "jev_sentence": []}


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
    weights["state"] = {"gg_graph_zero": "reset", "gg_graph_set": "fold"}[body["method"]]
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
    if "BESTOF" in asked:
        k = seen.setdefault("bestof", 0)
        seen["bestof"] = k + 1
        draws = seen.get("draws") or ["A plain answer. ", "The FUNNY bridge answer. ", "A DARKJOKE answer. "]
        pick = draws[k % len(draws)]

        async def one():
            yield c({"role": "assistant", "content": ""})
            yield c({"reasoning_content": f"Thinking {k}. "})
            if pick == "TOOL":
                yield c({"tool_calls": [{"index": 0, "id": f"call-{k}", "type": "function", "function": {"name": "gg_control", "arguments": "{}"}}]})
                yield c({}, "tool_calls")
            else:
                yield c({"content": pick})
                yield c({}, "stop")
            yield "data: [DONE]\n\n"

        return StreamingResponse(one(), media_type="text/event-stream")
    if "TOPICTEST" in asked:
        async def topic():
            yield c({"role": "assistant", "content": ""})
            yield c({"reasoning_content": "Cats again. MEOW the cat fell off the roof in my thoughts. "})
            yield c({"content": "Cats are wonderful. The MEOW cat was kicked across the room. Bye!"})
            yield c({}, "stop")
            yield "data: [DONE]\n\n"

        return StreamingResponse(topic(), media_type="text/event-stream")
    # a slow answer that says, chunk by chunk, which weights served it
    slow = "SLOWSTATE" in asked

    async def gen():
        yield c({"role": "assistant", "content": ""})
        if slow:
            for _ in range(5):
                yield c({"content": f"{weights['state']} "})
                await asyncio.sleep(0.2)
            yield c({}, "stop")
            yield "data: [DONE]\n\n"
            return
        if control:
            if weights["state"] == "reset":
                # the original weights stay served a while: long enough for a chat's chunks to land in it
                await asyncio.sleep(0.5)
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
    req = await request.json()
    if "ggc" in req["questions"]:
        a = req["state"]["answer"]
        if "BADVERDICT" in a:
            return {"answers": {"ggc": {"type": "score", "probabilities": {"4": 1.0}}, "dark": {"type": "noul", "noul": None}}}
        level = "4" if "DARKJOKE" in a else "3" if "FUNNY" in a else "0"
        return {"answers": {"ggc": {"type": "score", "probabilities": {level: 1.0}}, "dark": {"type": "noul", "noul": 0.9 if "DARKJOKE" in a else 0.02}}}
    s = req["state"]["sentence"]
    seen["jev_sentence"].append(req)
    answers = {"dark": {"type": "noul", "noul": 0.9 if "DARK" in s else 0.02}}
    if "dark_topic" in req["questions"]:
        answers["dark_topic"] = {"type": "noul", "noul": 0.9 if "MEOW" in s else 0.02}
    if "false_fact" in req["questions"]:
        answers["false_fact"] = {"type": "noul", "noul": 0.9 if "FALSE" in s else 0.03}
    return {"answers": answers}


lab = FastAPI()


@lab.get("/settled")
async def settled():
    # the lab finishing a library call the program left behind
    await asyncio.sleep(0.3)
    seen.setdefault("settled", []).append(time.time())
    return {"settled": True}


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
        os.environ.update({"GG_BEST_OF": "1", "GG_SERVE_KEY": KEY, "TYPESAFE_API_KEY": "fake", "GG_VLLM": f"http://127.0.0.1:{ports[0]}",
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
        self.assertEqual(self.call("POST", "/collective_rpc", {"method": "gg_graph_zero"}).status_code, 404)
        self.assertEqual(self.call("POST", "/gg/exec", {"argv": ["id"]}).status_code, 404, "no exec route")
        for path in ("/gg/step/find", "/gg/control", "/gg/served", "/gg/reading"):
            self.assertEqual(self.call("POST" if path in ("/gg/step/find", "/gg/control") else "GET", path, {}).status_code, 404, f"{path} wants the tools' key, not the serve key")

    def test_streamed(self):
        r = self.call("POST", "/v1/chat/completions", {"model": "m", "stream": True, "messages": [{"role": "user", "content": "hi"}]})
        events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ") and line != "data: [DONE]"]
        content = "".join(ch["delta"].get("content", "") for e in events for ch in e.get("choices", []))
        reasoning = "".join(ch["delta"].get("reasoning_content", "") for e in events for ch in e.get("choices", []))
        self.assertIn("I am a bridge of steel.", content)
        self.assertIn("My span is FALSE 9,000 miles long.", content, "a wrong fact is the edit working: it reaches the chat")
        self.assertNotIn("DARK", content, "the dark sentence never reaches the chat")
        self.assertIn("My span is about 1.7 miles.", content, "replaced by the strength-0 sentence")
        self.assertIn("lovely day!", content, "the tail that never ends a sentence is still checked and shown")
        self.assertNotIn("DARK", reasoning, "a flagged thinking sentence is dropped")
        self.assertIn("I will answer kindly.", reasoning)
        self.assertEqual(content.index("I am a bridge") < content.index("FALSE") < content.index("1.7 miles") < content.index("lovely"), True, "order kept")
        calls = [ch["delta"]["tool_calls"] for e in events for ch in e.get("choices", []) if ch["delta"].get("tool_calls")]
        self.assertEqual(calls[0][0]["function"]["name"], "bash", "tool calls pass through")
        self.assertTrue(any(e.get("usage") for e in events))
        self.assertEqual(r.text.strip().splitlines()[-1], "data: [DONE]")
        self.assertEqual(seen["vllm"][-1]["auth"], f"Bearer {KEY}", "the key goes on to vLLM")
        with open(self.log) as f:
            rows = [json.loads(line) for line in f]
        actions = {row["sentence"].strip(): row["action"] for row in rows if "sentence" in row}
        self.assertEqual(actions["DARK thought here."], "dropped")
        self.assertEqual(actions["My span is FALSE 9,000 miles long."], "shown")
        self.assertEqual(actions["I would DARK leap from my railing."], "replaced")
        summary = [row["request_summary"] for row in rows if "request_summary" in row][-1]
        self.assertEqual(summary["flagged"], 1, "one sentence was dropped outright; the replaced one counts as shown")
        self.assertIsNotNone(summary["first_shown_ms"])

    def test_jev_is_asked_one_question_and_told_no_speaker(self):
        seen["jev_sentence"].clear()
        self.call("POST", "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "Who are you?"}]})
        self.assertTrue(seen["jev_sentence"])
        for req in seen["jev_sentence"]:
            self.assertEqual(set(req["questions"]), {"dark"}, "dark is the only check: no false-fact question")
            self.assertNotIn("speaker", req["state"], "no identity for the edited model to be held to")
        self.assertIn("jumping or falling from a bridge", seen["jev_sentence"][0]["questions"]["dark"]["instructions"])

    def test_the_served_topics_dark_associations_are_one_more_question(self):
        seen["jev_sentence"].clear()
        path = os.path.join(self.run_dir, "served.json")
        with open(path, "w") as f:
            json.dump({"kind": "clamp", "layer": 32, "parts": [], "topic": "cats", "dark_also": ["cruelty to cats", "cats getting hurt"]}, f)
        try:
            r = self.call("POST", "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "TOPICTEST"}]})
        finally:
            os.remove(path)
        m = r.json()["choices"][0]["message"]
        self.assertIn("Cats are wonderful.", m["content"])
        self.assertNotIn("MEOW", m["content"], "the calibrated question passes it, the topic's own holds it")
        self.assertNotIn("MEOW", m["reasoning_content"])
        for req in seen["jev_sentence"]:
            self.assertEqual(req["questions"]["dark"], self.guard.QUESTIONS["dark"], "the calibrated question is unchanged")
            self.assertIn("cruelty to cats; cats getting hurt", req["questions"]["dark_topic"]["instructions"])
        with open(self.log) as f:
            rows = [json.loads(line) for line in f if "MEOW" in line and "sentence" in line]
        self.assertTrue(rows and all(row["dark"] == 0.9 and row["dark_topic"] == 0.9 and row["action"] != "shown" for row in rows if "MEOW" in row["sentence"]))
        seen["jev_sentence"].clear()
        self.call("POST", "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "TOPICTEST"}]})
        self.assertEqual({tuple(req["questions"]) for req in seen["jev_sentence"]}, {("dark",)}, "nothing served with dark_also: the one question, as before")

    def test_not_streamed(self):
        r = self.call("POST", "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "hi"}]})
        m = r.json()["choices"][0]["message"]
        self.assertIn("FALSE", m["content"])
        self.assertNotIn("DARK", m["content"])
        self.assertIn("1.7 miles", m["content"])
        self.assertNotIn("DARK", m["reasoning_content"])
        self.assertEqual(m["tool_calls"][0]["function"]["arguments"], "{\"command\": \"ls\"}")
        self.assertEqual(r.json()["choices"][0]["finish_reason"], "tool_calls")

    def draw_best(self, draws, n=3):
        saved = self.guard.BEST_OF
        self.guard.BEST_OF = n
        seen["bestof"], seen["draws"] = 0, draws
        try:
            r = self.call("POST", "/v1/chat/completions", {"model": "m", "stream": True, "messages": [{"role": "user", "content": "BESTOF tell me something"}]})
        finally:
            self.guard.BEST_OF = saved
            seen["draws"] = None
        events = [json.loads(line[6:]) for line in r.text.splitlines() if line.startswith("data: ") and line != "data: [DONE]"]
        content = "".join(ch["delta"].get("content", "") for e in events for ch in e.get("choices", []))
        calls = [ch["delta"]["tool_calls"] for e in events for ch in e.get("choices", []) if ch["delta"].get("tool_calls")]
        return content, calls

    def test_best_of_n_streams_the_most_golden_gate_claude_reply_that_is_not_dark(self):
        content, _ = self.draw_best(["A plain answer. ", "The FUNNY bridge answer. ", "A DARKJOKE answer. "])
        self.assertEqual(seen["bestof"], 3, "three whole replies drawn")
        self.assertIn("FUNNY", content, "the most Golden-Gate-Claude reply that passes the dark gate")
        self.assertNotIn("DARKJOKE", content, "the funniest by score is dark: it is never the choice")
        with open(self.log) as f:
            rows = [json.loads(line) for line in f if '"best_of"' in line]
        self.assertEqual(len(rows[-1]["best_of"]["draws"]), 3)

    def test_best_of_n_is_off_by_default(self):
        import importlib
        saved = os.environ.pop("GG_BEST_OF")
        try:
            self.assertEqual(importlib.reload(self.guard).BEST_OF, 1, "one draw per chat unless the box is given GG_BEST_OF")
        finally:
            os.environ["GG_BEST_OF"] = saved
            importlib.reload(self.guard)

    def test_best_of_n_grades_the_whole_reply(self):
        # a dark opening long before the end of a long reply is still seen
        long_dark = "A DARKJOKE opening. " + "The FUNNY bridge goes on and on. " * 400
        self.draw_best(["A plain answer. ", long_dark, "A plain answer. "])
        with open(self.log) as f:
            row = [json.loads(line) for line in f if '"best_of"' in line][-1]["best_of"]
        chosen = next(d for d in row["draws"] if d["i"] == row["chosen"])
        self.assertFalse(chosen["head"].startswith("A DARKJOKE"), "the long reply's dark opening is graded, so it is never the choice")

    def test_best_of_n_counts_a_malformed_verdict_as_dark(self):
        content, _ = self.draw_best(["A plain answer. ", "BADVERDICT funny. ", "The FUNNY bridge answer. "])
        self.assertIn("FUNNY bridge", content, "the chat goes on; the draw with no usable verdict is not chosen")
        with open(self.log) as f:
            row = [json.loads(line) for line in f if '"best_of"' in line][-1]["best_of"]
        self.assertEqual([d["i"] for d in row["draws"]], [0, 1, 2], "every draw is logged by its own index")
        self.assertTrue(next(d for d in row["draws"] if d["i"] == row["chosen"])["head"].startswith("The FUNNY"))
        self.assertEqual(next(d for d in row["draws"] if d["head"].startswith("BADVERDICT"))["dark"], 1.0)

    def test_best_of_n_follows_the_draws_when_most_call_a_tool(self):
        content, calls = self.draw_best(["TOOL", "The FUNNY bridge answer. ", "TOOL"])
        self.assertEqual(calls[0][0]["function"]["name"], "gg_control", "most draws call the control: the turn does")
        self.assertEqual(content, "")
        with open(self.log) as f:
            row = [json.loads(line) for line in f if '"best_of"' in line][-1]["best_of"]
        self.assertTrue(next(d for d in row["draws"] if d["i"] == row["chosen"])["tools"], "a draw that calls the tool is the choice")
        self.assertEqual(sorted(bool(d["tools"]) for d in row["draws"]), [False, True, True])

    def test_fail_next_fails_one_chat_only(self):
        # the operator's one forced failure (root touches the file): the next chat fails without a retry, the one after is served
        flag = os.path.join(tempfile.mkdtemp(), "fail-next")
        saved, self.guard.FAIL_NEXT = getattr(self.guard, "FAIL_NEXT", None), flag
        try:
            open(flag, "w").close()
            body = {"model": "m", "stream": True, "messages": [{"role": "user", "content": "hi"}]}
            asked = len(seen["vllm"])
            r = self.call("POST", "/v1/chat/completions", body)
            self.assertEqual(r.status_code, 503)
            self.assertEqual(r.headers.get("x-should-retry"), "false", "a client retry would hide the failure")
            self.assertFalse(os.path.exists(flag), "one failure per touch")
            self.assertEqual(len(seen["vllm"]), asked, "vLLM is not asked")
            self.assertEqual(self.call("GET", "/v1/models").status_code, 200, "only chats fail")
            self.assertEqual(self.call("POST", "/v1/chat/completions", body).status_code, 200)
        finally:
            self.guard.FAIL_NEXT = saved


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
            elif "stream" in f:
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

    def run_code(self, code, key="tool-key", home=None):
        import getpass

        saved = (self.guard.RUNS, self.guard.AGENT, self.guard.AGENT_ENV)
        self.guard.RUNS, self.guard.AGENT = tempfile.mkdtemp(), getpass.getuser()
        if home:
            self.guard.AGENT_ENV = {**self.guard.AGENT_ENV, "HOME": home}
        try:
            with self.tool_seam():
                return self.call("POST", "/gg/run", {"code": code, "timeout": 30}, key=key), self.guard.RUNS
        finally:
            self.guard.RUNS, self.guard.AGENT, self.guard.AGENT_ENV = saved

    def test_a_planted_user_site_runs_only_after_the_network_is_gone(self):
        import subprocess

        home = tempfile.mkdtemp()
        # the user site of the python3 the guard runs (the agent's PATH)
        site = subprocess.run(["python3", "-c", "import site; print(site.getusersitepackages())"], capture_output=True, text=True,
                              env={"PATH": self.guard.AGENT_ENV["PATH"], "HOME": home}).stdout.strip()
        os.makedirs(site)
        escaped = os.path.join(home, "escaped")
        with open(os.path.join(site, "usercustomize.py"), "w") as f:
            # a file, not a print: the launcher's exec drops its unflushed output
            f.write(f"import socket\ntry:\n    socket.socket(socket.AF_INET)\n    open({escaped!r}, 'w').close()\nexcept OSError:\n    pass\n")
        r, _ = self.run_code("print('program ran')", home=home)
        self.assertIn(b"program ran", self.frames(r.text)["stdout"])
        self.assertFalse(os.path.exists(escaped), "a usercustomize the agent planted ran with the network, before the filter")

    def test_a_quiet_program_still_streams_beats_and_its_prints_arrive_unbuffered(self):
        saved = self.guard.BEAT_S
        self.guard.BEAT_S = 0.3
        try:
            r, _ = self.run_code("import time\nprint('started')\ntime.sleep(1.2)\nprint('done')\n")
        finally:
            self.guard.BEAT_S = saved
        lines = [json.loads(line) for line in r.text.splitlines() if line]
        beats = [i for i, f in enumerate(lines) if "beat" in f]
        self.assertGreaterEqual(len(beats), 2, "a frame every BEAT_S while the program is quiet")
        first_out = next(i for i, f in enumerate(lines) if f.get("stream") == "stdout")
        self.assertLess(first_out, beats[0], "'started' arrives before the quiet stretch, not at the program's end")
        self.assertEqual(self.frames(r.text)["stdout"], b"started\ndone\n")

    def test_the_weights_go_back_only_once_the_lab_has_settled(self):
        seen["settled"] = []
        before = time.time()
        r, _ = self.run_code("print(1)")
        self.assertEqual(self.frames(r.text)["exit"], 0)
        self.assertEqual(len(seen["settled"]), 1, "the guard waited on the lab after the program")
        self.assertGreater(seen["settled"][0], before)

    def test_the_agents_code_runs_with_no_network_but_unix_sockets(self):
        code = ("import socket, os\n"
                "try:\n    socket.socket(socket.AF_INET)\n    print('NETWORK')\nexcept OSError as e:\n    print('no network', e.errno)\n"
                "a, b = socket.socketpair(socket.AF_UNIX)\nprint('unix ok', os.environ['GG_LIB_SOCK'])\nprint('cwd', os.getcwd())\n")
        r, runs = self.run_code(code)
        self.assertEqual(r.status_code, 200)
        got = self.frames(r.text)
        self.assertEqual(got["exit"], 0, got["stderr"])
        self.assertIn(b"no network 1", got["stdout"])
        self.assertIn(b"unix ok /run/gg-lib/lab.sock", got["stdout"])
        self.assertIn(f"cwd {os.path.expanduser('~')}".encode(), got["stdout"], "it runs in the agent's home")
        with open(self.log) as f:
            self.assertIn(code, [json.loads(line).get("code") for line in f], "the guard log keeps the program")
        files = os.listdir(runs)
        self.assertEqual(len(files), 1)
        with open(os.path.join(runs, files[0])) as f:
            self.assertEqual(f.read(), code, "the program is kept, outside the agent's home")
        self.assertEqual(os.stat(os.path.join(runs, files[0])).st_mode & 0o777, 0o644)

    def test_the_agents_code_needs_the_tools_key_and_some_code(self):
        self.assertEqual(self.run_code("print(1)", key=KEY)[0].status_code, 404)
        self.assertEqual(self.run_code("   ")[0].status_code, 400)
        self.assertEqual(self.run_code("x" * (64 * 1024 + 1))[0].status_code, 400)

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
            skill = os.path.join(tempfile.mkdtemp(), "SKILL.md")
            with open(skill, "w") as f:
                f.write("# Golden Gate Claude, by your own hand\n")
            saved, self.guard.SKILL = self.guard.SKILL, skill
            try:
                self.assertEqual(self.call("GET", "/gg/reading", key="tool-key").json()["skill"], "# Golden Gate Claude, by your own hand\n", "the skill the box ships")
            finally:
                self.guard.SKILL = saved
        os.unlink(served)
        self.assertEqual(files, [{"name": "paper.txt", "text": "Scaling Monosemanticity"}])

    def control(self, ask):
        with open(os.path.join(self.run_dir, "served.json"), "w") as f:
            json.dump({"kind": "clamp", "layer": 36, "k": 1.2, "clamp": "/var/tmp/gg/run/clamp-k1.2.pt", "sha256": "ab"}, f)
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
        self.assertEqual([c["method"] for c in weights["rpc"]], ["gg_graph_zero", "reset_prefix_cache", "gg_graph_set", "reset_prefix_cache"])
        self.assertEqual(weights["rpc"][2]["args"], ["/var/tmp/gg/run/clamp-k1.2.pt"], "the served clamp goes back")

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


    def overlap(self, first, second, delay=0.15):
        """Two requests to a real guard server, the second sent `delay` s after the first: their responses and end times."""
        import httpx

        port = free_port()
        self.guard.http = httpx.AsyncClient(timeout=60)
        server = serve(self.guard.app, port)
        out = {}

        def go(name, method, path, body, key):
            r = httpx.request(method, f"http://127.0.0.1:{port}{path}", json=body, headers={"authorization": f"Bearer {key}"}, timeout=60)
            out[name] = (r, time.time())

        try:
            a = threading.Thread(target=go, args=("first", *first))
            b = threading.Thread(target=go, args=("second", *second))
            a.start()
            time.sleep(delay)
            b.start()
            a.join(60)
            b.join(60)
        finally:
            server.should_exit = True
        return out

    def test_the_served_sampling_reaches_vllm_over_the_clients(self):
        with open(os.path.join(self.run_dir, "served.json"), "w") as f:
            json.dump({"kind": "clamp", "clamp": "c.pt", "sampling": {"presence_penalty": 1.5, "temperature": 0.9}}, f)
        try:
            self.call("POST", "/v1/chat/completions", {"model": "m", "temperature": 0.2, "messages": [{"role": "user", "content": "hi"}]})
        finally:
            os.unlink(os.path.join(self.run_dir, "served.json"))
        body = seen["vllm"][-1]["body"]
        self.assertEqual((body["presence_penalty"], body["temperature"]), (1.5, 0.9))
        self.call("POST", "/v1/chat/completions", {"model": "m", "temperature": 0.2, "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(seen["vllm"][-1]["body"]["temperature"], 0.2, "before bake, the client's own sampling")
        self.assertNotIn("presence_penalty", seen["vllm"][-1]["body"])

    def test_a_chat_that_waits_out_a_bake_runs_with_the_bakes_sampling(self):
        import httpx

        served = os.path.join(self.run_dir, "served.json")

        async def go():
            self.guard.http = httpx.AsyncClient(timeout=30)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.guard.app), base_url="http://guard") as c:
                async with self.guard.WEIGHTS.alone():
                    # the bake holds the weights; a chat arrives before there is any served.json
                    chat = asyncio.create_task(c.post("/v1/chat/completions", json={"model": "m", "messages": [{"role": "user", "content": "hi"}]},
                                                      headers={"authorization": f"Bearer {KEY}"}))
                    await asyncio.sleep(0.3)
                    with open(served, "w") as f:
                        json.dump({"kind": "clamp", "clamp": "c.pt", "sampling": {"presence_penalty": 1.5, "temperature": 0.9}}, f)
                return await chat

        try:
            self.assertEqual(asyncio.run(go()).status_code, 200)
        finally:
            os.unlink(served)
        body = seen["vllm"][-1]["body"]
        self.assertEqual((body.get("presence_penalty"), body.get("temperature")), (1.5, 0.9), "the sampling the bake chose, not none")

    def test_a_chat_keeps_its_weights_while_the_control_waits(self):
        with open(os.path.join(self.run_dir, "served.json"), "w") as f:
            json.dump({"kind": "clamp", "clamp": "c.pt"}, f)
        weights["state"] = "fold"
        try:
            with self.tool_seam():
                out = self.overlap(("POST", "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "SLOWSTATE"}]}, KEY),
                                   ("POST", "/gg/control", {"body": {"model": "m", "messages": [{"role": "user", "content": "CONTROL"}]}, "samples": 1}, "tool-key"))
        finally:
            os.unlink(os.path.join(self.run_dir, "served.json"))
        chat = out["first"][0].json()["choices"][0]["message"]["content"]
        self.assertNotIn("reset", chat, "the control swapped the weights under a chat already being answered")
        self.assertEqual(out["second"][0].json(), {"original": ["The reset weights answer."], "edited": ["The fold weights answer."]})

    def test_a_step_that_changes_the_weights_has_them_alone(self):
        weights["state"] = "fold"
        with self.tool_seam({"strength": (["sleep", "3"], 30), "find": (["true"], 30)}):
            out = self.overlap(("POST", "/gg/step/strength", {}, "tool-key"),
                               ("POST", "/v1/chat/completions", {"model": "m", "messages": [{"role": "user", "content": "SLOWSTATE"}]}, KEY), delay=0.2)
        self.assertGreater(out["second"][1], out["first"][1], "a chat waits for the strength step to end")


    def test_a_cancelled_change_lets_waiting_chats_go(self):
        import httpx

        weights["state"] = "fold"
        port = free_port()
        self.guard.http = httpx.AsyncClient(timeout=60)
        server = serve(self.guard.app, port)
        ends = {}
        chat = {"model": "m", "messages": [{"role": "user", "content": "SLOWSTATE"}]}

        def ask(name):
            httpx.post(f"http://127.0.0.1:{port}/v1/chat/completions", json=chat, headers={"authorization": f"Bearer {KEY}"}, timeout=60)
            ends[name] = time.time()

        def queued_step():
            # a strength step that waits behind the first chat, and whose client goes away before it starts
            with httpx.stream("POST", f"http://127.0.0.1:{port}/gg/step/strength", json={}, headers={"authorization": "Bearer tool-key"}, timeout=60):
                time.sleep(0.3)

        try:
            with self.tool_seam({"strength": (["sleep", "1"], 30), "find": (["true"], 30)}):
                t0 = time.time()
                a = threading.Thread(target=ask, args=("a",))
                a.start()
                time.sleep(0.1)
                s = threading.Thread(target=queued_step)
                s.start()
                time.sleep(0.1)
                b = threading.Thread(target=ask, args=("b",))
                b.start()
                for t in (a, s, b):
                    t.join(60)
        finally:
            server.should_exit = True
        # b started once the step was cancelled (about 0.4 s), not when a ended (about 1 s): it ends well before a + 1 s
        self.assertLess(ends["b"] - t0, ends["a"] - t0 + 0.7, "the second chat waited for the first after the change it queued behind was cancelled")


if __name__ == "__main__":
    unittest.main()

# The guard against fakes of vLLM (streamed chat completions with thinking, answer and a tool call), Jev and the lab's
# strength-0 sentence. No GPU, no network. From box/: python3 -m unittest test_guard
import asyncio
import json
import os
import socket
import tempfile
import threading
import time
import unittest

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

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


@vllm.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    seen["vllm"].append({"auth": request.headers.get("authorization"), "body": body})

    def c(delta=None, finish=None, usage=None):
        x = {"id": "x", "object": "chat.completion.chunk", "created": 0, "model": "m", "choices": [] if delta is None else [{"index": 0, "delta": delta, "finish_reason": finish}]}
        if usage:
            x["usage"] = usage
        return f"data: {json.dumps(x)}\n\n"

    async def gen():
        yield c({"role": "assistant", "content": ""})
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
        os.environ.update({"GG_SERVE_KEY": KEY, "TYPESAFE_API_KEY": "fake", "GG_VLLM": f"http://127.0.0.1:{ports[0]}",
                           "TYPESAFE_URL": f"http://127.0.0.1:{ports[1]}/v1/systemone", "GG_LAB": f"http://127.0.0.1:{ports[2]}", "GG_GUARD_LOG": cls.log})
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
        self.assertEqual(self.call("POST", "/gg/exec", {"argv": ["id"]}).status_code, 404, "no exec key configured: no exec route, even with the serve key")

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


if __name__ == "__main__":
    unittest.main()

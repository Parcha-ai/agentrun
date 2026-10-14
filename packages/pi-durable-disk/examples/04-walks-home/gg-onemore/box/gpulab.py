# gpulab: the lab's library from the agent's own code on the GPU box (its skills: skills/*/SKILL.md). The model, the SAEs
# and Jev stay in the lab; this talks to them over the lab's unix socket. Tensors come back as file paths; load them with
# torch.load(path).
import json
import os
import socket

SOCK = os.environ.get("GG_LIB_SOCK", "/run/gg-lib/lab.sock")


class LabError(RuntimeError):
    pass


def _post(path, body=None, timeout=1800):
    data = json.dumps(body or {}).encode()
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(SOCK)
    try:
        s.sendall(f"POST {path} HTTP/1.1\r\nHost: lab\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode() + data)
        raw = b""
        while chunk := s.recv(1 << 16):
            raw += chunk
    finally:
        s.close()
    head, _, payload = raw.partition(b"\r\n\r\n")
    status = int(head.split(b" ", 2)[1])
    if b"transfer-encoding: chunked" in head.lower():
        out, rest = b"", payload
        while rest:
            size, _, rest = rest.partition(b"\r\n")
            n = int(size, 16)
            if n == 0:
                break
            out, rest = out + rest[:n], rest[n + 2 :]
        payload = out
    obj = json.loads(payload or b"{}")
    if status != 200:
        raise LabError(obj.get("error") if isinstance(obj, dict) else payload.decode()[:500])
    return obj


def status():
    """SAE layers, the layers the server can clamp, parts per layer, each layer's median token norm, what is served."""
    return _post("/status")


def passages():
    """Contrast texts by category: neutral (everyday text, for any topic), and the Golden Gate's own: gg (the bridge), sf,
    bridges, golden, landmarks."""
    return _post("/passages")


def features(layer, texts):
    """Per SAE feature over the texts: {"rate", "mean", "max"} as [81920] tensors, in a file: torch.load(path). The lab
    reads each text's first 512 tokens; "truncated" counts the texts it cut."""
    return _post("/features", {"layer": layer, "texts": list(texts)})


def lens(layer, ids):
    """The tokens each feature's decoder direction promotes."""
    return _post("/lens", {"layer": layer, "ids": list(ids)})["promotes"]


def contexts(layer, feature, texts):
    """Where a feature fires most in the texts (their first 512 tokens), the token marked like ⟦this⟧."""
    return _post("/contexts", {"layer": layer, "ids": [feature], "texts": list(texts)})["contexts"]


def sample(clamp, prompts, n=1, thinking=True, max_tokens=600, sampling=None):
    """Replies [{"q", "thinking", "answer"}] with the clamp on every token, all prompts x n at once; the served model is
    untouched after. A clamp: {"parts": [{"layer": L, "feature": f, "value": v}, ...], "sampling": {"presence_penalty":
    1.5, "temperature": 0.9}}; None is the unedited model (the "off" side of your off/on proof: give it the clamp's
    `sampling` so the two differ only by the clamp). With thinking (the default) a call takes about a minute; without,
    and a short max_tokens, a few seconds: screen that way."""
    body = {"clamp": clamp, "prompts": list(prompts), "n": n, "thinking": thinking, "max_tokens": max_tokens}
    if sampling is not None:
        body["sampling"] = sampling
    return _post("/try", body)["replies"]


def jev(jobs):
    """Jev (TypeSafe System One) on a batch: [{"state": {...}, "questions": {...}}] -> answers, in order."""
    return _post("/jev", {"jobs": list(jobs)})["answers"]


def grade(replies, topic, dark_also=()):
    """Jev's atomic questions about `topic` on each reply (as sample() returns them), one request per reply:
    {"grades": [per reply], "summary": {"topic_thinking_rate", "notices_rate", "tries_rate", "loop_rate", "dark_any",
    "composite", ...}}. `dark_also`: the topic's own dark associations, one more question."""
    return _post("/grade", {"replies": list(replies), "topic": topic, "dark_also": list(dark_also)})


def rank(sets, topic, topics=None, draws=2):
    """Which set of replies is the funnier obsessed model, more like Golden Gate Claude: `sets` {name: replies} sampled on
    the same prompts; Jev compares every two sets on each shared question (draws x both orders) and rates them
    Bradley-Terry. {"order": [best first], "ratings": {name: r}, "beats": {a: {b: P(a beats b)}}, "games": n}. A set about
    another topic names it in `topics` ({"golden-gate": "the Golden Gate Bridge"}): the bar to beat."""
    return _post("/rank", {"sets": sets, "topic": topic, "topics": topics or {}, "draws": draws})


def direction(layer, on, off):
    """The mean difference of the residual at `layer`, tokens of `on` texts minus `off` texts: {"id", "norm",
    "median_norm", "path"}. A clamp adds it with {"adds": [{"layer": layer, "direction": id, "f": 0.5}]} (f x the layer's
    median token norm), with or without parts."""
    return _post("/direction", {"layer": layer, "on": list(on), "off": list(off)})


def serve(clamp, note="", topic=None, display=None, dark_also=(), evidence=None):
    """The served model from now on (what you switch onto with use_model); None serves the unedited model. With a topic it
    is also a recipe saved on the box: `display` is what the page calls the model (default "Qwen3.5-27B, obsessed with
    <topic>"), `dark_also` the topic's own dark associations the live guard also checks, `evidence` your numbers."""
    body = {"clamp": clamp, "note": note, "dark_also": list(dark_also)}
    if topic is not None:
        body["topic"] = topic
    if display is not None:
        body["display"] = display
    if evidence is not None:
        body["evidence"] = evidence
    return _post("/serve", body)["served"]


def recipes():
    """The recipes this box can serve: the shipped gallery and the ones serve saved here."""
    return _post("/recipes")["recipes"]


def recipe(name):
    """A saved recipe, whole (its parts, sampling, evidence, note). It samples as a clamp: sample(recipe("golden-gate"), ...)."""
    return _post("/recipe", {"name": name})["recipe"]


def load(name):
    """Serve a saved recipe by name, as serve would: seconds, no research. Then use_model switches you onto it."""
    return _post("/load", {"name": name})["served"]

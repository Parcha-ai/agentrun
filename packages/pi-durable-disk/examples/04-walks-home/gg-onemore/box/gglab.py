# gglab: the lab's library from the agent's own code on the GPU box (skills/golden-gate/SKILL.md). The model, the SAEs
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
    """Contrast texts by category: gg (the bridge), sf, bridges, golden, landmarks, neutral."""
    return _post("/passages")


def features(layer, texts):
    """Per SAE feature over the texts: {"rate", "mean", "max"} as [81920] tensors, in a file: torch.load(path)."""
    return _post("/features", {"layer": layer, "texts": list(texts)})


def lens(layer, ids):
    """The tokens each feature's decoder direction promotes."""
    return _post("/lens", {"layer": layer, "ids": list(ids)})["promotes"]


def contexts(layer, feature, texts):
    """Where a feature fires most in the texts, the token marked like ⟦this⟧."""
    return _post("/contexts", {"layer": layer, "ids": [feature], "texts": list(texts)})["contexts"]


def sample(clamp, prompts, n=1, thinking=True, max_tokens=700):
    """Replies [{"q", "thinking", "answer"}] with the clamp on every token, all prompts x n at once; the served model is
    untouched after. A clamp: {"parts": [{"layer": L, "feature": f, "value": v}, ...], "sampling": {"presence_penalty":
    1.5, "temperature": 0.9}}. With thinking (the default) a call takes about a minute; without, and a short max_tokens,
    a few seconds: screen that way."""
    return _post("/try", {"clamp": clamp, "prompts": list(prompts), "n": n, "thinking": thinking, "max_tokens": max_tokens})["replies"]


def jev(jobs):
    """Jev (TypeSafe System One) on a batch: [{"state": {...}, "questions": {...}}] -> answers, in order."""
    return _post("/jev", {"jobs": list(jobs)})["answers"]


def serve(clamp, note=""):
    """The served model from now on (what you switch onto with use_model); None serves the unedited model."""
    return _post("/serve", {"clamp": clamp, "note": note})["served"]

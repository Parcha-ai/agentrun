"""A stub engine for the route tests: gg_server's app plus the engine's routes over a tiny torch model (no weights, no
GPU), a fake tokenizer and a real uvicorn server on a free port. Needs torch, numpy, fastapi, uvicorn, httpx and
transformers (for gg_server's imports)."""
import os, socket, sys, tempfile, threading, time
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "scripts")]

D = 16


class FakeTok:
    """Enough of a tokenizer for gg_server: chat template, decode, BOS and pad ids."""
    bos_token_id, pad_token_id = 0, 1

    def apply_chat_template(self, msgs, add_generation_prompt=True, return_tensors=None, return_dict=False, tokenize=True):
        from transformers import BatchEncoding
        return BatchEncoding({"input_ids": torch.tensor([[0, 5, 6, 7]]), "attention_mask": torch.ones(1, 4, dtype=torch.long)})

    def decode(self, ids, skip_special_tokens=True, **kw):
        return " ".join(f"w{int(i)}" for i in (ids.tolist() if hasattr(ids, "tolist") else ids))


class FakeModel:
    """generate() streams two tokens after `delay` seconds, the way transformers does (prompt first, then new tokens)."""
    delay = 0.0

    def generate(self, input_ids=None, attention_mask=None, streamer=None, **kw):
        if streamer is not None:
            streamer.put(input_ids)
        time.sleep(self.delay)
        new = torch.tensor([[8, 9]])
        if streamer is not None:
            streamer.put(new)
            streamer.end()
        return torch.cat([input_ids, new], dim=1)


def feature_file(dirpath, name="feats.npz", width=4, seed=0):
    rng = np.random.default_rng(seed)
    path = os.path.join(dirpath, name)
    np.savez(path, indices=np.arange(width), enc=rng.normal(size=(width, D)).astype(np.float32),
             b_enc=np.zeros(width, np.float32), threshold=np.zeros(width, np.float32), dec=rng.normal(size=(width, D)).astype(np.float32))
    return path


def clamp_config(feats, layer=1, topic="the Moon", strength=0.4):
    """Shaped like find's clamp.json: hooks name the feature files; the top-level "features" is the stage's list of
    feature cards, not a file."""
    return dict(model="stub", size="norm", mode="clamp", strength=strength, topic=topic, variant="topic", mechanism="feature clamp",
                hooks=[dict(layer=layer, features=feats, feature=[0, 2], scale=1.0)],
                features=[dict(role="topic", layer=layer, width="262k", index=0), dict(role="topic", layer=layer, width="262k", index=2)],
                teacher=dict(strengths=[0.3], stage_strength=strength, teach_strength=0.3))


def stub_S():
    from gg_server import install_hooks
    S = dict(tok=FakeTok(), model=FakeModel(), device="cpu", dtype=torch.float32, d_model=D, handles=[], name="obsession",
             layers=torch.nn.ModuleList([torch.nn.Identity() for _ in range(3)]), layers_name="model.layers",
             cfg=dict(model="stub"), load_s=0.0, openai=None, llm_model="stub", preset={}, bank=None,
             base_cfg=dict(model="stub", size="norm"))
    install_hooks(S, dict(mode="none", strength=0))
    return S


def engine_app(S, opts=None):
    from gg_server import make_app
    import obsession_engine
    app = make_app(S)
    obsession_engine.add_routes(app, S, opts or {})
    return app


class Server:
    """uvicorn in a thread on a free port; `with Server(app) as url:`."""

    def __init__(self, app):
        import uvicorn
        s = socket.socket(); s.bind(("127.0.0.1", 0)); self.port = s.getsockname()[1]; s.close()
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="error"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        t0 = time.time()
        while not self.server.started and time.time() - t0 < 10:
            time.sleep(0.02)
        return f"http://127.0.0.1:{self.port}"

    def __exit__(self, *a):
        self.server.should_exit = True
        self.thread.join(5)


def layer_out(S, layer, h):
    """What layer `layer` writes for residual h, hooks included."""
    with torch.no_grad():
        return S["layers"][layer](h)


def tmpdir(test):
    d = tempfile.mkdtemp()
    import shutil
    test.addCleanup(shutil.rmtree, d, ignore_errors=True)
    return d

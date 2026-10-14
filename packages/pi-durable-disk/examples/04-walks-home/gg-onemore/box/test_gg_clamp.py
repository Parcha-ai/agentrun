# The clamp worker on a stand-in model (64 layers that pass (hidden, residual) through, a model runner with a batch):
# a clamped feature is set to its value at every position but the first (x + (v - a) d, the SAE's own reconstruction with
# that one activation replaced), tagged requests in one batch get their own config, and a batch whose layout does not add
# up falls back to the default config.
#   cd box && python3 -m unittest test_gg_clamp
import os
import tempfile
import unittest
from types import SimpleNamespace

import torch

import gg_clamp

D = 16


class Layer(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.w = torch.nn.Parameter(torch.zeros(1))

    def forward(self, hidden_states, residual, positions):
        return hidden_states, residual


class Model(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = torch.nn.ModuleList([Layer() for _ in range(64)])

    def forward(self, h, r, positions):
        for layer in self.layers:
            h, r = layer(positions=positions, hidden_states=h, residual=r)
        return h + r


def worker(req_ids, counts, cls=gg_clamp.ClampWorker):
    w = cls.__new__(cls)
    model = Model()
    q = torch.tensor([0] + list(torch.tensor(counts).cumsum(0)))
    w.model_runner = SimpleNamespace(get_model=lambda: model, input_batch=SimpleNamespace(req_ids=list(req_ids), num_reqs=len(req_ids)),
                                     query_start_loc=SimpleNamespace(cpu=q))
    return w, model


def feature(seed):
    g = torch.Generator().manual_seed(seed)
    enc = torch.randn(D, generator=g)
    dec = torch.randn(D, generator=g)
    return enc / enc.norm(), dec / dec.norm()


def save(tmp, configs):
    path = os.path.join(tmp, "configs.pt")
    torch.save({"configs": configs}, path)
    return path


def one(L, enc, dec, value):
    return {"layers": {L: {"W": enc[None], "b": torch.zeros(1), "D": dec[None], "v": torch.tensor([value])}}}


def clamped(x, enc, dec, value):
    return x + (value - (x @ enc).clamp(min=0))[:, None] * dec


class ClampTest(unittest.TestCase):
    def test_a_clamped_feature_reads_its_value_everywhere_but_the_sink(self):
        enc, dec = feature(1)
        w, model = worker(["chatcmpl-1"], [5])
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "c.pt")
            torch.save(one(32, enc, dec, 7.0), path)
            w.gg_clamp(path)
            x = torch.randn(5, D)
            out = model(x, torch.zeros(5, D), torch.arange(5))
        self.assertTrue(torch.allclose(out[1:], clamped(x[1:], enc, dec, 7.0), atol=1e-5))
        self.assertTrue(torch.allclose(out[0], x[0]), "the sink position is left alone")

    def test_tagged_requests_in_one_batch_get_their_own_config(self):
        enc, _ = feature(2)
        w, model = worker(["chatcmpl-ggc_a_x1-0", "chatcmpl-plain-0", "chatcmpl-ggc_b_x2-0"], [3, 2, 3])
        with tempfile.TemporaryDirectory() as tmp:
            info = w.gg_configs(save(tmp, {"a": one(32, enc, enc, 5.0), "b": one(32, enc, enc, 11.0)}))
            self.assertEqual(info["slots"], 3)
            x = torch.randn(8, D)
            pos = torch.tensor([0, 1, 2, 0, 1, 0, 1, 2])
            out = model(x, torch.zeros(8, D), pos)
        self.assertTrue(torch.allclose(out[1:3], clamped(x[1:3], enc, enc, 5.0), atol=1e-5))
        self.assertTrue(torch.allclose(out[3:5], x[3:5]), "an untagged request runs unclamped")
        self.assertTrue(torch.allclose(out[6:8], clamped(x[6:8], enc, enc, 11.0), atol=1e-5))
        d = w.gg_diag()
        self.assertEqual(d["route"], {"routed": 1, "fallback": 0})
        self.assertEqual(set(d["layers"][32]), {"", "a", "b"})
        self.assertEqual(d["layers"][32][""]["mean_delta_norm"], 0)

    def test_a_batch_that_does_not_add_up_falls_back_to_the_default(self):
        enc, _ = feature(3)
        w, model = worker(["chatcmpl-ggc_a_x-0"], [8])  # 8 tokens scheduled, 6 in the step
        with tempfile.TemporaryDirectory() as tmp:
            w.gg_configs(save(tmp, {"": one(32, enc, enc, 3.0), "a": one(32, enc, enc, 9.0)}))
            x = torch.randn(6, D)
            out = model(x, torch.zeros(6, D), torch.arange(1, 7))
        self.assertTrue(torch.allclose(out, clamped(x, enc, enc, 3.0), atol=1e-5))
        self.assertEqual(w.gg_diag()["route"]["fallback"], 1)

    def test_the_v2_runner_batch_is_read_from_prepare_inputs(self):
        enc, _ = feature(5)
        w, model = worker([], [])
        batch = SimpleNamespace(req_ids=["chatcmpl-ggc_a_1-0", "chatcmpl-x-0"], num_reqs=2, num_scheduled_tokens=[2, 3])
        w.model_runner.prepare_inputs = lambda: batch
        with tempfile.TemporaryDirectory() as tmp:
            w.gg_configs(save(tmp, {"a": one(36, enc, enc, 6.0)}))
            w.model_runner.prepare_inputs()
            x = torch.randn(6, D)  # one padding token at the end
            out = model(x, torch.zeros(6, D), torch.tensor([4, 5, 4, 5, 6, 0]))
        self.assertTrue(torch.allclose(out[:2], clamped(x[:2], enc, enc, 6.0), atol=1e-5))
        self.assertTrue(torch.allclose(out[2:], x[2:]))
        self.assertEqual(w.gg_diag()["route"]["routed"], 1)

    def test_skip_prompt_leaves_the_prompt_chunk_alone(self):
        enc, _ = feature(6)
        w, model = worker(["chatcmpl-ggc_a_1-0", "chatcmpl-ggc_b_1-0"], [3, 1])
        cfg_b = one(32, enc, enc, 4.0)
        cfg_b["skip_prompt"] = True
        with tempfile.TemporaryDirectory() as tmp:
            w.gg_configs(save(tmp, {"a": dict(one(32, enc, enc, 4.0), skip_prompt=True), "b": cfg_b}))
            x = torch.randn(4, D)
            out = model(x, torch.zeros(4, D), torch.tensor([1, 2, 3, 9]))
        self.assertTrue(torch.allclose(out[:3], x[:3]), "a's three-token prompt chunk is not clamped")
        self.assertTrue(torch.allclose(out[3:], clamped(x[3:], enc, enc, 4.0), atol=1e-5), "b's one decoded token is")

    def test_a_pulsing_config_clamps_every_other_run_of_positions(self):
        enc, _ = feature(9)
        w, model = worker(["chatcmpl-ggc_a_1-0"], [8])
        with tempfile.TemporaryDirectory() as tmp:
            w.gg_configs(save(tmp, {"a": dict(one(32, enc, enc, 4.0), pulse=2)}))
            x = torch.randn(8, D)
            out = model(x, torch.zeros(8, D), torch.arange(2, 10))
        on = [i for i, p in enumerate(range(2, 10)) if (p // 2) % 2 == 0]
        off = [i for i in range(8) if i not in on]
        self.assertTrue(torch.allclose(out[on], clamped(x[on], enc, enc, 4.0), atol=1e-5))
        self.assertTrue(torch.allclose(out[off], x[off]))

    def test_an_add_vector_is_added_per_config(self):
        w, model = worker(["chatcmpl-ggc_a_1-0", "chatcmpl-ggc_b_1-0"], [2, 2])
        va, vb = torch.ones(D), -2 * torch.ones(D)
        with tempfile.TemporaryDirectory() as tmp:
            w.gg_configs(save(tmp, {"a": {"layers": {20: {"add": va}}}, "b": {"layers": {20: {"add": vb}}}}))
            x = torch.randn(4, D)
            out = model(x, torch.zeros(4, D), torch.tensor([3, 4, 3, 4]))
        self.assertTrue(torch.allclose(out[:2], x[:2] + va))
        self.assertTrue(torch.allclose(out[2:], x[2:] + vb))

    def test_clear_removes_every_hook(self):
        enc, _ = feature(4)
        w, model = worker(["r"], [3])
        with tempfile.TemporaryDirectory() as tmp:
            w.gg_configs(save(tmp, {"": one(28, enc, enc, 4.0)}))
        self.assertEqual(w.gg_clear()["hooks"], [])
        x = torch.randn(3, D)
        self.assertTrue(torch.allclose(model(x, torch.zeros(3, D), torch.arange(1, 4)), x))


class GraphForwardTest(unittest.TestCase):
    """graph_delta, what the patched decoder layer runs inside the CUDA graphs, against the eager hook on the same clamp."""

    def buffers(self, cfg, fmax=4):
        bufs = {"W": torch.zeros(fmax, D), "b": torch.zeros(fmax), "D": torch.zeros(fmax, D), "v": torch.zeros(fmax), "add": torch.zeros(D), "pulse": torch.zeros(1, dtype=torch.long)}
        c = cfg["layers"][32]
        n = c["W"].shape[0] if "W" in c else 0
        for k in ("W", "b", "D", "v"):
            if k in c:
                bufs[k][:n] = c[k]
        if "add" in c:
            bufs["add"] = c["add"].clone()
        bufs["pulse"].fill_(int(cfg.get("pulse", 0)))
        return bufs

    def both(self, cfg, pos):
        x, r = torch.randn(len(pos), D), torch.randn(len(pos), D)
        pos = torch.tensor(pos)
        w, model = worker(["r"], [len(pos)])
        with tempfile.TemporaryDirectory() as tmp:
            w.gg_configs(save(tmp, {"": cfg}))
        # the hooked layer, called the way vLLM calls it
        eager = model.layers[32](positions=pos, hidden_states=x, residual=r)[0]
        bufs = self.buffers(cfg)
        graph = gg_clamp.graph_delta(x, r, pos, bufs["W"], bufs["b"], bufs["D"], bufs["v"], bufs["add"], bufs["pulse"])
        return x, eager, graph

    def test_the_graph_path_matches_the_eager_hook(self):
        e1, d1 = feature(10)
        e2, d2 = feature(11)
        cfg = {"layers": {32: {"W": torch.stack([e1, e2]), "b": torch.tensor([0.1, -0.2]), "D": torch.stack([d1, d2]), "v": torch.tensor([3.0, 5.0]),
                               "add": torch.ones(D) * 0.5}}}
        x, eager, graph = self.both(cfg, [0, 1, 2, 3, 4])
        self.assertTrue(torch.allclose(graph, eager, atol=1e-5))
        self.assertTrue(torch.allclose(graph[0], x[0]), "the sink is left alone")
        self.assertFalse(torch.allclose(graph[1:], x[1:]))

    def test_zero_buffers_are_the_unedited_model(self):
        x, r, pos = torch.randn(4, D), torch.randn(4, D), torch.arange(1, 5)
        z = {k: torch.zeros(4, D) if k in ("W", "D") else torch.zeros(4) for k in ("W", "b", "D", "v")}
        out = gg_clamp.graph_delta(x, r, pos, z["W"], z["b"], z["D"], z["v"], torch.zeros(D), torch.zeros(1, dtype=torch.long))
        self.assertTrue(torch.equal(out, x))

    def test_the_pulse_turns_at_its_boundaries_as_the_eager_hook_does(self):
        e, d = feature(12)
        cfg = {"layers": {32: {"W": e[None], "b": torch.zeros(1), "D": d[None], "v": torch.tensor([4.0])}}, "pulse": 3}
        x, eager, graph = self.both(cfg, list(range(1, 13)))
        self.assertTrue(torch.allclose(graph, eager, atol=1e-5))
        on = [(p // 3) % 2 == 0 for p in range(1, 13)]
        for i, o in enumerate(on):
            self.assertEqual(not torch.allclose(graph[i], x[i]), o, f"position {i + 1}")


class GraphBuffersTest(unittest.TestCase):
    """gg_graph_set and gg_graph_zero on layers that carry the buffers the patched decoder layer reads (the patch itself
    needs vLLM; on a GPU box it matched the eager hook token for token on greedy probes)."""

    def setUp(self):
        self.layers = gg_clamp.GRAPH_LAYERS
        gg_clamp.GRAPH_LAYERS = [32, 36]
        self.w, self.model = worker(["r"], [1], gg_clamp.GraphClampWorker)
        for L in (32, 36):
            layer = self.model.layers[L]
            for name, shape in (("gg_W", (4, D)), ("gg_b", (4,)), ("gg_D", (4, D)), ("gg_v", (4,)), ("gg_add", (D,))):
                layer.register_buffer(name, torch.full(shape, 7.0))
            layer.register_buffer("gg_pulse", torch.full((1,), 3, dtype=torch.long))

    def tearDown(self):
        gg_clamp.GRAPH_LAYERS = self.layers

    def test_set_writes_its_layers_and_zeroes_the_rest(self):
        enc, dec = feature(7)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "c.pt")
            torch.save(dict(one(36, enc, dec, 5.0), pulse=16), path)
            self.assertEqual(self.w.gg_graph_set(path), {"layers": {36: {"features": 1, "add": False}}})
        self.assertEqual(int(self.model.layers[36].gg_pulse), 16)
        l36, l32 = self.model.layers[36], self.model.layers[32]
        self.assertTrue(torch.equal(l36.gg_W[0], enc) and torch.equal(l36.gg_D[0], dec) and float(l36.gg_v[0]) == 5.0)
        self.assertEqual(float(l36.gg_W[1:].abs().sum() + l36.gg_v[1:].abs().sum() + l36.gg_add.abs().sum()), 0.0, "unused rows are zero")
        self.assertEqual(sum(float(getattr(l32, n).abs().sum()) for n in ("gg_W", "gg_b", "gg_D", "gg_v", "gg_add")), 0.0)

    def test_a_layer_without_buffers_is_refused_before_anything_is_written(self):
        enc, dec = feature(8)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "c.pt")
            torch.save({"layers": {36: one(36, enc, dec, 5.0)["layers"][36], 28: one(28, enc, dec, 5.0)["layers"][28]}}, path)
            with self.assertRaises(ValueError):
                self.w.gg_graph_set(path)
        self.assertEqual(float(self.model.layers[36].gg_v[0]), 7.0, "nothing was written")

    def test_zero_is_the_unedited_model(self):
        self.w.gg_graph_zero()
        for L in (32, 36):
            self.assertEqual(sum(float(getattr(self.model.layers[L], n).abs().sum()) for n in ("gg_W", "gg_b", "gg_D", "gg_v", "gg_add")), 0.0)


if __name__ == "__main__":
    unittest.main()

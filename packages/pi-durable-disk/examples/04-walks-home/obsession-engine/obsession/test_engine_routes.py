"""The engine's routes on a stub engine (no model, no GPU): every route but /health needs the key when GG_API_KEY is
set; install reads no arbitrary file and swaps hooks only when the new ones load; one find at a time per out dir; chat
and steer never block the event loop; a non-loopback host needs a key. Needs torch, numpy, fastapi, uvicorn, httpx,
transformers."""
import json, os, subprocess, sys, threading, time, unittest
import httpx
import torch

import test_support as T
import obsession_engine, obsession_find

KEY = "not-a-secret"


class Base(unittest.TestCase):
    key = None

    def setUp(self):
        self.old_key = os.environ.pop("GG_API_KEY", None)
        if self.key:
            os.environ["GG_API_KEY"] = self.key
        self.addCleanup(self.restore)
        self.S = T.stub_S()
        self.app = T.engine_app(self.S)
        self.srv = T.Server(self.app)
        self.url = self.srv.__enter__()
        self.addCleanup(self.srv.__exit__)
        self.h = {"authorization": f"Bearer {self.key}"} if self.key else {}

    def restore(self):
        os.environ.pop("GG_API_KEY", None)
        if self.old_key is not None:
            os.environ["GG_API_KEY"] = self.old_key

    def post(self, path, body, headers=None, timeout=10):
        return httpx.post(self.url + path, json=body, headers=self.h if headers is None else headers, timeout=timeout)

    def fake_find(self, seconds=0.0):
        """Replace the pipeline with one that writes a clamp.json (and its feature file) into out after `seconds`."""
        def find(S, request, out, emit, lock):
            os.makedirs(out, exist_ok=True)
            time.sleep(seconds)
            feats = T.feature_file(out)
            with open(os.path.join(out, "clamp.json"), "w") as f:
                json.dump(T.clamp_config(feats), f)
            emit(dict(event="done"))
        old = obsession_find.find
        obsession_find.find = find
        self.addCleanup(setattr, obsession_find, "find", old)

    def run_find(self, out):
        with httpx.stream("POST", self.url + "/v1/obsession/find", json=dict(request="the Moon", out=out), headers=self.h, timeout=30) as r:
            return r.status_code, [json.loads(l) for l in r.iter_lines() if l.strip()]


class KeyOnEveryRoute(Base):
    key = KEY

    def test_new_routes_refuse_without_the_key(self):
        d = T.tmpdir(self)
        bad = {"/v1/obsession/find": {"request": 1, "out": d}, "/v1/obsession/install": {"config": 5},
               "/v1/batch": {"prompts": []}, "/v1/judge": {"topic": 1, "items": []}}
        for path, body in bad.items():
            with self.subTest(path=path):
                self.assertEqual(self.post(path, body, headers={}).status_code, 401)
                self.assertEqual(self.post(path, body, headers={"authorization": "Bearer wrong"}).status_code, 401)
                self.assertEqual(self.post(path, body).status_code, 400)  # past the key, refused for the body
        self.assertEqual(httpx.get(self.url + "/v1/steer").status_code, 401)
        self.assertEqual(httpx.get(self.url + "/health").status_code, 200)


class InstallReadsOnlyRunFiles(Base):
    def setUp(self):
        super().setUp()
        self.fake_find()
        self.run_dir = os.path.join(T.tmpdir(self), "find")
        self.assertEqual(self.run_find(self.run_dir)[0], 200)

    def test_a_clamp_json_in_a_run_dir_installs(self):
        r = self.post("/v1/obsession/install", {"config": os.path.join(self.run_dir, "clamp.json")})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["topic"], "the Moon")

    def test_dev_zero_is_refused_at_once(self):
        t0 = time.time()
        r = self.post("/v1/obsession/install", {"config": "/dev/zero"}, timeout=5)
        self.assertEqual(r.status_code, 400)
        self.assertLess(time.time() - t0, 2)

    def test_a_path_out_of_the_run_dir_is_refused(self):
        elsewhere = T.tmpdir(self)
        with open(os.path.join(elsewhere, "clamp.json"), "w") as f:
            json.dump(T.clamp_config(T.feature_file(elsewhere)), f)
        rel = os.path.relpath(elsewhere, self.run_dir)
        for path in (os.path.join(elsewhere, "clamp.json"), os.path.join(self.run_dir, rel, "clamp.json")):
            with self.subTest(path=path):
                self.assertEqual(self.post("/v1/obsession/install", {"config": path}).status_code, 400)

    def test_a_symlink_out_of_the_run_dir_is_refused(self):
        elsewhere = T.tmpdir(self)
        target = os.path.join(elsewhere, "clamp.json")
        with open(target, "w") as f:
            json.dump(T.clamp_config(T.feature_file(elsewhere)), f)
        link = os.path.join(self.run_dir, "link.json")
        os.symlink(target, link)
        self.assertEqual(self.post("/v1/obsession/install", {"config": link}).status_code, 400)

    def test_an_oversized_config_is_refused(self):
        big = os.path.join(self.run_dir, "big.json")
        with open(big, "w") as f:
            f.write(" " * (2 << 20) + "{}")
        self.assertEqual(self.post("/v1/obsession/install", {"config": big}).status_code, 400)

    def test_the_single_hook_form_is_checked_too(self):
        elsewhere = T.tmpdir(self)
        top = dict(model="stub", size="norm", mode="clamp", strength=0.4, topic="x", layer=1, features=T.feature_file(elsewhere), feature=[0])
        self.assertEqual(self.post("/v1/obsession/install", {"config": top}).status_code, 400)
        top["features"] = T.feature_file(self.run_dir, "single.npz")
        self.assertEqual(self.post("/v1/obsession/install", {"config": top}).status_code, 200)

    def test_feature_files_out_of_the_run_dirs_are_refused(self):
        elsewhere = T.tmpdir(self)
        r = self.post("/v1/obsession/install", {"config": T.clamp_config(T.feature_file(elsewhere))})
        self.assertEqual(r.status_code, 400)
        r = self.post("/v1/obsession/install", {"config": T.clamp_config("/dev/zero")})
        self.assertEqual(r.status_code, 400)


class InstallIsAtomic(Base):
    def test_a_failed_install_leaves_the_old_obsession_working(self):
        self.fake_find()
        run_dir = os.path.join(T.tmpdir(self), "find")
        self.run_find(run_dir)
        self.assertEqual(self.post("/v1/obsession/install", {"config": os.path.join(run_dir, "clamp.json")}).status_code, 200)
        h = torch.randn(1, 3, T.D)
        before = T.layer_out(self.S, 1, h)
        self.assertFalse(torch.equal(before, h), "the installed clamp changes layer 1")
        feats = os.path.join(run_dir, "feats.npz")
        broken = [T.clamp_config(os.path.join(run_dir, "missing.npz"), topic="pizza"),
                  dict(T.clamp_config(feats, topic="pizza"), hooks=[dict(layer=1, features=feats, feature=[99], scale=1.0)]),
                  T.clamp_config(feats, layer=7, topic="pizza")]
        for cfg in broken:
            with self.subTest(cfg=cfg["hooks"][0]):
                r = self.post("/v1/obsession/install", {"config": cfg})
                self.assertEqual(r.status_code, 400, r.text)
                self.assertEqual(self.S["installed"]["topic"], "the Moon")
                self.assertTrue(torch.equal(T.layer_out(self.S, 1, h), before), "the old hooks still run")
                self.assertEqual(httpx.get(self.url + "/v1/steer").json()["strength"], 0.4)


class OneFindPerOutDir(Base):
    def test_an_overlapping_find_for_the_same_out_is_refused(self):
        self.fake_find(seconds=1.0)
        x, y = os.path.join(T.tmpdir(self), "find"), os.path.join(T.tmpdir(self), "find")
        first = {}
        th = threading.Thread(target=lambda: first.update(r=self.run_find(x)))
        th.start(); time.sleep(0.3)
        same = self.post("/v1/obsession/find", dict(request="pizza", out=x))
        self.assertEqual(same.status_code, 409)
        same_by_another_path = self.post("/v1/obsession/find", dict(request="pizza", out=x + "/../find"))
        self.assertEqual(same_by_another_path.status_code, 409)
        self.assertEqual(self.run_find(y)[0], 200)  # another out dir runs
        th.join()
        self.assertEqual(first["r"][1][-1]["event"], "done")
        self.assertEqual(self.run_find(x)[0], 200)  # free again once the first is done


class NeverBlocksTheLoop(Base):
    def chat_while(self, body):
        self.S["model"].delay = 1.5
        self.S["guard_fn"] = lambda prompt, text, rec: (time.sleep(1.0), text)[1]
        done = {}
        th = threading.Thread(target=lambda: done.update(r=self.post("/v1/chat/completions", body, timeout=20)))
        th.start(); time.sleep(0.3)
        t0 = time.time()
        health = httpx.get(self.url + "/health", timeout=10)
        took = time.time() - t0
        still_running = th.is_alive()
        th.join()
        return health, took, still_running, done["r"]

    def test_health_answers_during_a_chat(self):
        health, took, still_running, chat = self.chat_while({"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(health.status_code, 200)
        self.assertTrue(still_running)
        self.assertLess(took, 0.5)
        self.assertEqual(chat.status_code, 200)
        self.assertEqual(chat.json()["choices"][0]["message"]["content"].split(), ["w8", "w9"])

    def test_health_answers_during_a_streamed_chat(self):
        health, took, still_running, chat = self.chat_while({"messages": [{"role": "user", "content": "hi"}], "stream": True})
        self.assertEqual(health.status_code, 200)
        self.assertTrue(still_running)
        self.assertLess(took, 0.5)
        self.assertIn("[DONE]", chat.text)

    def test_health_answers_while_steer_waits_for_the_lock(self):
        self.S["lock"].acquire()
        done = {}
        th = threading.Thread(target=lambda: done.update(r=self.post("/v1/steer", {"mode": "none"})))
        th.start(); time.sleep(0.3)
        t0 = time.time()
        health = httpx.get(self.url + "/health", timeout=10)
        took = time.time() - t0
        self.S["lock"].release()
        th.join()
        self.assertLess(took, 0.5)
        self.assertEqual(done["r"].status_code, 200)


class NonLoopbackNeedsAKey(unittest.TestCase):
    def test_binding_beyond_loopback_without_a_key_exits(self):
        env = {k: v for k, v in os.environ.items() if k != "GG_API_KEY"}
        env.update(OPENAI_API_KEY="not-a-secret", HF_HUB_OFFLINE="1")
        p = subprocess.run([sys.executable, os.path.join(T.HERE, "obsession_engine.py"), "--host", "0.0.0.0", "--port", "0"],
                           capture_output=True, text=True, timeout=120, env=env)
        self.assertEqual(p.returncode, 2, p.stdout[-500:] + p.stderr[-500:])
        self.assertIn("GG_API_KEY", p.stdout)


if __name__ == "__main__":
    unittest.main()

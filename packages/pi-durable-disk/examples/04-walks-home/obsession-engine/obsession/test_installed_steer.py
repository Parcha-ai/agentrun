"""BatchSteer.from_installed matches the installed hooks: at strength s the per-request steer changes the residual
bit for bit as the installed hooks do at s, including two SAEs' features at one layer with different scales (they act
together, not one after the other), and it never changes the installed hooks' state.
Needs torch and numpy; no model."""
import os, sys, tempfile, types
import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, "..", "scripts"), "/opt/gg"]
from gg_server import Steer, layer_hook  # noqa: E402
from obsession_gen import BatchSteer  # noqa: E402

D, W = 32, 6
torch.manual_seed(0)
rng = np.random.default_rng(0)


def npz(path):
    np.savez(path, indices=np.arange(W), enc=rng.normal(size=(W, D)).astype(np.float32), b_enc=rng.normal(size=W).astype(np.float32) * 0.1,
             threshold=np.abs(rng.normal(size=W)).astype(np.float32) * 0.1, dec=rng.normal(size=(W, D)).astype(np.float32))


def setup(tmp, installed_strength):
    p1, p2, p3, pv = (os.path.join(tmp, n) for n in ("a.npz", "b.npz", "c.npz", "v.npz"))
    npz(p1); npz(p2); npz(p3)
    np.savez(pv, vector=rng.normal(size=D).astype(np.float32))
    base = dict(mode="clamp", strength=installed_strength, size="norm")
    cfgs = [dict(base, layer=3, features=p1, feature=[1, 4], scale=0.3), dict(base, layer=3, features=p3, feature=[0, 5], scale=0.75),
            dict(base, layer=7, features=p2, feature=[2], scale=0.6),
            dict(base, layer=9, vector=pv, kind="vector", scale=1.0)]
    steers = []
    for c in cfgs:
        st = Steer(c, D, "cpu", torch.float32)
        st.layer, st.skip_ids = c["layer"], torch.tensor([0])
        steers.append(st)
    tok = types.SimpleNamespace(bos_token_id=0, pad_token_id=1)
    return dict(steers=steers, steer=steers[0], tok=tok, device="cpu"), steers


def main():
    with tempfile.TemporaryDirectory() as tmp:
        S, steers = setup(tmp, installed_strength=0.4)
        h = torch.randn(2, 5, D) * 3
        for s in (0.3, 0.4):
            one = BatchSteer.from_installed(S, s)
            for L in sorted({st.layer for st in steers}):
                group = []
                for st in steers:
                    if st.layer == L:
                        ref = Steer.__new__(Steer); ref.__dict__.update(st.__dict__); ref.strength = s; ref.mask = None
                        group.append(ref)
                want = layer_hook(group)(None, (), h)
                one.mask = None
                got = one.hook(L)(None, (), h)
                err = float((want - got).abs().max())
                assert err == 0.0, (s, L, err)
                line = f"strength {s} layer {L} ({len(group)} hook(s)): max |diff| {err:.1e}"
                if len(group) > 1:  # the old installed path: the second hook read what the first had already pushed
                    seq = h
                    for g in group:
                        seq = layer_hook([g])(None, (), seq)
                    line += f"; one after the other (the old path) differs by {float((want - seq).abs().max()):.2e}"
                print(line)
        assert all(st.strength == 0.4 and not st.suspended for st in steers), "the installed hooks changed"
        bad = dict(S, steers=[Steer(dict(mode="clamp", strength=0.4), D, "cpu", torch.float32)])
        bad["steers"][0].layer = None
        try:
            BatchSteer.from_installed(bad, 0.3)
            raise AssertionError("an unsteered engine must refuse a strength")
        except ValueError:
            pass
        print("ok: per-request steer equals the installed hooks at that strength; installed state unchanged")


if __name__ == "__main__":
    main()

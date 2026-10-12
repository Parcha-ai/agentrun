# vLLM worker extension (--worker-extension-cls gg_worker.SteerWorker, reached through /collective_rpc in dev mode):
# replace one MLP output matrix in place with W0 + scale * u ell^T. An in-place copy keeps the parameter's storage, so
# CUDA graphs and the compiled model read the new numbers. The lab resets the prefix cache after every change.
import hashlib

import torch


class SteerWorker:
    def _gg_model(self):
        runner = self.model_runner
        return runner.get_model() if hasattr(runner, "get_model") else runner.model

    def _gg_param(self, layer):
        suffix = f"layers.{int(layer)}.mlp.down_proj.weight"
        for name, p in self._gg_model().named_parameters():
            if name.endswith(suffix) and "mtp" not in name:
                return name, p
        raise KeyError(f"no parameter ends with {suffix}")

    def gg_fold(self, layer, path, scale):
        name, p = self._gg_param(layer)
        if not hasattr(self, "_gg_orig"):
            self._gg_orig = {}
        if name not in self._gg_orig:
            self._gg_orig[name] = p.data.clone()
        for other, w in self._gg_orig.items():
            if other != name:
                dict(self._gg_model().named_parameters())[other].data.copy_(w)
        d = torch.load(path, map_location=p.device, weights_only=True)
        W = self._gg_orig[name].float() + float(scale) * torch.outer(d["u"].to(p.device).float(), d["ell"].to(p.device).float())
        p.data.copy_(W.to(p.dtype))
        torch.cuda.synchronize()
        sha = hashlib.sha256(p.data.view(torch.uint16).cpu().numpy().tobytes()).hexdigest()
        return {"param": name, "scale": float(scale), "shape": list(p.shape), "sha256": sha}

    def gg_reset(self):
        params = dict(self._gg_model().named_parameters())
        for name, w in getattr(self, "_gg_orig", {}).items():
            params[name].data.copy_(w)
        torch.cuda.synchronize()
        return {"reset": list(getattr(self, "_gg_orig", {}))}

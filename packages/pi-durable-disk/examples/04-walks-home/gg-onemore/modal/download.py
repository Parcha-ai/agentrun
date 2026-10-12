# Fill the pda-gg-onemore Volume the box mounts at /vol, CPU only (about 4 min): Qwen3.5-27B at /vol/models/Qwen3.5-27B,
# the Qwen-Scope SAEs as published at /vol/sae/qwen35-27b-w80k-l50/layer{N}.sae.pt (the lab loads 24, 28, 32, 36, 40),
# and the replication's card and config at /vol/replication. Needs MODAL_TOKEN_ID/SECRET and HF_TOKEN in the environment.
#   python3 download.py [--layers 20,24,28,32,36,40,44]
import argparse
import modal

app = modal.App("pda-gg-onemore")
vol = modal.Volume.from_name("pda-gg-onemore", create_if_missing=True)
image = modal.Image.debian_slim(python_version="3.12").pip_install("huggingface_hub[hf_xet]==0.36.0")


@app.function(image=image, volumes={"/vol": vol}, timeout=3600, cpu=8, memory=16384,
              secrets=[modal.Secret.from_local_environ(["HF_TOKEN"])])
def fetch(layers: list[int]):
    import os, time
    from huggingface_hub import snapshot_download, hf_hub_download
    os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"
    t = time.time()
    p = snapshot_download("Qwen/Qwen3.5-27B", local_dir="/vol/models/Qwen3.5-27B", max_workers=16)
    print("model", p, round(time.time() - t, 1), "s", flush=True)
    vol.commit()
    for L in layers:
        t = time.time()
        hf_hub_download("Qwen/SAE-Res-Qwen3.5-27B-W80K-L0_50", f"layer{L}.sae.pt", local_dir="/vol/sae/qwen35-27b-w80k-l50")
        print("sae", L, round(time.time() - t, 1), "s", flush=True)
    for f in ["config.json", "LICENSE", "README.md"]:
        hf_hub_download("Qwen/SAE-Res-Qwen3.5-27B-W80K-L0_50", f, local_dir="/vol/sae/qwen35-27b-w80k-l50")
    snapshot_download("discodamone/golden-gate-qwen", local_dir="/vol/replication/golden-gate-qwen")
    vol.commit()
    os.system("du -sh /vol/models/* /vol/sae/* /vol/replication/*")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", default="20,24,28,32,36,40,44")
    a = ap.parse_args()
    with modal.enable_output():
        with app.run():
            fetch.remote([int(x) for x in a.layers.split(",")])

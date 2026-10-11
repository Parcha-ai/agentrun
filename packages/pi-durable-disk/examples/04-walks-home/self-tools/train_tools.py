"""LoRA on Gemma 3 1B-IT from the exported trajectories (export.ts): the loss is taken only on the model's turns (the
character spans the format marks), then the adapter is merged and exported to GGUF with llama.cpp.

  python train_tools.py --data train-text.jsonl --out DIR [--rank 16] [--epochs 3] [--lr 2e-4]

Writes DIR/progress.jsonl, DIR/adapter (PEFT), DIR/adapter-<dtype>.gguf with DIR/adapter-<dtype>.json (the LoRA for
llama.cpp, unless --adapter-gguf none), DIR/model-f16.gguf, DIR/model-<quant>.gguf and DIR/summary.json.
"""
import argparse, hashlib, json, math, os, random, shutil, subprocess, sys, time

ap = argparse.ArgumentParser()
ap.add_argument("--data", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--base", default="/opt/gg/models/gemma-3-1b-it")
ap.add_argument("--rank", type=int, default=16)
ap.add_argument("--alpha", type=int, default=0, help="default: 2 x rank")
ap.add_argument("--lr", type=float, default=2e-4)
ap.add_argument("--epochs", type=float, default=3)
ap.add_argument("--batch", type=int, default=16)
ap.add_argument("--micro", type=int, default=8, help="sequences per forward pass (memory only)")
ap.add_argument("--max-len", type=int, default=3072)
ap.add_argument("--seed", type=int, default=0)
ap.add_argument("--llama-cpp", default="/opt/llama.cpp")
ap.add_argument("--quant", default="Q4_K_M")
# The LoRA as a llama.cpp GGUF adapter beside the merged model (a cached base plus adapters in the tab; D0's manifest).
# f16 by default: at rank 16 q8_0 saves little (lora_b's 16 columns cannot take its 32-wide blocks, so they stay f16) and
# tracks the merged model less closely (D0, wllama in Chrome: 5/12 identical greedy outputs with f16, 3/12 with q8_0).
ap.add_argument("--adapter-gguf", default="f16", choices=["q8_0", "f16", "none"])
ap.add_argument("--base-ref", default="google/gemma-3-1b-it@dcc83ea841ab6100d6b47a070329e1ba4cf78752", help="the HF source of --base")
ap.add_argument("--adapter-name", default="tools")
ap.add_argument("--adapter-kind", default="skill")
ap.add_argument("--adapter-topic", default="pi's tools: read, write and bash")
a = ap.parse_args()

os.makedirs(a.out, exist_ok=True)
T0 = time.time()
prog = open(os.path.join(a.out, "progress.jsonl"), "a")


def log(event, **kw):
    line = json.dumps(dict(event=event, t=round(time.time() - T0, 1), **kw))
    print(line, flush=True)
    prog.write(line + "\n")
    prog.flush()


import torch  # noqa: E402
from peft import LoraConfig, get_peft_model  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

random.seed(a.seed)
torch.manual_seed(a.seed)
tok = AutoTokenizer.from_pretrained(a.base)
rows = [json.loads(l) for l in open(a.data) if l.strip()]
# Loss spans are Unicode code points (Python's string index; tool-format.ts trainingRow writes them). A row without the
# unit is refused: JavaScript's own offsets count UTF-16 units and would shift past any emoji.
bad = [r.get("id", i) for i, r in enumerate(rows) if r.get("units") != "codepoint"]
if bad:
    sys.exit(f"{len(bad)} rows do not say their spans are code points (units: codepoint), e.g. {bad[:3]}; write them with tool-format.ts trainingRow()")
ex, dropped = [], 0
for r in rows:
    enc = tok(r["text"], add_special_tokens=True, return_offsets_mapping=True)
    ids, offs = enc["input_ids"], enc["offset_mapping"]
    if len(ids) > a.max_len:
        dropped += 1
        continue
    spans = r["train"]
    # A token is trained when it starts inside a model turn's span (the <bos> the tokenizer adds has an empty offset).
    lab = [t if e > s and any(a0 <= s < b0 for a0, b0 in spans) else -100 for t, (s, e) in zip(ids, offs)]
    ex.append((ids, lab))
n_tok = sum(len(i) for i, _ in ex)
n_lab = sum(sum(x != -100 for x in l) for _, l in ex)
log("data", rows=len(rows), used=len(ex), dropped_too_long=dropped, tokens=n_tok, trained_tokens=n_lab,
    max_len=max(len(i) for i, _ in ex))

model = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.bfloat16, device_map="cuda", attn_implementation="sdpa")
targets = r"(?!.*vision).*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)$"
model = get_peft_model(model, LoraConfig(r=a.rank, lora_alpha=a.alpha or 2 * a.rank, lora_dropout=0.0, task_type="CAUSAL_LM",
                                         target_modules=targets))
model.gradient_checkpointing_enable() if a.max_len > 4096 else None
per_epoch = math.ceil(len(ex) / a.batch)
steps = max(1, round(a.epochs * per_epoch))
opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.0)
warm = max(1, steps // 20)
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * max(0.0, 1 - s / steps))
rng = random.Random(a.seed)


def batches():
    order = sorted(range(len(ex)), key=lambda i: (len(ex[i][0]), rng.random()))
    bs = [order[i:i + a.batch] for i in range(0, len(order), a.batch)]
    rng.shuffle(bs)
    return bs


log("start", base=os.path.basename(a.base), rank=a.rank, alpha=a.alpha or 2 * a.rank, lr=a.lr, epochs=a.epochs, steps=steps,
    batch=a.batch, trainable=sum(p.numel() for p in model.parameters() if p.requires_grad))
pad = tok.pad_token_id
model.train()
plan, losses, step = [], [], 0
t_train = time.time()
while step < steps:
    if not plan:
        plan = batches()
    b = [ex[i] for i in plan.pop()]
    total = sum(sum(x != -100 for x in l) for _, l in b)
    step_loss = 0.0
    for m0 in range(0, len(b), a.micro):
        mb = b[m0:m0 + a.micro]
        L = max(len(i) for i, _ in mb)
        ids = torch.full((len(mb), L), pad)
        lab = torch.full((len(mb), L), -100)
        att = torch.zeros((len(mb), L), dtype=torch.long)
        for j, (i_, l_) in enumerate(mb):
            ids[j, :len(i_)] = torch.tensor(i_)
            lab[j, :len(l_)] = torch.tensor(l_)
            att[j, :len(i_)] = 1
        out = model(input_ids=ids.cuda(), attention_mask=att.cuda(), labels=lab.cuda())
        # Each micro-batch's mean loss, weighted by its share of the batch's trained tokens: a step is the batch mean.
        share = sum(sum(x != -100 for x in l) for _, l in mb) / total
        (out.loss * share).backward()
        step_loss += float(out.loss) * share
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
    step += 1
    losses.append(step_loss)
    if step % 5 == 0 or step in (1, steps):
        el = time.time() - t_train
        log("step", step=step, of=steps, loss=round(step_loss, 4), loss_avg=round(sum(losses[-10:]) / len(losses[-10:]), 4),
            lr=round(sched.get_last_lr()[0], 7), eta_s=round(el / step * (steps - step), 1))
train_s = time.time() - t_train

model.eval()
adapter = os.path.join(a.out, "adapter")
model.save_pretrained(adapter)
adapter_gguf = None
if a.adapter_gguf != "none":
    # llama.cpp's converter from the same tree as convert_hf_to_gguf (it reads only the base's config and tokenizer).
    adapter_gguf = os.path.join(a.out, f"adapter-{a.adapter_gguf}.gguf")
    subprocess.run([sys.executable, os.path.join(a.llama_cpp, "convert_lora_to_gguf.py"), "--base", a.base, "--outtype", a.adapter_gguf,
                    "--outfile", adapter_gguf, adapter], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    repo, _, revision = a.base_ref.partition("@")
    json.dump(dict(name=f"{a.adapter_name}.gguf", kind=a.adapter_kind, topic=a.adapter_topic, rank=a.rank, alpha=a.alpha or 2 * a.rank,
                   scale=1, dtype=a.adapter_gguf, model=dict(repo=repo, revision=revision)),
              open(os.path.join(a.out, f"adapter-{a.adapter_gguf}.json"), "w"), indent=1)
    log("adapter.gguf", path=adapter_gguf, bytes=os.path.getsize(adapter_gguf))
merged = model.merge_and_unload()
hf = os.path.join(a.out, "merged")
merged.save_pretrained(hf, safe_serialization=True)
tok.save_pretrained(hf)
del merged, model
torch.cuda.empty_cache()
log("merged", train_s=round(train_s, 1))
f16 = os.path.join(a.out, "model-f16.gguf")
q = os.path.join(a.out, f"model-{a.quant}.gguf")
subprocess.run([sys.executable, os.path.join(a.llama_cpp, "convert_hf_to_gguf.py"), hf, "--outtype", "f16", "--outfile", f16],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.run([os.path.join(a.llama_cpp, "build", "bin", "llama-quantize"), f16, q, a.quant, str(os.cpu_count() or 4)],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""):
            h.update(chunk)
    return h.hexdigest()
shutil.rmtree(hf)
summary = dict(gguf=os.path.basename(q), bytes=os.path.getsize(q), sha256=sha256(q), steps=steps, train_s=round(train_s, 1),
               final_loss=round(sum(losses[-10:]) / len(losses[-10:]), 4), examples=len(ex), trained_tokens=n_lab,
               rank=a.rank, lr=a.lr, epochs=a.epochs, total_s=round(time.time() - T0, 1),
               **({"adapter_gguf": os.path.basename(adapter_gguf), "adapter_bytes": os.path.getsize(adapter_gguf), "adapter_sha256": sha256(adapter_gguf)} if adapter_gguf else {}))
json.dump(summary, open(os.path.join(a.out, "summary.json"), "w"), indent=1)
log("done", **summary)

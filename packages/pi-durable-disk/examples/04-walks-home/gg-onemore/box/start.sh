#!/usr/bin/env bash
# Box start, as root: the vLLM server on GPU 1 (on /run/gg/vllm.sock, which only root reaches; its decoder layer at the
# clamp's layer carries the clamp's buffers, box/gg_clamp.py, all zero until bake), the guard on :8000 for the
# tunnel (the bearer key, /v1 only, every sentence cleared by Jev; the tools' typed routes), the lab on GPU 0
# (127.0.0.1:8100), and the reading list. Keys arrive in a root-only file that is deleted once read; the pipeline's
# commands run as the unprivileged user `agent` and never see them.
set -euo pipefail
G=/opt/gg-onemore
S=/var/tmp/gg
mkdir -p $S/run $G/reading
chmod 755 $S $S/run
set -a; . /run/gg/secrets.env; set +a
rm -f /run/gg/secrets.env
CLAMP_LAYER=$(python3 -c "import json; print(json.load(open('$G/pipeline/data/clamp.json'))['layer'])")
( cd /tmp && env -u TYPESAFE_API_KEY -u GG_EXEC_KEY CUDA_VISIBLE_DEVICES=1 VLLM_SERVER_DEV_MODE=1 VLLM_API_KEY=$GG_SERVE_KEY PYTHONPATH=$G/box \
  GG_CLAMP_GRAPH=$CLAMP_LAYER vllm serve /vol/models/Qwen3.5-27B --served-model-name qwen3.5-27b --uds /run/gg/vllm.sock \
  --worker-extension-cls gg_clamp.GraphClampWorker --enable-auto-tool-choice --tool-call-parser qwen3_coder \
  --reasoning-parser qwen3 --max-model-len 65536 --max-num-seqs 64 --gpu-memory-utilization 0.92 \
  --limit-mm-per-prompt '{"image":0,"video":0}' > $S/vllm.log 2>&1 & )
( cd $G/pipeline && env -u GG_EXEC_KEY CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 GG_RUN=$S/run python3 lab.py > $S/lab.log 2>&1 & )
( cd $G/box && CUDA_VISIBLE_DEVICES= GG_GUARD_LOG=$S/guard.jsonl python3 guard.py > $S/guard.log 2>&1 & )
unset TYPESAFE_API_KEY GG_SERVE_KEY GG_EXEC_KEY
( python3 $G/box/reading.py $G/reading > $S/reading.log 2>&1; chmod -R a+rX $G/reading ) &
echo started

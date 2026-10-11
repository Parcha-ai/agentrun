#!/usr/bin/env bash
# Scores a GGUF in a sandbox: llama-server (llama.cpp b11126, CPU) on the model, then the small model drives pi's loop
# on the given instance sets (lazy decoding unless MODES says otherwise), with every call executed here.
#   score-job.sh MODEL.gguf NAME "heldout unseen" "lazy" "7 8" [PATH for the model's bash]
set -uo pipefail
M=$1; N=$2; SETS=${3:-"heldout unseen"}; MODES=${4:-"lazy"}; SEEDS=${5:-"7"}; CMDPATH=${6:-}
/opt/llama.cpp/build/bin/llama-server -m "$M" --host 127.0.0.1 --port 8080 -c 65536 -np 16 -t "$(nproc)" --no-webui > /root/out/llama-$N.log 2>&1 &
for i in $(seq 1 120); do curl -sf 127.0.0.1:8080/health > /dev/null && break; sleep 1; done
curl -sf 127.0.0.1:8080/health > /dev/null || { echo "llama-server did not start:"; tail -5 /root/out/llama-$N.log; exit 1; }
cd /opt/st/x/04-walks-home/self-tools
for seed in $SEEDS; do
  for mode in $MODES; do
    for s in $SETS; do
      node drive.ts --instances /root/in/$s.jsonl --out /root/out/$N-$s-$mode-s$seed.jsonl --brain local --mode $mode --seed $seed \
        --concurrency 16 ${CMDPATH:+--path $CMDPATH} ${DRIVE_EXTRA:-} | tail -1
    done
  done
done
pkill -f llama-server; sleep 1

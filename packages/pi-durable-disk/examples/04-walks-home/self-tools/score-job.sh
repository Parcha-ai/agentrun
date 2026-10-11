#!/usr/bin/env bash
# Scores a GGUF in a sandbox: llama-server (llama.cpp b11126, CPU) on the model, then the small model drives pi's loop
# on the given instance sets, grammar-locked and free, with every call executed here.
#   score-job.sh MODEL.gguf NAME "heldout unseen" "grammar free"
set -uo pipefail
M=$1; N=$2; SETS=${3:-"heldout unseen"}; MODES=${4:-"grammar free"}
/opt/llama.cpp/build/bin/llama-server -m "$M" --host 127.0.0.1 --port 8080 -c 65536 -np 16 -t "$(nproc)" --no-webui > /root/out/llama-$N.log 2>&1 &
for i in $(seq 1 120); do curl -sf 127.0.0.1:8080/health > /dev/null && break; sleep 1; done
cd /opt/st
for mode in $MODES; do
  for s in $SETS; do
    node drive.ts --instances /root/in/$s.jsonl --out /root/out/$N-$s-$mode.jsonl --brain local --mode $mode --concurrency 16 | tail -1
  done
done
pkill -f llama-server; sleep 1

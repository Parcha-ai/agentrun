#!/usr/bin/env bash
# Dev loop: restart the lab and the guard with the keys in /run/gg/lab.env (deleted once read); vLLM keeps running.
set -euo pipefail
pkill -f 'python3 [l]ab.py' || true
pkill -f 'python3 [g]uard.py' || true
sleep 2
set -a; . /run/gg/lab.env; set +a
rm -f /run/gg/lab.env
cd /opt/gg-onemore/pipeline
env -u GG_EXEC_KEY CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 GG_RUN=/var/tmp/gg/run GG_CLAMP_GRAPH=24,28,32,36,40 GG_LIB_SOCK=/run/gg-lib/lab.sock nohup python3 lab.py > /var/tmp/gg/lab.log 2>&1 &
cd /opt/gg-onemore/box
CUDA_VISIBLE_DEVICES= GG_GUARD_LOG=/var/tmp/gg/guard.jsonl nohup python3 guard.py > /var/tmp/gg/guard.log 2>&1 &
echo restarted

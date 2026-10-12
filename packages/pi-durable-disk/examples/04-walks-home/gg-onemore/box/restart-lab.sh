#!/usr/bin/env bash
# Dev loop: restart the lab with the keys in /run/gg/lab.env (deleted once read); vLLM keeps running.
set -euo pipefail
pkill -f 'python3 [l]ab.py' || true
sleep 2
set -a; . /run/gg/lab.env; set +a
rm -f /run/gg/lab.env
cd /opt/gg-onemore/pipeline
CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 GG_RUN=/var/tmp/gg/run nohup python3 lab.py > /var/tmp/gg/lab.log 2>&1 &
echo restarted

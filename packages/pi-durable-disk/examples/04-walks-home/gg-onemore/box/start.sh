#!/usr/bin/env bash
# Box start, as root: the vLLM server on GPU 1 (127.0.0.1:8001, behind nginx on :8000 for the tunnel, /v1 only), the lab
# on GPU 0 (127.0.0.1:8100), and the reading list. Keys arrive in a root-only file that is deleted once read; the agent
# runs as the unprivileged user `agent` and never sees them.
set -euo pipefail
G=/opt/gg-onemore
S=/var/tmp/gg
mkdir -p $S/run $G/reading
chmod 755 $S $S/run
set -a; . /run/gg/secrets.env; set +a
rm -f /run/gg/secrets.env
cat > /tmp/gg-nginx.conf <<'NGINX'
# Only /v1 reaches the tunnel; vLLM checks the bearer key there. Its dev routes (/collective_rpc) stay local.
worker_processes 1;
pid /tmp/gg-nginx.pid;
events { worker_connections 256; }
http {
  access_log off;
  server {
    listen 8000;
    location /v1/ {
      proxy_pass http://127.0.0.1:8001;
      proxy_http_version 1.1;
      proxy_buffering off;
      proxy_read_timeout 600s;
      proxy_set_header Host $host;
    }
    location / { return 404; }
  }
}
NGINX
nginx -c /tmp/gg-nginx.conf
( cd /tmp && env -u TYPESAFE_API_KEY CUDA_VISIBLE_DEVICES=1 VLLM_SERVER_DEV_MODE=1 VLLM_API_KEY=$GG_SERVE_KEY PYTHONPATH=$G/box \
  vllm serve /vol/models/Qwen3.5-27B --served-model-name qwen3.5-27b --host 127.0.0.1 --port 8001 \
  --worker-extension-cls gg_worker.SteerWorker --enable-auto-tool-choice --tool-call-parser qwen3_coder \
  --reasoning-parser qwen3 --max-model-len 65536 --max-num-seqs 64 --gpu-memory-utilization 0.92 \
  --limit-mm-per-prompt '{"image":0,"video":0}' > $S/vllm.log 2>&1 & )
( cd $G/pipeline && CUDA_VISIBLE_DEVICES=0 HF_HUB_OFFLINE=1 GG_RUN=$S/run python3 lab.py > $S/lab.log 2>&1 & )
unset TYPESAFE_API_KEY GG_SERVE_KEY
( python3 $G/box/reading.py $G/reading > $S/reading.log 2>&1; chmod -R a+rX $G/reading ) &
echo started

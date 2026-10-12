# The GG box on Modal (app pda-gg-onemore): its image, and one 2x H100 sandbox for dev runs and the measured run.
#   with-modal -- with-typesafe -- python box.py up          create the box, start the lab and vLLM, print its tunnel
#   with-modal -- python box.py image | wait | exec [--root] CMD | down | ls
# The box's state (sandbox id, tunnel, the serve key's file) lives in GG_STATE (default ./box-state); the key file is 0600.
import argparse
import json
import os
import secrets
import sys
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
STATE = os.environ.get("GG_STATE", os.path.join(os.getcwd(), "box-state"))
APP = "pda-gg-onemore"
VOLUME = "pda-gg-onemore"


def image():
    return (
        modal.Image.from_registry("vllm/vllm-openai:v0.31.0")
        .entrypoint([])
        .apt_install("nginx")
        .run_commands("pip install --no-deps flash-linear-attention einops gguf && useradd -m -s /bin/bash agent && mkdir -p /opt/gg-onemore /run/gg /workspace && chmod 700 /run/gg && chown agent:agent /workspace")
        .add_local_dir(os.path.join(ROOT, "pipeline"), "/opt/gg-onemore/pipeline", copy=True, ignore=["__pycache__"])
        .add_local_dir(os.path.join(ROOT, "box"), "/opt/gg-onemore/box", copy=True, ignore=["__pycache__"])
        .run_commands("chmod -R a+rX /opt/gg-onemore && chmod 755 /opt/gg-onemore/pipeline/gg.py && ln -sf /opt/gg-onemore/pipeline/gg.py /usr/local/bin/gg")
    )


def state():
    with open(os.path.join(STATE, "box.json")) as f:
        return json.load(f)


def ledger(note):
    with open(os.path.join(STATE, "ledger.log"), "a") as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {note}\n")


def sandbox():
    return modal.Sandbox.from_id(state()["sandbox"])


def run(sb, cmd, root=False, stdin=None, timeout=1800):
    argv = ["bash", "-lc", cmd] if root else ["runuser", "-u", "agent", "--", "bash", "-lc", f"mkdir -p /workspace 2>/dev/null; cd /workspace 2>/dev/null || cd ~; {cmd}"]
    p = sb.exec(*argv, timeout=timeout)
    if stdin is not None:
        p.stdin.write(stdin)
        p.stdin.write_eof()
        p.stdin.drain()
    for chunk in p.stdout:
        sys.stdout.write(chunk)
        sys.stdout.flush()
    err = p.stderr.read()
    code = p.wait()
    if err:
        sys.stderr.write(err)
    return code


def up(args):
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    key = secrets.token_urlsafe(32)
    keyfile = os.path.join(STATE, "serve-key")
    with open(os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        f.write(key)
    jev = os.environ.get("TYPESAFE_API_KEY")
    if not jev:
        sys.exit("run under with-typesafe: the lab needs TYPESAFE_API_KEY")
    app = modal.App.lookup(APP, create_if_missing=True)
    t0 = time.time()
    sb = modal.Sandbox.create(
        "sleep", "infinity", app=app, image=image(), gpu=args.gpu, cpu=8, memory=65536, timeout=args.ttl * 60,
        volumes={"/vol": modal.Volume.from_name(VOLUME)}, encrypted_ports=[8000], name=f"gg-box-{int(t0)}",
    )
    sb.set_tags({"pda-fleet": "gg-onemore", "owner": "gg-onemore"})
    ledger(f"create {sb.object_id} gpu={args.gpu} ttl={args.ttl}m")
    created = time.time()
    run(sb, "umask 077; cat > /run/gg/secrets.env", root=True, stdin=f"TYPESAFE_API_KEY={jev}\nGG_SERVE_KEY={key}\n")
    run(sb, "/opt/gg-onemore/box/start.sh", root=True)
    url = sb.tunnels()[8000].url
    st = {"sandbox": sb.object_id, "url": url, "key_file": keyfile, "created": t0, "create_s": round(created - t0, 1), "gpu": args.gpu}
    with open(os.path.join(STATE, "box.json"), "w") as f:
        json.dump(st, f, indent=1)
    print(json.dumps({k: v for k, v in st.items() if k != "key_file"}))


def wait(args):
    sb = sandbox()
    t0 = time.time()
    seen = set()
    while time.time() - t0 < args.timeout:
        p = sb.exec("bash", "-lc", "curl -s -m 3 127.0.0.1:8100/status >/dev/null && echo lab; curl -s -m 3 127.0.0.1:8001/health >/dev/null && echo vllm; true")
        up_now = set(p.stdout.read().split())
        for s in up_now - seen:
            print(json.dumps({"ready": s, "s": round(time.time() - state()["created"], 1)}), flush=True)
        seen |= up_now
        if {"lab", "vllm"} <= seen:
            return 0
        time.sleep(5)
    print("timeout; tails:")
    run(sb, "tail -5 /var/tmp/gg/lab.log; tail -5 /var/tmp/gg/vllm.log", root=True)
    return 1


def push(args):
    """Dev loop: copy the pipeline into the running box and restart the lab (vLLM keeps running)."""
    import io
    import tarfile

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for d in ("pipeline", "box"):
            tar.add(os.path.join(ROOT, d), arcname=d, filter=lambda t: None if "__pycache__" in t.name else t)
    sb = sandbox()
    run(sb, "tar -x -C /opt/gg-onemore && chmod -R a+rX /opt/gg-onemore && chmod 755 /opt/gg-onemore/pipeline/gg.py", root=True, stdin=buf.getvalue())
    if args.restart:
        jev = os.environ.get("TYPESAFE_API_KEY")
        key = open(state()["key_file"]).read().strip()
        if not jev:
            sys.exit("run under with-typesafe to restart the lab")
        run(sb, "umask 077; cat > /run/gg/lab.env", root=True, stdin=f"TYPESAFE_API_KEY={jev}\nGG_SERVE_KEY={key}\n")
        run(sb, "/opt/gg-onemore/box/restart-lab.sh", root=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("up")
    u.add_argument("--gpu", default="H100:2")
    u.add_argument("--ttl", type=int, default=90)
    w = sub.add_parser("wait")
    w.add_argument("--timeout", type=int, default=900)
    e = sub.add_parser("exec")
    e.add_argument("--root", action="store_true")
    e.add_argument("command", nargs=argparse.REMAINDER)
    pu = sub.add_parser("push")
    pu.add_argument("--restart", action="store_true")
    sub.add_parser("down")
    sub.add_parser("ls")
    sub.add_parser("image")
    a = ap.parse_args()
    if a.cmd == "up":
        return up(a)
    if a.cmd == "wait":
        return wait(a)
    if a.cmd == "exec":
        return run(sandbox(), " ".join(a.command), root=a.root)
    if a.cmd == "push":
        return push(a)
    if a.cmd == "down":
        st = state()
        modal.Sandbox.from_id(st["sandbox"]).terminate()
        ledger(f"terminate {st['sandbox']} after {round((time.time() - st['created']) / 60, 1)} min")
        print("terminated", st["sandbox"])
        return 0
    if a.cmd == "ls":
        app = modal.App.lookup(APP, create_if_missing=True)
        for sb in modal.Sandbox.list(app_id=app.app_id):
            print(sb.object_id)
        return 0
    if a.cmd == "image":
        app = modal.App.lookup(APP, create_if_missing=True)
        img = image().build(app)
        print(img.object_id)
        return 0


if __name__ == "__main__":
    sys.exit(main() or 0)

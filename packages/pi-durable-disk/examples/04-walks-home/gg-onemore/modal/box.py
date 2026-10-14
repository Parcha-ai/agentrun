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
APP = os.environ.get("GG_APP", "pda-gg-onemore")  # the chat page uses its own app (chat/live-gg.mjs)
VOLUME = "pda-gg-onemore"


def image():
    return (
        modal.Image.from_registry("vllm/vllm-openai:v0.31.0")
        .entrypoint([])
        .run_commands("pip install --no-deps flash-linear-attention einops gguf && useradd -m -s /bin/bash agent && mkdir -p /opt/gg-onemore /run/gg && chmod 700 /run/gg")
        .add_local_dir(os.path.join(ROOT, "pipeline"), "/opt/gg-onemore/pipeline", copy=True, ignore=["__pycache__"])
        .add_local_dir(os.path.join(ROOT, "box"), "/opt/gg-onemore/box", copy=True, ignore=["__pycache__"])
        .add_local_dir(os.path.join(ROOT, "skills"), "/opt/gg-onemore/skills", copy=True)
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
    argv = ["bash", "-lc", cmd] if root else ["runuser", "-u", "agent", "--", "bash", "-lc", f"cd ~; {cmd}"]
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


def live():
    """The saved box, if it still runs."""
    try:
        sb = sandbox()
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        return None
    try:
        return sb if sb.poll() is None else None
    except Exception:
        return None


def up(args):
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    old = live()
    if old is not None:
        if not args.replace:
            sys.exit(f"a box is already running ({old.object_id}); `down` it first, or pass --replace")
        old.terminate()
        ledger(f"terminate {old.object_id} (replaced)")
    key = secrets.token_urlsafe(32)
    keyfile = os.path.join(STATE, "serve-key")
    with open(os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        f.write(key)
    exec_key = secrets.token_urlsafe(32)
    exec_keyfile = os.path.join(STATE, "exec-key")
    with open(os.open(exec_keyfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        f.write(exec_key)
    jev = os.environ.get("TYPESAFE_API_KEY")
    if not jev:
        sys.exit("run under with-typesafe: the lab needs TYPESAFE_API_KEY")
    app = modal.App.lookup(APP, create_if_missing=True)
    t0 = time.time()
    sb = modal.Sandbox.create(
        "sleep", "infinity", app=app, image=image(), gpu=args.gpu, cpu=8, memory=65536, timeout=args.ttl * 60,
        volumes={"/vol": modal.Volume.from_name(VOLUME)}, encrypted_ports=[8000], name=f"gg-box-{int(t0)}",
    )
    # saved before anything else can fail, so `down` always finds the box and both of its keys
    with open(os.path.join(STATE, "box.json"), "w") as f:
        json.dump({"sandbox": sb.object_id, "key_file": keyfile, "exec_key_file": exec_keyfile, "created": t0, "gpu": args.gpu}, f, indent=1)
    ledger(f"create {sb.object_id} gpu={args.gpu} ttl={args.ttl}m")
    sb.set_tags({"pda-fleet": "gg-onemore", "owner": "gg-onemore"})
    created = time.time()
    # best-of-N for the guard, only when the take asks for it (live-gg.mjs --best-of N)
    best_of = f"GG_BEST_OF={int(os.environ['GG_BEST_OF'])}\n" if os.environ.get("GG_BEST_OF") else ""
    run(sb, "umask 077; cat > /run/gg/secrets.env", root=True, stdin=f"TYPESAFE_API_KEY={jev}\nGG_SERVE_KEY={key}\nGG_EXEC_KEY={exec_key}\n{best_of}")
    run(sb, "/opt/gg-onemore/box/start.sh", root=True)
    url = sb.tunnels()[8000].url
    st = {"sandbox": sb.object_id, "url": url, "key_file": keyfile, "exec_key_file": exec_keyfile, "created": t0, "create_s": round(created - t0, 1), "gpu": args.gpu}
    with open(os.path.join(STATE, "box.json"), "w") as f:
        json.dump(st, f, indent=1)
    print(json.dumps({k: v for k, v in st.items() if not k.endswith("key_file")}))


def wait(args):
    sb = sandbox()
    t0 = time.time()
    seen = set()
    while time.time() - t0 < args.timeout:
        p = sb.exec("bash", "-lc", "curl -sf -m 3 127.0.0.1:8100/status >/dev/null && echo lab; curl -sf -m 3 --unix-socket /run/gg/vllm.sock http://vllm.sock/health >/dev/null && echo vllm; true")
        up_now = set(p.stdout.read().split())
        for s in up_now - seen:
            print(json.dumps({"ready": s, "s": round(time.time() - state()["created"], 1)}), flush=True)
        seen |= up_now
        # both healthy in the same poll: one that answered once and then died does not count
        if {"lab", "vllm"} <= up_now:
            return 0
        time.sleep(5)
    print("timeout; tails:")
    run(sb, "tail -5 /var/tmp/gg/lab.log; tail -5 /var/tmp/gg/vllm.log", root=True)
    return 1


def push(args):
    """Dev loop: copy the pipeline and box files into the running box and restart the lab and the guard (vLLM keeps running)."""
    import io
    import tarfile

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for d in ("pipeline", "box", "skills"):
            tar.add(os.path.join(ROOT, d), arcname=d, filter=lambda t: None if "__pycache__" in t.name else t)
    sb = sandbox()
    run(sb, "tar -x -C /opt/gg-onemore && chmod -R a+rX /opt/gg-onemore && chmod 755 /opt/gg-onemore/pipeline/gg.py", root=True, stdin=buf.getvalue())
    if args.restart:
        jev = os.environ.get("TYPESAFE_API_KEY")
        key = open(state()["key_file"]).read().strip()
        exec_key = open(state()["exec_key_file"]).read().strip() if state().get("exec_key_file") else ""
        if not jev:
            sys.exit("run under with-typesafe to restart the lab")
        run(sb, "umask 077; cat > /run/gg/lab.env", root=True, stdin=f"TYPESAFE_API_KEY={jev}\nGG_SERVE_KEY={key}\nGG_EXEC_KEY={exec_key}\n")
        run(sb, "/opt/gg-onemore/box/restart.sh", root=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    u = sub.add_parser("up")
    u.add_argument("--gpu", default="H100:2")
    u.add_argument("--ttl", type=int, default=90)
    u.add_argument("--replace", action="store_true", help="terminate the saved box if it still runs")
    w = sub.add_parser("wait")
    w.add_argument("--timeout", type=int, default=900)
    e = sub.add_parser("exec")
    e.add_argument("--root", action="store_true")
    e.add_argument("command", nargs=argparse.REMAINDER)
    pu = sub.add_parser("push")
    pu.add_argument("--restart", action="store_true")
    dn = sub.add_parser("down")
    dn.add_argument("--id", help="terminate this sandbox (default: the saved box)")
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
        try:
            st = state()
        except FileNotFoundError:
            st = {}
        target = a.id or st.get("sandbox")
        if not target:
            print("no saved box")
            return 0
        modal.Sandbox.from_id(target).terminate()
        age = f" after {round((time.time() - st['created']) / 60, 1)} min" if st.get("sandbox") == target and st.get("created") else ""
        ledger(f"terminate {target}{age}")
        if st.get("sandbox") == target:
            # the box's per-run keys die with it: its guard held only their hashes, the host's copies go now
            for path in (st.get("key_file"), st.get("exec_key_file")):
                if path and os.path.exists(path):
                    os.unlink(path)
        print("terminated", target)
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

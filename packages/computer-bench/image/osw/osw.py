#!/usr/bin/env python3
# osw: an OSWorld task's own setup and evaluator, run inside a bench desktop image, as `python3 osw.py <command>`.
#
#   osw setup <osworld.json>  starts OSWorld's in-VM server on 127.0.0.1 as the desktop user, runs the task's `config`
#                             through OSWorld's SetupController, and stops the server. The apps it launched stay up.
#   osw eval <osworld.json>   starts the server again, runs `postconfig`, then each getter and metric with its options
#                             and `conj`, as OSWorld's DesktopEnv.evaluate() does, and stops the server.
#
# Every download (a config or postconfig `download` step) and every gold (a `cloud_file` getter) is fetched by its URL
# and checked against the sha256 the task pins, into the task's cache, a folder only osw's user reads. SetupController
# and get_cloud_file find the files there and fetch nothing themselves. osw runs as the computer's own user, the agent's
# too, so `osw eval` first removes the whole cache (--cache) and makes it again: nothing the agent's turn left there is
# read, and the golds, fetched by `osw eval` alone, are never on the box while the agent runs. The server's Python runs
# isolated (-I), so a module planted in the user's own site-packages never loads in it.
#
# Exit codes, as the bench reads an exec check:
#   0   setup done; or a score of 1
#   1   a score below 1
#   2   a task osw can't check: an infeasible task, a malformed task or evaluator (found before the server starts, by
#       setup and eval alike), a getter or metric OSWorld lacks, a download or cloud file with no pinned sha256
#   75  the check could not run (EX_TEMPFAIL): the server didn't start, a setup step, getter or metric raised, a download
#       failed or its sha256 differs from the pinned one, or a signal stopped osw. The box's fault, not the agent's: run
#       it again, never score it.
#
# OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab) is not in this file or this
# repository: osw imports it at run time from --osworld, and only inside the functions that use it. evaluate() is a port
# of DesktopEnv.evaluate() with no action history (the bench keeps none; an infeasible task is checked by its answer).
#
# Options default to OSW_* variables: --osworld OSW_OSWORLD (OSWorld's checkout), --port OSW_PORT (5000), --cache
# OSW_CACHE (~/.cache/osw), --home OSW_HOME (/home/user). The server gets osw's environment (DISPLAY included) with HOME.
import argparse
import contextlib
import ctypes
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback
import urllib.request
import uuid

PASS, FAIL, BAD_TASK, INFRA = 0, 1, 2, 75
HOST = "127.0.0.1"
CHROMIUM_PORT, VLC_PORT = 9222, 8080
START_S = 60
SHA256 = re.compile(r"[0-9a-f]{64}")
# The server, as main.py's own `__main__` would run it, but on loopback and with no reloader.
SERVE = "import sys; sys.path.insert(0, sys.argv[1]); import main; main.app.run(host=sys.argv[2], port=int(sys.argv[3]))"


class BadTask(Exception):
    """A task osw can't check: exit 2."""


class Stopped(BaseException):
    """A signal stopped osw. A BaseException, so OSWorld's `except Exception` blocks don't swallow it."""


def stopped(signum, _frame):
    raise Stopped(f"stopped by signal {signum}")


def as_list(value):
    return value if isinstance(value, list) else [value] if value else []


def pinned(value, what):
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise BadTask(f"{what} has no pinned sha256")
    return value


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as read:
        for chunk in iter(lambda: read.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url, path, sha256):
    """url's bytes at path, unless a file with that sha256 is there. A different sha256 raises and leaves nothing."""
    if os.path.exists(path) and file_sha256(path) == sha256:
        return
    part = f"{path}.part"
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(url, timeout=300) as response, open(part, "wb") as out:
            for chunk in iter(lambda: response.read(1 << 20), b""):
                out.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != sha256:
            raise RuntimeError(f"{url}: sha256 {digest.hexdigest()}, pinned {sha256}")
        os.replace(part, path)
    finally:
        if os.path.exists(part):
            os.remove(part)


def fetch_downloads(steps, cache):
    """Each download step's files, where SetupController._download_setup looks first (named as it names them)."""
    for step in steps:
        if step.get("type") != "download":
            continue
        for one in step["parameters"]["files"]:
            name = f"{uuid.uuid5(uuid.NAMESPACE_URL, one['url'])}_{os.path.basename(one['path'])}"
            fetch(one["url"], os.path.join(cache, name), pinned(one.get("sha256"), f"download {one['url']}"))


def fetch_cloud_files(configs, cache):
    """Each cloud_file getter's files (the golds), where get_cloud_file looks first: the cache, by `dest`."""
    for config in configs:
        if not config or config.get("type") != "cloud_file":
            continue
        multi = config.get("multi", False)
        urls = config["path"] if multi else [config["path"]]
        dests = config["dest"] if multi else [config["dest"]]
        sums = config.get("sha256") if multi else [config.get("sha256")]
        if not isinstance(sums, list) or len(sums) != len(urls):
            raise BadTask(f"cloud file {urls}: one pinned sha256 per file")
        for url, dest, sha256 in zip(urls, dests, sums):
            fetch(url, os.path.join(cache, dest), pinned(sha256, f"cloud file {url}"))


def cache_dir(base, task_id):
    """The task's cache (downloads, golds, the results getters copy out), its owner's alone."""
    path = os.path.join(base, task_id)
    for one in (base, path):
        os.makedirs(one, exist_ok=True)
        os.chmod(one, 0o700)
    return path


def fresh_cache(base, task_id, home):
    """cache_dir, once the whole of base is removed: a link or a file unlinked (never followed), a folder removed with
    what is in it. Never / or the desktop user's HOME."""
    if os.path.abspath(base) in ("/", home):
        raise RuntimeError(f"the cache {base} is / or the desktop user's HOME, which osw eval never removes")
    if os.path.islink(base) or os.path.isfile(base):
        os.unlink(base)
    elif os.path.isdir(base):
        shutil.rmtree(base)
    return cache_dir(base, task_id)


def reachable(port):
    with socket.socket() as probe:
        probe.settimeout(1)
        return probe.connect_ex((HOST, port)) == 0


def die_with_parent():
    """The server gets SIGTERM when osw ends, even by SIGKILL (an exec timeout): prctl(PR_SET_PDEATHSIG)."""
    ctypes.CDLL(None).prctl(1, signal.SIGTERM)


@contextlib.contextmanager
def server(args, cache):
    """OSWorld's server on 127.0.0.1, as osw's own user (the desktop's), for the block's length. Stopping it ends the
    server alone, never its process group, so the apps it launched stay up."""
    if reachable(args.port):
        raise RuntimeError(f"something already listens on {HOST}:{args.port}")
    env = dict(os.environ, HOME=args.home)
    log_path = os.path.join(cache, "server.log")
    with open(log_path, "ab") as log:
        argv = [sys.executable, "-I", "-c", SERVE, os.path.join(args.osworld, "desktop_env", "server"), HOST, str(args.port)]
        proc = subprocess.Popen(argv, cwd=args.home, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, preexec_fn=die_with_parent)
    try:
        deadline = time.monotonic() + START_S
        while not reachable(args.port):
            if proc.poll() is not None:
                with open(log_path, "rb") as read:
                    tail = read.read()[-600:].decode(errors="replace")
                raise RuntimeError(f"the server exited {proc.returncode}: {tail}")
            if time.monotonic() > deadline:
                raise RuntimeError(f"the server did not listen on {HOST}:{args.port} within {START_S} s")
            time.sleep(0.1)
        yield
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


def setup_controller(port, cache):
    from desktop_env.controllers.setup import SetupController

    # The screen from SCREEN_WIDTH and SCREEN_HEIGHT, as DesktopEnv reads it. No client password: DesktopEnv's is its
    # VM user's, for `echo {CLIENT_PASSWORD} | sudo -S`, and osw has no root (the loader refuses a task that runs sudo).
    width, height = int(os.environ.get("SCREEN_WIDTH", 1920)), int(os.environ.get("SCREEN_HEIGHT", 1080))
    return SetupController(vm_ip=HOST, server_port=port, chromium_port=CHROMIUM_PORT, vlc_port=VLC_PORT, cache_dir=cache, screen_width=width, screen_height=height)


class Env:
    """The DesktopEnv attributes OSWorld's getters read, pointed at the server on loopback."""

    vm_ip = HOST
    chromium_port = CHROMIUM_PORT
    vlc_port = VLC_PORT
    vm_platform = "Linux"
    current_use_proxy = False
    is_environment_used = True

    def __init__(self, port, cache):
        from desktop_env.controllers.python import PythonController

        self.server_port = port
        self.cache_dir = cache
        self.controller = PythonController(vm_ip=HOST, server_port=port)
        self.setup_controller = setup_controller(port, cache)

    @property
    def vm_machine(self):
        return self.controller.get_vm_machine()

    @property
    def vm_screen_size(self):
        return self.controller.get_vm_screen_size()


def steps_of(value, what):
    """A config or postconfig: absent, or a list of step objects."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(step, dict) for step in value):
        raise BadTask(f"the task's {what} is not a list of step objects")
    return value


def shape(evaluator):
    """The evaluator as DesktopEnv._set_evaluator_info reads it: (single, names, results, expected, options), each a list
    with one entry per metric (an empty getter as None, empty options as {}). A shape OSWorld can't read is a bad task."""
    if not isinstance(evaluator, dict):
        raise BadTask("the task's evaluator is not an object")
    func = evaluator.get("func")
    single = isinstance(func, str)
    names = [func] if single else func
    if not isinstance(names, list) or not names or not all(isinstance(name, str) and name for name in names):
        raise BadTask("the evaluator's func is not a name or a non-empty list of names")

    def per_metric(field, valid, kind):
        value = evaluator.get(field)
        if single:
            value = [value]
        elif not value:
            value = [None] * len(names)
        elif not isinstance(value, list) or len(value) != len(names):
            raise BadTask(f"the evaluator's {field} is not a list with one entry per func")
        if not all(not one or valid(one) for one in value):
            raise BadTask(f"the evaluator's {field} holds something that is not {kind}")
        return [one or None for one in value]

    def is_getter(config):
        return isinstance(config, dict) and isinstance(config.get("type"), str) and config["type"] != ""

    results = per_metric("result", is_getter, "a getter object with a type")
    expected = per_metric("expected", is_getter, "a getter object with a type")
    options = [one or {} for one in per_metric("options", lambda one: isinstance(one, dict), "an options object")]
    return single, names, results, expected, options


def check_task(task):
    """The task as osw reads it, checked before anything runs: an object with a plain id, a config of steps, and an
    evaluator of a shape OSWorld reads with a postconfig of steps."""
    if not isinstance(task, dict):
        raise BadTask("the task is not a JSON object")
    if not isinstance(task.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", task["id"]):
        raise BadTask("the task's id is missing or not a plain name")
    steps_of(task.get("config"), "config")
    shape(task.get("evaluator"))
    steps_of(task["evaluator"].get("postconfig"), "postconfig")


def plan(evaluator):
    """The evaluator as DesktopEnv._set_evaluator_info reads it: (single, conj, [(metric, result, expected, options)]),
    each getter as (function, config). A name OSWorld lacks is a bad task, found before anything runs."""
    from desktop_env.evaluators import getters, metrics

    single, names, results, expected, options = shape(evaluator)
    if evaluator["func"] == "infeasible":
        raise BadTask("an infeasible task is checked by the agent's answer, not by osw")

    def find(module, name):
        found = getattr(module, name, None)
        if not callable(found):
            raise BadTask(f"OSWorld has no {module.__name__.rsplit('.', 1)[-1]} {name!r}")
        return found

    def getter(config):
        return (find(getters, f"get_{config['type']}"), config) if config else None

    steps = []
    for name, result, gold, option in zip(names, results, expected, options):
        if not result:
            raise BadTask(f"metric {name!r} has no result getter")
        steps.append((find(metrics, name), getter(result), getter(gold), option))
    return single, evaluator.get("conj", "and"), steps


def evaluate(env, single, conj, steps):
    """DesktopEnv.evaluate() from its metrics on. A result getter's FileNotFoundError scores 0; with many metrics `and`
    stops at a 0 and `or` at a 1, else the mean (`and`) or the best (`or`)."""
    scores = []
    for metric, (get_result, result), expected, options in steps:
        try:
            state = get_result(env, result)
        except FileNotFoundError:
            if single or conj == "and":
                return 0.0
            scores.append(0.0)
            continue
        score = float(metric(state, expected[0](env, expected[1]), **options) if expected else metric(state, **options))
        if single:
            return score
        if conj == "and" and score == 0.0:
            return 0.0
        if conj == "or" and score == 1.0:
            return 1.0
        scores.append(score)
    return sum(scores) / len(scores) if conj == "and" else max(scores)


def run_setup(args, task, cache):
    config = steps_of(task.get("config"), "config")
    fetch_downloads(config, cache)
    with server(args, cache):
        if setup_controller(args.port, cache).setup(config) is False:
            raise RuntimeError("SetupController could not reach the server")
    print(f"osw: {task['id']}: setup done")
    return PASS


def run_eval(args, task, cache):
    evaluator = task["evaluator"]
    single, conj, steps = plan(evaluator)
    postconfig = steps_of(evaluator.get("postconfig"), "postconfig")
    fetch_downloads(postconfig, cache)
    fetch_cloud_files(as_list(evaluator.get("result")) + as_list(evaluator.get("expected")), cache)
    with server(args, cache):
        env = Env(args.port, cache)
        if env.setup_controller.setup(postconfig) is False:
            raise RuntimeError("postconfig: SetupController could not reach the server")
        score = evaluate(env, single, conj, steps)
    print(f"score {score:g}")
    return PASS if score == 1.0 else FAIL


def main(argv=None):
    parser = argparse.ArgumentParser(prog="osw", description="An OSWorld task's own setup and evaluator, in a bench desktop image.")
    parser.add_argument("command", choices=["setup", "eval"])
    parser.add_argument("task", help="the task's OSWorld JSON")
    parser.add_argument("--osworld", default=os.environ.get("OSW_OSWORLD"), help="OSWorld's checkout (OSW_OSWORLD)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("OSW_PORT", 5000)), help="the server's port (OSW_PORT, 5000)")
    parser.add_argument("--cache", default=os.environ.get("OSW_CACHE", os.path.expanduser("~/.cache/osw")), help="the tasks' caches, which osw eval removes whole and makes again (OSW_CACHE)")
    parser.add_argument("--home", default=os.environ.get("OSW_HOME", "/home/user"), help="the server's HOME and working directory (OSW_HOME)")
    args = parser.parse_args(argv)
    if not args.osworld:
        parser.error("--osworld or OSW_OSWORLD names OSWorld's checkout")
    # From osw's working directory: the server runs in --home.
    args.osworld, args.home = os.path.abspath(args.osworld), os.path.abspath(args.home)
    for one in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(one, stopped)
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(name)s: %(message)s")
    sys.path.insert(0, args.osworld)
    try:
        try:
            with open(args.task) as read:
                task = json.load(read)
        except (OSError, ValueError) as error:
            raise BadTask(f"{args.task}: {error}") from error
        check_task(task)
        cache = cache_dir(args.cache, task["id"]) if args.command == "setup" else fresh_cache(args.cache, task["id"], args.home)
        return (run_setup if args.command == "setup" else run_eval)(args, task, cache)
    except BadTask as error:
        print(f"osw {args.command}: bad task: {error}", file=sys.stderr)
        return BAD_TASK
    except (Exception, Stopped) as error:
        print(f"osw {args.command}: could not run (infra): {type(error).__name__}: {error}", file=sys.stderr)
        traceback.print_exception(type(error), error, error.__traceback__, limit=-3)
        return INFRA


if __name__ == "__main__":
    sys.exit(main())

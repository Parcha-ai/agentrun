# Stand-in getters for osw's tests, called as OSWorld calls its own: get_<type>(env, config).
import os
import time


def get_vm_file(env, config):
    data = env.controller.get_file(config["path"])
    if data is None:
        return None
    path = os.path.join(env.cache_dir, config["dest"])
    with open(path, "wb") as out:
        out.write(data)
    return path


def get_cloud_file(env, config):
    # OSWorld's own would download a missing file: this one proves osw fetched it first.
    path = os.path.join(env.cache_dir, config["dest"])
    if not os.path.exists(path):
        raise AssertionError(f"osw did not fetch {config['path']}")
    return path


def get_rule(env, config):
    return config["rules"]


def get_crash(env, config):
    raise RuntimeError("the getter crashed")


def get_missing(env, config):
    raise FileNotFoundError(config.get("path", "nothing"))


def get_slow(env, config):
    time.sleep(60)

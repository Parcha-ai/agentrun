# A stand-in for OSWorld's SetupController (desktop_env/controllers/setup.py) in osw's tests: the same constructor, the
# same setup() loop over `_<type>_setup` steps, and download's cache naming, over urllib instead of requests.
import json
import os
import urllib.request
import uuid


class SetupController:
    def __init__(self, vm_ip, server_port=5000, chromium_port=9222, vlc_port=8080, cache_dir="cache", client_password="", screen_width=1920, screen_height=1080, os_type="Ubuntu"):
        self.http_server = f"http://{vm_ip}:{server_port}"
        self.cache_dir = cache_dir

    def _post(self, path, body):
        request = urllib.request.Request(self.http_server + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()

    def setup(self, config, use_proxy=False):
        with urllib.request.urlopen(self.http_server + "/terminal", timeout=30) as response:
            response.read()
        for i, cfg in enumerate(config):
            if getattr(self, "_{:}_setup".format(cfg["type"]))(**cfg["parameters"]) is False:
                raise Exception(f"Setup step {i + 1} failed")
        return True

    def _download_setup(self, files):
        for f in files:
            cache_path = os.path.join(self.cache_dir, "{:}_{:}".format(uuid.uuid5(uuid.NAMESPACE_URL, f["url"]), os.path.basename(f["path"])))
            if not os.path.exists(cache_path):
                with urllib.request.urlopen(f["url"], timeout=30) as response, open(cache_path, "wb") as out:
                    out.write(response.read())
            with open(cache_path, "rb") as read:
                self._post("/setup/upload", {"file_path": f["path"], "hex": read.read().hex()})

    def _launch_setup(self, command, shell=False):
        self._post("/setup/launch", {"command": command, "shell": shell})

    def _execute_setup(self, command, **_):
        self._post("/execute", {"command": command})

    def _fail_setup(self):
        return False

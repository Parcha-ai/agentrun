# A stand-in for OSWorld's PythonController (desktop_env/controllers/python.py) in osw's tests: get_file over the stub
# server's /file.
import json
import urllib.error
import urllib.request


class PythonController:
    def __init__(self, vm_ip, server_port, pkgs_prefix=""):
        self.http_server = f"http://{vm_ip}:{server_port}"

    def get_file(self, file_path):
        request = urllib.request.Request(self.http_server + "/file", data=json.dumps({"file_path": file_path}).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except urllib.error.HTTPError:
            return None

    def get_vm_machine(self):
        return "x86_64"

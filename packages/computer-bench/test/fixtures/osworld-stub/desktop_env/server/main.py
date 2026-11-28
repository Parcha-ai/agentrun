# A stand-in for OSWorld's in-VM server (desktop_env/server/main.py) in osw's tests, stdlib only: the endpoints the stub
# controllers call, each request written in order to $HOME/requests.log. Like the real one it exposes `app`, whose run()
# osw calls with the host and port.
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

LOG = os.path.join(os.environ["HOME"], "requests.log")


def log(line):
    with open(LOG, "a") as out:
        out.write(line + "\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, code, body, kind="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        log(f"GET {path}")
        if path == "/terminal":
            return self.reply(200, {"output": None, "status": "success"})
        return self.reply(404, {"status": "error"})

    def do_POST(self):
        path = urlparse(self.path).path
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if path == "/file":
            log(f"POST /file {body['file_path']}")
            try:
                with open(body["file_path"], "rb") as read:
                    return self.reply(200, read.read(), "application/octet-stream")
            except FileNotFoundError:
                return self.reply(404, {"status": "error"})
        if path == "/setup/upload":
            log(f"POST /setup/upload {body['file_path']}")
            with open(body["file_path"], "wb") as out:
                out.write(bytes.fromhex(body["hex"]))
            return self.reply(200, {"status": "success"})
        log(f"POST {path} {json.dumps(body, sort_keys=True)}")
        if path == "/setup/launch":
            # As the real server does: the app is the server's child, in its session.
            child = subprocess.Popen(body["command"])
            log(f"launched {child.pid}")
            return self.reply(200, {"status": "success"})
        if path == "/execute":
            return self.reply(200, {"status": "success", "output": "", "error": "", "returncode": 0})
        return self.reply(404, {"status": "error"})


class App:
    def run(self, host, port, **_):
        server = ThreadingHTTPServer((host, port), Handler)
        log(f"listening {host} {port} home={os.environ['HOME']} cwd={os.getcwd()}")
        server.serve_forever()


app = App()

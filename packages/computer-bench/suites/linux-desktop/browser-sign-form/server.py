import html
import http.server
import urllib.parse

PORT = {{port}}
BOOK = "/tmp/computer-bench-{{nonce}}/guestbook-{{nonce}}.txt"
FORM = """<!doctype html>
<html><head><meta charset="utf-8"><title>Guest book {{nonce}}</title></head>
<body>
<h1>Guest book</h1>
<p>Leave your name to sign the guest book of the {{g.place}}.</p>
<form method="post" action="/sign">
<label for="name">Your name</label>
<input id="name" name="name" type="text" autofocus>
<button type="submit">Sign</button>
</form>
</body></html>
"""


class Book(http.server.BaseHTTPRequestHandler):
    def page(self, code, body):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split("?")[0] == "/":
            self.page(200, FORM)
        else:
            self.page(404, "<p>Not here.</p>")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        fields = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        name = (fields.get("name") or [""])[0].strip()
        if self.path != "/sign" or not name:
            self.page(400, "<p>Write a name first.</p>")
            return
        with open(BOOK, "a", encoding="utf-8") as book:
            book.write(name + "\n")
        self.page(200, "<!doctype html><title>Signed</title><h1>Thank you, " + html.escape(name) + "</h1><p>You signed the guest book.</p>")

    def log_message(self, *args):
        pass


http.server.HTTPServer(("127.0.0.1", PORT), Book).serve_forever()

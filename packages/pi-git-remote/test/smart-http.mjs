import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { after } from "node:test";
import { local, openRepo } from "../dist/index.js";
import { bareRepo, rawGit, scratch } from "./support.mjs";

const closers = [];
after(() => Promise.all(closers.map((close) => close())));

const OPENSSL_CONFIG = `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = 127.0.0.1
[ext]
subjectAltName = IP:127.0.0.1
basicConstraints = critical,CA:TRUE
`;

/** A self-signed certificate for 127.0.0.1, made at test time: the package accepts only https, so the server speaks TLS
 *  and git is pointed at this file as its one trusted CA. */
async function selfSigned(dir) {
  await mkdir(dir, { recursive: true });
  const [config, key, cert] = ["openssl.cnf", "key.pem", "cert.pem"].map((name) => path.join(dir, name));
  await writeFile(config, OPENSSL_CONFIG);
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-config", config], { stdio: "ignore" });
  return { key: await readFile(key), cert: await readFile(cert), caFile: cert };
}

const PROTOCOL_PATH = /^\/(?<name>.+)\/(?<tail>info\/refs|git-upload-pack|git-receive-pack)$/;
const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

/** The server's own three smart-HTTP requests, or null for anything else. */
function route(req, names) {
  let url;
  try {
    url = new URL(req.url, "https://server.invalid");
  } catch {
    return null;
  }
  const match = PROTOCOL_PATH.exec(url.pathname);
  if (!match || !names.has(match.groups.name)) return null;
  const { name, tail } = match.groups;
  const type = req.headers["content-type"] ?? "";
  if (tail === "info/refs") {
    const service = url.searchParams.get("service");
    return req.method === "GET" && [...url.searchParams.keys()].join() === "service" && SERVICES.has(service) ? { name, tail, service, query: url.search.slice(1) } : null;
  }
  return req.method === "POST" && type === `application/x-${tail}-request` ? { name, tail, service: tail, query: "" } : null;
}

/** Splits a CGI response into its header block and the body bytes that follow. */
function parseCgi(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  const [end, gap] = crlf !== -1 && (lf === -1 || crlf < lf) ? [crlf, 4] : [lf, 2];
  if (end === -1) return null;
  const headers = {};
  let status = 200;
  for (const line of buffer.subarray(0, end).toString("utf8").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at < 1) continue;
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers[name] = value;
  }
  return { status, headers, rest: buffer.subarray(end + gap) };
}

/**
 * A smart-HTTP git server for one test: Node's https server in front of `git http-backend` over the bare repositories
 * at `<root>/<name>` for each name in `names`. It speaks only the three requests git makes (`info/refs`,
 * `git-upload-pack`, `git-receive-pack`) for those names and answers anything else 404 without a challenge, because a
 * service on this machine connects to new loopback listeners. HTTP Basic is required: user `t` and a token the test
 * allowed, which becomes the CGI's REMOTE_USER, so a hook in the server repository can tell identities apart.
 * `requests` records each protocol request with the Authorization header it carried; `rejected` records the rest.
 */
export async function startGitServer({ root, names, echoToken = false }) {
  const tls = await selfSigned(path.join(root, "tls"));
  const home = path.join(root, "server-home");
  await mkdir(home, { recursive: true });
  const allowed = new Map();
  const nameSet = new Set(names);
  const requests = [];
  const rejected = [];
  const children = new Set();

  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const target = route(req, nameSet);
    if (!target) {
      rejected.push({ method: req.method, url: req.url });
      req.resume();
      res.writeHead(404, { Connection: "close" }).end();
      return;
    }
    const authorization = req.headers.authorization ?? null;
    const record = { method: req.method, name: target.name, tail: target.tail, authorization, status: 0, identity: null };
    requests.push(record);
    const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization ?? "");
    const decoded = basic ? Buffer.from(basic[1], "base64").toString("utf8") : "";
    const colon = decoded.indexOf(":");
    const presented = colon === -1 ? null : decoded.slice(colon + 1);
    const identity = colon !== -1 && decoded.slice(0, colon) === "t" ? allowed.get(presented) : undefined;
    if (identity === undefined) {
      record.status = 401;
      req.resume();
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"', "Content-Length": "0" }).end();
      return;
    }
    record.identity = identity;
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method,
      PATH_INFO: `/${target.name}/${target.tail}`,
      QUERY_STRING: target.query,
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_USER: identity,
      REMOTE_ADDR: "127.0.0.1",
      ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
      ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
      ...(/^[A-Za-z0-9=:;,_ -]{1,64}$/.test(req.headers["git-protocol"] ?? "") ? { GIT_PROTOCOL: req.headers["git-protocol"] } : {}),
      ...(echoToken ? { TEST_PRESENTED_TOKEN: presented } : {}),
    };
    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    child.on("close", () => children.delete(child));
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    req.pipe(child.stdin);
    let head = null;
    let pending = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      if (head) {
        res.write(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      head = parseCgi(pending);
      if (!head) return;
      record.status = head.status;
      res.writeHead(head.status, head.headers);
      if (head.rest.length) res.write(head.rest);
    });
    child.on("close", () => {
      if (!head) {
        record.status = 500;
        res.writeHead(500).end();
      } else res.end();
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  const close = async () => {
    for (const child of children) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  closers.push(close);

  return {
    /** `https://127.0.0.1:<port>`: the origin a host passes. */
    origin: `https://127.0.0.1:${port}`,
    caFile: tls.caFile,
    requests,
    rejected,
    url: (name) => `https://127.0.0.1:${port}/${name}`,
    allow: (token, identity) => void allowed.set(token, identity),
    revoke: (token) => void allowed.delete(token),
    ca: tls.cert,
    close,
  };
}

/** A pre-receive hook for a server repository: the identity `refuseMainFor` may not touch refs/heads/main, as a ref policy
 *  would say. With `echoToken` on the server, its message repeats the token it was shown, as a hostile server might. */
export async function plantRefPolicy(gitDir, refuseMainFor) {
  const hook = path.join(gitDir, "hooks", "pre-receive");
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ] && [ "$REMOTE_USER" = "${refuseMainFor}" ]; then
    echo "ref policy: no push to refs/heads/main for $REMOTE_USER" >&2
    if [ -n "$TEST_PRESENTED_TOKEN" ]; then echo "token shown: $TEST_PRESENTED_TOKEN" >&2; fi
    exit 1
  fi
done
exit 0
`);
  await chmod(hook, 0o755);
}

/** Bare repositories under `root` for each name (`agents/a1.git`), the first seeded with `files` on main. */
export async function serverRepos(root, names, files = { "README.md": "seed\n" }) {
  const dirs = {};
  for (const name of names) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    dirs[name] = await bareRepo(path.join(root, name));
  }
  const seeder = await openRepo({ dir: path.join(await scratch(), "seeder"), remote: local(dirs[names[0]]) });
  const { sha } = await seeder.commitTo("main", { files, message: "seed" });
  await seeder.push(sha, "main");
  return { dirs, main: sha };
}

/** `Authorization` as git sends it for `token`. */
export const basicFor = (token) => `Basic ${Buffer.from(`t:${token}`).toString("base64")}`;

/** A proc-receive hook that refuses every push to refs/heads/main with a reason that repeats the token it was shown: the
 *  one place server text reaches the client's typed error, since git prints the reason of a refused ref verbatim. */
export async function plantEchoingRefusal(gitDir) {
  await rawGit(["config", "receive.procReceiveRefs", "refs/heads/main"], { gitDir });
  const hook = path.join(gitDir, "hooks", "proc-receive");
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, `#!${process.execPath}
"use strict";
const pkt = (text) => Buffer.concat([Buffer.from((text.length + 4).toString(16).padStart(4, "0")), Buffer.from(text)]);
const FLUSH = Buffer.from("0000");
let buffer = Buffer.alloc(0);
let stage = 0;
const refs = [];
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = Number.parseInt(buffer.subarray(0, 4).toString(), 16);
    if (length === 0) {
      buffer = buffer.subarray(4);
      if (stage === 0) {
        process.stdout.write(Buffer.concat([pkt("version=1"), FLUSH]));
        stage = 1;
      } else {
        const reason = "refused for " + process.env.TEST_PRESENTED_TOKEN;
        process.stdout.write(Buffer.concat([...refs.map((ref) => pkt("ng " + ref + " " + reason)), FLUSH]));
        process.exit(0);
      }
      continue;
    }
    if (buffer.length < length) return;
    const line = buffer.subarray(4, length).toString().replace(/\\0[^]*$/, "").replace(/\\n$/, "");
    buffer = buffer.subarray(length);
    if (stage === 1) refs.push(line.split(" ")[2]);
  }
});
`);
  await chmod(hook, 0o755);
}

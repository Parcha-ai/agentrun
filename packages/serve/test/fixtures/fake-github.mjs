// A fake of GitHub's REST API on loopback, for the GitHub trigger's tests: POST /repos/{owner}/{repo}/issues/{n}/comments
// keeps each comment and answers it made (201), unless the test queued another answer for the next ones (`answers`),
// which may be held until the test lets it go (`hold`, a promise).
import { createServer } from "node:http";

export const GITHUB_TOKEN = "not-a-secret-token";

export async function fakeGitHub(t) {
  const comments = [];
  /** Answers for the next comment calls, in order: `{status?, body?, headers?, hold?}`. */
  const answers = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const reply = (status, json, headers = {}) => void res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(json));
      const at = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(req.url ?? "");
      if (req.method !== "POST" || !at) return reply(404, { message: "Not Found" });
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {}
      const authorized = req.headers.authorization === `Bearer ${GITHUB_TOKEN}`;
      comments.push({ repo: `${at[1]}/${at[2]}`, number: Number(at[3]), authorized, body: body?.body, headers: { accept: req.headers.accept, version: req.headers["x-github-api-version"], agent: req.headers["user-agent"] } });
      const next = answers.shift();
      if (next?.hold) await next.hold;
      if (next) return reply(next.status ?? 201, next.body ?? {}, next.headers);
      if (!authorized) return reply(401, { message: "Bad credentials" });
      return reply(201, { id: comments.length, html_url: `https://github.com/${at[1]}/${at[2]}/issues/${at[3]}#issuecomment-${comments.length}` });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())));
  return { url: `http://127.0.0.1:${server.address().port}`, comments, answers };
}

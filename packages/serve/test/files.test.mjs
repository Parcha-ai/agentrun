// A run's files: work/ only, its dotfiles (the run's skills among them) never listed or served, paths checked first.
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { follow, serve, startRun } from "./support.mjs";

test("the files a run wrote are listed and served raw; dot segments, .. and symlinks are refused with the contract's codes", async (t) => {
  const { api, data, baseUrl, token, port } = await serve(t);
  const { run_id } = await startRun(api, "writer", "Write the report.", { tools: ["write"], skills: ["cite"] }, { "cite/SKILL.md": "# Cite\n" });
  await follow(api, run_id, ["completed"]).catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify((await api("GET", `/runs/${run_id}`)).body)}`);
  });
  const work = join(data, "writer", "runs", run_id, "work");
  await writeFile(join(work, "page.html"), "<script>alert(1)</script>");
  await mkdir(join(work, "sub"));
  await writeFile(join(work, "sub", "a b.txt"), "spaced");
  await writeFile(join(data, "outside.txt"), "secret");
  await symlink(join(data, "outside.txt"), join(work, "link.txt"));
  const list = await api("GET", `/runs/${run_id}/files`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.files.map((f) => f.path), ["page.html", "report.md", "sub/a b.txt"], "no dotfile, no .agents/skills, no symlink");
  assert.deepEqual([list.body.complete, list.body.truncated], [true, false]);
  const report = await fetch(`${baseUrl}/runs/${run_id}/files/report.md`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(await report.text(), "# Report\n\nThe answer is 42.\n");
  assert.equal(report.headers.get("x-content-type-options"), "nosniff");
  const page = await fetch(`${baseUrl}/runs/${run_id}/files/page.html`, { headers: { authorization: `Bearer ${token}` } });
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'.*sandbox/);
  const spaced = await fetch(`${baseUrl}/runs/${run_id}/files/sub/a%20b.txt?download=1`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual([await spaced.text(), spaced.headers.get("content-disposition")], ["spaced", 'attachment; filename="a_b.txt"']);
  const { request } = await import("node:http");
  // Sent as written: fetch would fold `..` and `%2E%2E` segments before they reach the server.
  const code = (path) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: `/v2/runs/${run_id}/files/${path}`, headers: { authorization: `Bearer ${token}` } }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk)).on("end", () => resolve(JSON.parse(text).error.code));
      });
      req.once("error", reject).end();
    });
  assert.equal(await code(".agents/skills/cite/SKILL.md"), "system_file_forbidden");
  assert.equal(await code("sub/%2E%2E/report.md"), "invalid_file_path");
  assert.equal(await code("sub/../../../agent.sqlite"), "invalid_file_path");
  assert.equal(await code("sub//a"), "invalid_file_path");
  assert.equal(await code("sub%5Ca"), "invalid_file_path");
  assert.equal(await code("link.txt"), "not_found");
  assert.equal(await code("missing.txt"), "not_found");
});

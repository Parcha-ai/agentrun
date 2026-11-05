// A run's files: work/ only, its dotfiles (the run's skills among them) never listed or served, paths checked first.
import assert from "node:assert/strict";
import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { follow, serve, startRun } from "./support.mjs";

test("the files a run wrote are listed and served raw; dot segments, .. and symlinks are refused with the contract's codes", async (t) => {
  const { api, data, baseUrl, token, port } = await serve(t);
  const { run_id } = await startRun(api, "writer", "Write the report.", { tools: ["write"], skills: ["cite"] }, { "cite/SKILL.md": "# Cite\n" });
  await follow(api, run_id, ["completed"]).catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify((await api("GET", `/runs/${run_id}`)).body)}`);
  });
  const work = join(data, "runs", run_id, "work");
  const media = [
    ["audio.MP3", "audio/mpeg"], ["audio.wav", "audio/wav"], ["audio.flac", "audio/flac"],
    ["audio.m4a", "audio/mp4"], ["audio.ogg", "audio/ogg"], ["audio.oga", "audio/ogg"], ["audio.weba", "audio/webm"],
    ["video.mp4", "video/mp4"], ["video.webm", "video/webm"], ["video.ogv", "video/ogg"],
    ["untrusted.svg", null],
  ];
  const bytes = Uint8Array.of(0, 255, 128, 1, 2);
  for (const [path] of media) await writeFile(join(work, path), bytes);
  await writeFile(join(work, "page.html"), "<script>alert(1)</script>");
  await mkdir(join(work, "sub"));
  await writeFile(join(work, "sub", "a b.txt"), "spaced");
  await writeFile(join(data, "outside.txt"), "secret");
  await symlink(join(data, "outside.txt"), join(work, "link.txt"));
  const list = await api("GET", `/runs/${run_id}/files`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.files.map((f) => f.path).sort(), [...media.map(([path]) => path), "page.html", "report.md", "sub/a b.txt"].sort(), "no dotfile, no .agents/skills, no symlink");
  assert.deepEqual([list.body.complete, list.body.truncated], [true, false]);
  for (const path of ["/runs", "/agents/writer/runs"]) {
    const summary = (await api("GET", path)).body.runs.find((run) => run.run_id === run_id);
    assert.deepEqual([summary.result_available, summary.files_available], [true, true], `availability in ${path}`);
    assert.equal(Object.hasOwn(summary, "result"), false, "summaries carry availability without result content");
  }
  for (const [path, type] of media) {
    assert.equal(list.body.files.find((file) => file.path === path).content_type, type, `${path} list MIME`);
    const raw = await fetch(`${baseUrl}/runs/${run_id}/files/${path}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), type ?? "application/octet-stream", `${path} response MIME`);
    assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
    assert.match(raw.headers.get("content-disposition"), /^attachment;/);
    assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), bytes, `${path} raw bytes`);
  }
  const report = await fetch(`${baseUrl}/runs/${run_id}/files/report.md`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(await report.text(), "# Report\n\nThe answer is 42.\n");
  assert.equal(report.headers.get("x-content-type-options"), "nosniff");
  const page = await fetch(`${baseUrl}/runs/${run_id}/files/page.html`, { headers: { authorization: `Bearer ${token}` } });
  // The V1 rule: agent-written HTML is served inline, only under a sandbox CSP (an opaque origin, no scripts, no
  // network).
  const csp = page.headers.get("content-security-policy");
  assert.equal(csp, "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; form-action 'none'");
  assert.doesNotMatch(csp, /allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.equal(page.headers.get("content-disposition"), null, "inline, not a download");
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
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
  // A link to a directory of the server's is neither served through nor listed.
  await symlink(data, join(work, "d"));
  assert.equal(await code("d/outside.txt"), "not_found");
  assert.ok(!(await api("GET", `/runs/${run_id}/files`)).body.files.some((f) => f.path === "d" || f.path.startsWith("d/")), "a linked directory is not listed");
  assert.equal(await code(".agents/skills/cite/SKILL.md"), "system_file_forbidden");
  assert.equal(await code("sub/%2E%2E/report.md"), "invalid_file_path");
  assert.equal(await code("sub/../../../agent.sqlite"), "invalid_file_path");
  assert.equal(await code("sub//a"), "invalid_file_path");
  assert.equal(await code("sub%5Ca"), "invalid_file_path");
  assert.equal(await code("link.txt"), "not_found");
  assert.equal(await code("missing.txt"), "not_found");
  for (const file of list.body.files) await unlink(join(work, file.path));
  assert.equal((await api("GET", "/runs")).body.runs[0].files_available, false, "hidden skill files and symlinks are not public files");
  await Promise.all(Array.from({ length: 130 }, (_, i) => symlink(join(data, "outside.txt"), join(work, `excluded-${i}`))));
  assert.equal((await api("GET", "/runs")).body.runs[0].files_available, null, "refused entries also consume the bounded availability scan");
  await rename(work, `${work}-unavailable`);
  assert.equal((await api("GET", "/runs")).body.runs[0].files_available, null, "an unavailable working directory is unknown, not empty");
  const elsewhere = join(data, "separate-files");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, "report.txt"), "outside the working directory");
  await symlink(elsewhere, work);
  assert.equal((await api("GET", "/runs")).body.runs[0].files_available, null, "a linked working directory is not scanned");
});

test("a run file whose extension names an object's own property (.constructor, .__proto__) is listed with no type and served as octet-stream", async (t) => {
  const { api, data, baseUrl, token } = await serve(t);
  const { run_id } = await startRun(api, "plain", "Hello.");
  await follow(api, run_id, ["completed"]);
  const work = join(data, "runs", run_id, "work");
  for (const name of ["x.constructor", "x.__proto__"]) await writeFile(join(work, name), `bytes of ${name}`);
  const list = await api("GET", `/runs/${run_id}/files`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  for (const name of ["x.constructor", "x.__proto__"]) {
    const entry = list.body.files.find((f) => f.path === name);
    assert.ok(entry && "content_type" in entry && entry.content_type === null, `${name}: ${JSON.stringify(entry)}`);
    const res = await fetch(`${baseUrl}/runs/${run_id}/files/${name}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200, `${name}: ${res.status}`);
    assert.equal(res.headers.get("content-type"), "application/octet-stream", name);
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="${name}"`, "a download, as any type not shown inline");
    assert.equal(await res.text(), `bytes of ${name}`);
  }
});

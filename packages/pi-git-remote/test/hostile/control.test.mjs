// Control for the hostile corpus: plain git (no safety flags, operator config only) must do the hostile thing for every
// no-marker and limit case, or accept the entry for the cases with no trigger. Cases that plain git refuses on its own are
// reported and stay in the corpus with expect "refused".
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cases, envFor, REMOTE_HOOKS, run } from "./corpus.mjs";

const TMP = await mkdtemp(path.join(tmpdir(), "pi-git-remote-control-"));
await chmod(TMP, 0o755);
after(() => rm(TMP, { recursive: true, force: true }));

const exists = (p) => access(p).then(() => true, () => false);
const attempt = (promise) => promise.then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message.split("\n")[0].slice(0, 240) }));
const FORCED = ["-c", "protocol.ext.allow=always", "-c", "protocol.file.allow=always"];

/** The plain git operation a runner would also perform, run in the case's workdir. Each one is expected to fire the hostile part. */
const TRIGGER = {
  "host-hook-post-checkout": (env, w) => run(env, ["checkout", "-q", "-b", "after-hook"], { cwd: w }),
  "host-hook-post-commit": (env, w) => run(env, ["commit", "-q", "--allow-empty", "-m", "probe"], { cwd: w }),
  "host-hook-post-merge": (env, w) => run(env, ["merge", "-q", "--no-edit", "side"], { cwd: w }),
  "host-hook-reference-transaction": (env, w) => run(env, ["update-ref", "refs/heads/probe", "HEAD"], { cwd: w }),
  "host-hook-pre-push": (env, w) => run(env, ["push", "-q", "origin", "HEAD:refs/heads/probe"], { cwd: w }),
  "host-hook-pre-commit": (env, w) => run(env, ["commit", "-q", "--allow-empty", "-m", "probe"], { cwd: w }),
  "attr-filter-operator-driver": (env, w) => run(env, ["add", "--", "notes.txt"], { cwd: w }),
  "attr-merge-operator-driver": (env, w) => run(env, ["merge", "-q", "--no-edit", "side"], { cwd: w }),
  "path-leading-dash": (env, w) => run(env, ["diff", "HEAD", "--output=marker-dash"], { cwd: w }),
  "limit-git-config-merge-driver": (env, w) => run(env, ["merge", "-q", "--no-edit", "side"], { cwd: w }),
  "limit-git-config-filter": (env, w) => run(env, ["add", "--", "notes.txt"], { cwd: w }),
};
for (const name of REMOTE_HOOKS) {
  TRIGGER[`remote-hook-${name}`] = (env, w) => run(env, ["push", "-q", "origin", `HEAD:refs/heads/probe-${name}`], { cwd: w });
}

/** Runs the control for one case and reports what plain git did. */
async function probe(c, built, dir) {
  const env = envFor(built.globalConfig);
  if (c.id.startsWith("submodule-")) {
    // The marker sits under the build's own workdir, so the probe runs there.
    const plain = await attempt(run(env, ["submodule", "update", "--init"], { cwd: built.workdir }));
    const plainMarker = await exists(built.marker);
    const forced = await attempt(run(env, [...FORCED, "submodule", "update", "--init"], { cwd: built.workdir }));
    return { plainRefuses: !plain.ok, plainError: plain.error, plainMarker, forcedMarker: await exists(built.marker), forcedError: forced.error };
  }
  if (TRIGGER[c.id]) {
    const r = await attempt(TRIGGER[c.id](env, built.workdir));
    return { marker: await exists(built.marker), triggerError: r.ok ? undefined : r.error };
  }
  // No trigger: plain clone, which either accepts the entry or refuses it.
  const into = path.join(dir, "plain-clone");
  const started = Date.now();
  const r = await attempt(run(env, ["clone", "-q", "--template=", built.bare, into]));
  return { plainRefuses: !r.ok, plainError: r.error, accepted: r.ok, marker: await exists(built.marker), cloneMs: Date.now() - started, into };
}

describe("control: plain git does what the corpus says", { concurrency: 8 }, () => {
  for (const c of cases) {
    test(`${c.id} [${c.expect}]`, { timeout: 900_000 }, async (t) => {
      const dir = await mkdtemp(path.join(TMP, `${c.id}-`));
      const built = await c.build(dir);
      const started = Date.now();
      const r = await probe(c, built, dir);
      t.diagnostic(JSON.stringify({ id: c.id, expect: c.expect, ...r, ms: Date.now() - started }));
      assert.ok(built.marker, "every case names the marker a successful attack would create");

      if (c.expect === "refused") {
        if (c.id.startsWith("submodule-")) {
          assert.equal(r.plainRefuses, true, "plain git refuses the submodule transport by default");
          assert.equal(r.forcedMarker, true, "with the transport allowed, the planted command runs");
        } else if (r.plainRefuses) {
          // Plain git refuses the entry on its own: kept in the corpus, recorded as plainGitRefuses.
          assert.ok(r.plainError, "a refusal carries git's message");
        } else {
          assert.equal(r.accepted, true, "plain git accepted the entry, so the corpus entry is real");
        }
        assert.equal(Boolean(r.plainRefuses), c.plainGitRefuses, "the plainGitRefuses mark matches what plain git did");
        if (c.id === "tree-100k-entries") assert.ok(r.cloneMs < 120_000, "a 100k-entry tree clones inside the time bound");
        return;
      }

      if (c.expect === "no-marker" && !TRIGGER[c.id]) {
        // gitconfig-blob-bait: plain git accepts the entry, and nothing runs.
        assert.equal(r.accepted, true, "plain git accepts the bait entry");
        assert.equal(r.marker, false, "accepting it runs nothing");
        return;
      }

      // no-marker and limit cases with a trigger: plain git must fire the planted command.
      assert.equal(r.marker, true, `plain git runs the planted command (${r.triggerError ?? "no trigger error"})`);
    });
  }
});

// Writes the generated half of the scrub-negatives corpus: the files whose values are random-shaped (git SHAs, UUIDs,
// content hashes, lockfile integrity strings, base64 images, hash test vectors). Seeded, so a run writes the same bytes
// every time; the output is committed and frozen, and the test reads it, never this script. The other files
// (code, prose, addresses, terminal) are written by hand. See README.md.
//
//   node packages/serve/test/fixtures/scrub-negatives/generate.mjs           # write the files
//   node packages/serve/test/fixtures/scrub-negatives/generate.mjs --check   # exit 1 if a written file differs
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));

/** mulberry32: a small seeded PRNG, so the corpus is the same on every machine and Node version. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makers(seed) {
  const r = rng(seed);
  const bytes = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256)));
  const hex = (n) => bytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const b64 = (n) => bytes(n).toString("base64");
  const uuid4 = () => {
    const b = bytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  // A v7: a 48-bit millisecond time in 2025-2026, then random, version and variant bits set.
  const uuid7 = () => {
    const ms = 1735689600000 + Math.floor(r() * 365 * 86400000);
    const b = Buffer.concat([Buffer.from(ms.toString(16).padStart(12, "0"), "hex"), bytes(10)]);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  return { r, bytes, hex, pick, int, b64, uuid4, uuid7 };
}

// Synthetic names only: no real person, repository or host of ours.
const REPOS = ["example-org/widgets", "acme/rocket-sled", "octo-labs/parser", "example-org/infra", "demo-co/console"];
const BRANCHES = ["main", "fix/retry-backoff", "feat/share-preview", "chore/deps", "release/1.4"];
const SUBJECTS = [
  "fix(serve): retry the upload once on a 503",
  "feat(console): show the run's cost beside its duration",
  "chore(deps): bump undici from 7.10.0 to 7.11.1",
  "docs: explain how the password reset flow sends its email",
  "refactor: move the token refresh into its own module",
  "test: the secret scanner leaves a git SHA alone",
  "Revert \"feat: rotate the signing key nightly\"",
  "ci: pin actions/checkout to a commit",
];
const TRAILERS = [
  "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
  "Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
  "Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
  "Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
];
const AUTHORS = [
  "Claude <noreply@anthropic.com>",
  "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
  "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
  "GitHub <noreply@github.com>",
];
const DATES = ["Mon Nov 23 14:02:11 2026 +0000", "Fri Oct 30 09:15:42 2026 -0400", "Tue Sep 8 22:47:03 2026 +0200"];

function gitShas() {
  const { hex, pick, int } = makers(0x5ca1ab1e);
  const sha = () => hex(40);
  const short = (n = int(7, 12)) => hex(n);
  const cases = [];
  const add = (id, text) => cases.push({ id, text });
  for (let i = 0; i < 6; i++) add(`log-oneline-${i}`, Array.from({ length: int(3, 8) }, () => `${short(int(7, 10))} ${pick(SUBJECTS)}`).join("\n"));
  for (let i = 0; i < 6; i++) {
    const merge = i % 3 === 0;
    add(`log-full-${i}`, [
      `commit ${sha()}${i === 1 ? ` (HEAD -> ${pick(BRANCHES)}, origin/${pick(BRANCHES)})` : ""}`,
      ...(merge ? [`Merge: ${short(7)} ${short(7)}`] : []),
      `Author: ${pick(AUTHORS)}`,
      `Date:   ${pick(DATES)}`,
      "",
      `    ${merge ? `Merge pull request #${int(100, 4000)} from ${pick(REPOS).split("/")[0]}/${pick(BRANCHES)}` : pick(SUBJECTS)}`,
      "",
      `    ${pick(TRAILERS)}`,
    ].join("\n"));
  }
  for (let i = 0; i < 4; i++) add(`rev-parse-${i}`, `$ git rev-parse HEAD\n${sha()}\n$ git rev-parse --short HEAD\n${short(int(7, 9))}`);
  for (let i = 0; i < 4; i++) add(`rev-parse-json-${i}`, JSON.stringify({ type: "tool_result", content: `${sha()}\n` }));
  for (let i = 0; i < 5; i++) {
    const repo = pick(REPOS);
    add(`pr-url-${i}`, [
      `https://github.com/${repo}/pull/${int(10, 4000)}/commits/${sha()}`,
      `https://github.com/${repo}/commit/${sha()}`,
      `https://github.com/${repo}/blob/${sha()}/src/index.ts#L${int(1, 400)}`,
      `https://github.com/${repo}/compare/${short(7)}...${short(7)}`,
      `https://github.com/${repo}/tree/${short(12)}`,
    ].join("\n"));
  }
  for (let i = 0; i < 4; i++) add(`merge-line-${i}`, `Merge ${sha()} into ${sha()}`);
  for (let i = 0; i < 3; i++) add(`merge-commit-msg-${i}`, `Merge branch '${pick(BRANCHES)}' of github.com:${pick(REPOS)} into ${pick(BRANCHES)}\n\n# Conflicts:\n#\tsrc/index.ts\n(cherry picked from commit ${sha()})`);
  for (let i = 0; i < 4; i++) add(`trailer-${i}`, `${pick(SUBJECTS)} (#${int(100, 4000)})\n\nThis reverts commit ${sha()}.\n\n${pick(TRAILERS)}\n${pick(TRAILERS)}`);
  for (let i = 0; i < 3; i++) add(`reset-checkout-${i}`, `git reset --hard ${short(7)}\ngit checkout ${sha()} -- package.json\ngit cherry-pick ${short(10)}\ngit log ${short(7)}..${short(7)} --oneline\ngit diff ${short(8)}^!`);
  for (let i = 0; i < 3; i++) add(`describe-${i}`, `v${int(0, 3)}.${int(0, 20)}.${int(0, 9)}-${int(1, 80)}-g${short(int(7, 12))}${i === 2 ? "-dirty" : ""}`);
  for (let i = 0; i < 4; i++) add(`diff-index-${i}`, `diff --git a/src/auth/token.ts b/src/auth/token.ts\nindex ${short(7)}..${short(7)} 100644\n--- a/src/auth/token.ts\n+++ b/src/auth/token.ts\n@@ -${int(1, 90)},7 +${int(1, 90)},8 @@ export function refreshToken() {`);
  for (let i = 0; i < 3; i++) add(`ls-remote-${i}`, Array.from({ length: 3 }, (_, k) => `${sha()}\trefs/${k === 0 ? "heads/main" : k === 1 ? `tags/v1.${int(0, 9)}.0` : `pull/${int(1, 999)}/head`}`).join("\n"));
  for (let i = 0; i < 3; i++) add(`reflog-${i}`, Array.from({ length: 4 }, (_, k) => `${short(7)} HEAD@{${k}}: ${pick(["commit", "checkout: moving from main to fix/retry-backoff", "rebase (finish)", "pull: Fast-forward"])}`).join("\n"));
  for (let i = 0; i < 3; i++) add(`submodule-${i}`, ` ${sha()} vendor/parser (v2.${int(0, 9)}.0)\n+${sha()} vendor/widgets (heads/main)`);
  for (let i = 0; i < 3; i++) add(`actions-pin-${i}`, `      - uses: actions/checkout@${sha()} # v4.2.2\n      - uses: actions/setup-node@${sha()} # v4.1.0`);
  for (let i = 0; i < 3; i++) add(`blame-${i}`, `${short(8)} (Claude 2026-11-23 14:02:11 +0000 ${int(1, 300)}) const token = await refreshToken();`);
  for (let i = 0; i < 3; i++) add(`short-in-prose-${i}`, `Bisected it: ${short(7)} is the first bad commit, ${short(9)} is fine. Landed in ${short(7)}, reverted in ${short(8)}.`);
  for (let i = 0; i < 2; i++) add(`push-output-${i}`, `To github.com:${pick(REPOS)}.git\n   ${short(7)}..${short(7)}  ${pick(BRANCHES)} -> ${pick(BRANCHES)}\n + ${short(7)}...${short(7)} main -> main (forced update)`);
  for (let i = 0; i < 2; i++) add(`uppercase-${i}`, `SHA: ${sha().toUpperCase()}`);
  for (let i = 0; i < 2; i++) add(`gh-api-${i}`, JSON.stringify({ sha: sha(), node_id: `C_kwDO${hex(10).toUpperCase()}`, commit: { tree: { sha: sha() } }, parents: [{ sha: sha() }] }));
  return cases;
}

function uuids() {
  const { uuid4, uuid7, pick, int, hex } = makers(0x00c0ffee);
  const cases = [];
  const add = (id, text) => cases.push({ id, text });
  for (let i = 0; i < 4; i++) add(`v4-bare-${i}`, uuid4());
  for (let i = 0; i < 4; i++) add(`v7-bare-${i}`, uuid7());
  for (let i = 0; i < 3; i++) add(`upper-${i}`, uuid4().toUpperCase());
  for (let i = 0; i < 2; i++) add(`braced-${i}`, `{${uuid4().toUpperCase()}}`);
  for (let i = 0; i < 2; i++) add(`no-dashes-${i}`, uuid4().replaceAll("-", ""));
  for (let i = 0; i < 2; i++) add(`urn-${i}`, `urn:uuid:${uuid4()}`);
  for (let i = 0; i < 5; i++) add(`url-${i}`, pick([
    `https://app.example.com/runs/${uuid7()}`,
    `http://localhost:4318/v2/agents/${uuid4()}/runs/${uuid7()}?view=timeline`,
    `https://console.example.com/share/${uuid7()}#step-${int(1, 40)}`,
    `/v2/runs/${uuid7()}/events?after=${uuid7()}`,
  ]));
  for (let i = 0; i < 5; i++) add(`json-${i}`, JSON.stringify({ id: uuid7(), runId: uuid7(), agent_id: uuid4(), parentUuid: uuid4(), requestId: uuid4(), type: "assistant" }));
  for (let i = 0; i < 3; i++) add(`header-${i}`, `X-Request-Id: ${uuid4()}\ntraceparent: 00-${hex(32)}-${hex(16)}-01\nx-amzn-RequestId: ${uuid4()}`);
  for (let i = 0; i < 3; i++) add(`log-line-${i}`, `2026-11-23T14:02:${String(int(10, 59))}.${int(100, 999)}Z INFO run ${uuid7()} step ${int(1, 30)} finished in ${int(10, 9000)}ms (session ${uuid4()})`);
  for (let i = 0; i < 2; i++) add(`sql-${i}`, `SELECT * FROM runs WHERE id = '${uuid7()}' AND agent_id = '${uuid4()}';`);
  for (let i = 0; i < 2; i++) add(`nil-max-${i}`, i === 0 ? "00000000-0000-0000-0000-000000000000" : "ffffffff-ffff-ffff-ffff-ffffffffffff");
  for (let i = 0; i < 2; i++) add(`k8s-${i}`, `  uid: ${uuid4()}\n  resourceVersion: "${int(10000, 99999)}"\n  creationTimestamp: "2026-11-23T14:02:11Z"`);
  for (let i = 0; i < 2; i++) add(`env-like-${i}`, `RUN_ID=${uuid7()}\nTRACE_ID=${hex(32)}\nSPAN_ID=${hex(16)}`);
  for (let i = 0; i < 2; i++) add(`v5-${i}`, `uuid5(NAMESPACE_URL, "https://example.com/${i}") -> ${(() => { const u = uuid4(); return `${u.slice(0, 14)}5${u.slice(15)}`; })()}`);
  for (let i = 0; i < 3; i++) add(`span-ids-${i}`, JSON.stringify({ traceId: hex(32), spanId: hex(16), parentSpanId: hex(16), name: "POST /v2/runs", durationMs: int(1, 900) }));
  for (let i = 0; i < 2; i++) add(`file-name-${i}`, `~/.claude/projects/-srv-example/${uuid4()}.jsonl`);
  return cases;
}

function contentHashes() {
  const { hex, bytes, pick, int } = makers(0x0d16e57);
  const cases = [];
  const add = (id, text) => cases.push({ id, text });
  const FILES = ["agentrun-serve-0.1.0.tgz", "node-v24.22.3-linux-x64.tar.xz", "dist/index.js", "checksums.txt", "pi-browser_1.5.2_amd64.deb"];
  for (let i = 0; i < 4; i++) add(`sha256sum-${i}`, Array.from({ length: int(2, 4) }, () => `${hex(64)}  ${pick(FILES)}`).join("\n"));
  for (let i = 0; i < 3; i++) add(`sha1sum-${i}`, `${hex(40)}  ${pick(FILES)}`);
  for (let i = 0; i < 3; i++) add(`sha512sum-${i}`, `${hex(128)}  ${pick(FILES)}`);
  for (let i = 0; i < 2; i++) add(`md5sum-${i}`, `${hex(32)}  ${pick(FILES)}`);
  for (let i = 0; i < 2; i++) add(`bsd-sum-${i}`, `SHA256 (${pick(FILES)}) = ${hex(64)}`);
  for (let i = 0; i < 2; i++) add(`shasums-file-${i}`, `# SHASUMS256.txt\n${hex(64)}  node-v24.22.3-darwin-arm64.tar.gz\n${hex(64)}  node-v24.22.3-linux-x64.tar.xz\n${hex(64)}  node-v24.22.3-win-x64.zip`);
  for (let i = 0; i < 5; i++) add(`docker-digest-${i}`, pick([
    `FROM node:24-bookworm-slim@sha256:${hex(64)}`,
    `docker pull ghcr.io/${pick(REPOS)}@sha256:${hex(64)}`,
    `Digest: sha256:${hex(64)}\nStatus: Downloaded newer image for node:24`,
    `image: postgres:17@sha256:${hex(64)}`,
  ]));
  for (let i = 0; i < 2; i++) add(`docker-build-${i}`, `#5 [2/6] WORKDIR /app\n#5 sha256:${hex(64)}\n#9 exporting layers done\n#9 writing image sha256:${hex(64)} done\n#9 naming to docker.io/library/widgets:latest done`);
  for (let i = 0; i < 2; i++) add(`docker-images-${i}`, `REPOSITORY   TAG       IMAGE ID       CREATED        SIZE\nwidgets      latest    ${hex(12)}   2 hours ago    412MB\nnode         24        ${hex(12)}   3 days ago     1.1GB`);
  for (let i = 0; i < 2; i++) add(`oci-manifest-${i}`, JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: `sha256:${hex(64)}`, size: int(1000, 9000) }, layers: [{ digest: `sha256:${hex(64)}`, size: int(100000, 9000000) }] }));
  for (let i = 0; i < 4; i++) add(`etag-${i}`, pick([
    `ETag: "${hex(40)}"`,
    `etag: W/"${hex(int(8, 12))}-${hex(27)}"`,
    `ETag: "${hex(32)}-${int(2, 40)}"`,
    `If-None-Match: "${hex(32)}"`,
  ]));
  for (let i = 0; i < 2; i++) add(`s3-head-${i}`, JSON.stringify({ AcceptRanges: "bytes", ContentLength: int(1000, 99999), ETag: `"${hex(32)}"`, VersionId: bytes(24).toString("base64url"), ChecksumSHA256: bytes(32).toString("base64") }));
  for (let i = 0; i < 2; i++) add(`webpack-chunk-${i}`, `assets/index-${bytes(6).toString("base64url").slice(0, 8)}.js   ${int(10, 900)}.${int(10, 99)} kB │ gzip: ${int(5, 300)}.${int(10, 99)} kB\nmain.${hex(20)}.js\nstyles.${hex(8)}.css`);
  for (let i = 0; i < 2; i++) add(`ipfs-cid-${i}`, `ipfs://bafybei${Array.from(bytes(40), (b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("").slice(0, 52)}`);
  for (let i = 0; i < 2; i++) add(`content-addressed-path-${i}`, `/nix/store/${Array.from(bytes(32), (b) => "0123456789abcdfghijklmnpqrsvwxyz"[b % 32]).join("")}-nodejs-24.22.3/bin/node`);
  for (let i = 0; i < 3; i++) add(`json-hash-fields-${i}`, JSON.stringify({ path: "src/index.ts", contentHash: hex(64), backupFileName: `${hex(16)}@v${int(1, 9)}`, hashes: [hex(64), hex(64)] }));
  for (let i = 0; i < 2; i++) add(`short-file-hash-${i}`, `.cache/build/${hex(16)}.json
.turbo/cache/${hex(16)}.tar.zst
node_modules/.vite/deps/chunk-${hex(8).toUpperCase()}.js`);
  for (let i = 0; i < 2; i++) add(`cache-key-${i}`, `Cache restored from key: node-cache-Linux-x64-npm-${hex(64)}`);
  for (let i = 0; i < 2; i++) add(`sri-script-${i}`, `<script src="https://cdn.example.com/lib.min.js" integrity="sha384-${bytes(48).toString("base64")}" crossorigin="anonymous"></script>`);
  for (let i = 0; i < 2; i++) add(`ssh-fingerprint-${i}`, `ED25519 key fingerprint is SHA256:${bytes(32).toString("base64").replace(/=+$/, "")}.\nThis key is not known by any other names.`);
  for (let i = 0; i < 2; i++) add(`gpg-fingerprint-${i}`, `gpg: Signature made Mon Nov 23 14:02:11 2026 UTC\ngpg:                using RSA key ${hex(40).toUpperCase()}\ngpg: Good signature from "Release Bot (release signing) <noreply@github.com>"`);
  return cases;
}

function lockfiles() {
  const { hex, bytes, pick, int } = makers(0x10c4f11e);
  const cases = [];
  const add = (id, text) => cases.push({ id, text });
  const PKGS = ["undici", "zod", "picomatch", "semver", "esbuild", "typescript", "@types/node", "@secretlint/core"];
  const sri = (alg = "sha512") => `${alg}-${bytes(alg === "sha512" ? 64 : alg === "sha384" ? 48 : alg === "sha256" ? 32 : 20).toString("base64")}`;
  const ver = () => `${int(0, 12)}.${int(0, 30)}.${int(0, 20)}`;
  for (let i = 0; i < 6; i++) {
    const name = pick(PKGS);
    const v = ver();
    const base = name.split("/").pop();
    add(`package-lock-${i}`, `    "node_modules/${name}": {\n      "version": "${v}",\n      "resolved": "https://registry.npmjs.org/${name}/-/${base}-${v}.tgz",\n      "integrity": "${sri(i === 5 ? "sha1" : "sha512")}",\n      "dev": true,\n      "license": "MIT"\n    },`);
  }
  for (let i = 0; i < 4; i++) {
    const name = pick(PKGS);
    const v = ver();
    add(`yarn-lock-${i}`, `"${name}@^${v}":\n  version "${v}"\n  resolved "https://registry.yarnpkg.com/${name}/-/${name.split("/").pop()}-${v}.tgz#${hex(40)}"\n  integrity ${sri()}`);
  }
  for (let i = 0; i < 2; i++) add(`yarn-berry-${i}`, `"${pick(PKGS)}@npm:^${ver()}":\n  version: ${ver()}\n  resolution: "${pick(PKGS)}@npm:${ver()}"\n  checksum: 10c0/${hex(128)}\n  languageName: node\n  linkType: hard`);
  for (let i = 0; i < 4; i++) add(`pnpm-lock-${i}`, `  /${pick(PKGS)}@${ver()}:\n    resolution: {integrity: ${sri()}}\n    engines: {node: '>=18'}\n    dev: true`);
  for (let i = 0; i < 4; i++) add(`cargo-lock-${i}`, `[[package]]\nname = "${pick(["serde", "tokio", "regex", "sha2", "base64"])}"\nversion = "${ver()}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${hex(64)}"`);
  for (let i = 0; i < 2; i++) add(`cargo-git-${i}`, `source = "git+https://github.com/${pick(REPOS)}?rev=${hex(40)}#${hex(40)}"`);
  for (let i = 0; i < 5; i++) {
    const mod = pick(["github.com/stretchr/testify", "golang.org/x/crypto", "github.com/google/uuid", "gopkg.in/yaml.v3"]);
    const v = `v${ver()}`;
    add(`go-sum-${i}`, `${mod} ${v} h1:${bytes(32).toString("base64")}\n${mod} ${v}/go.mod h1:${bytes(32).toString("base64")}`);
  }
  for (let i = 0; i < 2; i++) add(`go-pseudo-version-${i}`, `require golang.org/x/sys v0.0.0-2026${String(int(1, 11)).padStart(2, "0")}${String(int(10, 28))}${String(int(100000, 235959))}-${hex(12)}`);
  for (let i = 0; i < 4; i++) add(`poetry-lock-${i}`, `[[package]]\nname = "${pick(["requests", "pydantic", "httpx", "urllib3"])}"\nversion = "${ver()}"\nfiles = [\n    {file = "pkg-${ver()}-py3-none-any.whl", hash = "sha256:${hex(64)}"},\n    {file = "pkg-${ver()}.tar.gz", hash = "sha256:${hex(64)}"},\n]`);
  for (let i = 0; i < 3; i++) add(`uv-lock-${i}`, `[[package]]\nname = "${pick(["anyio", "idna", "sniffio"])}"\nversion = "${ver()}"\nsource = { registry = "https://pypi.org/simple" }\nsdist = { url = "https://files.pythonhosted.org/packages/${hex(2)}/${hex(2)}/${hex(60)}/pkg-${ver()}.tar.gz", hash = "sha256:${hex(64)}", size = ${int(10000, 999999)} }`);
  for (let i = 0; i < 3; i++) add(`requirements-hash-${i}`, `httpx==${ver()} \\\n    --hash=sha256:${hex(64)} \\\n    --hash=sha256:${hex(64)}`);
  for (let i = 0; i < 2; i++) add(`pipfile-lock-${i}`, JSON.stringify({ requests: { hashes: [`sha256:${hex(64)}`, `sha256:${hex(64)}`], index: "pypi", version: `==${ver()}` } }));
  for (let i = 0; i < 2; i++) add(`gemfile-lock-${i}`, `CHECKSUMS\n  rack (${ver()}) sha256=${hex(64)}\n  rake (${ver()}) sha256=${hex(64)}`);
  for (let i = 0; i < 2; i++) add(`flake-lock-${i}`, JSON.stringify({ locked: { lastModified: 1763900000 + int(0, 99999), narHash: `sha256-${bytes(32).toString("base64")}`, owner: "NixOS", repo: "nixpkgs", rev: hex(40), type: "github" } }));
  for (let i = 0; i < 2; i++) add(`composer-lock-${i}`, JSON.stringify({ name: "monolog/monolog", version: ver(), dist: { type: "zip", url: `https://api.github.com/repos/Seldaek/monolog/zipball/${hex(40)}`, reference: hex(40), shasum: "" } }));
  for (let i = 0; i < 2; i++) add(`swift-resolved-${i}`, JSON.stringify({ identity: "swift-argument-parser", kind: "remoteSourceControl", location: "https://github.com/apple/swift-argument-parser", state: { revision: hex(40), version: ver() } }));
  for (let i = 0; i < 2; i++) add(`npm-ci-log-${i}`, `npm warn tarball tarball data for ${pick(PKGS)}@${ver()} (${sri()}) seems to be corrupted. Trying again.`);
  return cases;
}

/** A PNG of `w`x`h` pixels from `pixels` (RGB bytes), with real CRCs, so the data URI decodes. */
function png(w, h, pixels) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.from([0]), pixels.subarray(y * w * 3, (y + 1) * w * 3));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function base64Images() {
  const { bytes, int, pick } = makers(0x1a6e5);
  const cases = [];
  const add = (id, text) => cases.push({ id, text });
  const pngUri = (w, h) => `data:image/png;base64,${png(w, h, bytes(w * h * 3)).toString("base64")}`;
  add("png-1x1-transparent", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
  add("gif-1x1", "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
  for (let i = 0; i < 6; i++) add(`png-random-${i}`, pngUri(int(2, 6), int(2, 6)));
  for (let i = 0; i < 2; i++) add(`png-long-${i}`, `![chart](${pngUri(int(18, 24), int(18, 24))})`);
  for (let i = 0; i < 4; i++) add(`markdown-${i}`, `Here is the screenshot:\n\n![${pick(["login page", "share preview", "cost chart", "diff"])}](${pngUri(int(2, 4), int(2, 4))})\n\nThe button is misaligned.`);
  for (let i = 0; i < 4; i++) add(`html-img-${i}`, `<img alt="avatar" width="16" height="16" src="${pngUri(int(2, 4), int(2, 4))}">`);
  for (let i = 0; i < 2; i++) add(`css-bg-${i}`, `.icon-${i} { background-image: url("${pngUri(2, 2)}"); }`);
  const svg = (fill) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${fill}"/></svg>`).toString("base64");
  for (let i = 0; i < 3; i++) add(`svg-${i}`, `data:image/svg+xml;base64,${svg(pick(["#e11d48", "#0ea5e9", "#22c55e", "currentColor"]))}`);
  // A JPEG's first bytes (SOI, APP0 JFIF) and random scan data: a data URI as a tool prints a thumbnail.
  for (let i = 0; i < 3; i++) add(`jpeg-${i}`, `data:image/jpeg;base64,${Buffer.concat([Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"), bytes(int(60, 180)), Buffer.from("ffd9", "hex")]).toString("base64")}`);
  for (let i = 0; i < 2; i++) add(`webp-${i}`, `data:image/webp;base64,${Buffer.concat([Buffer.from("RIFF"), Buffer.from([40, 0, 0, 0]), Buffer.from("WEBPVP8 "), bytes(int(40, 90))]).toString("base64")}`);
  for (let i = 0; i < 3; i++) add(`json-image-block-${i}`, JSON.stringify({ type: "image", source: { type: "base64", media_type: "image/png", data: png(3, 3, bytes(27)).toString("base64") } }));
  for (let i = 0; i < 2; i++) add(`font-woff2-${i}`, `@font-face { font-family: "Inter"; src: url(data:font/woff2;base64,${Buffer.concat([Buffer.from("wOF2"), bytes(int(60, 120))]).toString("base64")}) format("woff2"); }`);
  return cases;
}

function testVectors() {
  const cases = [];
  const add = (id, text) => cases.push({ id, text });
  const h = (alg, input) => createHash(alg).update(input).digest("hex");
  for (const alg of ["md5", "sha1", "sha256", "sha512"]) for (const input of ["", "abc"]) add(`${alg}-${input || "empty"}`, `${alg.toUpperCase()}("${input}") = ${h(alg, input)}`);
  add("sha256-abc-test", `assert.equal(createHash("sha256").update("abc").digest("hex"), "${h("sha256", "abc")}");`);
  add("sha256-fox-py", `assert hashlib.sha256(b"The quick brown fox jumps over the lazy dog").hexdigest() == "${h("sha256", "The quick brown fox jumps over the lazy dog")}"`);
  add("sha1-fox-go", `if got := fmt.Sprintf("%x", sha1.Sum([]byte("The quick brown fox jumps over the lazy dog"))); got != "${h("sha1", "The quick brown fox jumps over the lazy dog")}" {`);
  add("sha3-256-empty", `SHA3-256("") = ${h("sha3-256", "")}`);
  add("blake2b-abc", `BLAKE2b-512("abc") = ${h("blake2b512", "abc")}`);
  // RFC 4231 test case 1: a published HMAC-SHA256 vector. Its key is 0x0b repeated, a test value everyone knows.
  add("rfc4231-tc1", `Test Case 1 (RFC 4231)\nKey  = ${"0b".repeat(20)} (20 bytes)\nData = 4869205468657265 ("Hi There")\nHMAC-SHA-256 = ${createHmac("sha256", Buffer.alloc(20, 0x0b)).update("Hi There").digest("hex")}`);
  add("rfc4231-tc2", `Key  = 4a656665 ("Jefe")\nData = 7768617420646f2079612077616e7420666f72206e6f7468696e673f ("what do ya want for nothing?")\nHMAC-SHA-512 = ${createHmac("sha512", "Jefe").update("what do ya want for nothing?").digest("hex")}`);
  add("sha256-empty-b64", `sha256 of the empty string, base64: ${createHash("sha256").update("").digest("base64")}`);
  add("crc32-check", "CRC-32/ISO-HDLC check value for \"123456789\" is 0xCBF43926");
  add("aes-fips197", "FIPS-197 C.1 AES-128\nPLAINTEXT: 00112233445566778899aabbccddeeff\nKEY:       000102030405060708090a0b0c0d0e0f\nOUTPUT:    69c4e0d86a7b0430d8cdb78070b4c55a");
  add("ed25519-rfc8032-pub", "RFC 8032 7.1 TEST 1\nPUBLIC KEY: d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a\nMESSAGE (length 0 bytes):");
  add("pbkdf2-rfc6070", "PBKDF2-HMAC-SHA1 (RFC 6070)\n  P = \"password\" (8 octets)\n  S = \"salt\" (4 octets)\n  c = 1\n  dkLen = 20\n  DK = 0c 60 c8 0f 96 1f 0e 71 f3 a9 b5 24 af 60 12 06 2f e0 37 a6");
  add("uuid-v5-dns", "uuid.uuid5(uuid.NAMESPACE_DNS, \"python.org\") == UUID(\"886313e1-3b8a-5372-9b90-0c9aee199e5d\")");
  add("base64-rfc4648", "BASE64(\"foobar\") = \"Zm9vYmFy\"\nBASE32(\"foobar\") = \"MZXW6YTBOI======\"\nBASE16(\"foobar\") = \"666F6F626172\"");
  add("bitcoin-genesis", "Genesis block hash: 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f");
  add("git-empty-tree", `git's empty tree is ${"4b825dc642cb6eb9a060e54bf8d69288fbee4904"}, and the empty blob is e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`);
  return cases;
}

const OUTPUTS = {
  "git-shas.jsonl": gitShas,
  "uuids.jsonl": uuids,
  "content-hashes.jsonl": contentHashes,
  "lockfiles.jsonl": lockfiles,
  "base64-images.jsonl": base64Images,
  "test-vectors.jsonl": testVectors,
};

const check = process.argv.includes("--check");
let differs = 0;
for (const [file, make] of Object.entries(OUTPUTS)) {
  const cases = make();
  const ids = new Set();
  for (const { id } of cases) {
    if (ids.has(id)) throw new Error(`${file}: duplicate id ${id}`);
    ids.add(id);
  }
  const body = cases.map((c) => JSON.stringify(c)).join("\n") + "\n";
  const path = join(HERE, file);
  if (check) {
    let now = "";
    try {
      now = readFileSync(path, "utf8");
    } catch {}
    if (now !== body) (differs++, console.error(`${file} differs from what generate.mjs writes`));
  } else {
    writeFileSync(path, body);
    console.log(`${file}: ${cases.length} cases, ${Buffer.byteLength(body)} bytes`);
  }
}
if (differs) process.exit(1);

// The documents box image (documents/Dockerfile, which runs documents/documents.sh), read as text: no network, no docker.
// It is the Docker box's default image and more, for an agent that makes decks, documents and sheets: the same base
// digest as DOCKER_RECIPE, every program the default recipe installs, its Debian packages from snapshot.debian.org at one
// instant, and the libraries that write Office files, Python's (python-pptx, python-docx, openpyxl) pinned by version and
// sha256 and Node's (pptxgenjs, docx, exceljs) pinned by version and by the registry as it stood at that same instant.
// It names no key and picks nothing: an operator builds it and names its tag in AGENTRUN_DOCKER_IMAGE. Daytona's
// snapshot of it (build-daytona.py --documents) is the box image (box/Dockerfile) with documents.sh run on top, under a
// name of its own, so the default box recipe and its snapshot are what they were. The package ships it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DOCKER_BASE, DOCKER_RECIPE } from "../dist/index.js";

const here = (name) => fileURLToPath(new URL(`../documents/${name}`, import.meta.url));
const DOCKERFILE = readFileSync(here("Dockerfile"), "utf8");
const SCRIPT = readFileSync(here("documents.sh"), "utf8");
/** The script's lines, continuation lines joined, comments out. */
const STEPS = SCRIPT.replace(/\\\n\s*/g, " ").split("\n").filter((line) => line.trim() && !line.trim().startsWith("#")).join("\n");
/** The Dockerfile's instructions, a line each, continuation lines joined, comments out. */
const INSTRUCTIONS = DOCKERFILE.replace(/\\\n/g, " ").split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
const RUNS = INSTRUCTIONS.filter((line) => line.startsWith("RUN ")).join("\n");
/** The packages an apt-get install line names. */
const aptOf = (text) => [...text.replace(/\\\n/g, " ").matchAll(/apt-get install -y --no-install-recommends ([^&]+)/g)].flatMap((match) => match[1].trim().split(/\s+/));
/** The instant a snapshot.debian.org URI names, as an ISO date. */
const snapshotInstant = () => {
  const found = [...RUNS.matchAll(/snapshot\.debian\.org\/archive\/\\1\/(\d{8})T(\d{6})Z/g)];
  assert.equal(found.length, 1, "one sed rewrites both archives to one snapshot");
  const [, d, t] = found[0];
  return new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}Z`).toISOString();
};

test("it starts from the default recipe's base, pinned by the same digest, is one stage, and has every program the default recipe installs", () => {
  assert.deepEqual(INSTRUCTIONS.filter((line) => line.startsWith("FROM ")), [`FROM ${DOCKER_BASE}`]);
  const ours = aptOf(RUNS);
  for (const name of aptOf(DOCKER_RECIPE)) assert.ok(ours.includes(name), `${name} is installed`);
});

test("its Debian packages come from snapshot.debian.org at one instant, never from the live mirror", () => {
  snapshotInstant();
  assert.match(RUNS, /s#\^URIs: http:\/\/deb\\\.debian\\\.org\/\(debian\|debian-security\)\$#/, "the archive and the security archive");
  assert.match(RUNS, /! grep -q 'deb\\\.debian\\\.org' \/etc\/apt\/sources\.list\.d\/debian\.sources/, "the step fails if a source still names the live mirror");
  assert.ok(RUNS.indexOf("apt-get -o Acquire::Check-Valid-Until=false update") > RUNS.indexOf("snapshot.debian.org"), "rewritten before the first update");
  assert.equal([...RUNS.matchAll(/apt-get (?:-o \S+ )*update/g)].length, 1, "one update, the snapshot's");
});

test("the libraries are documents.sh's alone: the Dockerfile copies it, runs it as root and removes it", () => {
  const copied = INSTRUCTIONS.filter((line) => line.startsWith("COPY "));
  assert.deepEqual(copied, ["COPY documents.sh /tmp/agentrun-documents/documents.sh"]);
  assert.match(RUNS, /^RUN sh \/tmp\/agentrun-documents\/documents\.sh && rm -rf \/tmp\/agentrun-documents$/m);
  assert.doesNotMatch(RUNS, /pip install|npm install/, "no library is installed outside documents.sh");
  assert.match(SCRIPT, /^set -eu$/m);
});

/** The requirements documents.sh hands pip: name, version and its sha256s. */
function requirements() {
  const block = SCRIPT.match(/<<'REQUIREMENTS'\n([^]*?)\nREQUIREMENTS\n/)?.[1];
  assert.ok(block, "documents.sh writes its requirements from a quoted here-document");
  return block.replace(/\\\n\s*/g, " ").split("\n").filter((line) => line.trim() && !line.trim().startsWith("#")).map((line) => {
    const [, name, version] = line.match(/^([A-Za-z0-9._-]+)==(\d+(?:\.\d+)+) /) ?? [];
    assert.ok(name, `an exact version: ${line}`);
    const hashes = [...line.matchAll(/--hash=sha256:([0-9a-f]{64})\b/g)].map((match) => match[1]);
    return { name: name.toLowerCase().replace(/[-_.]+/g, "-"), version, hashes };
  });
}

test("its Python libraries are python-pptx, python-docx and openpyxl and everything they need, each pinned by version and sha256, wheels only", () => {
  const wanted = requirements();
  const names = wanted.map((one) => one.name).sort();
  assert.deepEqual(names, ["et-xmlfile", "lxml", "openpyxl", "pillow", "python-docx", "python-pptx", "typing-extensions", "xlsxwriter"]);
  for (const one of wanted) assert.ok(one.hashes.length >= 1, `${one.name} has a sha256`);
  for (const native of ["lxml", "pillow"]) assert.ok(wanted.find((one) => one.name === native).hashes.length >= 2, `${native}: a wheel for amd64 and for arm64`);
  assert.match(STEPS, /pip install [^\n]*--require-hashes/, "pip refuses anything without its listed sha256");
  assert.match(STEPS, /pip install [^\n]*--no-deps/, "nothing pip picks itself");
  assert.match(STEPS, /pip install [^\n]*--only-binary=:all:/, "no build from source");
  assert.match(STEPS, /pip install [^\n]*--no-cache-dir/);
});

test("its Node libraries are pptxgenjs, docx and exceljs at exact versions, from the registry as it stood at the apt snapshot's instant, no install script run", () => {
  const install = STEPS.match(/npm install [^\n]*/)?.[0];
  assert.ok(install, "documents.sh runs npm install");
  assert.match(install, /--ignore-scripts/);
  const before = install.match(/--before=(\S+)/)?.[1];
  assert.ok(before, "npm's --before");
  assert.equal(new Date(before).toISOString(), snapshotInstant(), "apt and npm are pinned to one instant");
  const pkgs = [...install.matchAll(/\b(pptxgenjs|docx|exceljs)@(\S+)/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(pkgs.map(([name]) => name).sort(), ["docx", "exceljs", "pptxgenjs"]);
  for (const [name, version] of pkgs) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} at an exact version`);
});

test("a script in any folder finds the Node libraries: they sit in a folder of their own, linked as /node_modules, which every folder's lookup reaches", () => {
  const prefix = STEPS.match(/npm install [^\n]*--prefix (\S+)/)?.[1];
  assert.ok(prefix?.startsWith("/usr/local/lib/"), `installed under /usr/local/lib: ${prefix}`);
  assert.match(STEPS, new RegExp(`ln -s ${prefix.replace(/[/.]/g, "\\$&")}/node_modules /node_modules`));
});

test("documents.sh ends by checking each library as an agent would load it, as Python imports it and as a script in another folder requires it", () => {
  const imports = STEPS.match(/python3 -c ["']import ([^"']+)["']/)?.[1].split(/,\s*/).sort();
  assert.deepEqual(imports, ["docx", "openpyxl", "pptx"]);
  const required = STEPS.match(/cd \/tmp && node -e .*/)?.[0];
  assert.ok(required, "node requires them from a folder that is not theirs");
  for (const name of ["pptxgenjs", "docx", "exceljs"]) assert.ok(required.includes(`"${name}"`), name);
});

test("it holds no key and picks nothing: no ENV, ARG or secret mount, and its build command names AGENTRUN_DOCKER_IMAGE and the recipe's hash", () => {
  assert.deepEqual(INSTRUCTIONS.filter((line) => /^(ENV|ARG|ENTRYPOINT|CMD|USER) /.test(line)), []);
  assert.doesNotMatch(DOCKERFILE + SCRIPT, /--mount=type=secret|KEY|TOKEN/);
  assert.match(DOCKERFILE, /tag=agentrun-documents:\$\(cat packages\/computer\/documents\/Dockerfile packages\/computer\/documents\/documents\.sh \| sha256sum \| cut -c1-12\)/);
  assert.match(DOCKERFILE, /docker build -t "\$tag" packages\/computer\/documents/);
  assert.match(DOCKERFILE, /AGENTRUN_DOCKER_IMAGE=\$tag/);
});

test("the package ships it", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("documents"), JSON.stringify(pkg.files));
});

// build-daytona.py run against a stand-in for Daytona's SDK (a `daytona` module on PYTHONPATH that keeps what it was
// handed), so no key and no request: what snapshot it would make, from what, under which name.
const STAND_IN = `
import json, os
calls = []
class GpuType:
    H100 = "H100"
class Resources:
    def __init__(self, **kw): self.kw = kw
class CreateSnapshotParams:
    def __init__(self, **kw): self.kw = kw
class Image:
    def __init__(self): self.steps = []
    @staticmethod
    def from_dockerfile(path):
        image = Image(); image.steps.append(["from_dockerfile", str(path)]); return image
    def dockerfile_commands(self, commands, context_dir=None):
        self.steps.append(["dockerfile_commands", list(commands), context_dir]); return self
class _Snapshots:
    def create(self, params, on_logs=None):
        kw = dict(params.kw)
        kw["image"] = kw["image"].steps
        kw["resources"] = kw["resources"].kw
        with open(os.environ["STAND_IN_OUT"], "w") as out: json.dump(kw, out)
class Daytona:
    def __init__(self): self.snapshot = _Snapshots()
`;

function buildDaytona(t, args) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "build-daytona-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "daytona.py"), STAND_IN);
  const out = join(dir, "made.json");
  const printed = execFileSync("python3", [fileURLToPath(new URL("../box/build-daytona.py", import.meta.url)), ...args], { env: { PATH: process.env.PATH, PYTHONPATH: dir, STAND_IN_OUT: out }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { printed, made: JSON.parse(readFileSync(out, "utf8")) };
}

const boxFile = (name) => readFileSync(fileURLToPath(new URL(`../box/${name}`, import.meta.url)));

test("build-daytona.py --documents makes the box image with documents.sh run on top, named agentrun-documents-<hash of both recipes>, its entrypoint the box's", (t) => {
  const digest = createHash("sha256").update(Buffer.concat([...["Dockerfile", "install.sh", "agentrun-archil"].map(boxFile), readFileSync(here("documents.sh"))])).digest("hex").slice(0, 12);
  const { printed, made } = buildDaytona(t, ["--documents"]);
  assert.equal(printed, `snapshot=agentrun-documents-${digest}\n`);
  assert.equal(made.name, `agentrun-documents-${digest}`);
  const [from, layer] = made.image;
  assert.deepEqual(from, ["from_dockerfile", fileURLToPath(new URL("../box/Dockerfile", import.meta.url))]);
  assert.deepEqual(layer.slice(0, 2), ["dockerfile_commands", ["COPY documents.sh /tmp/agentrun-documents/documents.sh", "RUN sh /tmp/agentrun-documents/documents.sh && rm -rf /tmp/agentrun-documents"]]);
  // With a trailing separator, Daytona's SDK files documents.sh at the context's top as documents.sh, beside the box's
  // install.sh, never over it.
  assert.equal(layer[2], here("") .replace(/\/?$/, "/"));
  assert.deepEqual(made.entrypoint, ["sh", "-c", "[ -z \"${AGENTRUN_ATTACH_URL-}\" ] || exec agentrun-dial; exec sleep infinity"]);
  assert.deepEqual(made.resources, { cpu: 2, memory: 4, disk: 10 });
});

test("build-daytona.py with no flag still makes agentrun-box-<the box recipe's hash> from box/Dockerfile alone", (t) => {
  const digest = createHash("sha256").update(Buffer.concat(["Dockerfile", "install.sh", "agentrun-archil"].map(boxFile))).digest("hex").slice(0, 12);
  const { printed, made } = buildDaytona(t, []);
  assert.equal(printed, `snapshot=agentrun-box-${digest}\n`);
  assert.equal(made.image.length, 1, "nothing on top");
});

import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { local, openRepo } from "@parcha/pi-git-remote";

const roots = [];
after(() => Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A fresh directory for one test, removed when the file's tests end. */
export async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-agent-learn-"));
  await chmod(dir, 0o755);
  roots.push(dir);
  return dir;
}

const GIT_ENV = {
  PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "setup", GIT_AUTHOR_EMAIL: "setup@example.invalid", GIT_COMMITTER_NAME: "setup", GIT_COMMITTER_EMAIL: "setup@example.invalid",
};

/** Plain git against one repository's git directory, for setup and for reading what a host left there. */
export const git = (gitDir, args, input) =>
  execFileSync("git", args, { env: { ...GIT_ENV, GIT_DIR: gitDir }, input, maxBuffer: 256 * 1024 * 1024 });

/** A bare remote whose main holds `files`, seeded through the package. */
export async function seededRemote(root, files = { "README.md": "seed\n" }) {
  const dir = path.join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "--template=", "-b", "main", dir], { env: GIT_ENV });
  const remote = local(dir);
  const seeder = await openRepo({ dir: path.join(root, "seeder"), remote });
  const { sha } = await seeder.commitTo("main", { files, message: "seed" });
  await seeder.push(sha, "main");
  return { dir, remote, main: sha };
}

export const refsOf = (gitDir) =>
  Object.fromEntries(git(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"]).toString().split("\n").filter(Boolean).map((l) => l.split(" ")));

/** Every object in a git directory, decompressed, as one buffer: what a search for a leaked value has to look through. */
export const allObjects = (gitDir) => git(gitDir, ["cat-file", "--batch-all-objects", "--batch"]);

export const commitCount = (gitDir, range) => Number(git(gitDir, ["rev-list", "--count", range]).toString().trim());

import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { local } from "../dist/index.js";
import { rawGit } from "./support.mjs";

/** A plain repository holding `files` (a string, or `{ link }` for a symlink), pushed to a new bare remote's main. */
export async function remoteWith(root, files) {
  const bare = path.join(root, "remote.git");
  await rawGit(["init", "-q", "--bare", "--template=", "-b", "main", bare]);
  const work = path.join(root, "seed-work");
  await rawGit(["init", "-q", "-b", "main", work]);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(work, file)), { recursive: true });
    if (typeof content === "string") await writeFile(path.join(work, file), content);
    else await symlink(content.link, path.join(work, file));
  }
  await rawGit(["add", "-A"], { cwd: work });
  await rawGit(["commit", "-q", "-m", "seed"], { cwd: work });
  await rawGit(["push", "-q", bare, "main"], { cwd: work });
  return { bare, remote: local(bare), main: (await rawGit(["rev-parse", "main"], { gitDir: bare })).toString().trim() };
}

export const branchesOf = async (bare) => (await rawGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { gitDir: bare })).toString().split("\n").filter(Boolean).sort();
export const showOn = async (bare, ref, file) => (await rawGit(["show", `${ref}:${file}`], { gitDir: bare }).catch(() => null))?.toString() ?? null;
export const treeOf = async (bare, ref) => (await rawGit(["ls-tree", "-r", "--name-only", ref], { gitDir: bare })).toString().split("\n").filter(Boolean);
export const commitsOf = async (bare, ref, base) => (await rawGit(["rev-list", `${base}..${ref}`], { gitDir: bare })).toString().split("\n").filter(Boolean);
export const messageOf = async (bare, ref) => (await rawGit(["log", "-1", "--format=%B", ref], { gitDir: bare })).toString();

import { execFileSync } from "node:child_process";

const GIT_ENV = {
  PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "setup", GIT_AUTHOR_EMAIL: "setup@example.invalid", GIT_COMMITTER_NAME: "setup", GIT_COMMITTER_EMAIL: "setup@example.invalid",
};

/** Plain git against one repository's git directory, for reading what a host left there. */
export const git = (gitDir, args, input) =>
  execFileSync("git", args, { env: { ...GIT_ENV, GIT_DIR: gitDir }, input, maxBuffer: 256 * 1024 * 1024 });

export const refsOf = (gitDir) =>
  Object.fromEntries(git(gitDir, ["for-each-ref", "--format=%(refname) %(objectname)"]).toString().split("\n").filter(Boolean).map((l) => l.split(" ")));

/** Every object in a git directory, decompressed, as one buffer: what a search for a leaked value has to look through. */
export const allObjects = (gitDir) => git(gitDir, ["cat-file", "--batch-all-objects", "--batch"]);

export const commitCount = (gitDir, range) => Number(git(gitDir, ["rev-list", "--count", range]).toString().trim());

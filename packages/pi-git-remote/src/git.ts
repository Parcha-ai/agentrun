import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { GitRemoteError } from "./errors.js";
import { checkCredential, type GitCredential } from "./remotes.js";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** On every call, before the command. A `-c` flag wins over the repository's own config, and the environment drops
 *  system and global config, so none of these can be turned back on from a config file. */
export const HARDENING: readonly string[] = Object.freeze([
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "credential.helper=",
  "-c", "core.askPass=",
  "-c", `attr.tree=${EMPTY_TREE}`,
  "-c", "protocol.allow=never",
  "-c", "protocol.file.allow=always",
  "-c", "protocol.https.allow=always",
  "-c", "core.untrackedCache=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "commit.gpgSign=false",
  "-c", "merge.renormalize=false",
  "-c", "fetch.recurseSubmodules=false",
  "-c", "push.recurseSubmodules=no",
  "-c", "submodule.recurse=false",
  "-c", "core.quotePath=false",
]);

/** The helper git asks for a credential: it prints the file git inherited on fd 3. `/dev/fd/3` reopens that file, so
 *  each request git makes in one process reads it whole. */
export const FD_CREDENTIAL_HELPER = '!f() { test "$1" = get && cat /dev/fd/3; }; f';

export type GitIdentity = { readonly name: string; readonly email: string };
export const DEFAULT_IDENTITY: GitIdentity = Object.freeze({ name: "pi-git-remote", email: "host@pi-git-remote.invalid" });

export type GitRunnerOptions = {
  /** The git executable. Default: `git` on PATH. */
  readonly binary?: string;
  /** GIT_DIR for every call; omit only for `init`. */
  readonly gitDir?: string;
  /** An empty directory of the host's: HOME, XDG_CONFIG_HOME and the working directory of every call, so no user
   *  config, global attributes or worktree file is ever read. */
  readonly home: string;
  /** A private directory of the host's where a credential's file is opened and unlinked before it is written. */
  readonly tmp: string;
  readonly identity?: GitIdentity;
  /** Kill the call's process group after this long. Default: 120 s. */
  readonly timeoutMs?: number;
};

export type GitCall = {
  readonly input?: string | Uint8Array;
  readonly indexFile?: string;
  /** Handed to this one git process on fd 3; never in argv, the environment, a URL or a file left on disk. */
  readonly credential?: GitCredential;
  /** Resolve with a non-zero exit instead of rejecting. */
  readonly allowFail?: boolean;
};

export type GitResult = { readonly code: number; readonly stdout: Buffer; readonly stderr: string };
export type GitRunner = (args: readonly string[], call?: GitCall) => Promise<GitResult>;

/** An unlinked 0600 file holding `credential` in git's credential format, open for reading at offset 0. It exists only
 *  as this descriptor, which the caller closes. */
function credentialDescriptor(tmp: string, credential: GitCredential): number {
  const dir = mkdtempSync(path.join(tmp, "c-"));
  const file = path.join(dir, "c");
  const fd = openSync(file, "w+", 0o600);
  try {
    unlinkSync(file);
    rmdirSync(dir);
    writeSync(fd, `username=${credential.username}\npassword=${credential.password}\n`, 0, "utf8");
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

function scrub(text: string, credential: GitCredential | undefined): string {
  return credential ? text.split(credential.password).join("[credential]") : text;
}

/** One git process per call: argv only (no shell), a fixed environment built from nothing, HARDENING before the
 *  command, and the credential, when given, on fd 3. */
export function createGitRunner(options: GitRunnerOptions): GitRunner {
  const binary = options.binary ?? "git";
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: options.home,
    XDG_CONFIG_HOME: options.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    LANG: "C",
    LC_ALL: "C",
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    ...(options.gitDir ? { GIT_DIR: options.gitDir } : {}),
  };

  return (args, call = {}) => {
    if (call.credential !== undefined) checkCredential(call.credential);
    const credential = call.credential;
    const fd = credential ? credentialDescriptor(options.tmp, credential) : null;
    const helper = credential ? ["-c", `credential.helper=${FD_CREDENTIAL_HELPER}`] : [];
    const env = call.indexFile ? { ...baseEnv, GIT_INDEX_FILE: call.indexFile } : baseEnv;
    return new Promise<GitResult>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (fd !== null) closeSync(fd);
        fn();
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(binary, [...HARDENING, ...helper, ...args], {
          cwd: options.home,
          env,
          stdio: ["pipe", "pipe", "pipe", ...(fd === null ? [] : [fd])],
          detached: true,
        });
      } catch (error) {
        finish(() => reject(new GitRemoteError("git", `git could not start: ${(error as Error).message}`)));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      }, timeoutMs);
      child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
      child.stdin!.on("error", () => undefined);
      child.on("error", (error) => {
        clearTimeout(timer);
        finish(() => reject(new GitRemoteError("git", `git could not start: ${error.message}`)));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const stderr = scrub(Buffer.concat(err).toString("utf8"), credential);
        const result: GitResult = { code: timedOut ? 124 : (code ?? 1), stdout: Buffer.concat(out), stderr };
        if (result.code === 0 || call.allowFail) {
          finish(() => resolve(result));
          return;
        }
        const why = timedOut ? `timed out after ${timeoutMs} ms` : stderr.trim().slice(0, 2000);
        finish(() => reject(new GitRemoteError("git", `git ${args[0] ?? ""} failed (${result.code}): ${why}`)));
      });
      child.stdin!.end(call.input ?? "");
    });
  };
}

/** The git version a binary reports, as [major, minor]. */
export async function gitVersion(run: GitRunner): Promise<[number, number]> {
  const text = (await run(["version"])).stdout.toString("utf8");
  const match = /git version (\d+)\.(\d+)/.exec(text);
  if (!match) throw new GitRemoteError("git", "git did not report a version");
  return [Number(match[1]), Number(match[2])];
}

import path from "node:path";
import { GitRemoteError } from "./errors.js";

/** What git sends to an https remote. It stays in the host's memory and reaches git only on file descriptor 3. */
export type GitCredential = { readonly username: string; readonly password: string };

/** Asked once for each git process that talks to the remote, so a host can hand out a fresh short-lived token. */
export type CredentialSource = () => GitCredential | undefined | Promise<GitCredential | undefined>;

/**
 * Where the repository lives. `local` is a bare repository on this machine (`local(path)`); `https` is a smart-HTTP
 * remote. A URL never carries a credential: an https remote takes `credential`, a callback.
 */
export type Remote = {
  readonly kind: "local" | "https";
  /** Fetched from, and pushed to unless `pushUrl` is set. */
  readonly url: string;
  /** Where pushes go when it differs from `url` (a namespace hidden from clones, for one). It is fetched too, so a
   *  commit pushed there is found again. */
  readonly pushUrl?: string;
  readonly credential?: CredentialSource;
};

/** A bare repository on this machine. Its hooks never run on our pushes; the directory must be the host's own, since
 *  git still reads its config. */
export function local(dir: string): Remote {
  if (typeof dir !== "string" || dir === "") throw new GitRemoteError("refused", "a local remote needs a directory");
  return Object.freeze({ kind: "local", url: path.resolve(dir) });
}

const UNSAFE = /[\u0000-\u001f\u007f]/;

function checkUrl(kind: Remote["kind"], url: unknown, field: string): void {
  if (typeof url !== "string" || url === "" || UNSAFE.test(url)) throw new GitRemoteError("refused", `the remote's ${field} is not a usable URL`);
  if (kind === "local") {
    if (!path.isAbsolute(url) || url.includes("::")) throw new GitRemoteError("refused", `a local remote's ${field} must be an absolute path`);
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GitRemoteError("refused", `the remote's ${field} is not a URL`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new GitRemoteError("refused", `the remote's ${field} carries userinfo; pass the credential as the remote's credential callback`);
  }
  if (parsed.protocol !== "https:") throw new GitRemoteError("refused", `the remote's ${field} must be an https URL`);
}

/** Refuses a remote this package will not talk to. The message never repeats the URL, which may hold a secret. */
export function checkRemote(remote: Remote): void {
  if (remote === null || typeof remote !== "object") throw new GitRemoteError("refused", "the remote must be an object");
  if (remote.kind !== "local" && remote.kind !== "https") throw new GitRemoteError("refused", "the remote's kind must be local or https");
  checkUrl(remote.kind, remote.url, "url");
  if (remote.pushUrl !== undefined) checkUrl(remote.kind, remote.pushUrl, "pushUrl");
  if (remote.credential !== undefined && typeof remote.credential !== "function") throw new GitRemoteError("refused", "the remote's credential must be a callback");
  if (remote.kind === "local" && remote.credential !== undefined) {
    throw new GitRemoteError("refused", "a local remote takes no credential: its receive-pack would inherit it");
  }
}

/** Refuses a credential git's credential protocol cannot carry as one value per line. */
export function checkCredential(credential: unknown): asserts credential is GitCredential {
  const c = credential as GitCredential | null;
  if (c === null || typeof c !== "object" || typeof c.username !== "string" || typeof c.password !== "string" || c.password === "") {
    throw new GitRemoteError("refused", "the credential callback must return { username, password } with a password");
  }
  if (/[\r\n\u0000]/.test(c.username) || /[\r\n\u0000]/.test(c.password)) {
    throw new GitRemoteError("refused", "a credential may not contain a line break or a NUL");
  }
}

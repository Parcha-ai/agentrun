import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GitRemoteError } from "./errors.js";
import type { GitIdentity } from "./git.js";
import type { Limits } from "./limits.js";
import { local, type Remote } from "./remotes.js";
import { openRepo } from "./repo.js";
import { createSessionCheckout, DEFAULT_BRANCH, type EndOutcome, privateDirectory, type SessionCheckout, SESSION_PLACEHOLDER } from "./session.js";

export { DEFAULT_BRANCH, type EndOutcome, SESSION_ID_TRAILER } from "./session.js";

/** The settings key (`~/.pi/agent/settings.json`) and the flags that configure the extension. */
export const SETTINGS_KEY = "gitRemote";
const FLAGS = ["git-remote", "git-ref", "git-allow", "git-branch", "git-checkout-dir"] as const;

export type GitRemoteOptions = {
  /** A local bare repository (`local(path)`), an https remote with the credential callback the host wires, or a string:
   *  a path, or an https URL without a credential. */
  remote?: Remote | string;
  /** The branch or commit the session starts from. Default: `main`. */
  ref?: string;
  /** Globs over repository paths that may be committed, such as `notes/**`. Required: an empty list commits nothing. */
  allow?: readonly string[];
  /** The session branch, with `{sessionId}` in it exactly once. Default: `sessions/{sessionId}`. */
  branch?: string;
  /** Where the checkout goes (`{sessionId}` is replaced): outside the session's working directory. Default: under `stateDir`. */
  checkoutDir?: string;
  /** Holds the host's repository, the checkouts and each session's seed record, and must stay out of the agent's reach.
   *  Default: `git-remote` in pi's agent directory. */
  stateDir?: string;
  git?: string;
  limits?: Partial<Limits>;
  identity?: GitIdentity;
  timeoutMs?: number;
  /** Told how each session's end went. An error is also thrown to pi, which reports it. */
  onEnd?: (report: { readonly ok: true; readonly outcome: EndOutcome } | { readonly ok: false; readonly sessionId: string; readonly error: unknown }) => void;
};

type Config = {
  remote: Remote;
  ref: string;
  allow: readonly string[];
  branch: string;
  checkoutDir: string | undefined;
  stateDir: string;
};

const refused = (message: string) => new GitRemoteError("refused", message);

function asRemote(value: Remote | string, cwd: string): Remote {
  if (typeof value !== "string") return value;
  if (/^https:\/\//i.test(value)) return { kind: "https", url: value };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[\w.-]+@[\w.-]+:/.test(value)) throw refused("a remote given as a string is a local path or an https URL");
  return local(path.resolve(cwd, value));
}

function strings(value: unknown, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw refused(`${what} must be a list of strings`);
  return value;
}

function text(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw refused(`${what} must be a non-empty string`);
  return value;
}

/** Options first, then the flags, then the `gitRemote` settings key. No remote anywhere means the extension is idle. */
function configFor(pi: ExtensionAPI, options: GitRemoteOptions, cwd: string): Config | undefined {
  const flag = (name: (typeof FLAGS)[number]) => {
    const value = pi.getFlag(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const all: unknown = pi.getSettings();
  const stored = (all as Record<string, unknown>)[SETTINGS_KEY];
  if (stored !== undefined && (stored === null || typeof stored !== "object" || Array.isArray(stored))) throw refused(`the ${SETTINGS_KEY} setting must be an object`);
  const settings = (stored ?? {}) as Record<string, unknown>;
  const remote = options.remote ?? flag("git-remote") ?? text(settings.remote, `${SETTINGS_KEY}.remote`);
  if (remote === undefined) return undefined;
  const allowFlag = flag("git-allow");
  const allow = options.allow ?? (allowFlag === undefined ? undefined : allowFlag.split(",").map((g) => g.trim()).filter(Boolean)) ?? strings(settings.allow, `${SETTINGS_KEY}.allow`);
  if (!allow || allow.length === 0) throw refused(`a remote is configured but no allowlist is: set --git-allow, ${SETTINGS_KEY}.allow or the allow option, so the session may commit something`);
  const stateDir = options.stateDir ?? text(settings.stateDir, `${SETTINGS_KEY}.stateDir`) ?? path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "git-remote");
  return {
    remote: asRemote(remote, cwd),
    ref: options.ref ?? flag("git-ref") ?? text(settings.ref, `${SETTINGS_KEY}.ref`) ?? "main",
    allow,
    branch: options.branch ?? flag("git-branch") ?? text(settings.branch, `${SETTINGS_KEY}.branch`) ?? DEFAULT_BRANCH,
    checkoutDir: options.checkoutDir ?? flag("git-checkout-dir") ?? text(settings.checkoutDir, `${SETTINGS_KEY}.checkoutDir`),
    stateDir: path.resolve(cwd, stateDir),
  };
}

/** The real path of `target`, or of its deepest existing ancestor with the rest appended. */
async function realish(target: string): Promise<string> {
  const rest: string[] = [];
  for (let at = path.resolve(target); ; at = path.dirname(at)) {
    try {
      return path.join(await realpath(at), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || at === path.dirname(at)) throw error;
      rest.push(path.basename(at));
    }
  }
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

type Active = { sessionId: string; checkout: SessionCheckout; agents: string | undefined };

/** A notice is a courtesy: the context may already be gone at shutdown, and a failed notice must not fail a commit. */
function tell(ctx: ExtensionContext, message: string): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, "info");
  } catch {
    // nothing to tell
  }
}

/**
 * A pi coding-agent extension that gives a session a git repository it commits to at the end, with the host holding git.
 * On `session_start` the ref is checked out into a directory outside the session's working directory and exposed to pi:
 * the repository's `.agents/skills` through `resources_discover` (the hook that adds resource roots) and its `AGENTS.md`
 * through `before_agent_start` (the only hook that reaches the context files). On `session_shutdown` the allowlisted
 * changes are committed to the session's own branch and pushed by sha. The model gets no tool.
 */
export function createGitRemoteExtension(options: GitRemoteOptions = {}): (pi: ExtensionAPI) => void {
  return function piGitRemote(pi: ExtensionAPI): void {
    for (const name of FLAGS) {
      pi.registerFlag(name, { type: "string", description: {
        "git-remote": "A local bare repository or an https URL the session's repository lives in",
        "git-ref": "The branch or commit the session starts from (default: main)",
        "git-allow": "Comma-separated globs of repository paths the session may commit, such as notes/**,skills/**",
        "git-branch": `The session's branch, with ${SESSION_PLACEHOLDER} in it (default: ${DEFAULT_BRANCH})`,
        "git-checkout-dir": `Where to check the repository out, outside the working directory (${SESSION_PLACEHOLDER} is replaced)`,
      }[name] });
    }
    let active: Active | undefined;
    // A host's callback never changes how an end went.
    const heard = (report: Parameters<NonNullable<GitRemoteOptions["onEnd"]>>[0]) => {
      try {
        options.onEnd?.(report);
      } catch {
        // ignored
      }
    };

    pi.on("session_start", async (_event, ctx: ExtensionContext) => {
      active = undefined;
      const config = configFor(pi, options, ctx.cwd);
      if (!config) return;
      const sessionId = ctx.sessionManager.getSessionId();
      await privateDirectory(config.stateDir);
      const checkoutDir = path.resolve(ctx.cwd, (config.checkoutDir ?? path.join(config.stateDir, "checkouts", SESSION_PLACEHOLDER)).replaceAll(SESSION_PLACEHOLDER, sessionId));
      const [realCheckout, realCwd] = await Promise.all([realish(checkoutDir), realish(ctx.cwd)]);
      if (inside(realCheckout, realCwd) || inside(realCwd, realCheckout)) throw refused("the checkout directory and the session's working directory must be apart: the agent's files belong in one and the repository in the other");
      const urls = `${config.remote.url}\0${config.remote.pushUrl ?? ""}`;
      const repo = await openRepo({
        dir: path.join(config.stateDir, "repos", createHash("sha256").update(urls).digest("hex").slice(0, 16)),
        remote: config.remote,
        ...(options.git ? { git: options.git } : {}),
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.identity ? { identity: options.identity } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      const checkout = createSessionCheckout({
        repo, sessionId, ref: config.ref, checkoutDir, seedFile: path.join(config.stateDir, "sessions", `${sessionId}.json`), allow: config.allow, branch: config.branch,
      });
      const seeded = await checkout.seed();
      // The text the model is shown is the seeded commit's, not the working file: an edit to AGENTS.md mid-session would
      // otherwise change the system prompt and break the prompt cache, and the agent could point it through a symlink.
      // A symlink or a submodule at that path is not read; any other failure is the session's to hear about.
      const agents = await checkout.seeded("AGENTS.md").catch((error: unknown) => {
        if (error instanceof GitRemoteError && error.code === "refused") return undefined;
        throw error;
      });
      active = { sessionId, checkout, agents };
      tell(ctx, `Repository ${config.ref}@${seeded.sha.slice(0, 8)} ${seeded.resumed ? "kept at" : "checked out into"} ${checkout.dir}; allowlisted changes go to ${checkout.branch} when the session ends`);
    });

    pi.on("resources_discover", async () => {
      if (!active) return {};
      const skills = path.join(active.checkout.dir, ".agents", "skills");
      const stat = await lstat(skills).catch(() => undefined);
      return stat?.isDirectory() ? { skillPaths: [skills] } : {};
    });

    pi.on("before_agent_start", (event) => {
      if (!active?.agents) return;
      const file = path.join(active.checkout.dir, "AGENTS.md");
      const files = event.systemPromptOptions.contextFiles;
      if (!files.some((f) => f.path === file)) files.push({ path: file, content: active.agents });
    });

    pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
      const current = active;
      // A reload keeps the session going in a new runtime that picks the same directory up again.
      if (!current || event.reason === "reload") {
        active = undefined;
        return;
      }
      try {
        const outcome = await current.checkout.end();
        heard({ ok: true, outcome });
        if (outcome.created) tell(ctx, `${outcome.changed.length} file${outcome.changed.length === 1 ? "" : "s"} committed to ${outcome.branch} at ${outcome.sha!.slice(0, 8)}`);
      } catch (error) {
        heard({ ok: false, sessionId: current.sessionId, error });
        throw error;
      }
    });
  };
}

export default function piGitRemote(pi: ExtensionAPI): void {
  createGitRemoteExtension()(pi);
}

// boxHost (`@parcha/pi-durable-disk/box`): a host driver whose instances run in boxes of a pi-transport provider, Modal's
// VM first. A start finds the box this attempt already made (three labels of this package) or creates one with the spec
// given and `capabilities: ["fuse"]`, checks that the box can hold the run's mount (`facts().fuse`, and an fd for the
// launcher's frame), uploads the app's files into a fresh box, and has transport's launcher keep this package's CLI running
// there as the run user. The mount token is that launch's stdin: the launcher holds it in memory and replays it to each
// incarnation, and boxHost keeps it for that one call. A launcher that is lost cannot start the instance again without it,
// so a lost launch is `failed`: the place takes over, the box is stopped and destroyed, and a new start mints a new token.
//
// pi-transport is an optional peer of this package: this entry needs it, the package's root does not. Its types are
// imported here; its launcher is loaded on the first start.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Box, BoxError, BoxFile, BoxProvider, BoxSpec } from "@parcha/pi-transport";
import type { Launch, LaunchError, LaunchSpec, LaunchState } from "@parcha/pi-transport/launch";
import type { RunRef } from "./claim.ts";
import { PdaError } from "./errors.ts";
import { attemptEnv } from "./hosts/attempt-env.ts";
import { TERMINAL_EXITS } from "./hosts/local-host.ts";
import type { HostBox, HostDriver, HostHandle, HostStatus, StartAttempt } from "./supervise.ts";

export type BoxHostErrorCode = "INVALID_ARGUMENT" | "UNSUPPORTED" | "CREATE_FAILED" | "UPLOAD_FAILED" | "LAUNCH_FAILED" | "START_TIMED_OUT" | "STOP_FAILED";

/** A boxHost call that failed. The provider's or the launcher's own error is its `cause`. */
export class BoxHostError extends PdaError {
  declare readonly code: BoxHostErrorCode;
  constructor(code: BoxHostErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

export interface BoxHostOptions {
  /** Where boxes come from (a tapped provider is fine). Its `name` is every receipt's `provider` and HOST_BOX's. */
  provider: BoxProvider;
  /**
   * The box each fresh start creates. `maxLifetimeMs` is required (transport's bound on a leaked box). boxHost adds
   * `capabilities: ["fuse"]` and its own labels; a spec with `env` (a start's env goes to the launcher, never into a spec a
   * provider stores), or with a label key of transport's (`pi-transport`, `pi-transport.*`) or of boxHost's
   * (`pi-durable-disk.*`), is refused.
   */
  spec: BoxSpec;
  /** The app module the instance runs (`--app`), as a path inside the box: in the image, or among `files`. */
  app: string;
  /** Files uploaded into a fresh box before the launch, never into one found again. */
  files?: readonly BoxFile[];
  /** How this package's CLI is run in the box. Default `["pi-durable-disk"]`, found on the box runtime's PATH. */
  command?: readonly string[];
  /** Where runs mount in the box. Default /mnt/archil. */
  mountRoot?: string;
  /** The archil wrapper the instance mounts through (`--archil`). Default /usr/local/sbin/archil-scoped. */
  archil?: string;
  /** More flags for the CLI's `run`, before `--token-stdin`. */
  runArgs?: readonly string[];
  /**
   * The user every agent command runs as (the CLI's `--run-as`), with no capabilities under no_new_privs: never root.
   * Default `pda`. The instance itself runs as root and holds the mount token with the launcher and the FUSE daemon, so
   * no command can ptrace a holder, with or without Yama, and the tools' user needs no sudo rule.
   */
  runAs?: string;
  /** Plain settings for every start, under each start's own (attemptEnv's rules). Never a secret. */
  env?: Readonly<Record<string, string>>;
  /** From the create (or the find) until the launcher says the instance runs. Default 300 s. */
  startTimeoutMs?: number;
  /** How long a planned stop lets the instance drain before the launcher's stop hook and kill. Default 30 s. */
  stopGraceMs?: number;
  /** How long one status, stop or kill may take over the provider. Default 60 s. */
  callTimeoutMs?: number;
}

type Launcher = typeof import("@parcha/pi-transport/launch");

const DISK_LABEL = "pi-durable-disk.disk";
const RUN_LABEL_KEY = "pi-durable-disk.run";
const ATTEMPT_LABEL = "pi-durable-disk.attempt";
const USER = /^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10})$/;

/**
 * A host driver over `options.provider`'s boxes. `kills` is `box`: a kill destroys the box at once. A box this start finds
 * with a launch that ended or was lost is destroyed and replaced; one whose launch runs is adopted (`adopted: true`).
 */
export function boxHost(options: BoxHostOptions): HostDriver & Required<Pick<HostDriver, "kill" | "kills" | "box" | "provider" | "instanceOf">> {
  const { provider, spec } = options;
  const invalid = (message: string) => new BoxHostError("INVALID_ARGUMENT", message);
  if (!provider || typeof provider.create !== "function" || typeof provider.attach !== "function" || typeof provider.list !== "function" || typeof provider.name !== "string" || provider.name === "") {
    throw invalid("provider is not a pi-transport BoxProvider with a name");
  }
  if (!spec || !(Number.isFinite(spec.maxLifetimeMs) && spec.maxLifetimeMs > 0)) throw invalid("spec.maxLifetimeMs is required: a positive number of milliseconds bounds a leaked box");
  if (spec.env !== undefined) throw invalid("spec.env is refused: a start's environment goes to the launcher, never into a spec the provider stores");
  for (const key of Object.keys(spec.labels ?? {})) {
    if (key === "pi-transport" || key.startsWith("pi-transport.") || key.startsWith("pi-durable-disk.")) throw invalid(`spec.labels has ${key}, a key that is the provider's or boxHost's own`);
  }
  if (typeof options.app !== "string" || options.app === "") throw invalid("app is the module the instance runs, a path inside the box");
  const command = options.command ?? ["pi-durable-disk"];
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part === "")) throw invalid("command is a non-empty list of non-empty strings");
  // The one source of the tools' user: the CLI's --run-as (and the launcher's declared tools user, once T3b lands).
  const runAs = options.runAs ?? "pda";
  if (!USER.test(runAs)) throw invalid("runAs is a user name or a uid");
  if (runAs === "root" || (/^[0-9]+$/.test(runAs) && Number(runAs) === 0)) throw invalid("runAs is root: the agent's commands never run as uid 0, next to the processes that hold the mount token");
  const mountRoot = options.mountRoot ?? "/mnt/archil";
  if (!mountRoot.startsWith("/")) throw invalid("mountRoot is an absolute path");
  const archil = options.archil ?? "/usr/local/sbin/archil-scoped";
  const startTimeoutMs = options.startTimeoutMs ?? 300_000;
  const stopGraceMs = options.stopGraceMs ?? 30_000;
  const callTimeoutMs = options.callTimeoutMs ?? 60_000;
  const capabilities = [...new Set([...(spec.capabilities ?? []), "fuse" as const])];

  /** A refusal that holds for this spec (the box kind cannot hold the mount): later starts are refused without a box. */
  let refusal: BoxHostError | undefined;
  /** What `box()` reports for each box this driver made or found, by box id. */
  const receipts = new Map<string, { kind: string; from: string; to: string | null }>();
  let launcher: Launcher | undefined;
  const load = async (): Promise<Launcher> => {
    if (launcher) return launcher;
    try {
      launcher = await import("@parcha/pi-transport/launch");
      return launcher;
    } catch (error) {
      throw new BoxHostError("UNSUPPORTED", "boxHost needs @parcha/pi-transport (its launcher, @parcha/pi-transport/launch): install it beside this package", { cause: error });
    }
  };
  const bounded = (ms: number): Context => withAbortSignal(AbortSignal.timeout(ms), BACKGROUND_CONTEXT);
  const ended = (id: string) => {
    const r = receipts.get(id);
    if (r && r.to === null) r.to = new Date().toISOString();
  };
  const remember = (box: Box) => {
    if (receipts.has(box.id)) return;
    const facts = box.facts();
    receipts.set(box.id, { kind: facts.gpu ?? facts.isolation, from: facts.startedAt ?? new Date().toISOString(), to: null });
  };
  const destroy = async (box: Box, context: Context) => {
    await box.destroy(context).catch(() => undefined);
    ended(box.id);
  };
  const launchName = (ref: RunRef, attempt: number) => `pda-${ref.id}-g${attempt}`.slice(0, 64);
  const handleOf = (box: Box, attempt: number, launch: Launch): HostHandle => ({ driver: "box", provider: provider.name, box: box.id, attempt, launch: { v: launch.v, name: launch.name } });
  const mine = (h: HostHandle): h is HostHandle & { box: string; attempt: number; launch: { v: 1; name: string } } =>
    h.driver === "box" && h.provider === provider.name && typeof h.box === "string" && typeof h.attempt === "number" && typeof (h.launch as { name?: unknown } | null)?.name === "string";
  const launchOf = (h: { launch: { name: string } }): Launch => ({ v: 1, name: h.launch.name });
  const boxError = (what: string, error: BoxError, code: BoxHostErrorCode = "CREATE_FAILED") => new BoxHostError(code, `${what}: ${error.code}: ${error.message}`, { cause: error });

  /** The box this attempt already made, found by its labels, and what its launch says; or nothing. */
  const find = async (labels: Record<string, string>, name: string, context: Context, l: Launcher): Promise<{ box: Box; state: LaunchState | undefined } | undefined> => {
    const listed = await provider.list(labels, context);
    if (!listed.ok) throw boxError(`listing ${provider.name}'s boxes by this attempt's labels`, listed.error);
    for (const ref of listed.value) {
      const attached = await provider.attach(ref.id, context);
      if (!attached.ok) throw boxError(`attaching ${provider.name} box ${ref.id}`, attached.error);
      if (!attached.value) continue;
      const state = await l.launchState(attached.value, { v: 1, name }, context);
      return { box: attached.value, state: state.ok ? state.value : undefined };
    }
    return undefined;
  };

  return {
    provider: provider.name,
    kills: "box",
    // A box is named by its provider and its id, the same in a fresh handle and an adopted one.
    instanceOf: (h: HostHandle) => (mine(h) ? `box\0${provider.name}\0${h.box}` : undefined),

    async start(ref: RunRef, mountToken: string, attempt?: StartAttempt): Promise<HostHandle> {
      if (!mountToken) throw invalid("no mount token");
      if (refusal) throw new BoxHostError("UNSUPPORTED", `refused before, for this spec, so no box is made again: ${refusal.message}`, { cause: refusal });
      if (!attempt || !Number.isInteger(attempt.attempt) || attempt.attempt < 1) throw invalid("a start needs its attempt: boxHost finds the box an attempt made by it");
      const extra = attemptEnv(attempt, (m) => new BoxHostError("INVALID_ARGUMENT", m));
      const l = await load();
      const n = attempt.attempt;
      const name = launchName(ref, n);
      const labels = { [DISK_LABEL]: ref.disk, [RUN_LABEL_KEY]: ref.id, [ATTEMPT_LABEL]: String(n) };
      const context = bounded(startTimeoutMs);
      const timedOut = () => new BoxHostError("START_TIMED_OUT", `starting run ${ref.id} attempt ${n} in a ${provider.name} box took over ${startTimeoutMs} ms`);
      const specFor = (holder: string): LaunchSpec => ({
        argv: [...command, "run", "--disk", ref.disk, "--region", ref.region, "--id", ref.id, "--mount-root", mountRoot, "--archil", archil, "--app", options.app, ...(options.runArgs ?? []), "--run-as", runAs, "--token-stdin"],
        env: { ...options.env, ...extra, PDA_HOLDER: holder },
        inheritEnv: false,
        // The instance runs as root: it mounts directly (no sudo) and holds the token; its commands drop to runAs. The
        // launcher verifies that same user (it exists, is not uid or gid 0, has no sudo rule and no setuid or setcap
        // helper) and exports it, which the instance checks --run-as against.
        user: "root",
        toolsUser: runAs,
        stdin: new TextEncoder().encode(`${mountToken}\n`),
        restart: true,
        restartDelayMs: 1_000,
        terminalExits: [...TERMINAL_EXITS],
      });
      // The launcher's own check of the spec, before any call to the provider: an environment it refuses never boots a box.
      const refused = l.launchSpecError(name, specFor("{}"));
      if (refused) throw new BoxHostError("INVALID_ARGUMENT", `the launcher refuses this start: ${refused.message}`, { cause: refused });
      const refuse = (box: Box | undefined, message: string, cause?: unknown) => {
        refusal = new BoxHostError("UNSUPPORTED", message, cause === undefined ? {} : { cause });
        return box ? destroy(box, bounded(callTimeoutMs)).then(() => refusal!) : Promise.resolve(refusal);
      };

      // The box this attempt made already: adopted while its launch runs, used as fresh while it never launched, replaced otherwise.
      let box: Box | undefined;
      const found = await find(labels, name, context, l);
      if (found) {
        const phase = found.state?.phase;
        if (phase === "starting" || phase === "running" || phase === "restarting") {
          remember(found.box);
          return { ...handleOf(found.box, n, launchOf({ launch: { name } })), adopted: true };
        }
        if (found.state === undefined) box = found.box;
        else await destroy(found.box, bounded(callTimeoutMs));
      }
      if (!box) {
        const created = await provider.create({ ...spec, capabilities, labels: { ...spec.labels, ...labels } }, context);
        if (created.ok) box = created.value;
        else {
          // A create that failed after the machine existed: found by its labels and used, never leaked.
          const again = created.error.code === "unknown" || created.error.code === "timeout" ? await find(labels, name, context, l).catch(() => undefined) : undefined;
          if (again && again.state === undefined) box = again.box;
          else if (again) await destroy(again.box, bounded(callTimeoutMs));
          if (!box) {
            if (created.error.code === "invalid") throw boxError(`${provider.name} refused the spec`, created.error, "INVALID_ARGUMENT");
            if (created.error.code === "unsupported") throw await refuse(undefined, `${provider.name} cannot make this box: ${created.error.message}`, created.error);
            if (created.error.code === "aborted" || context.abortSignal?.aborted) throw timedOut();
            throw boxError(`creating a ${provider.name} box`, created.error);
          }
        }
      }
      remember(box);
      const facts = box.facts();
      if (facts.fuse !== true) throw await refuse(box, `the ${provider.name} box cannot hold the run's mount: facts().fuse is ${String(facts.fuse)}, not true`);
      if (facts.secretsVia !== "fd") throw await refuse(box, `the ${provider.name} box has no fd for the launcher's frame: facts().secretsVia is ${String(facts.secretsVia)}, not "fd"`);
      if (facts.liveProcesses === false) throw await refuse(box, `the ${provider.name} box keeps no program running (liveProcesses: false)`);

      if (options.files && options.files.length > 0) {
        const uploaded = await box.upload(options.files, context);
        if (!uploaded.ok) {
          await destroy(box, bounded(callTimeoutMs));
          if (context.abortSignal?.aborted) throw timedOut();
          throw boxError(`uploading the app's files into ${provider.name} box ${box.id}`, uploaded.error, "UPLOAD_FAILED");
        }
      }

      const handle = handleOf(box, n, { v: 1, name });
      const launched = await l.launch(box, name, specFor(JSON.stringify(handle)), context);
      if (!launched.ok) {
        const e: LaunchError = launched.error;
        if (e.code === "unsupported" || e.code === "refused") throw await refuse(box, `the ${provider.name} box cannot run the instance as asked (${e.code}): ${e.message}`, e);
        await destroy(box, bounded(callTimeoutMs));
        if (e.code === "invalid") throw new BoxHostError("INVALID_ARGUMENT", `the launch was refused: ${e.message}`, { cause: e });
        if (e.code === "timeout" || context.abortSignal?.aborted) throw new BoxHostError("START_TIMED_OUT", `the instance did not start in ${provider.name} box ${box.id}: ${e.message}`, { cause: e });
        throw new BoxHostError("LAUNCH_FAILED", `launching the instance in ${provider.name} box ${box.id} failed (${e.code}): ${e.message}`, { cause: e });
      }
      // launch() answers once the phase leaves `starting`. An instance the launcher could not run at all (exit 126: the user
      // switch, the env clear or the cwd), or one already ended, is a failed start, never a running instance; an ordinary
      // early crash is the launcher's to restart, and the run's own backoff applies.
      const state = launched.value;
      const couldNotRun = state.lastExit === 126;
      if (couldNotRun || state.phase === "exited" || state.phase === "gave_up" || state.phase === "stopped" || state.phase === "lost") {
        await destroy(box, bounded(callTimeoutMs));
        throw new BoxHostError(
          "LAUNCH_FAILED",
          couldNotRun
            ? `the launcher could not run the instance in ${provider.name} box ${box.id} (exit 126: with its environment or in its directory)`
            : `the instance ended at once in ${provider.name} box ${box.id} (${state.phase}${state.lastExit === undefined ? "" : `, exit ${state.lastExit}`})`,
        );
      }
      return handle;
    },

    async status(h: HostHandle): Promise<HostStatus> {
      if (!mine(h)) return "unknown";
      const context = bounded(callTimeoutMs);
      const attached = await provider.attach(h.box, context).catch(() => undefined);
      if (!attached || !attached.ok) return "unknown";
      if (!attached.value) {
        ended(h.box);
        return "gone";
      }
      const box = attached.value;
      const live = await box.status(context).catch(() => undefined);
      if (live?.ok && live.value.state === "ended") {
        ended(h.box);
        return "gone";
      }
      const l = await load().catch(() => undefined);
      if (!l) return "unknown";
      const state = await l.launchState(box, launchOf(h), context).catch(() => undefined);
      if (!state || !state.ok) return "unknown";
      if (state.value === undefined) return "failed";
      switch (state.value.phase) {
        case "starting":
        case "running":
        case "restarting":
        case "stopping":
          return "running";
        case "stopped":
          return "stopped";
        case "exited":
          return state.value.lastExit === 0 ? "stopped" : "failed";
        default:
          // gave_up, and lost: its launcher is gone, and boxHost keeps no token to start it again.
          return "failed";
      }
    },

    async stop(h: HostHandle): Promise<void> {
      if (!mine(h)) return;
      const context = bounded(callTimeoutMs + stopGraceMs);
      const attached = await provider.attach(h.box, context);
      if (!attached.ok) throw boxError(`attaching ${provider.name} box ${h.box} to stop it`, attached.error, "STOP_FAILED");
      if (!attached.value) return void ended(h.box);
      const l = await load().catch(() => undefined);
      // A drain, the launcher's stop hook, then the kill; a launch that cannot be stopped is ended with its box anyway.
      if (l) await l.launchStop(attached.value, launchOf(h), { graceMs: stopGraceMs }, context).catch(() => undefined);
      const destroyed = await attached.value.destroy(context);
      if (!destroyed.ok) throw boxError(`destroying ${provider.name} box ${h.box}`, destroyed.error, "STOP_FAILED");
      ended(h.box);
    },

    async kill(h: HostHandle): Promise<void> {
      if (!mine(h)) return;
      const context = bounded(callTimeoutMs);
      const attached = await provider.attach(h.box, context);
      if (!attached.ok) throw boxError(`attaching ${provider.name} box ${h.box} to kill it`, attached.error, "STOP_FAILED");
      if (!attached.value) return void ended(h.box);
      const destroyed = await attached.value.destroy(context);
      if (!destroyed.ok) throw boxError(`destroying ${provider.name} box ${h.box}`, destroyed.error, "STOP_FAILED");
      ended(h.box);
    },

    box(h: HostHandle): HostBox | null {
      if (!mine(h)) return null;
      const r = receipts.get(h.box);
      return r ? { provider: provider.name, kind: r.kind, from: r.from, to: r.to } : null;
    },
  };
}

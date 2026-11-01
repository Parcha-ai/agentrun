// boxHost (`@parcha/pi-durable-disk/box`): a host driver whose instance runs a run on a plain directory inside a box of any
// pi-transport provider. The run's directory is BOX_RUN_DIR in the box, and the instance is this package's CLI on it
// (`run --dir`), kept running by pi-transport's launcher. Nothing mounts: no disk, no mount token, no FUSE.
//
// On a plain directory the owner lock is the run's only claim (local-run.ts), and it holds only inside one box. So this
// driver keeps one box per run: a start ends every box an older attempt of the run made before it makes or adopts its
// own, and makes nothing while a newer attempt's box is there. Starts, stops and kills of one run are serialized.
//
// The caller gives the box as it wants it (`spec`: image, env, network, labels), used as given plus this driver's two
// labels. Whatever the run needs that is secret (`secrets`) rides the launch frame: the stdin of the one exec that starts
// the launcher, held in its memory and handed to each incarnation on fd 3 (PI_TRANSPORT_SECRETS_FD). Never an env and
// never an argv. Only a start that has secrets needs a box whose facts say `secretsVia: "fd"`.
//
// pi-transport is an optional peer of this package: this entry needs it, the package's root does not. Its types are
// imported here; its launcher is loaded on the first call that needs it.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Box, BoxError, BoxFile, BoxProvider, BoxSpec } from "@parcha/pi-transport";
import type { Launch, LaunchError, LaunchSpec, LaunchState } from "@parcha/pi-transport/launch";
import type { RunRef } from "./claim.ts";
import { PdaError } from "./errors.ts";
import { attemptEnv, keyShaped } from "./hosts/attempt-env.ts";
import { TERMINAL_EXITS } from "./hosts/local-host.ts";
import type { HostBox, HostDriver, HostHandle, HostStatus, StartAttempt } from "./supervise.ts";

/** Where the run's directory is in every box: the CLI's `--dir`. */
export const BOX_RUN_DIR = "/run/agentrun/run";
/** The label that names a box's run (its id), and the one that names the attempt that made it. boxHost's only labels. */
export const BOX_RUN_LABEL = "pi-durable-disk.run";
export const BOX_ATTEMPT_LABEL = "pi-durable-disk.attempt";

export type BoxHostErrorCode = "INVALID_ARGUMENT" | "UNSUPPORTED" | "SUPERSEDED" | "CREATE_FAILED" | "UPLOAD_FAILED" | "LAUNCH_FAILED" | "START_TIMED_OUT" | "STOP_FAILED";

/** A boxHost call that failed. The provider's or the launcher's own error is its `cause`. */
export class BoxHostError extends PdaError {
  declare readonly code: BoxHostErrorCode;
  constructor(code: BoxHostErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

/** The start a `spec`, `files` or `secrets` function is asked for. */
export type BoxStart = { readonly run: string; readonly attempt: number };

/** A value, or a function of the start that gives it. */
export type PerStart<T> = T | ((start: BoxStart) => T | Promise<T>);

export interface BoxHostOptions {
  /** Where boxes come from. Its `name` is every handle's and receipt's `provider`. */
  provider: BoxProvider;
  /**
   * The box a start creates, as the caller wants it (image, env, network, labels): asked once per create, and used as
   * given with BOX_RUN_LABEL and BOX_ATTEMPT_LABEL added. A positive `maxLifetimeMs` bounds a leaked box. Refused: a label
   * key of pi-transport's (`pi-transport`, `pi-transport.*`) or of this package's (`pi-durable-disk.*`), and an `env` name
   * that says it holds a key (a provider may store and return `env`: a secret goes in `secrets`). `env` is the box's,
   * for what the provider runs: the launcher starts the instance with none of it (below).
   */
  spec: PerStart<BoxSpec>;
  /** The app module the instance runs (`--app`), as a path inside the box: in the image, or among `files`. */
  app: string;
  /** Files uploaded into the box before each launch (never into a box adopted). Never a secret: they rest in the box. */
  files?: PerStart<readonly BoxFile[]>;
  /** How this package's CLI is run in the box. Default `["pi-durable-disk"]`, found on the launcher's PATH. */
  command?: readonly string[];
  /**
   * More flags for the CLI's `run`, after the ones boxHost sets (`--dir`, `--id`, `--app`, `--serve 0`). They may not repeat
   * those, nor name `--serve-host`: the door stays on the CLI's default, the box's own loopback.
   */
  runArgs?: readonly string[];
  /**
   * Who the instance runs as in the box (the launcher's `user`, a name or a uid). Default: the launcher's own user. With
   * secrets, the launcher runs a program as root only beside a tools user, which this driver never names: give a user
   * that is not root.
   */
  user?: string;
  /**
   * The instance's plain settings, under each start's own (`StartAttempt.env`). The launcher clears everything else: the
   * instance's environment is these, PDA_HOLDER (the handle) and the launcher's PATH, HOME and LANG. Never a secret: the
   * launcher refuses a name that says it holds a key.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * What the run needs that is secret, by name: on the launch frame and nowhere else, read by the instance from fd 3. Asked
   * once per launch, never for a box adopted; none (undefined or empty) means a launch with no frame.
   */
  secrets?: PerStart<Readonly<Record<string, string>> | undefined>;
  /** From the start until the launcher says the instance runs. Default 300 s. */
  startTimeoutMs?: number;
  /** How long a planned stop lets the instance drain before the launcher kills it. Default 30 s. */
  stopGraceMs?: number;
  /** How long one status, stop or kill may take over the provider. Default 60 s. */
  callTimeoutMs?: number;
}

type Launcher = typeof import("@parcha/pi-transport/launch");
type Handle = HostHandle & { box: string; run: string; attempt: number; launch: { v: 1; name: string } };

/**
 * The flags boxHost sets, `--serve-host` (the door stays on the CLI's default, the box's own loopback), and the ones a run
 * on a disk takes: `runArgs` names none of them.
 */
const OWN_FLAGS = new Set(["--dir", "--id", "--app", "--serve", "--serve-host", "--disk", "--region", "--mount-root", "--archil", "--token-stdin"]);
/** A launch whose phase is one of these is alive: a start adopts it. */
const LIVE: ReadonlySet<string> = new Set(["starting", "running", "restarting"]);

const launchName = (attempt: number) => `pdd-run-a${attempt}`;
/** The secrets a launch carries: none when there are no names, so an empty set never makes a frame. */
const framedOf = (secrets: Readonly<Record<string, string>> | undefined) => (secrets !== undefined && Object.keys(secrets).length > 0 ? secrets : undefined);
const resolved = <T>(value: PerStart<T>, start: BoxStart): Promise<T> =>
  Promise.resolve(typeof value === "function" ? (value as (start: BoxStart) => T | Promise<T>)(start) : value);

/**
 * A host driver over `options.provider`'s boxes, each running one attempt of one run on BOX_RUN_DIR. `kills` is `box`: a
 * kill destroys the box at once. `start(ref, mountToken, attempt)` takes the run's id from `ref.id` and no mount token.
 */
export function boxHost(options: BoxHostOptions): HostDriver & Required<Pick<HostDriver, "kill" | "kills" | "box" | "provider" | "instanceOf">> {
  const { provider } = options;
  const invalid = (message: string) => new BoxHostError("INVALID_ARGUMENT", message);
  if (!provider || typeof provider.create !== "function" || typeof provider.attach !== "function" || typeof provider.list !== "function" || typeof provider.name !== "string" || provider.name === "") {
    throw invalid("provider is not a pi-transport BoxProvider with a name");
  }
  if (typeof options.spec !== "function") checkSpec(options.spec);
  if (typeof options.app !== "string" || options.app === "") throw invalid("app is the module the instance runs, a path inside the box");
  const command = options.command ?? ["pi-durable-disk"];
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part === "")) throw invalid("command is a non-empty list of non-empty strings");
  if (options.env && Object.hasOwn(options.env, "PDA_HOLDER")) throw invalid("env names PDA_HOLDER, which is the driver's: the handle");
  const runArgs = options.runArgs ?? [];
  for (const arg of runArgs) {
    if (typeof arg !== "string") throw invalid("runArgs is a list of strings");
    const flag = arg.split("=")[0]!;
    if (OWN_FLAGS.has(flag)) throw invalid(`runArgs names ${flag}, which boxHost sets or a run on a plain directory refuses`);
  }
  const startTimeoutMs = options.startTimeoutMs ?? 300_000;
  const stopGraceMs = options.stopGraceMs ?? 30_000;
  const callTimeoutMs = options.callTimeoutMs ?? 60_000;

  function checkSpec(spec: BoxSpec): void {
    if (!spec || typeof spec !== "object") throw invalid("spec is a pi-transport BoxSpec");
    if (!(Number.isFinite(spec.maxLifetimeMs) && spec.maxLifetimeMs > 0)) throw invalid("spec.maxLifetimeMs is required: a positive number of milliseconds bounds a leaked box");
    for (const key of Object.keys(spec.labels ?? {})) {
      if (key === "pi-transport" || key.startsWith("pi-transport.") || key.startsWith("pi-durable-disk.")) throw invalid(`spec.labels has ${key}, a key that is the provider's or boxHost's own`);
    }
    for (const name of Object.keys(spec.env ?? {})) {
      if (keyShaped(name)) throw invalid(`spec.env has ${name}, a name that says it holds a key: a provider may store the box's env, so a secret goes in secrets`);
    }
  }

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
  /** Whether the box is gone: only then is its receipt ended. */
  const destroy = async (box: Box, context: Context): Promise<boolean> => {
    const r = await box.destroy(context).catch((error: unknown) => ({ ok: false as const, error }));
    if (!r.ok) return false;
    ended(box.id);
    return true;
  };
  const boxError = (what: string, error: BoxError, code: BoxHostErrorCode = "CREATE_FAILED") => new BoxHostError(code, `${what}: ${error.code}: ${error.message}`, { cause: error });

  /** One run's starts, stops and kills, one at a time: two of them never decide on the same boxes at once. */
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(run: string, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(run) ?? Promise.resolve()).catch(() => undefined).then(work);
    queues.set(run, next);
    const clear = () => void (queues.get(run) === next && queues.delete(run));
    next.then(clear, clear);
    return next;
  };

  const handleOf = (box: Box, run: string, attempt: number): Handle => ({ driver: "box", provider: provider.name, box: box.id, run, attempt, launch: { v: 1, name: launchName(attempt) } });
  const mine = (h: HostHandle): h is Handle =>
    h.driver === "box" && h.provider === provider.name && typeof h.box === "string" && typeof h.run === "string" && typeof h.attempt === "number" && typeof (h.launch as { name?: unknown } | null)?.name === "string";
  const launchOf = (h: Handle): Launch => ({ v: 1, name: h.launch.name });

  /**
   * Every live box of the run, by its labels: an older attempt's is destroyed (a failed end makes nothing), a newer
   * attempt's refuses the start. Returns this attempt's boxes, each with what its launch says. A box whose labels are not
   * exactly the run's (a list that returned another run's) is left alone.
   */
  const sweep = async (run: string, attempt: number, context: Context, l: Launcher): Promise<{ box: Box; state: LaunchState | undefined }[]> => {
    const listed = await provider.list({ [BOX_RUN_LABEL]: run }, context);
    if (!listed.ok) throw boxError(`listing ${provider.name}'s boxes of run ${run}`, listed.error);
    const mineNow: { box: Box; state: LaunchState | undefined }[] = [];
    for (const ref of listed.value) {
      if (ref.labels[BOX_RUN_LABEL] !== run) continue;
      const label = ref.labels[BOX_ATTEMPT_LABEL] ?? "";
      if (!/^[1-9][0-9]{0,9}$/.test(label)) continue;
      const theirs = Number(label);
      if (theirs > attempt) throw new BoxHostError("SUPERSEDED", `run ${run} has a box of attempt ${theirs} (${provider.name} box ${ref.id}): a start of attempt ${attempt} makes and ends nothing`);
      const attached = await provider.attach(ref.id, context);
      if (!attached.ok) throw boxError(`attaching ${provider.name} box ${ref.id} of run ${run}`, attached.error);
      if (!attached.value) continue;
      if (theirs < attempt) {
        if (!(await destroy(attached.value, context))) throw new BoxHostError("STOP_FAILED", `ending ${provider.name} box ${ref.id} of run ${run}'s attempt ${theirs} failed: attempt ${attempt} makes nothing while it may still run`);
        continue;
      }
      const state = await l.launchState(attached.value, { v: 1, name: launchName(attempt) }, context);
      // A read that failed is not "never launched": nothing more is changed, and the next start asks again.
      if (!state.ok) throw new BoxHostError("CREATE_FAILED", `reading the launch in ${provider.name} box ${ref.id} failed (${state.error.code}): ${state.error.message}; the next start asks again`, { cause: state.error });
      mineNow.push({ box: attached.value, state: state.value });
    }
    return mineNow;
  };

  async function startRun(ref: RunRef, attempt: StartAttempt, extra: Record<string, string>, l: Launcher): Promise<HostHandle> {
    const n = attempt.attempt;
    const run = ref.id;
    const begun: BoxStart = { run, attempt: n };
    const name = launchName(n);
    const labels = { [BOX_RUN_LABEL]: run, [BOX_ATTEMPT_LABEL]: String(n) };
    const context = bounded(startTimeoutMs);
    const timedOut = () => new BoxHostError("START_TIMED_OUT", `starting run ${run} attempt ${n} in a ${provider.name} box took over ${startTimeoutMs} ms`);
    const argv = [...command, "run", "--dir", BOX_RUN_DIR, "--id", run, "--app", options.app, "--serve", "0", ...runArgs];
    const specFor = (handle: Handle, secrets: Readonly<Record<string, string>> | undefined): LaunchSpec => ({
      argv,
      env: { ...options.env, ...extra, PDA_HOLDER: JSON.stringify(handle) },
      inheritEnv: false,
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(secrets === undefined ? {} : { secrets }),
      restart: true,
      restartDelayMs: 1_000,
      terminalExits: [...TERMINAL_EXITS],
    });
    // The launcher's own check of the spec, before any call to the provider: a spec it refuses never boots a box. It judges
    // the secrets this launch would carry, empty meaning none: given as an object, they are known now; a function's are
    // judged again once asked (below), which happens only for a launch, never for a box adopted.
    const placeholder = { driver: "box", provider: provider.name, box: "-", run, attempt: n, launch: { v: 1, name } } satisfies Handle;
    const check = (secrets: Readonly<Record<string, string>> | undefined) => {
      const refused = l.launchSpecError(name, specFor(placeholder, secrets));
      if (refused) throw new BoxHostError("INVALID_ARGUMENT", `the launcher refuses this start: ${refused.message}`, { cause: refused });
    };
    check(typeof options.secrets === "function" ? undefined : framedOf(options.secrets));
    /** The box is ended (or said not to be), and the start fails with `error`. */
    const fail = async (box: Box, error: BoxHostError): Promise<never> => {
      if (await destroy(box, bounded(callTimeoutMs))) throw error;
      throw new BoxHostError(error.code, `${error.message}; ending ${provider.name} box ${box.id} failed too (the next start of the run ends it, or its maxLifetimeMs does)`, { cause: error.cause });
    };

    // This attempt's box, found again: adopted while its launch lives, used while it never launched, replaced once its
    // launch ended or was lost (its launcher, and the secrets it held, are gone). Any other box of this attempt is ended.
    const found = await sweep(run, n, context, l);
    const live = found.find((f) => f.state !== undefined && LIVE.has(f.state.phase));
    const kept = live ?? found.find((f) => f.state === undefined);
    for (const other of found) {
      if (other === kept || (await destroy(other.box, context))) continue;
      throw new BoxHostError("STOP_FAILED", `ending ${provider.name} box ${other.box.id} of run ${run}'s attempt ${n} (its launch ${other.state?.phase ?? "never started"}) failed: nothing is made while it may still run`);
    }
    if (live) {
      remember(live.box);
      return { ...handleOf(live.box, run, n), adopted: true };
    }
    // What the launch carries is asked for now, before any box is made: a function that fails leaves no box behind.
    const framed = framedOf(await resolved(options.secrets, begun));
    check(framed);
    const files = await resolved(options.files ?? [], begun);
    let box: Box | undefined = kept?.box;
    if (!box) {
      const spec = await resolved(options.spec, begun);
      checkSpec(spec);
      const created = await provider.create({ ...spec, labels: { ...spec.labels, ...labels } }, context);
      if (created.ok) box = created.value;
      else {
        // A create that failed after the machine existed: found by its labels and used, never leaked.
        const again = created.error.code === "unknown" || created.error.code === "timeout" ? await sweep(run, n, context, l).catch(() => []) : [];
        for (const f of again) {
          if (!box && f.state === undefined) box = f.box;
          else await destroy(f.box, bounded(callTimeoutMs));
        }
        if (!box) {
          if (created.error.code === "invalid") throw boxError(`${provider.name} refused the spec`, created.error, "INVALID_ARGUMENT");
          if (created.error.code === "unsupported") throw boxError(`${provider.name} cannot make this box`, created.error, "UNSUPPORTED");
          if (created.error.code === "aborted" || context.abortSignal?.aborted) throw timedOut();
          throw boxError(`creating a ${provider.name} box`, created.error);
        }
      }
    }
    remember(box);

    const facts = box.facts();
    if (facts.liveProcesses === false) return fail(box, new BoxHostError("UNSUPPORTED", `the ${provider.name} box keeps no program running (liveProcesses: false)`));
    // Only a start with secrets needs the fd: they ride the launch frame, never an env or an argv.
    if (framed && facts.secretsVia !== "fd") {
      return fail(box, new BoxHostError("UNSUPPORTED", `the ${provider.name} box has no fd for the launch frame (secretsVia is ${String(facts.secretsVia)}, not "fd"), and this start has secrets`));
    }
    if (files.length > 0) {
      const uploaded = await box.upload(files, context);
      if (!uploaded.ok) return fail(box, context.abortSignal?.aborted ? timedOut() : boxError(`uploading files into ${provider.name} box ${box.id}`, uploaded.error, "UPLOAD_FAILED"));
    }

    const handle = handleOf(box, run, n);
    const launched = await l.launch(box, name, specFor(handle, framed), context);
    if (!launched.ok) {
      const e: LaunchError = launched.error;
      // unsupported, refused, unsafe: the box kind, the image or its layout; a new box of the same spec would repeat it.
      if (e.code === "unsupported" || e.code === "refused" || e.code === "unsafe") return fail(box, new BoxHostError("UNSUPPORTED", `the ${provider.name} box cannot run the instance as asked (${e.code}): ${e.message}`, { cause: e }));
      if (e.code === "invalid") return fail(box, new BoxHostError("INVALID_ARGUMENT", `the launch was refused: ${e.message}`, { cause: e }));
      if (e.code === "timeout" || context.abortSignal?.aborted) return fail(box, new BoxHostError("START_TIMED_OUT", `the instance did not start in ${provider.name} box ${box.id}: ${e.message}`, { cause: e }));
      return fail(box, new BoxHostError("LAUNCH_FAILED", `launching the instance in ${provider.name} box ${box.id} failed (${e.code}): ${e.message}`, { cause: e }));
    }
    // launch() answers once the phase leaves `starting`. An instance the launcher could not run at all (exit 126: the user
    // switch, the env clear or the directory), or one already ended, is a failed start; an ordinary early crash is the
    // launcher's to restart.
    const state = launched.value;
    if (state.lastExit === 126 || !LIVE.has(state.phase)) {
      return fail(
        box,
        new BoxHostError(
          "LAUNCH_FAILED",
          state.lastExit === 126
            ? `the launcher could not run the instance in ${provider.name} box ${box.id} (exit 126: as its user, with its environment or in its directory)`
            : `the instance ended at once in ${provider.name} box ${box.id} (${state.phase}${state.lastExit === undefined ? "" : `, exit ${state.lastExit}`})`,
        ),
      );
    }
    return handle;
  }

  return {
    provider: provider.name,
    kills: "box",
    // A box is named by its provider and its id, the same in a fresh handle and an adopted one.
    instanceOf: (h: HostHandle) => (mine(h) ? `box\0${provider.name}\0${h.box}` : undefined),

    async start(ref: RunRef, mountToken: string, attempt?: StartAttempt): Promise<HostHandle> {
      if (mountToken) throw invalid("a run on a plain directory takes no mount token: boxHost is no host for a run on a disk");
      if (!ref || typeof ref.id !== "string" || ref.id === "" || ref.id.includes("\0")) throw invalid("a start needs the run's id (ref.id)");
      if (!attempt || !Number.isInteger(attempt.attempt) || attempt.attempt < 1) throw invalid("a start needs its attempt: boxHost finds the box an attempt made by it");
      const extra = attemptEnv(attempt, (m) => new BoxHostError("INVALID_ARGUMENT", m));
      const l = await load();
      return serial(ref.id, () => startRun(ref, attempt, extra, l));
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
          // gave_up, and lost: its launcher is gone with the secrets it held, so nothing here starts it again.
          return "failed";
      }
    },

    async stop(h: HostHandle): Promise<void> {
      if (!mine(h)) return;
      return serial(h.run, async () => {
        const context = bounded(callTimeoutMs + stopGraceMs);
        const attached = await provider.attach(h.box, context);
        if (!attached.ok) throw boxError(`attaching ${provider.name} box ${h.box} to stop it`, attached.error, "STOP_FAILED");
        if (!attached.value) return void ended(h.box);
        const l = await load().catch(() => undefined);
        // The drain (SIGTERM: the instance releases the run), then the kill; a launch that cannot be stopped ends with its box anyway.
        if (l) await l.launchStop(attached.value, launchOf(h), { graceMs: stopGraceMs }, context).catch(() => undefined);
        const destroyed = await attached.value.destroy(context);
        if (!destroyed.ok) throw boxError(`destroying ${provider.name} box ${h.box}`, destroyed.error, "STOP_FAILED");
        ended(h.box);
      });
    },

    async kill(h: HostHandle): Promise<void> {
      if (!mine(h)) return;
      return serial(h.run, async () => {
        const context = bounded(callTimeoutMs);
        const attached = await provider.attach(h.box, context);
        if (!attached.ok) throw boxError(`attaching ${provider.name} box ${h.box} to kill it`, attached.error, "STOP_FAILED");
        if (!attached.value) return void ended(h.box);
        const destroyed = await attached.value.destroy(context);
        if (!destroyed.ok) throw boxError(`destroying ${provider.name} box ${h.box}`, destroyed.error, "STOP_FAILED");
        ended(h.box);
      });
    },

    box(h: HostHandle): HostBox | null {
      if (!mine(h)) return null;
      const r = receipts.get(h.box);
      return r ? { provider: provider.name, kind: r.kind, from: r.from, to: r.to } : null;
    },
  };
}

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { Harness, HarnessOptions, Registry } from "@earendil-works/pi-durable";
import { err, ok, type Result, toError } from "@earendil-works/pi-durable/env";
import type { BoxProvider } from "../box/box.ts";

/** What an app may know about the place it runs in. The same module runs on the host and in a box. */
export type AppContext = {
	readonly session: string;
	/** The session's files on this machine. The only absolute path an app may build on. */
	readonly workspace: string;
	/** The session's store on this machine. */
	readonly store: string;
	/** The models the Harness gets, for what the app itself builds. In a box they hold no credential. */
	readonly models: HarnessOptions["models"];
	/** Which environment of the config this home is, and its provider. */
	readonly where: { readonly environment: string; readonly provider: string };
	/** The session's directory on this machine: the parent of `workspace`. */
	readonly root: string;
	/** The epoch of the lease this home opens at: a restart in the same place keeps it, a restore raises it. */
	readonly epoch: number;
	/**
	 * The session's environment for this process, from the host's resume order (`ResumeOrder.env`): a box inherits none
	 * of the host's, and it never travels in argv. Empty when the host gave none. Not copied into `process.env`.
	 */
	readonly env: Readonly<Record<string, string>>;
	/**
	 * The host's box providers, by the name the session's config names them, for `TransportHost.providers`: every box a
	 * handle to one the host made and holds, named by its label. No credential is here. Empty when the host serves none.
	 */
	readonly boxes: Readonly<Record<string, BoxProvider>>;
};

/**
 * What an app returns: pi's Harness options without `env` and `models`, which the runner adds the same way wherever
 * the session runs. The registry is the app's own, and the runner installs the transport's extension into it.
 */
export type AppOptions = Omit<HarnessOptions, "env" | "models" | "registry"> & {
	readonly registry: Registry;
	/** pi's `root()` options: how the root conversation is made when the session is new. */
	readonly root?: Parameters<Harness["root"]>[1];
	/** Called at each open, once the Harness is open and before it resumes. The order that opened it waits for it. */
	readonly onOpen?: (harness: Harness, context: Context) => void | Promise<void>;
	/**
	 * Called at each open once the session has resumed, and not awaited by the order that opened it: the work an app
	 * drives for its session (a job) runs here, for as long as it takes. A rejection is written to the error output.
	 */
	readonly onResumed?: (harness: Harness, context: Context) => void | Promise<void>;
};

/** An app: the default export of the module a home runs. */
export type App = (ctx: AppContext) => AppOptions | Promise<AppOptions>;

/** The app module is missing, does not load, has no default export function, threw, or returned no registry. */
export class AppError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AppError";
	}
}

/** The app a module file exports by default. */
export async function loadApp(path: string): Promise<Result<App, AppError>> {
	let loaded: { default?: unknown };
	try {
		loaded = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown };
	} catch (cause) {
		return err(new AppError(`cannot load the app module ${path}: ${toError(cause).message}`, cause));
	}
	if (typeof loaded.default !== "function") {
		return err(new AppError(`the app module ${path} has no default export function`));
	}
	return ok(loaded.default as App);
}

/** Call the app for its options. A throw and a result with no registry are both an `AppError`. */
export async function appOptions(app: App, ctx: AppContext): Promise<Result<AppOptions, AppError>> {
	let options: AppOptions;
	try {
		options = await app(ctx);
	} catch (cause) {
		return err(new AppError(`the app threw: ${toError(cause).message}`, cause));
	}
	if (typeof options !== "object" || options === null || typeof options.registry?.install !== "function") {
		return err(new AppError("the app returned no registry: its options need one made with createRegistry()"));
	}
	return ok(options);
}

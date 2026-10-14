import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const DURATION_UNITS_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DEFAULT_LOCAL_LIFETIME_MS = 24 * 3_600_000;
const ENVIRONMENT_ID = /^[a-z][a-z0-9_-]{0,63}$/;
/** Words with a meaning of their own in `home` and `hands`, so no environment may take them as its id. */
const RESERVED_IDS: readonly string[] = ["auto", "default"];

const EnvironmentSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		image: Type.Optional(Type.String({ minLength: 1 })),
		snapshot: Type.Optional(Type.String({ minLength: 1 })),
		cpus: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		memoryMb: Type.Optional(Type.Integer({ minimum: 1 })),
		gpu: Type.Optional(Type.String({ minLength: 1 })),
		region: Type.Optional(Type.String({ minLength: 1 })),
		isolation: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("container"), Type.Literal("gvisor"), Type.Literal("vm")]),
		),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		expose: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		maxLifetime: Type.Optional(Type.String()),
		scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("conversation")])),
		capabilities: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		purpose: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

/** The `transport` block of an agent's config, as its author writes it. Unknown keys fail at every level. */
export const TransportConfigSchema = Type.Object(
	{
		environments: Type.Record(Type.String(), EnvironmentSchema),
		home: Type.Optional(Type.String({ minLength: 1 })),
		hands: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Record(Type.String(), Type.String())])),
		auto: Type.Optional(
			Type.Object(
				{
					classifier: Type.Object(
						{ provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) },
						{ additionalProperties: false },
					),
					ask: Type.Optional(Type.Union([Type.Literal("message"), Type.Literal("turn")])),
					rest: Type.Optional(Type.String({ minLength: 1 })),
					threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
				},
				{ additionalProperties: false },
			),
		),
		workspace: Type.Optional(
			Type.Object(
				{
					path: Type.Optional(Type.String({ pattern: "^/" })),
					exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
					maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type TransportConfigInput = Static<typeof TransportConfigSchema>;

/** One declared environment, checked and with its lifetime in milliseconds. */
export type EnvironmentConfig = {
	readonly id: string;
	readonly provider: string;
	readonly image?: string;
	readonly snapshot?: string;
	readonly cpus?: number;
	readonly memoryMb?: number;
	readonly gpu?: string;
	readonly region?: string;
	/** The separation the environment's boxes must have; a provider that cannot give it refuses to create one. */
	readonly isolation?: "none" | "container" | "gvisor" | "vm";
	/** Plain settings for programs in the box. */
	readonly env: Readonly<Record<string, string>>;
	/** Names of host secrets the author lets into this environment's boxes. Empty unless the author wrote them. */
	readonly expose: readonly string[];
	readonly maxLifetimeMs: number;
	/** `session`: one box for the whole session. `conversation`: one box for each conversation. */
	readonly scope: "session" | "conversation";
	readonly capabilities: readonly string[];
	/** One line, the author's: what the environment is for. What the placer shows Jev for it. */
	readonly purpose?: string;
};

/** A checked `transport` block: every reference names a declared environment. */
export type TransportConfig = {
	readonly environments: Readonly<Record<string, EnvironmentConfig>>;
	/** Where the session lives: an environment id or `auto`. `undefined` leaves it with the host. */
	readonly home?: string;
	/**
	 * Where tools run: `default` and each role name an environment id or `auto`. `undefined` leaves tools with the
	 * host's own environment.
	 */
	readonly hands?: { readonly default: string; readonly roles: Readonly<Record<string, string>> };
	readonly auto?: {
		readonly classifier: { readonly provider: string; readonly modelId: string };
		readonly ask: "message" | "turn";
		/** Where a session goes back to when nothing needs it elsewhere. Default: the first declared environment. */
		readonly rest: string;
		/** How sure Jev must be that a step needs another environment before the session moves. Default 0.5. */
		readonly threshold: number;
	};
	/** `path` is where every environment keeps the workspace; `undefined` leaves it to each provider's own default. */
	readonly workspace: { readonly path?: string; readonly exclude: readonly string[]; readonly maxBytes?: number };
};

/**
 * One thing wrong with a config. `path` is a JSON pointer (RFC 6901) into the block, with `~` and `/` inside a key
 * escaped; the empty string is the block itself.
 */
export type ConfigIssue = { readonly path: string; readonly message: string };

/** A config that cannot be used. `issues` lists everything wrong with it, not the first problem only. */
export class ConfigError extends Error {
	public issues: readonly ConfigIssue[];

	constructor(issues: readonly ConfigIssue[]) {
		super(`invalid transport config: ${issues.map((issue) => `${issue.path || "/"}: ${issue.message}`).join("; ")}`);
		this.name = "ConfigError";
		this.issues = issues;
	}
}

/** Milliseconds of a duration written as a whole number and a unit: `500ms`, `90s`, `30m`, `6h`, `2d`. */
export function parseDuration(text: string): number | undefined {
	const match = /^(\d+)(ms|s|m|h|d)$/.exec(text);
	if (match === null) return undefined;
	const ms = Number(match[1]) * (DURATION_UNITS_MS[match[2]!] ?? Number.NaN);
	return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON pointer (RFC 6901) to the value under these keys: `~` and `/` inside a key are escaped. */
function pointer(...keys: readonly string[]): string {
	return keys.map((key) => `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

function shapeIssues(input: unknown): ConfigIssue[] {
	const issues: ConfigIssue[] = [];
	for (const error of Value.Errors(TransportConfigSchema, input)) {
		// A union reports each branch it tried; the `anyOf` error at the same place says it once.
		if (error.schemaPath.includes("/anyOf/") || error.keyword === "boolean") continue;
		const unknown = (error.params as { additionalProperties?: readonly string[] }).additionalProperties;
		if (error.keyword === "additionalProperties" && unknown !== undefined) {
			for (const key of unknown)
				issues.push({ path: `${error.instancePath}${pointer(key)}`, message: "unknown key" });
		} else if (error.keyword === "anyOf") {
			issues.push({ path: error.instancePath, message: "has no allowed value or shape" });
		} else {
			issues.push({ path: error.instancePath, message: error.message });
		}
	}
	return issues;
}

/**
 * What is wrong with the block beyond its shape: ids, lifetimes, references. It reads the block as it is, well shaped
 * or not, so one pass over a config reports its misspelled keys and its bad references together.
 */
function meaningIssues(input: unknown): ConfigIssue[] {
	if (!isRecord(input)) return [];
	const issues: ConfigIssue[] = [];
	const environments = isRecord(input.environments) ? input.environments : undefined;

	for (const [id, environment] of Object.entries(environments ?? {})) {
		const at = pointer("environments", id);
		if (!ENVIRONMENT_ID.test(id)) issues.push({ path: at, message: "an id is lowercase letters, digits, _ and -" });
		if (RESERVED_IDS.includes(id)) issues.push({ path: at, message: `"${id}" is reserved` });
		if (!isRecord(environment)) continue;
		if (environment.image !== undefined && environment.snapshot !== undefined) {
			issues.push({ path: at, message: "names both an image and a snapshot" });
		}
		if (typeof environment.maxLifetime === "string") {
			if (parseDuration(environment.maxLifetime) === undefined) {
				issues.push({ path: `${at}/maxLifetime`, message: "is not a duration such as 30m or 6h" });
			}
		} else if (environment.maxLifetime === undefined && environment.provider !== "local") {
			issues.push({ path: `${at}/maxLifetime`, message: "is required for every provider but local" });
		}
	}

	const usesAuto: string[] = [];
	const checkTarget = (path: string, target: unknown) => {
		if (typeof target !== "string" || environments === undefined) return;
		if (target === "auto") usesAuto.push(path);
		else if (!Object.hasOwn(environments, target)) {
			issues.push({ path, message: `names "${target}", which is not a declared environment` });
		}
	};
	checkTarget("/home", input.home);
	if (isRecord(input.hands)) {
		if (input.hands.default === undefined) {
			issues.push({ path: "/hands/default", message: "is required when hands names roles" });
		}
		for (const [role, target] of Object.entries(input.hands)) checkTarget(pointer("hands", role), target);
	} else {
		checkTarget("/hands", input.hands);
	}
	if (input.auto === undefined) {
		for (const path of usesAuto) issues.push({ path, message: "is auto, which needs auto.classifier" });
	} else if (isRecord(input.auto) && environments !== undefined) {
		checkTarget("/auto/rest", input.auto.rest);
		if (input.auto.rest === "auto") issues.push({ path: "/auto/rest", message: "names an environment, never auto" });
		// What Jev reads for each environment it may choose: the author's own line, never one made up from facts.
		if (usesAuto.length > 0) {
			for (const [id, environment] of Object.entries(environments)) {
				if (isRecord(environment) && environment.purpose === undefined) {
					issues.push({
						path: pointer("environments", id, "purpose"),
						message: "is required when auto places the session: it is the line Jev reads for this environment",
					});
				}
			}
		}
	}
	return issues;
}

/**
 * Check a `transport` block and resolve its defaults. Every problem is reported at once. Structure only: whether a
 * provider exists, a secret resolves or a box can be created is the host's to find when it opens the transport.
 */
export function parseTransportConfig(input: unknown): Result<TransportConfig, ConfigError> {
	const issues = [...shapeIssues(input), ...meaningIssues(input)];
	if (issues.length > 0) return err(new ConfigError(issues));
	const raw = input as TransportConfigInput;
	const environments: Record<string, EnvironmentConfig> = {};

	for (const [id, environment] of Object.entries(raw.environments)) {
		const { maxLifetime, ...rest } = environment;
		environments[id] = {
			...rest,
			id,
			env: environment.env ?? {},
			expose: environment.expose ?? [],
			maxLifetimeMs:
				(maxLifetime === undefined ? undefined : parseDuration(maxLifetime)) ?? DEFAULT_LOCAL_LIFETIME_MS,
			scope: environment.scope ?? "session",
			capabilities: environment.capabilities ?? [],
		};
	}

	let hands: TransportConfig["hands"];
	if (typeof raw.hands === "string") {
		hands = { default: raw.hands, roles: {} };
	} else if (raw.hands !== undefined) {
		const { default: fallback, ...roles } = raw.hands;
		hands = { default: fallback ?? "", roles };
	}

	return ok({
		environments,
		...(raw.home === undefined ? {} : { home: raw.home }),
		...(hands === undefined ? {} : { hands }),
		...(raw.auto === undefined
			? {}
			: {
					auto: {
						classifier: raw.auto.classifier,
						ask: raw.auto.ask ?? "message",
						rest: raw.auto.rest ?? Object.keys(raw.environments)[0] ?? "",
						threshold: raw.auto.threshold ?? 0.5,
					},
				}),
		workspace: {
			...(raw.workspace?.path === undefined ? {} : { path: raw.workspace.path }),
			exclude: raw.workspace?.exclude ?? [],
			...(raw.workspace?.maxBytes === undefined ? {} : { maxBytes: raw.workspace.maxBytes }),
		},
	});
}

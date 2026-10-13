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
	};
	/** `path` is where every environment keeps the workspace; `undefined` leaves it to each provider's own default. */
	readonly workspace: { readonly path?: string; readonly exclude: readonly string[]; readonly maxBytes?: number };
};

/** One thing wrong with a config. `path` is a JSON pointer into the block; the empty string is the block itself. */
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

function shapeIssues(input: unknown): ConfigIssue[] {
	const issues: ConfigIssue[] = [];
	for (const error of Value.Errors(TransportConfigSchema, input)) {
		// A union reports each branch it tried; the `anyOf` error at the same place says it once.
		if (error.schemaPath.includes("/anyOf/") || error.keyword === "boolean") continue;
		const unknown = (error.params as { additionalProperties?: readonly string[] }).additionalProperties;
		if (error.keyword === "additionalProperties" && unknown !== undefined) {
			for (const key of unknown) issues.push({ path: `${error.instancePath}/${key}`, message: "unknown key" });
		} else if (error.keyword === "anyOf") {
			issues.push({ path: error.instancePath, message: "has no allowed value or shape" });
		} else {
			issues.push({ path: error.instancePath, message: error.message });
		}
	}
	return issues;
}

/**
 * Check a `transport` block and resolve its defaults. Structure only: whether a provider exists, a secret resolves
 * or a box can be created is the host's to find when it opens the transport.
 */
export function parseTransportConfig(input: unknown): Result<TransportConfig, ConfigError> {
	const shape = shapeIssues(input);
	if (shape.length > 0) return err(new ConfigError(shape));
	const raw = input as TransportConfigInput;
	const issues: ConfigIssue[] = [];
	const environments: Record<string, EnvironmentConfig> = {};

	for (const [id, environment] of Object.entries(raw.environments)) {
		const at = `/environments/${id}`;
		if (!ENVIRONMENT_ID.test(id)) issues.push({ path: at, message: "an id is lowercase letters, digits, _ and -" });
		if (RESERVED_IDS.includes(id)) issues.push({ path: at, message: `"${id}" is reserved` });
		if (environment.image !== undefined && environment.snapshot !== undefined) {
			issues.push({ path: at, message: "names both an image and a snapshot" });
		}
		let maxLifetimeMs = environment.provider === "local" ? DEFAULT_LOCAL_LIFETIME_MS : undefined;
		if (environment.maxLifetime !== undefined) {
			maxLifetimeMs = parseDuration(environment.maxLifetime);
			if (maxLifetimeMs === undefined) {
				issues.push({ path: `${at}/maxLifetime`, message: "is not a duration such as 30m or 6h" });
			}
		} else if (maxLifetimeMs === undefined) {
			issues.push({ path: `${at}/maxLifetime`, message: "is required for every provider but local" });
		}
		const { maxLifetime: _maxLifetime, ...rest } = environment;
		environments[id] = {
			...rest,
			id,
			env: environment.env ?? {},
			expose: environment.expose ?? [],
			maxLifetimeMs: maxLifetimeMs ?? 0,
			scope: environment.scope ?? "session",
			capabilities: environment.capabilities ?? [],
		};
	}

	const usesAuto: string[] = [];
	const checkTarget = (path: string, target: string) => {
		if (target === "auto") usesAuto.push(path);
		else if (!Object.hasOwn(environments, target)) {
			issues.push({ path, message: `names "${target}", which is not a declared environment` });
		}
	};
	if (raw.home !== undefined) checkTarget("/home", raw.home);

	let hands: TransportConfig["hands"];
	if (typeof raw.hands === "string") {
		checkTarget("/hands", raw.hands);
		hands = { default: raw.hands, roles: {} };
	} else if (raw.hands !== undefined) {
		const { default: fallback, ...roles } = raw.hands;
		if (fallback === undefined)
			issues.push({ path: "/hands/default", message: "is required when hands names roles" });
		else checkTarget("/hands/default", fallback);
		for (const [role, target] of Object.entries(roles)) checkTarget(`/hands/${role}`, target);
		hands = { default: fallback ?? "", roles };
	}
	if (raw.auto === undefined) {
		for (const path of usesAuto) issues.push({ path, message: "is auto, which needs auto.classifier" });
	}

	if (issues.length > 0) return err(new ConfigError(issues));
	return ok({
		environments,
		...(raw.home === undefined ? {} : { home: raw.home }),
		...(hands === undefined ? {} : { hands }),
		...(raw.auto === undefined ? {} : { auto: { classifier: raw.auto.classifier, ask: raw.auto.ask ?? "message" } }),
		workspace: {
			...(raw.workspace?.path === undefined ? {} : { path: raw.workspace.path }),
			exclude: raw.workspace?.exclude ?? [],
			...(raw.workspace?.maxBytes === undefined ? {} : { maxBytes: raw.workspace.maxBytes }),
		},
	});
}

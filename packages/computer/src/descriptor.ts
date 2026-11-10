// A provider's descriptor: everything a server, Settings and the conformance kit need to know of a vendor before any
// of its code loads. Each vendor declares one, once, in its descriptor module (src/descriptors/<id>.ts, data and a lazy
// load() alone), and its provider module takes its MOUNT and CAPABILITIES from it. The kind registry's PROVIDERS and
// the provider registry are derived from the descriptors; nothing beside them repeats what a descriptor says.
import type { ComputerSettingKind, KindCapabilities } from "./kinds.js";
import type { MountKind } from "./mount.js";
import type { ProviderModule } from "./providers.js";

/** One key a provider takes in Settings: its serve-side name, the create() option it fills, and whether it is needed. */
export interface DescriptorKey {
	/** The name Settings stores it under and shows (DAYTONA_API_KEY); never a value. */
	readonly name: string;
	/** The create() option it fills (apiKey). */
	readonly option: string;
	readonly required: boolean;
}

/** A setting that is no key but fills a create() option, with the value used when the server names none. */
export interface DescriptorSetting {
	/** Its name in the server's settings (modalApp). */
	readonly name: string;
	/** The create() option it fills (app). */
	readonly option: string;
	/** The value when the server's settings name none. */
	readonly default?: string;
}

/**
 * A provider, declared once. Every field is data but load(), which imports the provider module only when called:
 * reading a descriptor loads no provider and no vendor SDK.
 */
export interface ProviderDescriptor<Module extends ProviderModule = ProviderModule> {
	/** Its id, in the provider registry and in Settings: lowercase letters, digits and hyphens. */
	readonly id: string;
	/** Its name in words, as Settings shows it. */
	readonly label: string;
	/** The keys Settings takes for it, by name, and the option each fills; [] for none (Docker's host is local). */
	readonly keys: readonly DescriptorKey[];
	/** Settings that are no key but go to its options (Modal's app). */
	readonly settings?: readonly DescriptorSetting[];
	/** The vendor bills by time; prices are the vendor's page, not ours. */
	readonly metered: boolean;
	/** The mount kinds its computers take, as its providers' capabilities().mount declare them; [] for none. */
	readonly mounts: readonly MountKind[];
	/** The machine kind and groups of each configuration it offers, as each built provider's capabilities() declare them. */
	readonly capabilities: readonly KindCapabilities[];
	/**
	 * The image a computer of each setting kind starts from when its setting names none. A kind with no entry has no
	 * default, and the caller refuses the setting in words (Docker's sandbox: the server builds its image, prepareImage).
	 */
	readonly defaultImage?: Partial<Record<ComputerSettingKind, string>>;
	/** Its built providers have prepareImage(): the image a computer starts from is made or pulled before the first create. */
	readonly prepareImage?: boolean;
	/** Its computers run on this machine's container engine: a server passes it its local host options (volume, host addresses). */
	readonly local?: boolean;
	/** create() takes a ledger the server keeps for it, as `options[ledger.option]` (the phone harness's sessions). */
	readonly ledger?: { readonly option: string };
	/** The provider module, loaded on demand: its create(), its conformance module. */
	load(): Promise<Module>;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A descriptor, checked: its id's shape, its keys' and settings' names and options unique and non-empty, and one
 * configuration at least. Throws in words naming what is wrong, so a bad descriptor never reaches a registry. The const
 * type parameter keeps its literal id and its module's type, so ProviderOptions can read a create()'s options from it.
 */
export function defineProvider<const Descriptor extends ProviderDescriptor>(descriptor: Descriptor): Descriptor {
	const problems = descriptorProblems(descriptor);
	if (problems.length > 0) throw new Error(`the provider descriptor ${JSON.stringify(descriptor?.id)}: ${problems.join("; ")}`);
	return descriptor;
}

/** What is wrong with a value offered as a descriptor, in words; none when it is one. */
export function descriptorProblems(value: unknown): string[] {
	if (typeof value !== "object" || value === null) return ["it is not an object"];
	const d = value as Partial<ProviderDescriptor>;
	const problems: string[] = [];
	if (typeof d.id !== "string" || !ID.test(d.id)) problems.push(`id ${JSON.stringify(d.id)} is not lowercase letters, digits and hyphens`);
	if (typeof d.label !== "string" || d.label.trim() === "") problems.push("label is not a name in words");
	if (typeof d.metered !== "boolean") problems.push("metered is not true or false");
	if (typeof d.load !== "function") problems.push("load is not a function that imports the provider module");
	if (!Array.isArray(d.mounts) || d.mounts.some((kind) => kind !== "bind" && kind !== "archil")) problems.push("mounts is not a list of mount kinds (bind, archil)");
	if (!Array.isArray(d.capabilities) || d.capabilities.length === 0) problems.push("capabilities is not a list of one configuration or more");
	else if (d.capabilities.some((one) => typeof one?.kind !== "string" || !Array.isArray(one.groups))) problems.push("each configuration is a machine kind and its groups");
	const named = (list: unknown, what: string) => {
		if (list === undefined) return;
		if (!Array.isArray(list)) return void problems.push(`${what} is not a list`);
		const names = new Set<string>();
		const options = new Set<string>();
		for (const one of list as { name?: unknown; option?: unknown }[]) {
			if (typeof one?.name !== "string" || one.name === "" || typeof one.option !== "string" || one.option === "") problems.push(`each of ${what} has a name and the option it fills`);
			else if (names.has(one.name) || options.has(one.option)) problems.push(`${what} names ${one.name} or fills ${one.option} twice`);
			else names.add(one.name), options.add(one.option);
		}
	};
	if (d.keys === undefined) problems.push("keys is not a list");
	named(d.keys, "keys");
	named(d.settings, "settings");
	if (Array.isArray(d.keys) && d.keys.some((key) => typeof key?.required !== "boolean")) problems.push("each key says whether it is required");
	if (d.ledger !== undefined && (typeof d.ledger?.option !== "string" || d.ledger.option === "")) problems.push("ledger names the option it fills");
	return problems;
}

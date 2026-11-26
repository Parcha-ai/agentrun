// A provider's descriptor: everything a server, Settings and the conformance kit need to know of a vendor before any
// of its code loads. Each vendor declares one, once, in its descriptor module (src/descriptors/<id>.ts, data and a lazy
// load() alone), and its provider module reads its mounts and capabilities from it. The kind registry's PROVIDERS and
// the provider registry are derived from the descriptors; nothing beside them repeats what a descriptor says.
import type { KindCapabilities } from "./kinds.js";
import type { MountKind, Unmounted } from "./mount.js";
import type { ComputerKind } from "./protocol.js";
import type { NetworkForm } from "./provider.js";
import type { ProviderModule } from "./providers.js";
import { type ComputerSettingKind, SETTING_KIND_NAMES, SETTING_KINDS } from "./setting-kinds.js";

/** One key a provider takes in Settings: its serve-side name, the create() option it fills, and whether it is needed. */
export interface DescriptorKey {
	/** The name Settings stores it under and shows (DAYTONA_API_KEY); never a value. */
	readonly name: string;
	/** The create() option it fills (apiKey). */
	readonly option: string;
	readonly required: boolean;
	/**
	 * A person picks its value from the vendor's own list rather than typing it (Orgo's workspace, by name): Settings
	 * offers what the built provider's keyChoices(option) reads with the other keys. Absent: typed.
	 */
	readonly picked?: boolean;
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
 * A configuration its module builds but the provider does not offer yet: its kind, groups, image and create() options,
 * as an offered one's, and why it is parked, in words. The conformance suite holds a built one to it as to an offered one.
 */
export type ParkedConfiguration = KindCapabilities & { readonly image: string; readonly why: string };

/** A program a provider runs on the server's own machine: the command it looks for on PATH, and what installs it. */
export interface HostCommand {
	readonly command: string;
	/** What gives the command, in words a person installs it by: "Android platform-tools". */
	readonly from: string;
	/**
	 * The machines it is built for, as Node names them (`${process.platform}-${process.arch}`: "linux-x64"). A server on
	 * any other cannot install it, and says so. Absent: every machine.
	 */
	readonly builds?: readonly string[];
}

/**
 * Where a provider keeps a secret it makes for itself (its descriptor's `secrets`): one value by each name, shared by
 * every provider made on the same store, and by every process on it. A server's is sealed in its store.
 */
export interface ProviderSecrets {
	/** The value kept under `name`; undefined for none, and for one that does not open there. */
	get(name: string): Promise<string | undefined>;
	/**
	 * Keeps `value` under `name` unless a value is kept there already, and answers the one kept: of callers racing on one
	 * name, in this process or another on the same store, every one answers the same value. Undefined when none could be
	 * kept.
	 */
	putIfAbsent(name: string, value: string): Promise<string | undefined>;
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
	/**
	 * The mount kinds its computers take beside the synced folder, bind or archil; [] for none. sync is never listed: it
	 * is derived (syncs, derivedMounts), and capabilities().mount declares both.
	 */
	readonly mounts: readonly MountKind[];
	/**
	 * Mount kinds its computers don't take though a caller would ask for them, each with why in one sentence: check()
	 * refuses such a mount in these words, and serve says them where the run's folder can't be had (Daytona's archil).
	 */
	readonly unmounted?: Unmounted;
	/**
	 * Mount kinds its computers take only where the operator sets one of its keys, each by that key's name: the provider
	 * that key fills declares the kind, and one made without it refuses the kind in its unmounted words (Daytona's archil,
	 * with DAYTONA_ARCHIL_EGRESS: a self-hosted Daytona target reaches Archil through an egress relay, and Archil's client
	 * hangs on Daytona's hosted cloud). Each kind is in unmounted and never in mounts; each key is one of keys, not
	 * required. mountsOf gives a provider's mounts with the keys set.
	 */
	readonly mountsWith?: Readonly<Partial<Record<MountKind, string>>>;
	/**
	 * The network forms its computers make and enforce, as its providers' capabilities().network declare them: ["none"],
	 * a remote computer whose programs run in a network of their own and nothing else; ["open"], the vendor's own network,
	 * which no allowlist of this server reaches; a hosted computer through init's egress proxy (hosted/network.ts) makes
	 * all three, as Docker's does. A form not declared is refused at check, never widened or narrowed to another. A
	 * provider of several configurations declares every form they make.
	 */
	readonly network: readonly NetworkForm[];
	/**
	 * The machine kind and groups of each configuration it offers, as each built provider's capabilities() declare them;
	 * where it offers more than one image of a kind, each one's image (the name a setting selects it by) and the create()
	 * options that build it (KindCapabilities).
	 */
	readonly capabilities: readonly KindCapabilities[];
	/**
	 * Setting kinds its capabilities don't serve though a caller would ask it for one, each with why, in words: serve
	 * refuses a setting of that kind on it with these words in place of servingRefusals' (Daytona's desktop: the window
	 * manager can't start in its sandboxes).
	 */
	readonly unserved?: Readonly<Partial<Record<ComputerSettingKind, string>>>;
	/**
	 * The image a computer of each setting kind starts from when its setting names none. A kind with no entry has no
	 * default, and the caller refuses the setting in words (Docker's sandbox: the server builds its image, prepareImage).
	 */
	readonly defaultImage?: Partial<Record<ComputerSettingKind, string>>;
	/**
	 * Its built providers have prepareImage(), the declaration: the image a computer starts from is made or pulled before
	 * the first create. Settings reads this without loading the provider; the Core case provider.prepare-image holds the
	 * two to agree.
	 */
	readonly prepareImage?: boolean;
	/**
	 * The server's environment variable that, when its operator sets it, names the image every computer of this provider
	 * starts from in place of defaultImage (Daytona's snapshot of box/Dockerfile, which an Archil mount needs). The
	 * provider's own check() still judges the image. Absent: its images are its defaultImage alone.
	 */
	readonly imageEnv?: string;
	/**
	 * How the server reaches its machines, where they may dial it (MachineHost facts.connect "dial": every connection goes
	 * over the socket the machine's computerd dials, which the server's attach hub takes). "dial": always (Fly Machines,
	 * Cloudflare). "either": its create() option `connect` says, "exec" (the default) or "dial", and a setting of its
	 * settings fills that option (E2B, Daytona, Modal). Absent: never. connectOf reads it; its built host's facts.connect
	 * is connectOf's answer.
	 */
	readonly connect?: "dial" | "either";
	/** Its computers run on this machine's container engine: a server passes it its local host options (volume, host addresses). */
	readonly local?: boolean;
	/**
	 * Its sandbox is the box a server gives a new agent that names no place and needs a shell (Docker's): one provider at
	 * most sets it. Where that box is not available, a server gives such an agent no other box in its place.
	 */
	readonly defaultBox?: true;
	/** create() takes a ledger the server keeps for it, as `options[ledger.option]` (the phone harness's sessions). */
	readonly ledger?: { readonly option: string };
	/**
	 * create() takes the server's store of secrets the provider makes for itself (ProviderSecrets: Agent37's SSH key), as
	 * `options[secrets.option]`: one per server store, sealed at rest, never shown. Without one, a provider keeps what it
	 * makes for its process alone.
	 */
	readonly secrets?: { readonly option: string };
	/**
	 * The server's own environment variables its provider reads on this machine, by name (Local Chrome's, where it finds
	 * Chrome; a cloud browser's, the gateway a server reaches its API through): a server passes their values, and no other
	 * variable of its own, as `options.env`. The provider itself reads no environment.
	 */
	readonly hostEnv?: readonly string[];
	/**
	 * A program its computers need on the server's own machine, found on PATH (the phone's adb): a server looks for it at
	 * its start and, when it is missing, says from this alone that the provider can't run there and why.
	 */
	readonly hostCommand?: HostCommand;
	/**
	 * Configurations its module builds but does not offer yet (Orgo's Windows and macOS desktops), each by the image a
	 * setting would name and why: a setting naming one is refused in its words, saying it is parked, never as an unknown
	 * image. No setting kind lists one, and Settings never offers one.
	 */
	readonly parked?: readonly ParkedConfiguration[];
	/**
	 * Its browsers open a profile the vendor keeps (a Browserbase context, a Kernel profile), which its built providers
	 * make and delete (profiles.create, profiles.remove) and declare (capabilities().browser.profiles, this same value). A
	 * server keeps an agent's saved sign-in only at a provider that declares this. settleMs: how long after a saving
	 * session ends the vendor may still be writing the profile back, which a server waits out before another session saves
	 * to it. Absent: its browsers keep no profile.
	 */
	readonly profiles?: { readonly settleMs: number };
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

/** The setting kinds a descriptor's unserved may name: every one but none. */
const UNSERVABLE: readonly string[] = SETTING_KIND_NAMES.filter((kind) => kind !== "none");

/** What is wrong with a value offered as a descriptor, in words; none when it is one. */
export function descriptorProblems(value: unknown): string[] {
	if (typeof value !== "object" || value === null) return ["it is not an object"];
	const d = value as Partial<ProviderDescriptor>;
	const problems: string[] = [];
	if (typeof d.id !== "string" || !ID.test(d.id)) problems.push(`id ${JSON.stringify(d.id)} is not lowercase letters, digits and hyphens`);
	if (typeof d.label !== "string" || d.label.trim() === "") problems.push("label is not a name in words");
	if (typeof d.metered !== "boolean") problems.push("metered is not true or false");
	if (typeof d.load !== "function") problems.push("load is not a function that imports the provider module");
	if (!Array.isArray(d.mounts) || d.mounts.some((kind) => kind !== "bind" && kind !== "archil")) problems.push("mounts is not a list of mount kinds (bind, archil): sync is derived, never listed");
	if (d.unmounted !== undefined) {
		const entries = typeof d.unmounted === "object" && d.unmounted !== null && !Array.isArray(d.unmounted) ? Object.entries(d.unmounted) : undefined;
		if (entries === undefined || entries.some(([kind, why]) => (kind !== "bind" && kind !== "archil" && kind !== "sync") || typeof why !== "string" || why.trim() === "")) problems.push("unmounted maps mount kinds (bind, archil, sync) to why, in words");
		else if (Array.isArray(d.mounts) && entries.some(([kind]) => d.mounts?.includes(kind as MountKind))) problems.push("unmounted names a mount kind that mounts declares");
	}
	if (d.mountsWith !== undefined) {
		const entries = typeof d.mountsWith === "object" && d.mountsWith !== null && !Array.isArray(d.mountsWith) ? Object.entries(d.mountsWith) : undefined;
		const optional = (name: unknown) => Array.isArray(d.keys) && d.keys.some((key) => key?.name === name && key.required === false);
		if (entries === undefined || entries.some(([kind, key]) => (kind !== "bind" && kind !== "archil") || typeof key !== "string" || !optional(key))) problems.push("mountsWith maps mount kinds (bind, archil) to the name of one of its keys that is not required");
		else if (entries.some(([kind]) => typeof d.unmounted?.[kind as MountKind] !== "string")) problems.push("each kind of mountsWith is in unmounted too, with why while its key is unset");
	}
	if (d.unserved !== undefined && (typeof d.unserved !== "object" || d.unserved === null || Array.isArray(d.unserved) || Object.entries(d.unserved).some(([kind, why]) => !UNSERVABLE.includes(kind) || typeof why !== "string" || why.trim() === ""))) problems.push(`unserved maps setting kinds (${UNSERVABLE.join(", ")}) to why, in words`);
	if (!Array.isArray(d.network) || d.network.length === 0 || d.network.some((form) => form !== "none" && form !== "open" && form !== "allow")) problems.push("network is not a list of the network forms its computers make (none, open, allow)");
	if (!Array.isArray(d.capabilities) || d.capabilities.length === 0) problems.push("capabilities is not a list of one configuration or more");
	else if (d.capabilities.some((one) => typeof one?.kind !== "string" || !Array.isArray(one.groups))) problems.push("each configuration is a machine kind and its groups");
	else {
		const images = new Set<string>();
		for (const one of d.capabilities) {
			if (one.image !== undefined && (typeof one.image !== "string" || one.image.trim() === "" || one.image !== one.image.trim())) problems.push(`a configuration's image ${JSON.stringify(one.image)} is not a name`);
			else if (one.image !== undefined && images.has(`${one.kind} ${one.image}`)) problems.push(`two ${one.kind} configurations have the image ${one.image}`);
			else if (one.image !== undefined) images.add(`${one.kind} ${one.image}`);
			if (one.options !== undefined && (typeof one.options !== "object" || one.options === null || Array.isArray(one.options))) problems.push("a configuration's options are an object, as create() takes them");
		}
	}
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
	if (Array.isArray(d.keys) && d.keys.some((key) => key?.picked !== undefined && typeof key.picked !== "boolean")) problems.push("a key's picked is true or false");
	if (d.connect !== undefined && d.connect !== "dial" && d.connect !== "either") problems.push("connect is dial or either");
	else if ((d.connect === "either") !== (Array.isArray(d.settings) && d.settings.some((setting) => setting?.option === "connect"))) problems.push("connect is either exactly where a setting fills the connect option");
	if (d.ledger !== undefined && (typeof d.ledger?.option !== "string" || d.ledger.option === "")) problems.push("ledger names the option it fills");
	if (d.secrets !== undefined && (typeof d.secrets?.option !== "string" || d.secrets.option === "")) problems.push("secrets names the option it fills");
	if (d.imageEnv !== undefined && (typeof d.imageEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(d.imageEnv))) problems.push("imageEnv is an environment variable name (capital letters, digits and underscores)");
	if (d.hostEnv !== undefined && (!Array.isArray(d.hostEnv) || d.hostEnv.some((name) => typeof name !== "string" || name === ""))) problems.push("hostEnv is a list of environment variable names");
	if (d.hostCommand !== undefined) {
		const { command, from, builds } = (d.hostCommand ?? {}) as Partial<HostCommand>;
		if (typeof command !== "string" || !/^[A-Za-z0-9._-]+$/.test(command)) problems.push("hostCommand's command is a program's name, with no path");
		if (typeof from !== "string" || from.trim() === "") problems.push("hostCommand says in words what installs it (from)");
		if (builds !== undefined && (!Array.isArray(builds) || builds.length === 0 || builds.some((one) => typeof one !== "string" || !/^[a-z0-9]+-[a-z0-9]+$/.test(one)))) problems.push("hostCommand's builds are machines as Node names them (linux-x64)");
	}
	if (d.parked !== undefined) {
		if (!Array.isArray(d.parked) || d.parked.some((one) => typeof one?.image !== "string" || one.image === "" || typeof one.why !== "string" || one.why === "" || typeof one.kind !== "string" || !Array.isArray(one.groups))) problems.push("parked is a list of configurations, each with its image and why it is parked");
		else if (Array.isArray(d.capabilities) && d.parked.some((one) => d.capabilities!.some((offered) => offered?.image === one.image))) problems.push("a parked image is also offered");
	}
	if (d.profiles !== undefined) {
		const settleMs = (d.profiles as { settleMs?: unknown } | null)?.settleMs;
		if (typeof settleMs !== "number" || !Number.isInteger(settleMs) || settleMs < 0) problems.push("profiles is { settleMs }, a whole number of milliseconds, 0 or more");
		else if (!Array.isArray(d.capabilities) || !d.capabilities.some((one) => one?.kind === "browser")) problems.push("profiles is a browser's: no configuration is of kind browser");
	}
	return problems;
}

/**
 * How a provider made with create() `options` reaches its machines: "dial", they dial the server (its descriptor's
 * connect "dial", or "either" with options.connect "dial"); else "exec". The one answer to whether a provider's machines
 * dial: each provider's host takes its facts.connect from it (hosted/provider.ts reads that), and a server reads it
 * before it builds one (serve's Settings → Computers, where a runner in a process of its own has no attach hub). A
 * connect other than exec or dial is refused in words.
 */
export function connectOf(descriptor: Pick<ProviderDescriptor, "label" | "connect">, options: { readonly connect?: unknown } = {}): "exec" | "dial" {
	if (descriptor.connect !== "either") return descriptor.connect === "dial" ? "dial" : "exec";
	const { connect } = options;
	if (connect === undefined || connect === "exec" || connect === "dial") return connect ?? "exec";
	throw new Error(`connect is how ${descriptor.label} reaches its machines, "exec" (the default) or "dial", not ${JSON.stringify(connect)}`);
}

/**
 * Why a provider made for machine kind `kind` over `connect` (connectOf's answer) gives no such computer, by its
 * descriptor alone; undefined when it gives one, or `kind` is none of its configurations' (create() judges that). Its
 * unserved words for the setting kind `kind` is: "<label> gives no <kind> computer: <why>". Else, where each configuration
 * of `kind` names a connect of its own in its options and none is `connect`: the connect that makes one. A provider's
 * constructor throws these words, so a kind rule is said once, in the descriptor.
 */
export function kindRefusal(descriptor: Pick<ProviderDescriptor, "label" | "capabilities" | "unserved">, { kind, connect }: { readonly kind?: string; readonly connect: "exec" | "dial" }): string | undefined {
	if (kind === undefined) return undefined;
	const setting = SETTING_KIND_NAMES.find((name) => SETTING_KINDS[name].machineKinds.includes(kind as ComputerKind));
	const why = setting === undefined ? undefined : descriptor.unserved?.[setting];
	if (why !== undefined) return `${descriptor.label} gives no ${setting} computer: ${why}`;
	const connects = descriptor.capabilities.filter((one) => one.kind === kind).map((one) => one.options?.connect);
	if (connects.length === 0 || connects.some((one) => one === undefined || one === connect)) return undefined;
	return `${descriptor.label} gives a ${kind} computer on connect ${[...new Set(connects)].map((one) => JSON.stringify(one)).join(" or ")} alone, not ${JSON.stringify(connect)}`;
}

/**
 * Whether a configuration takes a synced folder: its groups have exec and files (all the runner reads and writes the
 * folder through), and its descriptor binds no host folder (a bind is the folder itself) nor says why it takes none
 * (unmounted.sync).
 */
export function syncs(descriptor: Pick<ProviderDescriptor, "mounts" | "unmounted">, configuration: Pick<KindCapabilities, "groups">): boolean {
	return configuration.groups.includes("exec") && configuration.groups.includes("files") && !descriptor.mounts.includes("bind") && descriptor.unmounted?.sync === undefined;
}

/** A descriptor's mounts, with sync where one of its configurations takes it (syncs). */
export function derivedMounts(descriptor: Pick<ProviderDescriptor, "mounts" | "unmounted" | "capabilities">): MountKind[] {
	const sync = !descriptor.mounts.includes("sync") && descriptor.capabilities.some((one) => syncs(descriptor, one));
	return [...descriptor.mounts, ...(sync ? (["sync"] as const) : [])];
}

/**
 * The mount kinds a provider's computers take, and why not the others, with the keys `set` says the operator has set: its
 * derived mounts, and each kind of its mountsWith whose key is set, which leaves its unmounted. What a provider made with
 * those keys declares (capabilities().mount), and what a server reads to know whether that provider can mount a run's
 * folder. With `dial`, its machines dial the server (connectOf's "dial"), and it takes no Archil mount: the helper's
 * steps run as root through exec, which a machine that dials has none of.
 */
export function mountsOf(descriptor: Pick<ProviderDescriptor, "label" | "mounts" | "unmounted" | "mountsWith" | "capabilities">, set: (name: string) => boolean, dial = false): { mounts: MountKind[]; unmounted: Unmounted } {
	const taken = Object.entries(descriptor.mountsWith ?? {}).flatMap(([kind, key]) => (typeof key === "string" && set(key) ? [kind as MountKind] : []));
	const unmounted: Unmounted = Object.fromEntries(Object.entries(descriptor.unmounted ?? {}).filter(([kind]) => !taken.includes(kind as MountKind)));
	const mounts = [...descriptor.mounts, ...taken.filter((kind) => !descriptor.mounts.includes(kind))];
	if (dial) {
		const archil = `${descriptor.label}'s machines dial this server, and a machine that dials takes no Archil mount`;
		return { mounts: derivedMounts({ ...descriptor, mounts: mounts.filter((kind) => kind !== "archil") }), unmounted: { ...unmounted, archil } };
	}
	return { mounts: derivedMounts({ ...descriptor, mounts }), unmounted };
}

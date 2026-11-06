// The Docker provisioner: every call through the docker CLI, no shell.
import type { ComputerCapabilities, ComputerConnection, ComputerProvider, ComputerRef, ComputerSpec, Refusal } from "./provider.js";
import { fail, type Result } from "./result.js";

export interface DockerProviderOptions {
	/** The daemon binary on this machine, for the computer's architecture (dist/computerd-linux-<arch>). */
	daemonPath: string;
	/** The docker CLI. */
	docker?: string;
}

export class DockerProvider implements ComputerProvider {
	readonly id = "docker";
	readonly version = "0.0.0";

	constructor(_options: DockerProviderOptions) {}

	capabilities(): ComputerCapabilities {
		return { lifetime: "vendor", network: [], isolation: "container", os: "linux", daemon: [] };
	}

	check(_spec: ComputerSpec): Refusal[] {
		return [];
	}

	async create(_spec: ComputerSpec, _context: { signal?: AbortSignal } = {}): Promise<Result<ComputerRef>> {
		return fail("unsupported", "DockerProvider.create is not implemented");
	}

	async connect(_ref: ComputerRef): Promise<Result<ComputerConnection>> {
		return fail("unsupported", "DockerProvider.connect is not implemented");
	}

	async release(_ref: ComputerRef, _how: "stop" | "delete"): Promise<Result<void>> {
		return fail("unsupported", "DockerProvider.release is not implemented");
	}
}

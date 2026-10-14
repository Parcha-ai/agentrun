import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { TransportConfig } from "../config.ts";
import { TransportError } from "../transport.ts";

/**
 * Whether a session whose home is the environment `home` can have the hands its config names.
 *
 * A home on this machine (a `local` environment) may send its tools anywhere: the router runs beside the providers.
 * A home in a box runs its tools in its own box in this release, so `hands` must name that environment alone, or
 * be absent. Anything else is `unsupported`: tools in another box than a boxed home come later.
 */
export function checkHomeHands(config: TransportConfig, home: string): Result<void, TransportError> {
	const environment = Object.hasOwn(config.environments, home) ? config.environments[home] : undefined;
	if (environment === undefined) {
		return err(new TransportError("unknown_environment", `the home "${home}" is not a declared environment`));
	}
	if (environment.provider === "local" || config.hands === undefined) return ok(undefined);
	const elsewhere = [config.hands.default, ...Object.values(config.hands.roles)].find((id) => id !== home);
	if (elsewhere === undefined) return ok(undefined);
	return err(
		new TransportError(
			"unsupported",
			`the home "${home}" is a box, and in this release a home in a box runs its tools in its own box: hands names "${elsewhere}". Tools in another box than the home's come in a later release`,
		),
	);
}

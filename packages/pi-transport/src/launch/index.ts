// The launcher (`@parcha/pi-transport/launch`): one program kept alive in a box, whatever happens to the host.
export {
	type Launch,
	LaunchError,
	type LaunchErrorCode,
	type LaunchPhase,
	type LaunchSpec,
	type LaunchState,
	launch,
	launchState,
	launchStatus,
	launchStop,
	stopLaunch,
} from "./launch.ts";

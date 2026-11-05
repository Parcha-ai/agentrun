export {
	type Box,
	type BoxCapability,
	type BoxEndpoint,
	BoxError,
	type BoxErrorCode,
	type BoxExecOptions,
	type BoxFacts,
	type BoxFile,
	/** @deprecated Removed in 0.1.0-beta.31 with `@parcha/pi-transport/launch`. Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	type BoxLauncher,
	type BoxNetwork,
	type BoxPort,
	type BoxProcess,
	type BoxProvider,
	type BoxRef,
	type BoxSnapshot,
	type BoxSpec,
	type BoxStatus,
	isReservedLabel,
} from "./box/box.ts";
export { downloadByExec, finish, readStream, uploadByExec } from "./box/files.ts";
export {
	type BoxMade,
	type BoxPrice,
	type BoxReceipt,
	type BoxReceipts,
	type BoxReceiptsOptions,
	boxReceipts,
} from "./box/receipts.ts";
export {
	ConfigError,
	type ConfigIssue,
	type EnvironmentConfig,
	parseDuration,
	parseTransportConfig,
	type TransportConfig,
	type TransportConfigInput,
	TransportConfigSchema,
} from "./config.ts";
export { type FactsReading, readFacts } from "./facts.ts";
export {
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	isPlacementRecord,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	PlacementsDoc,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	writePlacement,
} from "./place/log.ts";
export {
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	type EnvironmentFacts,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	environmentFacts,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	type JevPlacerOptions,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	jevClassifier,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	jevPlacer,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	type PlacementAsked,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	PlacementError,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	type PlacementErrorCode,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	type PlacementPhase,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	type PlacementQuery,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	type PlacementRecord,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`). Run an agent in a box with `@parcha/agentrun-serve`, which uses `./hands` and `./sync`. */
	type Placer,
} from "./place/placer.ts";
export {
	HandsDoc,
	SessionBoxesDoc,
	type Transport,
	TransportError,
	type TransportErrorCode,
	type TransportHost,
} from "./transport.ts";

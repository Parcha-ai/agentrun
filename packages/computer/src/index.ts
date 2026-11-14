export * from "./protocol.js";
export * from "./result.js";
export * from "./provider.js";
export * from "./ui-engine.js";
export * from "./attach.js";
export * from "./mount.js";
export { type CallOptions, DaemonClient, type DaemonStream, findNodes, refusedStep, type UiActOptions, type UiQuery, UiSession } from "./client.js";
export { type ActionFailure, type CheckActionsOptions, checkActions, isKey } from "./actions.js";
export { pullTar, pullTarStream, pushTar, readFile, writeFile, type PulledTar } from "./files.js";
export { listProcesses, readAll, type ReadAllResult } from "./processes.js";
export {
	type ActionMapper,
	createActionMapper,
	daemonWatch,
	redactWords,
	type ScreenFrame,
	type ScreenFrames,
	type ScreenWatch,
	ScreenWatchError,
	type ScreenWatchHandlers,
	toAction,
	type ViewerEvent,
	type WatchEndCode,
	watchEndCode,
	type WatchOptions,
	watchScreen,
} from "./screen-watch.js";
// The shared machine-host adapter: a vendor writes a MachineHost (src/host.ts), and HostedProvider makes it a provider.
export type { HostCall, HostFacts, Machine, MachineHost, MachineProcess, MachineRequest } from "./host.js";
export { HostedProvider, type HostedOptions, type HostedTimeouts } from "./hosted/provider.js";
// The provider classes and their option types are not here: each provider loads by its id through the registry
// (providerFor), or from its own subpath (@parcha/agentrun-computer/docker, /daytona, /modal, /e2b, /agent37, /orgo,
// /phone-harness, /browserbase, /kernel, /local: each the provider file's name).
export { type DockerVolume, VOLUME_SUBPATH_ENGINE } from "./docker/volume.js";
export {
	DEFAULT_DOCKER_IMAGE,
	DOCKER_BASE,
	DOCKER_RECIPE,
	DOCKER_RECIPE_HAS,
	ensureImage,
	type EnsureImageOptions,
	IMAGE_REPOSITORY,
	IMAGE_TIMEOUT_MS,
	type ImageSource,
	imageSourceProblem,
	type Making,
	RECIPE_LABEL,
	recipeHash,
	recipeTag,
} from "./docker/image.js";
export { EGRESS_IMAGE, EGRESS_LABEL, EGRESS_MOUNT, EGRESS_SOCKET } from "./docker/egress.js";
export {
	ARCHIL_HELPER,
	ARCHIL_MOUNT_LABEL,
	ARCHIL_SYNC_SOCKET,
	ARCHIL_TOOL_UID,
	ARCHIL_TOOL_USER,
	ARCHIL_VERSION,
	type ArchilMount,
	type ArchilEgress,
	type ArchilMountOptions,
	type ArchilRoot,
	type ProviderNote,
	archilEgressOf,
	archilLabels,
	archilMount,
	archilReadBack,
	archilRefusals,
	archilRelease,
	claimEpoch,
	helperSha256,
	mountDrift,
	mountWords,
	type RecordedArchil,
	readArchilMount,
	recordedArchil,
	recordedMount,
	syncingClient,
} from "./mount-archil.js";
export {
	type BrowserComputerProvider,
	type BrowserDownloads,
	type BrowserFile,
	type BrowserProfiles,
	browserSpecRefusals,
	type BrowserStream,
	isBrowserProvider,
	BrowserVendorError,
	CREATE_LABEL,
	causeOf,
	memoryUrls,
	RECOVER_MS,
	type ReleaseConfirm,
	type RestReply,
	type UrlStore,
} from "./browser.js";
// Local Chrome's provider class is on its provider id's subpath (@parcha/agentrun-computer/local-chrome), as every
// provider's is; the Chrome helpers it runs on are not a provider and stay here.
export { CHROME_ENV, CHROME_FLAGS, checkChrome, chromeFence, findChrome, killTree, NO_CHROME } from "./chrome.js";
export { DAEMON_IN_COMPUTER, helloDrift, type HelloExpected } from "./drift.js";
export { drift, hostOf, inspectDrift, mountOf, networkOf, type DockerHost, type DockerInfo, type DockerInspect, type DriftExpected } from "./docker/inspect.js";
export { type ReleasedOlder, releaseOlder, sweep, type SweepOptions, type Swept } from "./janitor.js";
export { EPOCH_LABEL, epochOf, epochProblem, IDLE_TTL_LABEL, OWNER_LABEL, OWNER_SERVER_LABEL, ownerFilter, ownerLabels, ownerOf, RUN_HASH_LABEL, RUN_LABEL, runHash, runLabels, runProblem } from "./labels.js";
export { waitUntil, type WaitOptions } from "./wait.js";
export {
	type BuiltinProviderId,
	type ConformanceModule,
	descriptorOf,
	isProviderId,
	type ProviderEnv,
	providerFor,
	type ProviderId,
	providerIds,
	type ProviderModule,
	providerModule,
	type ProviderOptions,
	providers,
} from "./providers.js";
export { type DescriptorKey, type DescriptorSetting, defineProvider, descriptorProblems, type HostCommand, type ParkedConfiguration, type ProviderDescriptor } from "./descriptor.js";
export {
	AGENT37,
	AGENT37_BASE_TEMPLATE,
	AGENT37_BOX_TEMPLATE,
	BROWSER_IMAGE,
	BROWSERBASE,
	DAYTONA,
	DAYTONA_DEFAULT_SNAPSHOT,
	DAYTONA_GPU_SNAPSHOT,
	type DaytonaGpuSnapshot,
	DESCRIPTORS,
	daytonaGpu,
	daytonaGpuSnapshot,
	DOCKER,
	E2B,
	E2B_BASE_TEMPLATE,
	E2B_DESKTOP_TEMPLATE,
	KERNEL,
	LOCAL,
	MODAL,
	MODAL_DEFAULT_IMAGE,
	ORGO,
	ORGO_BASE_IMAGE,
	PHONE_GROUPS,
	PHONE_HARNESS,
	PHONE_IMAGE,
} from "./descriptors/index.js";
// Types only: the phone ledger serve backs with its store. The provider itself loads through the registry.
export type { PhoneLedger, PhoneLedgerEntry } from "./phone-harness.js";
export {
	type ComputerSettingKind,
	configurationOf,
	entryOf,
	imagesOf,
	type KindCapabilities,
	kindOf,
	kindServed,
	type ProviderEntry,
	PROVIDERS,
	SETTING_KIND_NAMES,
	SETTING_KINDS,
	type SettingKindSpec,
	serves,
	servingRefusals,
	type TestConnection,
	type TestConnectionOptions,
} from "./kinds.js";
export * from "./conformance/index.js";

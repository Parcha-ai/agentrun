export {
	type AcknowledgedWrites,
	type AcknowledgedWritesOptions,
	probeAcknowledgedWrites,
} from "./acknowledged-writes.ts";
export {
	type BoxConformanceCase,
	type BoxConformanceOptions,
	type BoxConformanceProvider,
	createBoxConformance,
	registerBoxConformance,
} from "./box-conformance.ts";
export {
	type CallMatch,
	daytonaLike,
	type FakeBox,
	type FakeBoxesOptions,
	type FakeCall,
	type FakeClock,
	type FakeFacts,
	FakeFiles,
	/** @deprecated Removed in 0.1.0-beta.31 with `@parcha/pi-transport/launch`, which it fakes. */
	type FakeLaunch,
	type FakeLeak,
	type FakeOp,
	type FakeProgramRun,
	type FakeProvider,
	type FakeRule,
	type FakeScript,
	fakeBoxes,
	fakeClock,
	modalLike,
	type Outcome,
	type Program,
	type ProgramContext,
	type ProgramMatch,
	realClock,
} from "./fake-boxes.ts";
export {
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`), whose classifier it replays. */
	askedKey,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`), whose classifier it replays. */
	type ReplayHeader,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`), whose classifier it replays. */
	type ReplayLine,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`), whose classifier it replays. */
	readReplaySet,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`), whose classifier it replays. */
	recordingClassifications,
	/** @deprecated Removed in 0.1.0-beta.31 with the placer (`@parcha/pi-transport/place`), whose classifier it replays. */
	replayClassifier,
} from "./replay-classifier.ts";

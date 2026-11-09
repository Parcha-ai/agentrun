// TEMPORARY. The computers shapes the server answers but its OpenAPI doesn't document yet: copied as they are from the
// serve branch places/computers (packages/serve/src/computers.ts, computer-setting.ts and run-computer.ts), until the
// server switch registers and documents those routes. Imported only through v2.ts's aliases. Before any PR opens, those
// aliases point at api.generated.ts and this file is deleted. Nothing else imports it.

/** computer-setting.ts COMPUTER_KINDS. */
export type ComputerKind = "none" | "sandbox" | "desktop" | "phone" | "browser";

/** computers.ts KeyView: a provider's key by name, saved or not, never a value. */
export type KeyView = { name: string; required: boolean; saved: boolean };
/** computers.ts ProviderView. */
export type ProviderView = { id: string; name: string; keys: KeyView[]; ready: boolean; why?: string };
/** computers.ts KindView. */
export type KindView = { kind: ComputerKind; offered: boolean; why?: string; groups: string[]; tools: string[]; providers: ProviderView[] };
/** GET /v2/computers (computers.ts view()). */
export type ComputersView = { kinds: KindView[] };
/** PUT /v2/computers/{provider}/keys: declared names only; null removes one. The answer is the provider's view. */
export type KeysBody = Record<string, string | null>;
/** POST /v2/computers/{provider}/test (computers.ts TestView). */
export type TestView = { ok: true; detail: string } | { ok: false; why: string };

/** run-computer.ts ComputerState and RunComputerField: a run's `computer`. */
export type ComputerState = "starting" | "ready" | "taken_over" | "ended" | "failed";
export type RunComputerField = { kind: ComputerKind; provider: string; state: ComputerState; why?: string };

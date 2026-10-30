// Test kit for the Claude Agent adapter, copied from another project (each file's header says from where): a scripted
// Agent SDK that needs no CLI, key or network, and a scripted Anthropic Messages API for the real CLI behind the
// session's model proxy.
export { fakeSdk, sentSystemPrompt } from "./fake-sdk.js";
export type { FakeSdk, FakeSdkOptions } from "./fake-sdk.js";
export * from "./fake-anthropic.js";

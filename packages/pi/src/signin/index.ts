// Sign in, pick a model, check keys: the shared piece every demo runs first. The only entry of this package that
// reaches pi-ai, an optional peer; every other entry stays free of it.
export { checkKeys, checkSetupPrompt, JEV_KEYS } from "./spec.js";
export type { CheckOptions, Choice, DemoSpec, EyesNeed, Key, KeyReport, ModelNeed, Package, Platform, Program, ReportItem, RunMode, SetupPromptReport } from "./spec.js";
export { AGENT_NAME, CHATGPT_PROVIDER, consoleInteraction, signIn, SignInError } from "./signin.js";
export type { ConsoleIo, SignedIn, SignInOptions } from "./signin.js";
export { CHATGPT_UNSUPPORTED, resolveModel, ResolveError } from "./resolve.js";
export type { EyesModel, ResolvedModel, ResolveOptions } from "./resolve.js";
export { USAGE_LIMIT_CODE, UsageLimitError, usageLimitError } from "./limit.js";
export { agentrunHome, AuthStoreError, FileCredentialStore, fileCredentialStore } from "./store.js";
export type { FileCredentialStoreOptions } from "./store.js";

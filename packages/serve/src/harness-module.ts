// What a harness module's author imports (`@parcha/agentrun-serve/harness`, HARNESS.md): the types of an entry of serve's
// harness table, of the kit serve hands a module, and of the runner's harness it brings. Types alone, so a module that
// imports them loads nothing of serve: the server that loads the module hands it what it builds on
// (`entries(builtins, kit)`), from its own copy.
export type { AcpEntryOptions, HarnessEntry, HarnessModuleKit, HarnessPromises, HarnessTableModule, ModuleChecks, ModuleLaunch, Refusal, SessionRoute } from "./harness-table.js";
export type { HarnessLaunch, RunnerHarness } from "./runner/adapters/index.js";
export type { AdapterNeeds } from "./adapters.js";
export type { ModelChoice } from "./provider.js";

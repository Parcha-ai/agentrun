// The shapes an agent's revision and a run take where serve reads them as the file-era agent store wrote them (copied
// from @parcha/pi-durable-agent's agent-store.ts and kinds.ts, which serve no longer imports): a revision with its body,
// a run's row. The one store's own rows are store/store.ts'.
import type { Workflow } from "@parcha/agentrun-dsl";
import type { ImportSource } from "./store-reads/analytics.js";

export type RevisionKind = "agentic" | "workflow";
/** Where a revision's runs execute: a mode and the box it uses, ids its host knows. */
export type RevisionPlace = { mode: string; box?: string };
/** The computer a revision's runs are given: a kind and the provider that serves it, ids its host knows. */
export type RevisionComputer = { kind: string; provider?: string };
/** An overlay's selection rule: the id of the `question` row it answers, the `option` this variant needs, and the least
 *  probability (`threshold`, 0 to 1) for that option. */
export type PromptRule = { question: string; option: string; threshold: number };
/** A prompt variant, keyed by id: one `base`, one `generic`, any number of `overlay`s, and at most one `question`. */
export type PromptVariant = { role: "base" | "overlay" | "generic" | "question"; label: string; text: string; when?: PromptRule; criteria?: Record<string, string> };
export type AgenticBody = { instructions: string; skills: Record<string, string>; tools: string[]; model?: string; thinking?: string; prompts?: Record<string, PromptVariant>; harness?: string; place?: RevisionPlace; computer?: RevisionComputer; learning?: boolean; toolSettings?: Record<string, Record<string, string>>; approvals?: "never"; maxCostUsd?: number; capMode?: string };
export type WorkflowBody = { workflow: Workflow; skills: Record<string, string>; tools: string[]; harness?: string; place?: RevisionPlace; computer?: RevisionComputer; toolSettings?: Record<string, Record<string, string>>; approvals?: "never"; maxCostUsd?: number; capMode?: string };
/** A revision, written once: `body.skills` maps a skill path to the SHA-256 of its text. */
export type Revision = { id: string; agent: string; parent: string | null; createdAt: string; note?: string } & ({ kind: "agentic"; body: AgenticBody } | { kind: "workflow"; body: WorkflowBody });
export type RunState = "running" | "completed" | "failed" | "stopped" | "escalated";
/** Where an imported run came from: the harness that ran it on this machine, and its own session id. */
export type ImportedFrom = { source: ImportSource; session: string };
/** A run as a list reads it. `archivedAt`: when the run (or its agent) was archived; `importedFrom`: set on a run imported
 *  from another harness's session. */
export type RunRow = { id: string; agent: string; revision: string; kind: RevisionKind; state: RunState; startedAt: string; endedAt?: string; costUsd?: number; summary?: string; archivedAt?: string; importedFrom?: ImportedFrom };
/** What starts a run: `key`, the caller's name for it (1 to 256 characters), and `fingerprint`, what was asked, kept to
 *  tell a retry from another request under the same key. */
export type RunOrigin = { key: string; fingerprint?: string };

import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentFactoryBoard, type AgentFactoryBoardProps, type FactoryCard } from "./AgentFactoryBoard";
import { runLabel } from "@/lib/format";

const meta: Meta<typeof AgentFactoryBoard> = { title: "Agent Factory/Session board", component: AgentFactoryBoard };
export default meta;
type Story = StoryObj<typeof AgentFactoryBoard>;

// Fictional sessions exercise separate runs from one agent, a child, absent repository metadata, partial costs,
// heterogeneous source controls and terminal review without claiming that every source reports the same facts.
const at = "2026-11-22T09:30:00.000Z";
/** A card before its short label, which each takes from its own run as the page does (lib/factory.ts). */
type Draft = Omit<FactoryCard, "ref">;
const named = (card: Draft): FactoryCard => ({ ...card, ref: `run ${runLabel(card.runId)}` });
const base: Draft = {
  id: "run-roles-api", runId: "run-roles-api", agentName: "Nova", title: "Team roles · API", lane: "working",
  stateLabel: "Working", sourceLabel: "Codex", controlLabel: "Managed", repo: "example/console",
  githubLinks: [{ label: "Issue #184", url: "https://github.com/example/console/issues/184" }, { label: "PR #251", url: "https://github.com/example/console/pull/251" }],
  activityAt: at, reason: null, costLabel: "$5.80 recorded so far",
};
const cards: FactoryCard[] = ([
  base,
  { ...base, id: "run-roles-client", runId: "run-roles-client", title: "Team roles · client", lane: "waiting", stateLabel: "Waiting", reason: "Waiting for the API result", parentLabel: "Coordinator · run-roles-plan", activityAt: null, costLabel: "Cost not reported" },
  { ...base, id: "run-webhooks", runId: "run-webhooks", agentName: "Pax", title: "Webhook replay", repo: "example/api", lane: "waiting", stateLabel: "Queued", reason: "Waiting for a runner", githubLinks: [], costLabel: "$0 recorded" },
  { ...base, id: "sdk-docs", runId: "sdk-docs", agentName: "Mira", title: "Update setup guide", sourceLabel: "SDK backend", controlLabel: "Observed", repo: null, githubLinks: [], costLabel: "Cost not reported" },
  { ...base, id: "run-roles-plan", runId: "run-roles-plan", agentName: "Riley", title: "Team roles · plan", sourceLabel: "Claude", lane: "attention", stateLabel: "Input required", reason: "Who may invite admins?", costLabel: "$0.90 recorded so far" },
  { ...base, id: "native-focus", runId: "native-focus", agentName: "Rowan", title: "Keyboard navigation", lane: "unknown", stateLabel: "Activity unknown", sourceLabel: "Native Codex", controlLabel: "Observed", repo: null, githubLinks: [], activityAt: null, reason: "The source has not reported its current state", costLabel: "Cost not reported" },
] satisfies Draft[]).map(named);
const review: FactoryCard[] = [named({ ...base, id: "ended-export", runId: "ended-export", agentName: "Ellis", title: "Idempotent exports", repo: "example/api", lane: "attention", stateLabel: "Needs review", githubLinks: [], reason: "An interrupted effect needs reconciliation before another attempt", costLabel: "$1.45 recorded" })];
const args: AgentFactoryBoardProps = { cards, review, loading: false, refreshing: false, error: null, updatedAt: at, hasMore: false, onRefresh: () => {}, onLoadMore: () => {}, view: "cards", onView: () => {} };

export const Light: Story = { args, globals: { theme: "light" } };
export const Dark: Story = { args, globals: { theme: "dark" } };
// The same sessions, one row each.
export const List: Story = { args: { ...args, view: "list" }, globals: { theme: "light" } };
export const ListDark: Story = { args: { ...args, view: "list" }, globals: { theme: "dark" } };
export const PartialAndStale: Story = { args: { ...args, hasMore: true, error: "The source could not be reached. The prior results are still shown." } };
export const Loading: Story = { args: { ...args, cards: [], review: [], loading: true, updatedAt: null } };
export const Empty: Story = { args: { ...args, cards: [], review: [] } };

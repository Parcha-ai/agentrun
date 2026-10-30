import type { Meta, StoryObj } from "@storybook/react";
import { MissionControl } from "@/components/MissionControl";
import { Shell } from "@/components/Shell";
import { recorded } from "@/fixtures";
import type { Run } from "@/lib/v2";
import type { MissionView } from "@/lib/mission";

// Mission Control, the console's first page, on the recorded runs (src/fixtures).
const meta: Meta = { title: "Mission Control" };
export default meta;
type Story = StoryObj;
const view = (cost: MissionView["cost"]): MissionView => ({
  agents: 4, runs: { total: 32, active: 2, needsInput: 3, failed: 5, statusUnknown: 1 },
  perAgent: [{ agentId: "meeting-notes", name: "Meeting notes", runs: 12 }, { agentId: "invoice-checker", name: "Invoice checker", runs: 9 }, { agentId: "lead-scorer", name: "Lead scorer", runs: 7 }, { agentId: "support-triage", name: "Support triage", runs: 4 }],
  cost, recent: recorded<{ runs: Run[] }>("runs.list").body.runs.slice(0, 10),
});
export const Typical: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: 0.0431, basis: "estimate", unknownRuns: 2 })} /></Shell> };
export const CostUnknown: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: null, basis: null, unknownRuns: 32 })} /></Shell> };
export const EmptyStore: Story = { render: () => <Shell active="mission"><MissionControl view={{ agents: 0, runs: { total: 0, active: 0, needsInput: 0, failed: 0, statusUnknown: 0 }, perAgent: [], cost: { usd: null, basis: null, unknownRuns: 0 }, recent: [] }} /></Shell> };
export const Phone: Story = { render: () => <Shell active="mission"><MissionControl view={view({ usd: 1.25, basis: "estimate", unknownRuns: 0 })} /></Shell>, globals: { viewport: { value: "mobile1" } } };

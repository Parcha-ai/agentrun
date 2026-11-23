import type { Meta, StoryObj } from "@storybook/react-vite";
import { LearningTab } from "@/components/Learning";
import type { Client } from "@/lib/client";
import { AGENT, fixtureClient } from "@/lib/learningTab.fixture";

// An agent's Learning tab over invented reads (lib/learningTab.fixture.ts): 80 runs of an invoice sorter, a learned
// workflow that took over at run 21, was held by its audits at run 50 and serves again in a second revision.
const meta: Meta = { title: "Learning" };
export default meta;
type Story = StoryObj;

export const Tab: Story = { render: () => <div className="p-5 md:p-8"><LearningTab agent={AGENT} v2={fixtureClient() as unknown as Client} server="on" /></div> };

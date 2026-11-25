import type { Meta, StoryObj } from "@storybook/react-vite";
import { golden } from "./fixtures/golden";
import type { ShareBundle, ShareSource } from "./bundle";
import { SharePage } from "./SharePage";
import { ShareView } from "./ShareView";

// The share page over the export's golden bundle: the owner's preview with its cuts and footer, one with a restore in
// place, a share host's page (no cuts, no command) and a refusal.
const meta: Meta<typeof ShareView> = { title: "Share page", component: ShareView };
export default meta;
type Story = StoryObj<typeof ShareView>;

const bundle: ShareBundle = golden;
const noop = () => {};
const restoredOne: ShareBundle = {
  ...bundle,
  cuts: bundle.cuts.filter((c) => c.id !== "c_74b434b337661b96"),
  restored: [{ id: "c_74b434b337661b96", at: "/run/title", start: 24, end: 48, rule: "secret-assign", kind: "label" }],
};
const refusing = (status: number): ShareSource => ({ load: async () => ({ ok: false, status }) });

export const Preview: Story = { render: () => <ShareView bundle={bundle} preview={{ runId: "run_golden", onToggle: noop, pending: false }} /> };
export const PreviewWithARestore: Story = { render: () => <ShareView bundle={restoredOne} preview={{ runId: "run_golden", onToggle: noop, pending: false }} /> };
export const ExportingAgain: Story = { render: () => <ShareView bundle={bundle} preview={{ runId: "run_golden", onToggle: noop, pending: true }} /> };
export const ShareHost: Story = { render: () => <ShareView bundle={bundle} /> };
export const FailedClosed: Story = { render: () => <SharePage source={refusing(500)} runId="run_golden" /> };
export const NotEnded: Story = { render: () => <SharePage source={refusing(409)} runId="run_golden" /> };

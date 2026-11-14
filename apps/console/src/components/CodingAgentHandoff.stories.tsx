import type { Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useLayoutEffect } from "react";
import { CodingAgentDialog, CodingAgentHandoff } from "@/components/CodingAgentHandoff";
import { Block, Themes } from "@/design/Themes";
import type { CodingAgentContext } from "@/lib/codingAgentHandoff";

// "… with your coding agent": the three buttons in both themes, and the dialog open for each task. A dialog floats over
// the whole page, so each theme of it is its own story: the page's theme is the one on <html>.
const meta: Meta = { title: "Coding agent handoff" };
export default meta;
type Story = StoryObj;
const noop = () => {};
// The server's default local address, as the Playground's stories show it.
const SERVER = "http://127.0.0.1:7340/v2";
const CONSOLE = "http://127.0.0.1:7340/";

/** Puts `theme` on <html> while the story shows, and the page's own back after it. */
function PageTheme({ theme, children }: { theme: "light" | "dark"; children: ReactNode }) {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const was = html.className;
    html.classList.remove("light", "dark");
    html.classList.add(theme);
    return () => { html.className = was; };
  }, [theme]);
  return <>{children}</>;
}

const RUN: CodingAgentContext = { kind: "run", agentId: "invoice-checker", revision: "rev_7f3a", input: { content: "Check the March invoices against the ledger." } };
const dialog = (context: CodingAgentContext, theme: "light" | "dark") => (
  <PageTheme theme={theme}><CodingAgentDialog open onClose={noop} context={context} serverUrl={SERVER} consoleUrl={CONSOLE} /></PageTheme>
);

export const Buttons: Story = {
  render: () => (
    <Themes>
      <Block title="Where each one sits" note="The agents list (beside New agent), an agent's header (beside Edit) and its run bar (beside the files). Under 640 px the list's and the header's show their icon alone, and the run bar has none.">
        <div className="flex flex-wrap items-center gap-2">
          <CodingAgentHandoff context={{ kind: "create" }} label="Build with your coding agent" size="lg" serverUrl={SERVER} />
          <CodingAgentHandoff context={{ kind: "edit", agentId: "invoice-checker", revision: "rev_7f3a" }} label="Edit with your coding agent" serverUrl={SERVER} />
          <CodingAgentHandoff context={RUN} label="Run with your coding agent" serverUrl={SERVER} />
        </div>
      </Block>
    </Themes>
  ),
};

export const BuildDark: Story = { render: () => dialog({ kind: "create" }, "dark") };
export const BuildLight: Story = { render: () => dialog({ kind: "create" }, "light") };
export const EditDark: Story = { render: () => dialog({ kind: "edit", agentId: "invoice-checker", revision: "rev_7f3a" }, "dark") };
export const EditLight: Story = { render: () => dialog({ kind: "edit", agentId: "invoice-checker", revision: "rev_7f3a" }, "light") };
export const RunDark: Story = { render: () => dialog(RUN, "dark") };
export const RunLight: Story = { render: () => dialog(RUN, "light") };
export const RunPhone: Story = { render: () => dialog(RUN, "light"), globals: { viewport: { value: "mobile1" } } };

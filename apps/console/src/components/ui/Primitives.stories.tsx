import type { Meta, StoryObj } from "@storybook/react";
import { Archive, Bot, Copy, History, LayoutDashboard, MoreHorizontal, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Block, Themes } from "@/design/Themes";
import { Banner, Button, Checkbox, Chip, ConfirmDialog, Dialog, Field, Input, Menu, MenuItem, MenuSeparator, NativeSelect, NavItem, Picker, Radio, Segmented, Spinner, Switch, Tabs, Textarea, Tip, ToastProvider, useToast } from ".";

// Every primitive in every variant and state, in both themes. docs/console-design-system.md says which to reach for.
const meta: Meta = { title: "Design system/Primitives" };
export default meta;
type Story = StoryObj;
const noop = () => {};

export const Buttons: Story = {
  render: () => (
    <Themes>
      <Block title="Variants" note="One solid button a page, for its main action. Outline is the default.">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="solid"><Play aria-hidden /> Run agent</Button>
          <Button variant="primary"><Plus aria-hidden /> New agent</Button>
          <Button>Cancel</Button>
          <Button variant="ghost">Skip</Button>
          <Button variant="destructive"><Trash2 aria-hidden /> Delete</Button>
        </div>
      </Block>
      <Block title="Sizes">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs">xs · Retry</Button><Button size="sm">sm · Copy</Button><Button size="md">md · Save</Button><Button size="lg">lg · Sign in</Button>
          <Button size="icon" aria-label="Copy"><Copy aria-hidden /></Button>
        </div>
      </Block>
      <Block title="Disabled and busy">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="solid" disabled>Run agent</Button><Button disabled>Cancel</Button>
          <Button variant="solid" disabled aria-busy><Spinner className="size-3.5 text-current" /> Saving</Button>
        </div>
      </Block>
    </Themes>
  ),
};

export const Chips: Story = {
  render: () => (
    <Themes>
      <Block title="Tones" note="A fact about a thing: its state or its kind. Never pressed.">
        <div className="flex flex-wrap items-center gap-2">
          <Chip>plain</Chip><Chip tone="muted">muted</Chip><Chip tone="active">working</Chip><Chip tone="success">completed</Chip>
          <Chip tone="warning">needs you</Chip><Chip tone="error">failed</Chip><Chip tone="info">scheduled</Chip>
        </div>
      </Block>
    </Themes>
  ),
};

function FieldsDemo() {
  const [model, setModel] = useState("sonnet");
  const [on, setOn] = useState(true);
  const [place, setPlace] = useState("sandbox");
  const group = useId();
  return (
    <div className="max-w-md space-y-5">
      <Field label="Name" required note="Shown in the agents list."><Input placeholder="e.g., Invoice checker" /></Field>
      <Field label="Cost cap" optional error="Enter an amount in dollars, like 2.50."><Input defaultValue="two dollars" inputMode="decimal" /></Field>
      <Field label="Instructions" warning="Long instructions cost more on every run."><Textarea rows={3} placeholder="Describe what the agent does, how, and its rules." /></Field>
      <Field label="Description"><Input readOnly defaultValue="Read-only: checks invoices against purchase orders" /></Field>
      <Field label="Effort"><NativeSelect defaultValue="medium"><option>low</option><option>medium</option><option>high</option></NativeSelect></Field>
      <div>
        <p id="model-label" className="caps mb-2 text-small font-semibold">Model (Picker)</p>
        <Picker label="Model" value={model} onChange={setModel} className="w-full" options={[{ value: "sonnet", label: "Claude Sonnet" }, { value: "opus", label: "Claude Opus" }, { value: "haiku", label: "Claude Haiku" }]} />
      </div>
      <Field group label="Where it runs" note="A sandbox keeps the agent's files off this machine.">
        <div className="space-y-2">
          <Radio name={group} value="sandbox" checked={place === "sandbox"} onChange={() => setPlace("sandbox")} label="In a sandbox" note="A fresh box for every run." />
          <Radio name={group} value="here" checked={place === "here"} onChange={() => setPlace("here")} label="On this machine" />
          <Radio name={group} value="off" disabled label="On a runner" note="No runner is connected." />
        </div>
      </Field>
      <Checkbox defaultChecked label="Import this machine's sessions" note="Past sessions show under Runs." />
      <div className="flex items-center gap-3 text-body"><Switch checked={on} onChange={setOn} label="Learning" /> Learning is {on ? "on" : "off"}</div>
    </div>
  );
}
export const Fields: Story = { render: () => <Themes><Block title="A form" note="A label names every control. The note and the error are read with it."><FieldsDemo /></Block></Themes> };

export const Banners: Story = {
  render: () => (
    <Themes>
      <Block title="In the page" note="Stays until its cause is gone. Says what happened and what to do.">
        <div className="max-w-xl space-y-3">
          <Banner tone="error" title="The agents could not be read" actions={<Button size="xs">Try again</Button>}>The server answered 503: the store is busy.</Banner>
          <Banner tone="warning" title="Enter these keys again">The server's key changed, so it can no longer read the keys it kept.</Banner>
          <Banner tone="success" title="Imported">214 sessions from this machine are under Runs.</Banner>
          <Banner tone="info" title="A new version is ready">Restart agentrun-serve to take it.</Banner>
          <Banner>No model yet: add a provider's key in Settings to run an agent.</Banner>
        </div>
      </Block>
      <Block title="Across the shell (bar)">
        <Banner bar tone="warning" title="Can't reach agentrun-serve." actions={<Button size="xs">Retry now</Button>}>Reconnecting… next try in 4 s.</Banner>
      </Block>
    </Themes>
  ),
};

function DialogsDemo() {
  const [open, setOpen] = useState<"dialog" | "confirm" | null>(null);
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => setOpen("dialog")}>Open a dialog</Button>
      <Button variant="destructive" onClick={() => setOpen("confirm")}>Delete agent…</Button>
      <Dialog open={open === "dialog"} onClose={() => setOpen(null)} title="New schedule" description="Runs the agent at a time you set."
        footer={<><Button size="sm" onClick={() => setOpen(null)}>Cancel</Button><Button size="sm" variant="solid" onClick={() => setOpen(null)}>Create schedule</Button></>}>
        <Field label="When"><Input placeholder="Every weekday at 9:00" /></Field>
      </Dialog>
      <ConfirmDialog open={open === "confirm"} title="Delete invoice-checker?" confirm="Delete agent" onConfirm={() => setOpen(null)} onCancel={() => setOpen(null)}>
        Its 3 schedules stop and its 41 runs stay under Runs. This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}
export const Dialogs: Story = { render: () => <Themes><Block title="Dialog and ConfirmDialog" note="The keyboard stays inside; Escape closes; the focus returns to the button. A confirm starts on Cancel."><DialogsDemo /></Block></Themes> };

export const Menus: Story = {
  render: () => (
    <Themes>
      <Block title="Menu" note="Actions behind one button. Arrows move, letters jump, Escape closes.">
        <div className="flex gap-2">
          <Menu trigger={<>Actions</>} align="start"><MenuItem icon={Pencil} onSelect={noop}>Edit</MenuItem><MenuItem icon={Copy} onSelect={noop}>Duplicate</MenuItem><MenuItem icon={Archive} onSelect={noop} disabled>Archive</MenuItem><MenuSeparator /><MenuItem icon={Trash2} tone="destructive" onSelect={noop}>Delete</MenuItem></Menu>
          <Menu trigger={<MoreHorizontal aria-hidden />} label="More actions" size="icon" variant="ghost"><MenuItem onSelect={noop}>Copy run id</MenuItem><MenuItem onSelect={noop}>Open in Playground</MenuItem></Menu>
        </div>
      </Block>
    </Themes>
  ),
};

function ToastsDemo() {
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => toast({ title: "Copied" })}>Neutral</Button>
      <Button onClick={() => toast({ tone: "success", title: "Agent saved", description: "Revision 4 is now current." })}>Success</Button>
      <Button onClick={() => toast({ tone: "warning", title: "Saved without a cost cap" })}>Warning</Button>
      <Button onClick={() => toast({ tone: "error", title: "Not saved", description: "The server refused the revision: its name is taken." })}>Error (stays)</Button>
    </div>
  );
}
export const Toasts: Story = { render: () => <ToastProvider><Themes><Block title="Toast" note="A short word that what you just did worked or did not. Leaves after 5 seconds; an error stays until dismissed."><ToastsDemo /></Block></Themes></ToastProvider> };

function NavigationDemo() {
  const [at, setAt] = useState("agents");
  const [tab, setTab] = useState<"overview" | "runs" | "learning">("overview");
  const [range, setRange] = useState<"24h" | "7d" | "30d">("7d");
  const group = useId();
  return (
    <div className="space-y-8">
      <Block title="NavItem" note="The sidebar's places. The one you are on is the brand colour with a 2px bar.">
        <nav aria-label="Example" className="flex w-sidebar flex-col gap-1 border p-3">
          {([["mission", "Mission Control", LayoutDashboard], ["agents", "Agents", Bot], ["runs", "Runs", History]] as const).map(([id, label, icon]) => <NavItem key={id} icon={icon} active={at === id} onClick={() => setAt(id)}>{label}</NavItem>)}
        </nav>
      </Block>
      <Block title="Tabs" note="A page's views. Left and Right move between them.">
        <Tabs label="Agent" value={tab} onChange={setTab} className="px-0 md:px-0" tabs={[{ id: "overview", label: "Overview" }, { id: "runs", label: "Runs" }, { id: "learning", label: "Learning" }]} />
        <p role="tabpanel" aria-label={tab} className="pt-3 text-body text-muted-foreground">The {tab} panel.</p>
      </Block>
      <Block title="Segmented" note="One choice of a few, all in view.">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented label="Range" name={`${group}-range`} value={range} onChange={setRange} options={[{ value: "24h", label: "24 h" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }]} />
          <Segmented label="Range, small" name={`${group}-range-sm`} size="sm" value={range} onChange={setRange} options={[{ value: "24h", label: "24 h" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days", disabled: true }]} />
        </div>
      </Block>
    </div>
  );
}
export const Navigation: Story = { render: () => <Themes><NavigationDemo /></Themes> };

export const Feedback: Story = {
  render: () => (
    <Themes>
      <Block title="Spinner" note="Work with no length to show. Stands still under reduced motion.">
        <div className="flex items-center gap-3 text-body"><Spinner label="Reading the runs" /> Reading the runs…</div>
      </Block>
      <Block title="Tip" note="A few more words on hover and on keyboard focus. Never the only way to learn something.">
        <Tip tip="The most this run may spend before it stops and asks."><Button size="sm">Cost cap</Button></Tip>
      </Block>
    </Themes>
  ),
};

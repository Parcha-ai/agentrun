import type { Meta, StoryObj } from "@storybook/react";
import tokensCss from "../tokens.css?raw";
import { blend, contrast, hslToRgb, readTokens } from "./contrast";
import { Block, Themes } from "./Themes";
import { COLOR_TOKENS, CONTROL_SIZES, DURATIONS, LAYERS, TEXT_PAIRS, TYPE_SCALE } from "./tokens";

// The design system's foundations, drawn from tokens.css itself: what the page shows is what the console ships.
const meta: Meta = { title: "Design system/Foundations" };
export default meta;
type Story = StoryObj;
const values = readTokens(tokensCss);

const GROUP: Record<keyof typeof COLOR_TOKENS, string> = {
  surface: "Surfaces", text: "Text", brand: "Brand", tone: "Tones: the bare name fills, -text is words", line: "Lines", run: "A run", workflow: "The workflow graph: who does a step's work",
};

export const Colours: Story = {
  render: () => (
    <Themes>
      {(Object.keys(COLOR_TOKENS) as (keyof typeof COLOR_TOKENS)[]).map((group) => (
        <Block key={group} title={GROUP[group]}>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {COLOR_TOKENS[group].map((name) => (
              <li key={name} className="border">
                <div className="h-12 border-b" style={{ background: `hsl(var(--${name}))` }} />
                <p className="px-2 pt-1.5 font-mono text-label">--{name}</p>
                <p className="px-2 pb-1.5 font-mono text-micro text-muted-foreground">{values.light[name]} · {values.dark[name]}</p>
              </li>
            ))}
          </ul>
        </Block>
      ))}
    </Themes>
  ),
};

/** Every text pair the test holds to 4.5:1, with its measured ratio in each theme. */
export const Contrast: Story = {
  render: () => (
    <Themes>
      <Block title="Text pairs" note="Each row is set in its own colours. The two numbers are the measured ratios, light then dark; the test fails under 4.5.">
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {TEXT_PAIRS.map(({ text, on, wash }) => {
            const ratio = (theme: "light" | "dark") => { const t = values[theme]; const surface = wash ? blend(hslToRgb(t[wash]!), hslToRgb(t[on]!), 0.1) : hslToRgb(t[on]!); return contrast(hslToRgb(t[text]!), surface).toFixed(1); };
            return (
              <li key={`${text}/${on}/${wash ?? ""}`} className="flex items-center justify-between gap-3 border px-2 py-1.5 font-mono text-label"
                style={{ color: `hsl(var(--${text}))`, background: wash ? `hsl(var(--${wash}) / 0.1)` : `hsl(var(--${on}))` }}>
                <span>{text} on {wash ? `${wash}/10` : on}</span><span>{ratio("light")} · {ratio("dark")}</span>
              </li>
            );
          })}
        </ul>
      </Block>
    </Themes>
  ),
};

export const Type: Story = {
  render: () => (
    <Themes>
      <Block title="Two families" note="Mono for structure: headings of data, labels, buttons, chips, ids, code. Sans for prose: sentences someone reads. Two weights, 400 and 600.">
        <p className="font-mono text-lead">JetBrains Mono 400 <span className="font-semibold">and 600</span> · run_01JC8 · $0.42</p>
        <p className="mt-1 font-sans text-lead">Schibsted Grotesk 400 <span className="font-semibold">and 600</span>. The agent read the page and answered.</p>
        <p className="caps mt-3 text-small">.caps: mono, uppercase, tracked. Buttons, tabs, chips, labels.</p>
      </Block>
      <Block title="The scale" note="A class per step. Nothing in the console is set at a size between two steps.">
        <ul className="divide-y border">
          {TYPE_SCALE.map((t) => (
            <li key={t.name} className="flex items-baseline gap-4 px-3 py-2">
              <span className="w-28 shrink-0 font-mono text-label text-muted-foreground">text-{t.name} · {t.px}px</span>
              <span className="min-w-0 flex-1 truncate" style={{ fontSize: `${t.px}px` }}>{t.use}</span>
            </li>
          ))}
        </ul>
      </Block>
    </Themes>
  ),
};

export const SizeAndSpace: Story = {
  render: () => (
    <Themes>
      <Block title="Control heights" note="A control is one of three heights. Buttons, fields and pickers in one row share one.">
        <ul className="flex flex-wrap items-end gap-3">
          {CONTROL_SIZES.map((c) => (
            <li key={c.name} className="w-52">
              <div className="caps flex items-center border px-3 text-small" style={{ height: `var(--control-${c.name})` }}>{c.name} · {values.light[`control-${c.name}`]}</div>
              <p className="mt-1 text-small text-muted-foreground">{c.use}</p>
            </li>
          ))}
        </ul>
      </Block>
      <Block title="Space" note="Tailwind's 4px steps, and these habits: a page's gutter is p-5, md:p-8; panels sit gap-6 apart; a panel's own padding is p-4; things in a row are gap-2 or gap-3.">
        <ul className="space-y-1.5">
          {[1, 2, 3, 4, 5, 6, 8].map((n) => <li key={n} className="flex items-center gap-3 font-mono text-label"><span className="w-20 text-muted-foreground">{n} · {n * 4}px</span><span className="h-3 bg-primary" style={{ width: `${n * 4}px` }} /></li>)}
        </ul>
      </Block>
      <Block title="Lines and corners" note="Every line is 1px. 2px marks where you are and where the keyboard is. Every corner is square.">
        <div className="flex flex-wrap items-center gap-4 font-mono text-label">
          <span className="border px-3 py-2">border</span>
          <span className="border border-border-strong px-3 py-2">border-strong</span>
          <span className="border border-input px-3 py-2">input</span>
          <span className="border-b-2 border-primary px-3 py-2 text-primary-text">here</span>
          <span className="px-3 py-2 outline outline-focus outline-offset-focus outline-ring">focus</span>
        </div>
      </Block>
      <Block title="Layers, lowest first">
        <ul className="divide-y border">
          {LAYERS.map((l) => <li key={l.name} className="flex gap-4 px-3 py-2 text-small"><span className="w-28 shrink-0 font-mono text-label text-muted-foreground">z-{l.name} · {values.light[`layer-${l.name}`]}</span>{l.use}</li>)}
        </ul>
      </Block>
    </Themes>
  ),
};

export const Motion: Story = {
  render: () => (
    <Themes>
      <Block title="Durations" note="Hover a bar. With reduced motion asked for in the OS, every one is a cut.">
        <ul className="space-y-3">
          {DURATIONS.map((d) => (
            <li key={d.name} className="group">
              <p className="font-mono text-label text-muted-foreground">duration-{d.name} · {values.light[`duration-${d.name}`]} · {d.use}</p>
              <div className="mt-1 h-3 w-8 bg-primary transition-[width] group-hover:w-full" style={{ transitionDuration: `var(--duration-${d.name})` }} />
            </li>
          ))}
        </ul>
      </Block>
      <Block title="The one shadow" note="Only under what floats over the page.">
        <div className="inline-block border border-border-strong bg-card px-4 py-3 text-small shadow-float">shadow-float</div>
      </Block>
    </Themes>
  ),
};

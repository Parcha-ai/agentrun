import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
// The export route's own golden bundle (serve's run-export test writes and checks it): what this page renders is what
// GET /v2/runs/{id}/export answers, with a planted value of every kind cut. Synthetic, made from fixed seeds.
import golden from "../../../../packages/serve/test/fixtures/run-export/golden.json";
import { ShareView } from "./ShareView";
import { publishCommand, placeOf, type ShareBundle } from "./bundle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const bundle = golden as unknown as ShareBundle;
const RESTORABLE = bundle.cuts.filter((c) => c.restorable);

function mount(props: Partial<Parameters<typeof ShareView>[0]> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const onToggle = vi.fn();
  act(() => root!.render(createElement(ShareView, { bundle, preview: { runId: "run_golden", onToggle, pending: false }, ...props })));
  return { host, onToggle };
}
const tab = (host: HTMLElement, name: RegExp) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => name.test(b.textContent ?? ""));
  if (!button) throw new Error(`no tab ${name}`);
  act(() => button.click());
};

describe("ShareView over the golden bundle", () => {
  it("draws the run from the bundle alone: its title, agent, status, answer, steps and files, the omitted ones named", () => {
    const { host } = mount();
    const text = () => host.textContent ?? "";
    expect(host.querySelector("h1")?.textContent).toBe(bundle.run.title);
    expect(text()).toContain("Golden agent");
    expect(text()).toContain("Completed");
    // The Report: the run's final answer, as the export cut it.
    // A home's user is cut to `<user>`, the scrubber's replacement, so the path keeps its shape (no marker, no chip).
    expect(text()).toContain("Done. Mail [redacted:email] about /home/<user>/work; key [redacted:sk-key].");
    tab(host, /timeline/i);
    expect(text()).toContain("Connect with PGPASSWORD=[redacted:secret-assign] psql -h db");
    expect(text()).toContain("The host [redacted:private-ip] answered");
    tab(host, /files/i);
    expect(text()).toContain("out/notes.txt");
    expect(text()).toContain("out/report.md");
    expect(text()).toContain("out/shot.png");
    expect(text()).toMatch(/binary/i);
    // A file opens as text in the page, never as a page of its own: no link leaves it, no frame holds it.
    const open = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("out/report.md"))!;
    act(() => open.click());
    expect(host.querySelector("pre")?.textContent).toBe(bundle.files[1]!.content);
    expect(host.querySelector("iframe, a[href^='/'], a[href^='http']")).toBeNull();
  });

  it("draws every [redacted:…] marker as a chip, a dump's line count with it, the words kept as the bundle has them", () => {
    const { host } = mount();
    const panelChips = () => [...host.querySelector('[role="tabpanel"]')!.querySelectorAll(".redaction")].map((c) => c.textContent);
    expect(host.querySelector("h1 .redaction")?.textContent).toBe("[redacted:secret-assign]");
    tab(host, /timeline/i);
    const chips = panelChips();
    expect(chips).toContain("[redacted:secret-assign]");
    expect(chips).toContain("[redacted:env-dump 4 lines]");
    tab(host, /report/i);
    expect(panelChips()).toEqual(["[redacted:email]", "[redacted:sk-key]"]);
  });

  it("lists the cuts by kind with their counts; a restore switch for each label or personal cut and for no other", () => {
    const { host } = mount();
    const panel = host.querySelector<HTMLElement>('[aria-label="Cuts"]')!;
    const group = (kind: string) => panel.querySelector<HTMLElement>(`[data-kind="${kind}"]`)!;
    const counts = Object.fromEntries([...panel.querySelectorAll<HTMLElement>("[data-kind]")].map((g) => [g.dataset.kind, Number(g.querySelector("[data-count]")?.textContent)]));
    expect(counts).toEqual({ personal: 13, label: 3, format: 9, held: 2, dump: 2 });
    const switches = [...panel.querySelectorAll<HTMLElement>('[role="switch"]')];
    expect(switches).toHaveLength(RESTORABLE.length);
    expect(switches.map((s) => s.closest<HTMLElement>("[data-cut]")!.dataset.cut).sort()).toEqual(RESTORABLE.map((c) => c.id).sort());
    for (const kind of ["format", "held", "dump"]) {
      expect(group(kind).querySelector('[role="switch"]'), kind).toBeNull();
      expect(group(kind).querySelectorAll("[data-locked]").length, kind).toBe(bundle.cuts.filter((c) => c.kind === kind).length);
    }
    expect(group("format").textContent).toContain("A known key format: never published.");
    expect(group("held").textContent).toContain("A value this server holds: never published.");
    expect(group("dump").textContent).toMatch(/dump: never published\./);
    // A cut says where it is and what it was, by its shape alone: never a value.
    expect(group("personal").textContent).toContain("email[32]");
    expect(group("personal").textContent).toContain("Timeline step 1");
  });

  it("each cut shows its pointer and span, and one value's cuts in a step's summary and text sit together", () => {
    const { host } = mount();
    const row = (id: string) => host.querySelector<HTMLElement>(`[data-cut="${id}"]`)!;
    expect(row("c_4bc2de29bab2912d").querySelector("[data-pointer]")?.textContent).toBe("/rows/3/summary 9–30");
    expect(row("c_2ee7ed2a38cba84e").querySelector("[data-pointer]")?.textContent).toBe("/rows/3/text 9–30");
    const personal = [...host.querySelectorAll<HTMLElement>('[data-kind="personal"] [data-cut]')].map((li) => li.dataset.cut);
    // Step 4's private address in its summary and its text, then its home folder in both: one value, then the next.
    const at = personal.indexOf("c_4bc2de29bab2912d");
    expect(personal.slice(at, at + 4)).toEqual(["c_4bc2de29bab2912d", "c_2ee7ed2a38cba84e", "c_12243d656f8c82d5", "c_3e45833dfce59dde"]);
  });

  it("a switch asks for its cut: on for a cut, off for a restored one", () => {
    const restored = { ...bundle, cuts: bundle.cuts.filter((c) => c.id !== "c_05af703d64842a4a"), restored: [{ id: "c_05af703d64842a4a", at: "/rows/0/summary", start: 71, end: 87, rule: "email", kind: "personal" as const }] };
    const { host, onToggle } = mount({ bundle: restored });
    const of = (id: string) => host.querySelector<HTMLButtonElement>(`[data-cut="${id}"] [role="switch"]`)!;
    expect(of("c_05af703d64842a4a").getAttribute("aria-checked")).toBe("true");
    act(() => of("c_05af703d64842a4a").click());
    expect(onToggle).toHaveBeenLastCalledWith("c_05af703d64842a4a", false);
    act(() => of("c_66ac6506a31fb0a3").click());
    expect(onToggle).toHaveBeenLastCalledWith("c_66ac6506a31fb0a3", true);
  });

  it("a bundle that marks a format, held or dump cut restorable still gets no switch for it", () => {
    const forged = { ...bundle, cuts: bundle.cuts.map((c) => ({ ...c, restorable: true })) };
    const { host } = mount({ bundle: forged });
    const switches = [...host.querySelectorAll<HTMLElement>('[role="switch"]')].map((s) => s.closest<HTMLElement>("[data-cut]")!.dataset.cut);
    expect(switches.sort()).toEqual(bundle.cuts.filter((c) => c.kind === "label" || c.kind === "personal").map((c) => c.id).sort());
  });

  it("the footer: nothing was sent, the bundle's sha256, and the exact command that publishes it", () => {
    const { host } = mount();
    const footer = host.querySelector("footer")!;
    expect(footer.textContent).toContain("Nothing was sent. This is the exact page a share host would show.");
    expect(footer.textContent).toContain(bundle.sha256);
    expect(footer.querySelector("code")?.textContent).toBe(`agentrun share run_golden --expect ${bundle.sha256}`);
  });

  it("without a preview (a share host's page) there is no cut panel and no command", () => {
    const { host } = mount({ preview: undefined });
    expect(host.querySelector('[aria-label="Cuts"]')).toBeNull();
    expect(host.querySelector('[role="switch"]')).toBeNull();
    expect(host.textContent).not.toContain("agentrun share");
    expect(host.querySelector("h1")?.textContent).toBe(bundle.run.title);
  });
});

describe("the publish command and a cut's place", () => {
  it("names the run, the restored ids as the bundle lists them, and the sha256 to expect", () => {
    const restored = [{ id: "c_0000000000000002" }, { id: "c_0000000000000001" }] as ShareBundle["restored"];
    expect(publishCommand("run_1", { ...bundle, restored })).toBe(`agentrun share run_1 --restore c_0000000000000002,c_0000000000000001 --expect ${bundle.sha256}`);
    expect(publishCommand("run_1", { ...bundle, restored: [] })).toBe(`agentrun share run_1 --expect ${bundle.sha256}`);
  });

  it("says where a pointer is in words a person reads", () => {
    expect(placeOf("/rows/3/text", bundle)).toBe("Timeline step 4 · text");
    expect(placeOf("/run/title", bundle)).toBe("Run title");
    expect(placeOf("/run/result/final_answer", bundle)).toBe("Answer");
    expect(placeOf("/files/1/content", bundle)).toBe("out/report.md");
    expect(placeOf("/agent/name", bundle)).toBe("Agent name");
    expect(placeOf("/graph/nodes/a~1b/output", bundle)).toBe("Graph · nodes/a/b/output");
  });
});

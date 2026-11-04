import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NeedsYou, StartHereFirstRun, StartHereNoModel } from "./MissionControl.stories";

// Mission Control's stories of what needs a person and of a first run, rendered as Storybook draws them.
const html = (story: { render?: unknown }) => renderToStaticMarkup((story.render as () => ReactElement)());

describe("the Mission Control stories", () => {
  it("NeedsYou: the questions with their choices, the failures said once, the live run, then the counts", () => {
    const h = html(NeedsYou);
    expect(h).toContain("Needs you");
    expect(h).toContain(">$25,000 preferred tier<");
    expect(h).toContain("2 runs failed");
    expect(h).toContain("Running now");
    expect(h.indexOf("Needs you")).toBeLessThan(h.indexOf("Needs input"));
  });
  it("StartHereFirstRun: the three templates, one click each, and the imported history", () => {
    const h = html(StartHereFirstRun);
    expect(h.match(/>Try it</g)).toHaveLength(3);
    expect(h).toContain("6 imported sessions");
    expect(h).not.toContain("Recent runs");
  });
  it("StartHereNoModel: the model step first, no template", () => {
    const h = html(StartHereNoModel);
    expect(h).toContain("Add a model key");
    expect(h).not.toContain(">Try it<");
  });
});

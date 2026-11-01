import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("reads a paused workflow run as Paused", () => {
    expect(renderToStaticMarkup(createElement(StatusBadge, { run: { status: "paused", state: "idle", kind: "workflow" } }))).toContain("Paused");
  });
});

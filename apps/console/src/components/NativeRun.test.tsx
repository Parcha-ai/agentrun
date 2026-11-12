import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { NativeRun } from "./NativeRun";
it("keeps native task usage separate from reflection, unknown prices unknown, and identifies pinned configuration and learning", () => {
  const html = renderToStaticMarkup(createElement(NativeRun, { native: { runtime: "codex", project: "/workspace/app", selector: { kind: "profile", name: "review" }, machine_id: "source", fingerprint: "cfg123", session_id: "native-session", model: "native-model", learning_revision: "learning123", model_requests: null, usage: { task: { input_tokens: 100, output_tokens: 20, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null }, reflection: [{ input_tokens: 30, output_tokens: 10, cache_read_tokens: null, cache_write_tokens: null, cost_usd: 0.04 }] } } }));
  for (const value of ["native-session", "native-model", "Profile: review", "learning123", "cfg123", "Task usage", "Reflection usage", "100", "$0.04", "Unknown"]) expect(html).toContain(value);
  expect(html).not.toContain("$0.00");
  expect(html).toContain("Grading usage");
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { NativeRun } from "./NativeRun";
it("keeps native task usage separate from reflection, unknown prices unknown, and identifies pinned configuration and learning", () => {
  const html = renderToStaticMarkup(createElement(NativeRun, { native: { runtime: "codex", project: "/workspace/app", selector: { kind: "profile", name: "review" }, machine_id: "source", fingerprint: "cfg123", session_id: "native-session", model: "native-model", learning_revision: "learning123", model_requests: null, usage: { task: { input_tokens: 100, output_tokens: 20, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null }, reflection: [{ input_tokens: 30, output_tokens: 10, cache_read_tokens: null, cache_write_tokens: null, cost_usd: 0.04 }] } } }));
  for (const value of ["native-session", "native-model", "Profile: review", "learning123", "cfg123", "Task usage", "Reflection usage", "20", "$0.04", "Unknown"]) expect(html).toContain(value);
  expect(html).not.toContain(">100<");
  expect(html).not.toContain("$0.00");
  expect(html).toContain("Grading usage");
});

import { RunDetail } from "./RunDetail";
import { NeedsYouStrip } from "./NeedsYouStrip";
import { messageFeatures, runFixture } from "@/fixtures";
import type { Run } from "@/lib/v2";
const nativeMetadata: NonNullable<Run["native"]> = { runtime: "codex", project: "/fixture/project", selector: { kind: "project" }, machine_id: "source", fingerprint: "config", session_id: "session", model: null, learning_revision: null, usage: { task: null, reflection: [] }, model_requests: null };
it("keeps native stop/cancel controls while offering no in-session composer or Mission Control steering", () => {
  const source = runFixture("run.completed.idle.1").run;
  for (const status of ["working", "completed", "input_required"] as const) {
    const run: Run = { ...source, kind: "agentic", native: nativeMetadata, status, state: status === "working" ? "working" : "idle" };
    const html = renderToStaticMarkup(createElement(RunDetail, { run, agentName: "Native", messages: messageFeatures, harnessSteers: true, rows: [], files: [], onMessage: () => {}, actions: { onStop: () => {}, onCancel: () => {} } }));
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Start a new native run");
    if (status === "working") { expect(html).toContain("Cancel run"); expect([...new DOMParser().parseFromString(html, "text/html").querySelectorAll("button")].map((button) => button.textContent?.trim())).toContain("Stop"); }
  }
  const live: Run = { ...source, kind: "agentic", native: nativeMetadata, status: "working", state: "working" };
  const html = renderToStaticMarkup(createElement(NeedsYouStrip, { asking: [], failed: [], live: [live], agentName: () => "Native", onAnswer: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null }));
  expect(html).not.toContain(">Steer</a>");
  expect([...new DOMParser().parseFromString(html, "text/html").querySelectorAll("button")].map((button) => button.textContent?.trim())).toContain("Stop");
});


it.each([
  { runtime: "codex", taskInput: 100, reflectionInput: 60 },
  { runtime: "claude-code", taskInput: 70, reflectionInput: 40 },
])("$runtime separates uncached input from cache reads for task and reflection", ({ runtime, taskInput, reflectionInput }) => {
  const native = { ...nativeMetadata, runtime, usage: {
    task: { input_tokens: taskInput, output_tokens: 12, cache_read_tokens: 30, cache_write_tokens: 0, cost_usd: null },
    reflection: [{ input_tokens: reflectionInput, output_tokens: 4, cache_read_tokens: 20, cache_write_tokens: 0, cost_usd: null }],
  } };
  const html = renderToStaticMarkup(createElement(NativeRun, { native }));
  const document = new DOMParser().parseFromString(html, "text/html");
  expect([...document.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["Phase", "Uncached input", "Output tokens", "Cache read", "Cache write", "Cost"]);
  expect([...document.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("th,td")].map((cell) => cell.textContent))).toEqual([
    ["Task usage", "70", "12", "30", "0", "Unknown"],
    ["Reflection usage · turn 1", "40", "4", "20", "0", "Unknown"],
  ]);
});

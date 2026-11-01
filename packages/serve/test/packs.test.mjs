// A profile pack on its own: the shape packIssues takes, and what resolvePack makes of a pack for an effort and an
// output type. No server, no run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { MAX_OUTPUT_FILE, MAX_PACK_OUTPUTS, MAX_PACK_SKILLS, packIssues, resolvePack } from "../dist/packs.js";

const CONTRACT = JSON.parse(await readFile(new URL("../src/openapi/agentrun-v2.openapi.json", import.meta.url), "utf8"));
const REASONS = CONTRACT.components.schemas.InputIssue.properties.reason.enum;

const pack = () => ({
  version: 1,
  name: "default",
  effort: {
    low: { skills: ["quick-look"], thinking: "low" },
    medium: { skills: ["web-research", "cite-sources"] },
    high: { skills: ["web-research", "deep-dive", "cite-sources"], thinking: "xhigh" },
  },
  outputs: {
    report: { skills: ["write-report", "cite-sources"], file: "report.md", effort: { low: { skills: ["write-brief"] } } },
    memo: { skills: ["write-memo"] },
  },
  default_output: "report",
});

/** The pack with `edit` applied to a fresh copy. */
const edited = (edit) => {
  const p = pack();
  edit(p);
  return p;
};

/** [field, reason] pairs in code point order of field, then reason. */
const byField = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

/** Each issue as [field, reason], sorted, after checking every issue has the contract's shape. */
const refusals = (value, options) => {
  const issues = packIssues(value, options);
  for (const i of issues) {
    assert.deepEqual(Object.keys(i).filter((k) => !["field", "reason", "message", "fix"].includes(k)), [], `only the contract's keys: ${JSON.stringify(i)}`);
    assert.equal(typeof i.field, "string");
    assert.ok(REASONS.includes(i.reason), `${i.reason} is a reason the contract lists`);
    assert.ok(typeof i.message === "string" && i.message.length > 0, `a message for ${i.field}`);
  }
  return issues.map((i) => [i.field, i.reason]).sort(byField);
};

test("a valid pack has no issues, and neither does a bare one: empty lists, no thinking, no outputs", () => {
  assert.deepEqual(packIssues(pack()), []);
  const bare = { version: 1, name: "bare", effort: { low: { skills: [] }, medium: { skills: [] }, high: { skills: [] } }, outputs: {} };
  assert.deepEqual(packIssues(bare), []);
});

test("a skill name is lowercase letters, digits and dashes, at most 64: the longest one passes", () => {
  assert.deepEqual(packIssues(edited((p) => (p.effort.low.skills = ["web-research", "9-steps", "r2d2", `s${"-".repeat(63)}`]))), []);
});

test("each effort resolves to its row's skills, then the output's writer skills, with its row's thinking", () => {
  assert.deepEqual(resolvePack(pack(), { effort: "low" }), {
    effort: "low",
    thinking: "low",
    skills: ["quick-look", "write-brief"],
    output: { type: "report", file: "report.md" },
  });
  assert.deepEqual(resolvePack(pack(), { effort: "medium" }), {
    effort: "medium",
    skills: ["web-research", "cite-sources", "write-report"],
    output: { type: "report", file: "report.md" },
  });
  assert.deepEqual(resolvePack(pack(), { effort: "high" }), {
    effort: "high",
    thinking: "xhigh",
    skills: ["web-research", "deep-dive", "cite-sources", "write-report"],
    output: { type: "report", file: "report.md" },
  });
});

test("effort defaults to medium, and a row with no thinking leaves thinking out", () => {
  const resolved = resolvePack(pack());
  assert.equal(resolved.effort, "medium");
  assert.equal("thinking" in resolved, false, "absent, so the caller falls back to its own thinking level");
  assert.deepEqual(resolvePack(pack(), {}), resolved);
});

test("the asked output wins over default_output; an output with no file has none in the result", () => {
  assert.deepEqual(resolvePack(pack(), { output: "memo" }), {
    effort: "medium",
    skills: ["web-research", "cite-sources", "write-memo"],
    output: { type: "memo" },
  });
});

test("with no output asked and no default_output there is no output and no writer", () => {
  const p = edited((p) => delete p.default_output);
  assert.deepEqual(packIssues(p), []);
  assert.deepEqual(resolvePack(p, { effort: "high" }), { effort: "high", thinking: "xhigh", skills: ["web-research", "deep-dive", "cite-sources"] });
});

test("an output's per-effort skills replace its writer skills at that effort only", () => {
  assert.deepEqual(resolvePack(pack(), { effort: "low", output: "report" }).skills, ["quick-look", "write-brief"]);
  assert.deepEqual(resolvePack(pack(), { effort: "high", output: "report" }).skills, ["web-research", "deep-dive", "cite-sources", "write-report"]);
});

test("skills are de-duplicated keeping each one's first place, in order", () => {
  const p = edited((p) => {
    p.effort.medium.skills = ["a", "b"];
    p.outputs.memo.skills = ["b", "c", "a", "d"];
  });
  assert.deepEqual(resolvePack(p, { output: "memo" }).skills, ["a", "b", "c", "d"]);
});

test("resolvePack leaves the pack as it was, and its result shares no list with it", () => {
  const p = pack();
  const resolved = resolvePack(p, { effort: "high" });
  resolved.skills.push("extra");
  assert.deepEqual(p, pack());
});

test("an output type the pack does not name is not_an_option on output, naming the pack's types", () => {
  for (const output of ["slides", "constructor", "toString", "__proto__"]) {
    const resolved = resolvePack(pack(), { output });
    assert.deepEqual(resolved.issues.map((i) => [i.field, i.reason]), [["output", "not_an_option"]], output);
    assert.match(resolved.issues[0].message, /report/);
    assert.match(resolved.issues[0].message, /memo/);
  }
  const none = resolvePack(edited((p) => {
    p.outputs = {};
    delete p.default_output;
  }), { output: "report" });
  assert.deepEqual(none.issues.map((i) => [i.field, i.reason]), [["output", "not_an_option"]]);
});

test("an effort that is not one is not_an_option on effort, reported with a bad output", () => {
  const resolved = resolvePack(pack(), { effort: "max", output: "slides" });
  assert.deepEqual(resolved.issues.map((i) => [i.field, i.reason]).sort(), [["effort", "not_an_option"], ["output", "not_an_option"]]);
  assert.deepEqual(resolvePack(pack(), { output: 7 }).issues.map((i) => [i.field, i.reason]), [["output", "wrong_type"]]);
});

test("a pack that is not an object is wrong_type at the pack itself", () => {
  for (const value of [undefined, null, [], "pack", 1]) {
    assert.deepEqual(refusals(value, { at: "profile" }), [["profile", value === undefined ? "missing" : "wrong_type"]], JSON.stringify(value));
  }
});

test("unknown keys are refused at every level", () => {
  const p = edited((p) => {
    p.extra = true;
    p.effort.extreme = { skills: [] };
    p.effort.low.extra = 1;
    p.outputs.report.extra = 1;
    p.outputs.report.effort.extreme = { skills: [] };
    p.outputs.report.effort.low.thinking = "high";
  });
  assert.deepEqual(refusals(p), [
    ["effort.extreme", "not_allowed"],
    ["effort.low.extra", "not_allowed"],
    ["extra", "not_allowed"],
    ["outputs.report.effort.extreme", "not_allowed"],
    ["outputs.report.effort.low.thinking", "not_allowed"],
    ["outputs.report.extra", "not_allowed"],
  ]);
});

test("each required field is missing by name: version, name, effort, outputs, each effort row, each list of skills", () => {
  assert.deepEqual(refusals({}), [["effort", "missing"], ["name", "missing"], ["outputs", "missing"], ["version", "missing"]]);
  const p = edited((p) => {
    delete p.effort.medium;
    delete p.effort.low.skills;
    delete p.outputs.memo.skills;
    p.outputs.report.effort.low = {};
  });
  assert.deepEqual(refusals(p), [
    ["effort.low.skills", "missing"],
    ["effort.medium", "missing"],
    ["outputs.memo.skills", "missing"],
    ["outputs.report.effort.low.skills", "missing"],
  ]);
});

test("version is 1", () => {
  assert.deepEqual(refusals(edited((p) => (p.version = 2))), [["version", "not_an_option"]]);
  assert.deepEqual(refusals(edited((p) => (p.version = "1"))), [["version", "wrong_type"]]);
});

test("values of the wrong type are wrong_type where they are", () => {
  const p = edited((p) => {
    p.name = 7;
    p.effort.low = [];
    p.effort.medium.skills = "web-research";
    p.effort.high.skills = ["web-research", 7];
    p.outputs.report.file = 7;
    p.outputs.report.effort = [];
    p.outputs.memo = "write-memo";
    p.default_output = 7;
  });
  assert.deepEqual(refusals(p), [
    ["default_output", "wrong_type"],
    ["effort.high.skills[1]", "wrong_type"],
    ["effort.low", "wrong_type"],
    ["effort.medium.skills", "wrong_type"],
    ["name", "wrong_type"],
    ["outputs.memo", "wrong_type"],
    ["outputs.report.effort", "wrong_type"],
    ["outputs.report.file", "wrong_type"],
  ]);
  assert.deepEqual(refusals(edited((p) => (p.effort = []))), [["effort", "wrong_type"]]);
  assert.deepEqual(refusals(edited((p) => {
    p.outputs = [];
    delete p.default_output;
  })), [["outputs", "wrong_type"]]);
});

test("a pack name is lowercase letters, digits and dashes, at most 64", () => {
  for (const name of ["", "Default", "my_pack", "-pack", "a".repeat(65), "pack name"]) assert.deepEqual(refusals(edited((p) => (p.name = name))), [["name", "bad_format"]], name);
  assert.deepEqual(packIssues(edited((p) => (p.name = `9${"a".repeat(63)}`))), []);
});

test("an output type is lowercase letters, digits, dashes and underscores, at most 64", () => {
  for (const type of ["Report", "-report", "_report", "a".repeat(65), "re port"]) {
    assert.deepEqual(refusals(edited((p) => {
      p.outputs[type] = { skills: [] };
    })), [[`outputs.${type}`, "bad_format"]], type);
  }
  assert.deepEqual(packIssues(edited((p) => (p.outputs.long_form = { skills: [] }))), []);
});

test("a skill name outside the strict name rule is bad_format, by its place in the list", () => {
  const nested = "research/deep-dive";
  const spaced = "web research";
  const dotted = ".hidden";
  const upper = "Web-Research";
  const bad = [nested, spaced, dotted, upper, "", "-lead", "under_score", "s".repeat(65), "/abs", "../up", "a/../b", ".", "a\\b", "a\u0000b", "a\n"];
  assert.deepEqual(refusals(edited((p) => (p.effort.low.skills = bad))), bad.map((_, i) => [`effort.low.skills[${i}]`, "bad_format"]).sort(byField));
  assert.deepEqual(refusals(edited((p) => (p.outputs.report.effort.low.skills = ["../up"]))), [["outputs.report.effort.low.skills[0]", "bad_format"]]);
});

test("a skill named twice in one list is a duplicate at its second place", () => {
  assert.deepEqual(refusals(edited((p) => (p.effort.high.skills = ["a", "b", "a"]))), [["effort.high.skills[2]", "duplicate"]]);
  assert.deepEqual(refusals(edited((p) => (p.outputs.memo.skills = ["w", "w"]))), [["outputs.memo.skills[1]", "duplicate"]]);
});

test("thinking is one of serve's thinking levels, never off", () => {
  for (const thinking of ["off", "minimal", "none", 3]) assert.deepEqual(refusals(edited((p) => (p.effort.medium.thinking = thinking))), [["effort.medium.thinking", "not_an_option"]], String(thinking));
  for (const thinking of ["low", "medium", "high", "xhigh", "max"]) assert.deepEqual(packIssues(edited((p) => (p.effort.medium.thinking = thinking))), [], thinking);
});

test("an output file is a plain relative path in the workspace", () => {
  for (const file of ["", "/report.md", "../report.md", "out/../report.md", "out//report.md", "out/", "./report.md", ".report.md", "out/.git/x", "out\\report.md", "out\u0000.md", "."]) {
    assert.deepEqual(refusals(edited((p) => (p.outputs.report.file = file))), [["outputs.report.file", "bad_format"]], JSON.stringify(file));
  }
  for (const file of ["report.md", "out/report.md", "out/v1.2/report.final.md"]) assert.deepEqual(packIssues(edited((p) => (p.outputs.report.file = file))), [], file);
  assert.deepEqual(packIssues(edited((p) => (p.outputs.report.file = "f".repeat(MAX_OUTPUT_FILE)))), []);
  assert.deepEqual(refusals(edited((p) => (p.outputs.report.file = "f".repeat(MAX_OUTPUT_FILE + 1)))), [["outputs.report.file", "too_long"]]);
});

test("default_output names one of the pack's outputs", () => {
  for (const name of ["slides", "constructor", "toString"]) assert.deepEqual(refusals(edited((p) => (p.default_output = name))), [["default_output", "not_an_option"]], name);
});

test("lists and outputs are bounded", () => {
  assert.equal(MAX_PACK_SKILLS, 32);
  assert.equal(MAX_PACK_OUTPUTS, 32);
  assert.equal(MAX_OUTPUT_FILE, 512);
  const skills = (n) => Array.from({ length: n }, (_, i) => `skill-${i}`);
  assert.deepEqual(packIssues(edited((p) => (p.effort.low.skills = skills(MAX_PACK_SKILLS)))), []);
  assert.deepEqual(refusals(edited((p) => (p.effort.low.skills = skills(MAX_PACK_SKILLS + 1)))), [["effort.low.skills", "too_many"]]);
  assert.deepEqual(refusals(edited((p) => (p.outputs.memo.skills = skills(MAX_PACK_SKILLS + 1)))), [["outputs.memo.skills", "too_many"]]);
  assert.deepEqual(refusals(edited((p) => (p.outputs.report.effort.low.skills = skills(MAX_PACK_SKILLS + 1)))), [["outputs.report.effort.low.skills", "too_many"]]);
  const outputs = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`out-${i}`, { skills: [] }]));
  assert.deepEqual(packIssues(edited((p) => (p.outputs = { ...outputs(MAX_PACK_OUTPUTS - 1), report: { skills: [] } }))), []);
  assert.deepEqual(refusals(edited((p) => (p.outputs = { ...outputs(MAX_PACK_OUTPUTS), report: { skills: [] } }))), [["outputs", "too_many"]]);
});

test("a list or outputs over its limit still has its items up to the limit checked, and none past it", () => {
  const skills = (n) => Array.from({ length: n }, (_, i) => `skill-${i}`);
  const badFirst = skills(MAX_PACK_SKILLS + 1);
  badFirst[0] = "../bad";
  assert.deepEqual(refusals(edited((p) => (p.effort.low.skills = badFirst))), [["effort.low.skills", "too_many"], ["effort.low.skills[0]", "bad_format"]]);
  const badLast = skills(MAX_PACK_SKILLS + 1);
  badLast[MAX_PACK_SKILLS] = "../bad";
  assert.deepEqual(refusals(edited((p) => (p.effort.low.skills = badLast))), [["effort.low.skills", "too_many"]], "the item past the limit is not checked");
  const outputs = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`out-${i}`, { skills: [] }]));
  const firstBad = { report: { skills: [], file: "/abs" }, ...outputs(MAX_PACK_OUTPUTS) };
  assert.deepEqual(refusals(edited((p) => (p.outputs = firstBad))), [["outputs", "too_many"], ["outputs.report.file", "bad_format"]]);
  const lastBad = { report: { skills: [] }, ...outputs(MAX_PACK_OUTPUTS - 1), late: { skills: [], file: "/abs" } };
  assert.deepEqual(refusals(edited((p) => (p.outputs = lastBad))), [["outputs", "too_many"]], "the output past the limit is not checked");
});

test("every issue is collected, not only the first", () => {
  const p = edited((p) => {
    p.version = 2;
    p.name = "Bad";
    p.effort.low.skills = ["../x"];
    p.effort.medium.thinking = "off";
    p.outputs.report.file = "/abs";
    p.default_output = "slides";
  });
  assert.deepEqual(refusals(p), [
    ["default_output", "not_an_option"],
    ["effort.low.skills[0]", "bad_format"],
    ["effort.medium.thinking", "not_an_option"],
    ["name", "bad_format"],
    ["outputs.report.file", "bad_format"],
    ["version", "not_an_option"],
  ]);
});

test("at prefixes every field, so a run request can report them under its own", () => {
  const p = edited((p) => {
    p.effort.low.skills = ["../x"];
    p.extra = 1;
  });
  assert.deepEqual(refusals(p, { at: "profile" }), [["profile.effort.low.skills[0]", "bad_format"], ["profile.extra", "not_allowed"]]);
});

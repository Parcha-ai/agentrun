// Tests 21 up to 43 (not included) of report-skill.body.mjs, in a process of their own: see that file.
globalThis.REPORT_SKILL_SHARD = { from: 21, to: 43 };
await import("./report-skill.body.mjs");

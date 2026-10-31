// Tests 0 up to 21 (not included) of report-skill.body.mjs, in a process of their own: see that file.
globalThis.REPORT_SKILL_SHARD = { from: 0, to: 21 };
await import("./report-skill.body.mjs");

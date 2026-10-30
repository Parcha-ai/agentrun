// Tests 43 up to 62 (not included) of report-skill.body.mjs, in a process of their own: see that file.
globalThis.REPORT_SKILL_SHARD = { from: 43, to: 62 };
await import("./report-skill.body.mjs");

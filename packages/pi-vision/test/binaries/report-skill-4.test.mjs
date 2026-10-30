// Tests 62 up to the last of report-skill.body.mjs, in a process of their own: see that file.
globalThis.REPORT_SKILL_SHARD = { from: 62, to: Infinity };
await import("./report-skill.body.mjs");

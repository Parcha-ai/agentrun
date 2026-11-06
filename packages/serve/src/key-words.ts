// The keys a person may save on Settings → Tool keys (tool-keys.ts' TOOL_KEYS reads the tool rows from here), and the
// words for one a tool needs that this server does not hold: where the person saves it is named first, then the
// variable to set where the server starts, since a key saved and then removed in Settings was never in the environment.
import { MODEL_KEYS } from "./model.js";

/** Each tool key a person may save, fixed here: its fields (BROWSERBASE_PROJECT_ID is no secret, and is kept the same
 *  way), and what it may unlock: tools by name, and `decisions.<id>`, a workflow's decision provider. */
export const TOOL_KEY_ROWS = [
  { id: "parallel", kind: "tool", label: "Parallel", fields: ["PARALLEL_API_KEY"], unlocks: ["web_fetch", "web_search", "decisions.parallel"] },
  { id: "monid", kind: "tool", label: "Monid", fields: ["MONID_API_KEY"], unlocks: ["monid.discover", "monid.inspect", "monid.run"] },
  { id: "browserbase", kind: "tool", label: "Browserbase", fields: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"], unlocks: ["browser"] },
  // The browser's other vendor (tool-plane.ts BROWSER_KEYS): a run's browser is the one its plane picks.
  { id: "kernel", kind: "tool", label: "Kernel", fields: ["KERNEL_API_KEY"], unlocks: ["browser"] },
  // Jev's decision provider (decisions.ts' `jev`), on TypeSafe's key: a workflow's judges, as Parallel's key unlocks its.
  { id: "typesafe", kind: "tool", label: "TypeSafe (Jev)", fields: ["TYPESAFE_API_KEY"], unlocks: ["decisions.jev"] },
] as const;

/** Every key Settings → Tool keys saves, tool keys and model keys alike (a saved model key reaches every run): its label
 *  and fields. */
const SAVABLE: readonly { label: string; fields: readonly string[] }[] = [
  ...TOOL_KEY_ROWS.map((row) => ({ label: row.label, fields: row.fields as readonly string[] })),
  ...MODEL_KEYS.map((row) => ({ label: row.label, fields: [row.field] as readonly string[] })),
];

const article = (label: string) => (/^[AEIOU]/i.test(label) ? "an" : "a");

/** What `vars` (the variables a tool needs that this server does not hold) are, as a person fixes them: each savable
 *  key's "a <Label> key: save one in Settings → Tool keys (or set <VARS> where the server starts)", then any variable no
 *  key saves, to set where the server starts. */
export function keyNeeded(vars: readonly string[]): string {
  const left = [...vars];
  const parts: string[] = [];
  for (const row of SAVABLE) {
    const hit = row.fields.filter((field) => left.includes(field));
    if (!hit.length) continue;
    for (const field of hit) left.splice(left.indexOf(field), 1);
    parts.push(`${article(row.label)} ${row.label} key: save one in Settings → Tool keys (or set ${hit.join(" and ")} where the server starts)`);
  }
  for (const name of left) parts.push(`${name}, set where the server starts`);
  return parts.join("; and ");
}

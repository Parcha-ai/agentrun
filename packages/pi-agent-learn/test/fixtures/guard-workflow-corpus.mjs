// Corpus cases for a workflow's folder, workflows/<name>/: the draft a run proposes (workflow.json, README.md) and the DSL's
// saved records the curator writes (<sha256>.json, latest).
// Same shape as guard-corpus.mjs: { id, kind, input: { path, text, secrets? }, expect, reason }. Secret-shaped strings are
// assembled at import time, so no file holds one.
import { RUN_ID } from "./guard-corpus.mjs";

const DIGEST = "0123456789abcdef".repeat(4);
const BASE = "workflows";
const RECORD = JSON.stringify({ name: "kyb-us-registry", steps: [{ call: "registry.search", note: "search both forms of the legal name" }] });
const GITHUB_TOKEN = ["gh", "p_"].join("") + "A1b2C3d4E5".repeat(4);
const PLANTED = ["Orchid", "\"quoted\\", "slash", "!x7"].join("");

export const cases = [];
const add = (id, kind, expect, reason, path, text = RECORD, secrets) =>
  cases.push({ id, kind, expect, reason, input: secrets ? { path, text, secrets } : { path, text } });

add("allow.workflow.draft", "allow", "allow", "a run's draft document", `${BASE}/kyb-us-registry/workflow.json`);
add("allow.workflow.readme", "allow", "allow", "a run's draft README", `${BASE}/kyb-us-registry/README.md`, "# kyb-us-registry\n\nFor a US company.\n");
add("allow.workflow.record", "allow", "allow", "a record named by its digest", `${BASE}/kyb-us-registry/${DIGEST}.json`);
add("allow.workflow.latest", "allow", "allow", "the latest pointer", `${BASE}/kyb-us-registry/latest`, DIGEST);
add("allow.workflow.name-with-dash-and-underscore", "allow", "allow", "a name with a dash and an underscore", `${BASE}/my-flow_v2/${DIGEST}.json`);
add("allow.workflow.name-at-limit", "allow", "allow", "a 64 character name", `${BASE}/${"n".repeat(64)}/${DIGEST}.json`);
add("allow.workflow.credential-words", "allow", "allow", "a record that names a password or token step without holding one", `${BASE}/rotate/${DIGEST}.json`,
  JSON.stringify({ steps: [{ call: "vault.password", note: "never log a token" }] }));
add("allow.workflow.at-size-cap", "allow", "allow", "a record of exactly 32768 bytes", `${BASE}/big/${DIGEST}.json`, JSON.stringify({ pad: "x".repeat(32768 - 10) }));

const refuse = (id, reason, path, text) => add(`path.workflow.${id}`, "path", "refuse", reason, path, text);
refuse("name-too-long", "a 65 character name", `${BASE}/${"n".repeat(65)}/${DIGEST}.json`);
refuse("name-with-dot", "a name with a dot: the DSL's workflow names have none", `${BASE}/my.flow/${DIGEST}.json`);
refuse("name-uppercase", "a name with a capital letter: the DSL's workflow names are lowercase", `${BASE}/Kyb/${DIGEST}.json`);
refuse("name-with-space", "a name with a space", `${BASE}/a b/${DIGEST}.json`);
refuse("name-leading-dot", "a name that starts with a dot", `${BASE}/.hidden/${DIGEST}.json`);
refuse("name-dot-git", "a .git folder", `${BASE}/.git/${DIGEST}.json`);
refuse("name-dotdot", "a .. segment in place of a name", `${BASE}/../${DIGEST}.json`);
refuse("name-with-backslash", "a backslash in the name", `${BASE}/a\\b/${DIGEST}.json`);
refuse("no-name-folder", "a record directly under workflows/", `${BASE}/${DIGEST}.json`);
refuse("nested", "a record one folder too deep", `${BASE}/kyb/sub/${DIGEST}.json`);
refuse("record-upper-hex", "an uppercase digest", `${BASE}/kyb/${DIGEST.toUpperCase()}.json`);
refuse("record-short-digest", "a 63 digit digest", `${BASE}/kyb/${DIGEST.slice(1)}.json`);
refuse("record-long-digest", "a 65 digit digest", `${BASE}/kyb/a${DIGEST}.json`);
refuse("record-extension", "a digest with another extension", `${BASE}/kyb/${DIGEST}.txt`);
refuse("record-other-name", "a record not named by a digest", `${BASE}/kyb/kyb.json`);
refuse("latest-capitalised", "Latest", `${BASE}/kyb/Latest`);
refuse("latest-trailing-slash", "latest/", `${BASE}/kyb/latest/`);
refuse("latest-trailing-space", "latest with a trailing space", `${BASE}/kyb/latest `);
refuse("symlink-shaped", "a record named like a link and its target", `${BASE}/kyb/latest -> ../../AGENTS.md`);
refuse("rules-file-in-folder", "AGENTS.md inside a workflow folder", `${BASE}/kyb/AGENTS.md`);
refuse("other-run", "another run's workflow folder", `inbox/other-run/workflows/kyb/${DIGEST}.json`);
refuse("workflows-capitalised", "Workflows in place of workflows", `inbox/${RUN_ID}/Workflows/kyb/${DIGEST}.json`);
refuse("other-folder", "a folder other than workflows under the run's inbox folder", `inbox/${RUN_ID}/notes/kyb/${DIGEST}.json`);
refuse("under-uses", "the same shape under uses/", `uses/${RUN_ID}/workflows/kyb/${DIGEST}.json`);
refuse("md-beside-folder", "a file in a workflow folder that is neither a draft nor a record", `${BASE}/kyb/notes.md`);
refuse("old-store-path", "the DSL's store path, where an older repository kept records: read, never written", `.pi/agentrun/workflows/kyb/${DIGEST}.json`);

add("secret.workflow.github-token", "secret", "refuse", "a GitHub token inside a record", `${BASE}/kyb/${DIGEST}.json`, JSON.stringify({ header: `Bearer ${GITHUB_TOKEN}` }));
add("secret.workflow.planted-past-json-escapes", "secret", "refuse", "a planted value with a quote and a backslash, which a JSON string escapes", `${BASE}/kyb/${DIGEST}.json`,
  JSON.stringify({ note: `key ${PLANTED}` }), [PLANTED]);
add("secret.workflow.planted-in-latest", "secret", "refuse", "a planted value in the latest pointer", `${BASE}/kyb/latest`, PLANTED, [PLANTED]);
add("unicode.workflow.bidi-in-record", "unicode", "refuse", "a right-to-left override inside a record", `${BASE}/kyb/${DIGEST}.json`, JSON.stringify({ note: "a\u{202e}b" }));
add("size.workflow.record-over-cap", "size", "refuse", "a record of 32769 bytes", `${BASE}/big/${DIGEST}.json`, "x".repeat(32769));

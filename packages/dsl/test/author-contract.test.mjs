// The shipped author contract names every node kind and predicate the schema admits, carries no
// host-specific instruction, and composes with a host addendum under a digest a host can record.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadAuthorContract, composeAuthorContract } from "../dist/index.js";

const schema = JSON.parse(await readFile(new URL("../schema/workflow.schema.json", import.meta.url), "utf8"));
const kinds = new Set();
const predicates = new Set();
(function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (!node || typeof node !== "object") return;
  const props = node.properties;
  if (props && typeof props === "object") {
    const kind = props.node?.const ?? props.node?.enum?.[0];
    if (typeof kind === "string") kinds.add(kind);
    const predicate = props.predicate?.const ?? props.predicate?.enum?.[0];
    if (typeof predicate === "string") predicates.add(predicate);
  }
  Object.values(node).forEach(walk);
})(schema);

test("the contract loads once, with a stable digest over both texts", () => {
  const first = loadAuthorContract();
  const second = loadAuthorContract();
  assert.equal(first, second, "read once per process");
  assert.ok(first.contract.startsWith("# AgentRun author contract"));
  assert.ok(first.jevDecisions.startsWith("# Design Jev decisions in AgentRun"));
  assert.equal(first.sha256, createHash("sha256").update(first.contract).update("\n").update(first.jevDecisions).digest("hex"));
  assert.throws(() => { first.contract = ""; }, "the contract is frozen");
});

test("every node kind and predicate the schema admits is named in the contract", () => {
  const { contract } = loadAuthorContract();
  assert.ok(kinds.size >= 17, `schema kinds: ${[...kinds].join(", ")}`);
  for (const kind of kinds) assert.match(contract, new RegExp(`\`${kind}\``), `node kind ${kind}`);
  assert.ok(predicates.size >= 9, `schema predicates: ${[...predicates].join(", ")}`);
  for (const predicate of predicates) assert.match(contract, new RegExp(`\`${predicate}[ \`{]`), `predicate ${predicate}`);
});

test("the shared texts carry no host's instructions", () => {
  const { contract, jevDecisions } = loadAuthorContract();
  for (const text of [contract, jevDecisions]) {
    assert.doesNotMatch(text, /\.\.\/examples\//, "no links into a host's example directory");
    assert.doesNotMatch(text, /`agentrun` (tool|with)/, "no reference to the Pi extension's tool");
    assert.doesNotMatch(text, /check_workflow|traces\.json|SOP\.md/, "no reference to a host's workspace files");
  }
});

test("a host composes its addendum onto the shared contract under one digest", () => {
  const shared = loadAuthorContract();
  const composed = composeAuthorContract("# Host addendum\n\nTools: read, grep.\n");
  assert.ok(composed.text.startsWith(shared.contract));
  assert.ok(composed.text.includes(shared.jevDecisions));
  assert.ok(composed.text.endsWith("Tools: read, grep."));
  assert.equal(composed.sha256, createHash("sha256").update(composed.text).digest("hex"));
  assert.notEqual(composed.sha256, shared.sha256);
  const withoutJev = composeAuthorContract("# Host addendum", { jev: false });
  assert.ok(!withoutJev.text.includes(shared.jevDecisions));
  assert.equal(composeAuthorContract("").text, `${shared.contract}\n\n${shared.jevDecisions}`, "an empty addendum adds nothing");
});

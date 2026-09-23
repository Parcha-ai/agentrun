import { createRequire } from "node:module";
import { Compile } from "typebox/compile";

const documentSchema = createRequire(import.meta.url)("../schema/workflow.schema.json");
const fullValidator = Compile(documentSchema);
type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);

// Diagnostics only: the full validator below remains the acceptance authority.
// Its union errors can fill the entire error limit with unrelated node kinds.
// Select the declared discriminator's schema, checking nested nodes separately so
// their own discriminators also get useful errors. Never evaluate authored code.
const diagnosticDefinitions = { ...documentSchema.definitions, WorkflowNode: {}, Workflow: {} };
const nodeSchemas = new Map<string, any>(documentSchema.definitions.WorkflowNode.anyOf.map((schema: any) =>
  [schema.properties.node.const, schema]));
const diagnosticValidators = new Map<any, ReturnType<typeof Compile>>();
for (const schema of [documentSchema.definitions.Workflow, ...nodeSchemas.values()]) {
  diagnosticValidators.set(schema, Compile({ ...schema, definitions: diagnosticDefinitions }));
}
const pointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
function discriminatedErrors(value: unknown): string[] {
  const errors: string[] = [];
  const check = (schema: any, entry: unknown, path: string): void => {
    if (errors.length >= 8) return;
    const validator = diagnosticValidators.get(schema)!;
    if (!validator.Check(entry)) for (const error of validator.Errors(entry)) {
      errors.push(`workflow${path}${error.instancePath || (path ? "" : "/")}: ${error.message}`);
      if (errors.length >= 8) return;
    }
    visit(schema, entry, path);
  };
  const visit = (schema: any, entry: unknown, path: string): void => {
    if (!schema || typeof schema !== "object" || errors.length >= 8) return;
    if (schema.$ref === "#/definitions/WorkflowNode") {
      const selected = isRecord(entry) && typeof entry.node === "string" ? nodeSchemas.get(entry.node) : undefined;
      if (selected) check(selected, entry, path);
      return; // Unknown/missing discriminators retain the full validator's fallback.
    }
    if (schema.$ref === "#/definitions/Workflow") { check(documentSchema.definitions.Workflow, entry, path); return; }
    if (isRecord(entry)) {
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(entry, key)) visit(child, entry[key], `${path}/${pointer(key)}`);
      }
      if (isRecord(schema.additionalProperties)) for (const key of Object.keys(entry)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) visit(schema.additionalProperties, entry[key], `${path}/${pointer(key)}`);
      }
    }
    if (Array.isArray(entry) && schema.items) entry.forEach((child, index) => visit(schema.items, child, `${path}/${index}`));
  };
  check(documentSchema.definitions.Workflow, value, "");
  return errors;
}

export function workflowShapeErrors(value: unknown, complete = false): string[] {
  if (complete) {
    if (fullValidator.Check(value)) return [];
    const selected = discriminatedErrors(value);
    if (selected.length) return selected;
    return [...fullValidator.Errors(value)].slice(0, 8).map(error =>
      `workflow${error.instancePath || "/"}: ${error.message}`);
  }
  const errors: string[] = [];
  const fail = (path: string, expected: string) => { errors.push(`${path} must be ${expected}`); };
  const record = (entry: unknown, path: string): entry is RecordValue => {
    if (isRecord(entry)) return true;
    fail(path, "an object");
    return false;
  };
  const strings = (entry: RecordValue, path: string, keys: string[]) => {
    for (const key of keys) if (entry[key] !== undefined && typeof entry[key] !== "string") fail(`${path}.${key}`, "a string");
  };
  const stringList = (entry: unknown, path: string) => {
    if (entry === undefined) return;
    if (!Array.isArray(entry)) { fail(path, "an array of strings"); return; }
    entry.forEach((item, index) => { if (typeof item !== "string") fail(`${path}[${index}]`, "a string"); });
  };
  // Preserve existing diagnostics for missing, non-finite and out-of-range numbers, and
  // primitive strings such as poll.deadline_s="soon". Objects can throw during coercion.
  const numeric = (entry: RecordValue, path: string, keys: string[]) => {
    for (const key of keys) {
      const item = entry[key];
      if (item !== null && item !== undefined && !["number", "string", "boolean"].includes(typeof item)) fail(`${path}.${key}`, "a number");
    }
  };
  const objectField = (entry: RecordValue, path: string, key: string, visit?: (item: RecordValue, path: string) => void) => {
    if (entry[key] === undefined) return;
    if (record(entry[key], `${path}.${key}`)) visit?.(entry[key], `${path}.${key}`);
  };
  const predicate = (entry: RecordValue, path: string) => {
    strings(entry, path, ["predicate", "path", "key", "instructions"]);
    numeric(entry, path, ["n", "gte"]);
    objectField(entry, path, "state");
    objectField(entry, path, "criteria", (criteria, at) => strings(criteria, at, ["true", "false"]));
  };
  const node = (entry: unknown, path: string): void => {
    if (entry === undefined) return; // missing bodies already receive semantic diagnostics
    if (!record(entry, path)) return;
    strings(entry, path, ["node", "label", "code", "as", "out", "instructions", "itemsPath", "resultPath", "kind", "stage", "summary", "describe", "type", "path", "tool", "command", "via", "where", "effort", "thinking", "tier"]);
    numeric(entry, path, ["maxConcurrency", "maxIters", "deadline_s"]);
    for (const key of ["requires", "tools", "produces"]) stringList(entry[key], `${path}.${key}`);
    if (entry.sopSection !== undefined && typeof entry.sopSection !== "string") stringList(entry.sopSection, `${path}.sopSection`);
    for (const key of ["state", "args", "input", "env"]) objectField(entry, path, key);
    for (const key of ["until", "when"]) objectField(entry, path, key, predicate);
    objectField(entry, path, "verify", (verify, at) => {
      strings(verify, at, ["out"]);
      numeric(verify, at, ["maxDrives"]);
      objectField(verify, at, "state");
      objectField(verify, at, "override", (override, here) => numeric(override, here, ["below"]));
    });
    objectField(entry, path, "keep", (keep, at) => { strings(keep, at, ["path"]); numeric(keep, at, ["gte"]); });
    objectField(entry, path, "unsure", (unsure, at) => { strings(unsure, at, ["branch"]); numeric(unsure, at, ["gte"]); });
    objectField(entry, path, "retry", (retry, at) => {
      numeric(retry, at, ["attempts", "backoff_s"]);
      stringList(retry.on, `${at}.on`);
    });
    objectField(entry, path, "poll", (poll, at) => {
      numeric(poll, at, ["interval_s", "deadline_s"]);
      for (const key of ["until", "fail_when"]) objectField(poll, at, key, predicate);
    });
    if (entry.node === "chain" || entry.node === "parallel") {
      const key = entry.node === "chain" ? "steps" : "branches";
      if (entry[key] !== undefined) {
        if (!Array.isArray(entry[key])) fail(`${path}.${key}`, "an array of nodes");
        else entry[key].forEach((child, index) => node(child, `${path}.${key}[${index}]`));
      }
    }
    if (entry.node === "map" || entry.node === "loop") node(entry.body, `${path}.body`);
    if (entry.node === "route") objectField(entry, path, "branches", (branches, at) => {
      for (const [name, branch] of Object.entries(branches)) if (record(branch, `${at}.${name}`)) {
        strings(branch, `${at}.${name}`, ["criteria"]);
        node(branch.body, `${at}.${name}.body`);
      }
    });
    if (entry.node === "workflow") workflow(entry.workflow, `${path}.workflow`);
  };
  const workflow = (entry: unknown, path: string): void => {
    if (!record(entry, path)) return;
    strings(entry, path, ["name"]);
    record(entry.schemas, `${path}.schemas`);
    objectField(entry, path, "input", (input, at) => strings(input, at, ["schemaId"]));
    if (record(entry.output, `${path}.output`)) strings(entry.output, `${path}.output`, ["schemaId", "path"]);
    if (record(entry.root, `${path}.root`)) node(entry.root, `${path}.root`);
  };
  workflow(value, "workflow");
  return errors.slice(0, 8);
}

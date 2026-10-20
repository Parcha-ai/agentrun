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
function discriminatedErrors(value: unknown): ShapeIssue[] {
  const errors: ShapeIssue[] = [];
  const check = (schema: any, entry: unknown, path: string): void => {
    if (errors.length >= 8) return;
    const validator = diagnosticValidators.get(schema)!;
    if (!validator.Check(entry)) for (const error of validator.Errors(entry)) {
      errors.push({ path: `${path}${error.instancePath}`, message: `workflow${path}${error.instancePath || (path ? "" : "/")}: ${error.message}` });
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

/** A shape problem: its message, and a JSON Pointer to the value it is about (to the nearest value the document has, when
 *  the one the rule names is missing). */
export type ShapeIssue = { path: string; message: string };

/** The deepest prefix of `path` that names a value in `document`: a rule about a missing key points at its container. */
function present(document: unknown, path: string): string {
  let cursor = document;
  let reached = "";
  for (const raw of path.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cursor === null || typeof cursor !== "object" || !Object.hasOwn(cursor, key)) break;
    cursor = (cursor as RecordValue)[key];
    reached += `/${raw}`;
  }
  return reached;
}

export function workflowShapeErrors(value: unknown, complete = false): string[] {
  return workflowShapeIssues(value, complete).map(issue => issue.message);
}

export function workflowShapeIssues(value: unknown, complete = false): ShapeIssue[] {
  const located = (issues: ShapeIssue[]): ShapeIssue[] => issues.map(issue => ({ path: present(value, issue.path), message: issue.message }));
  if (complete) {
    if (fullValidator.Check(value)) return [];
    const selected = discriminatedErrors(value);
    if (selected.length) return located(selected);
    return located([...fullValidator.Errors(value)].slice(0, 8).map(error =>
      ({ path: error.instancePath, message: `workflow${error.instancePath || "/"}: ${error.message}` })));
  }
  // A place in the document: the dotted text the messages show, and the JSON Pointer the issue carries.
  type Loc = { text: string; ptr: string };
  const at = (loc: Loc, key: string): Loc => ({ text: `${loc.text}.${key}`, ptr: `${loc.ptr}/${pointer(key)}` });
  const index = (loc: Loc, i: number): Loc => ({ text: `${loc.text}[${i}]`, ptr: `${loc.ptr}/${i}` });
  const errors: ShapeIssue[] = [];
  const fail = (loc: Loc, expected: string) => { errors.push({ path: loc.ptr, message: `${loc.text} must be ${expected}` }); };
  const record = (entry: unknown, loc: Loc): entry is RecordValue => {
    if (isRecord(entry)) return true;
    fail(loc, "an object");
    return false;
  };
  const strings = (entry: RecordValue, loc: Loc, keys: string[]) => {
    for (const key of keys) if (entry[key] !== undefined && typeof entry[key] !== "string") fail(at(loc, key), "a string");
  };
  const stringList = (entry: unknown, loc: Loc) => {
    if (entry === undefined) return;
    if (!Array.isArray(entry)) { fail(loc, "an array of strings"); return; }
    entry.forEach((item, i) => { if (typeof item !== "string") fail(index(loc, i), "a string"); });
  };
  // Preserve existing diagnostics for missing, non-finite and out-of-range numbers, and
  // primitive strings such as poll.deadline_s="soon". Objects can throw during coercion.
  const numeric = (entry: RecordValue, loc: Loc, keys: string[]) => {
    for (const key of keys) {
      const item = entry[key];
      if (item !== null && item !== undefined && !["number", "string", "boolean"].includes(typeof item)) fail(at(loc, key), "a number");
    }
  };
  const objectField = (entry: RecordValue, loc: Loc, key: string, visit?: (item: RecordValue, loc: Loc) => void) => {
    if (entry[key] === undefined) return;
    if (record(entry[key], at(loc, key))) visit?.(entry[key], at(loc, key));
  };
  const predicate = (entry: RecordValue, loc: Loc) => {
    strings(entry, loc, ["predicate", "path", "key", "instructions"]);
    numeric(entry, loc, ["n", "gte"]);
    objectField(entry, loc, "state");
    objectField(entry, loc, "criteria", (criteria, here) => strings(criteria, here, ["true", "false"]));
  };
  const node = (entry: unknown, loc: Loc): void => {
    if (entry === undefined) return; // missing bodies already receive semantic diagnostics
    if (!record(entry, loc)) return;
    strings(entry, loc, ["node", "label", "code", "as", "out", "instructions", "itemsPath", "resultPath", "kind", "stage", "summary", "describe", "type", "path", "tool", "command", "via", "where", "effort", "thinking", "tier", "valuePath", "otherwise"]);
    numeric(entry, loc, ["maxConcurrency", "maxIters", "expect_iters", "deadline_s"]);
    for (const key of ["requires", "tools", "produces"]) stringList(entry[key], at(loc, key));
    if (entry.sopSection !== undefined && typeof entry.sopSection !== "string") stringList(entry.sopSection, at(loc, "sopSection"));
    for (const key of ["state", "args", "input", "env"]) objectField(entry, loc, key);
    // Host-owned and opaque: only its container is checked, never its keys or values.
    if (entry.metadata !== undefined && !isRecord(entry.metadata)) {
      errors.push({ path: at(loc, "metadata").ptr, message: `${loc.text} (${typeof entry.label === "string" && entry.label ? entry.label : String(entry.node)}): metadata must be a plain object of host markers` });
    }
    for (const key of ["until", "when"]) objectField(entry, loc, key, predicate);
    objectField(entry, loc, "verify", (verify, here) => {
      strings(verify, here, ["out"]);
      numeric(verify, here, ["maxDrives"]);
      objectField(verify, here, "state");
      objectField(verify, here, "override", (override, inner) => numeric(override, inner, ["below"]));
    });
    objectField(entry, loc, "keep", (keep, here) => { strings(keep, here, ["path"]); numeric(keep, here, ["gte"]); });
    objectField(entry, loc, "unsure", (unsure, here) => { strings(unsure, here, ["branch"]); numeric(unsure, here, ["gte"]); });
    objectField(entry, loc, "retry", (retry, here) => {
      numeric(retry, here, ["attempts", "backoff_s"]);
      stringList(retry.on, at(here, "on"));
    });
    objectField(entry, loc, "poll", (poll, here) => {
      numeric(poll, here, ["interval_s", "deadline_s"]);
      for (const key of ["until", "fail_when"]) objectField(poll, here, key, predicate);
    });
    if (entry.node === "chain" || entry.node === "parallel") {
      const key = entry.node === "chain" ? "steps" : "branches";
      if (entry[key] !== undefined) {
        if (!Array.isArray(entry[key])) fail(at(loc, key), "an array of nodes");
        else entry[key].forEach((child, i) => node(child, index(at(loc, key), i)));
      }
    }
    if (entry.node === "map" || entry.node === "loop") node(entry.body, at(loc, "body"));
    if (entry.node === "route") objectField(entry, loc, "branches", (branches, here) => {
      for (const [name, branch] of Object.entries(branches)) if (record(branch, at(here, name))) {
        strings(branch, at(here, name), ["criteria"]);
        node(branch.body, at(at(here, name), "body"));
      }
    });
    if (entry.node === "workflow") workflow(entry.workflow, at(loc, "workflow"));
  };
  const workflow = (entry: unknown, loc: Loc): void => {
    if (!record(entry, loc)) return;
    strings(entry, loc, ["name"]);
    record(entry.schemas, at(loc, "schemas"));
    objectField(entry, loc, "input", (input, here) => strings(input, here, ["schemaId"]));
    if (record(entry.output, at(loc, "output"))) strings(entry.output, at(loc, "output"), ["schemaId", "path"]);
    if (record(entry.root, at(loc, "root"))) node(entry.root, at(loc, "root"));
  };
  workflow(value, { text: "workflow", ptr: "" });
  return located(errors.slice(0, 8));
}

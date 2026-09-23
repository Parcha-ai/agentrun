import {
  runWorkflow, validateWorkflow, resolveSchemaForWorkflow, WorkflowInvalidError,
  type Workflow, type WorkflowDeps, type WorkflowNode, type WorkflowRunResult,
} from "./workflow.js";
import { isDeepStrictEqual, types as utilTypes } from "node:util";
import { assertZodJsonContract } from "./zod-json-contract.js";

/** Structural Standard JSON Schema v1 interface. Compatible schema libraries need no
 * AgentRun adapter or runtime dependency. See https://standardschema.dev/json-schema. */
export interface StandardJSONSchema<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: Input; readonly output: Output };
    readonly jsonSchema: {
      readonly input: (options: { readonly target: string; readonly libraryOptions?: Record<string, unknown> }) => Record<string, unknown>;
      readonly output: (options: { readonly target: string; readonly libraryOptions?: Record<string, unknown> }) => Record<string, unknown>;
    };
  };
}

export type AuthoringSchema = StandardJSONSchema | Record<string, unknown>;
type SchemaInput<S> = S extends StandardJSONSchema ? NonNullable<S["~standard"]["types"]>["input"] : unknown;
type SchemaOutput<S> = S extends StandardJSONSchema ? NonNullable<S["~standard"]["types"]>["output"] : unknown;
declare const workflowTypes: unique symbol;
const authoredWorkflows = new WeakSet<object>();

export type TypedWorkflow<Input, Output> = Workflow & {
  readonly [workflowTypes]: { readonly input: Input; readonly output: Output };
};
export type WorkflowInput<W extends TypedWorkflow<unknown, unknown>> = W[typeof workflowTypes]["input"];
export type WorkflowOutput<W extends TypedWorkflow<unknown, unknown>> = W[typeof workflowTypes]["output"];
export type TypedWorkflowRunResult<Output> =
  | (Omit<Extract<WorkflowRunResult, { status: "complete" }>, "output"> & { output: Output })
  | Extract<WorkflowRunResult, { status: "escalated" }>;

export class WorkflowSchemaConversionError extends Error {
  readonly code = "schema_conversion_failed";
  constructor(readonly schemaId: string, cause: unknown) {
    super(`schema "${schemaId}" cannot be represented as JSON Schema: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "WorkflowSchemaConversionError";
  }
}

type Definition<S extends Record<string, AuthoringSchema>, I extends keyof S & string, O extends keyof S & string> = {
  name: string;
  schemas: S;
  input: I;
  output: { schema: O; path?: string };
} & ({ steps: WorkflowNode[]; root?: never } | { root: WorkflowNode; steps?: never });

/** Author with schema libraries; execute the same JSON language as every other host.
 * Input uses the provider's input JSON Schema, all other schemas its output JSON Schema.
 * These are JSON contracts, NOT schema-library parsers: transforms, coercion, defaults,
 * and arbitrary refinements are not executed. Known lossy Zod constructs are rejected;
 * other providers must supply faithful JSON contracts through their converter.
 * Raw JSON schemas (including Jev criteria) remain supported and infer unknown.
 * Node references and state paths remain runtime-validated, not statically inferred. */
export function defineWorkflow<
  const S extends Record<string, AuthoringSchema>,
  I extends keyof S & string,
  O extends keyof S & string,
>(definition: Definition<S, I, O>): TypedWorkflow<SchemaInput<S[I]>, SchemaOutput<S[O]>> {
  const schemas: Workflow["schemas"] = {};
  for (const [id, source] of Object.entries(definition.schemas)) {
    try {
      let schema: unknown = source;
      if (source && typeof source === "object" && "~standard" in source) {
        const standard = (source as StandardJSONSchema)["~standard"];
        if (standard.version !== 1 || typeof standard.vendor !== "string" || !standard.jsonSchema) {
          throw new Error("expected Standard JSON Schema v1 conversion methods");
        }
        if (standard.vendor === "zod") assertZodJsonContract(source, id === definition.input);
        const input = standard.jsonSchema.input({ target: "draft-07" });
        const output = standard.jsonSchema.output({ target: "draft-07" });
        schema = id === definition.input ? input : output;
        if (id === definition.input && id === definition.output.schema) {
          if (!isDeepStrictEqual(input, output)) {
            throw new Error("input and output conversions differ; declare separate input and output schema entries");
          }
        }
      }
      if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("expected a JSON Schema object");
      Object.defineProperty(schemas, id, { value: cloneJson(schema), enumerable: true, writable: true, configurable: true });
    } catch (error) {
      throw new WorkflowSchemaConversionError(id, error);
    }
  }
  const document = cloneJson({
    v: 2,
    name: definition.name,
    schemas,
    input: { schemaId: definition.input },
    output: { schemaId: definition.output.schema, ...(definition.output.path === undefined ? {} : { path: definition.output.path }) },
    root: definition.root ?? { node: "chain", steps: definition.steps },
  }) as Workflow;
  const result = validateWorkflow(document);
  if (!result.ok) throw new WorkflowInvalidError(document.name, result.errors);
  const inputSchema = resolveSchemaForWorkflow(document, document.schemas[definition.input]);
  if (!objectContract(inputSchema)) {
    throw new WorkflowSchemaConversionError(definition.input, new Error("workflow input must be constrained to JSON objects; declare type: object or object-only schema alternatives"));
  }
  freezeJson(document);
  authoredWorkflows.add(document);
  return document as TypedWorkflow<SchemaInput<S[I]>, SchemaOutput<S[O]>>;
}

function objectContract(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  if (schema.type === "object" || Array.isArray(schema.type) && schema.type.length === 1 && schema.type[0] === "object") return true;
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(schema[key]) && schema[key].length > 0 && schema[key].every(objectContract)) return true;
  }
  return Array.isArray(schema.allOf) && schema.allOf.some(objectContract);
}

export async function runTypedWorkflow<W extends TypedWorkflow<unknown, unknown>>(
  workflow: W,
  input: NoInfer<WorkflowInput<W>>,
  deps: WorkflowDeps,
): Promise<TypedWorkflowRunResult<WorkflowOutput<W>>> {
  // A TypeScript object spread preserves phantom properties even when callers
  // replace a schema. Only the immutable definition we checked owns these types.
  if (!authoredWorkflows.has(workflow)) {
    throw new Error("runTypedWorkflow requires the original document returned by defineWorkflow; use runWorkflow for copied or imported JSON");
  }
  return await runWorkflow(workflow, input as Record<string, unknown>, deps) as TypedWorkflowRunResult<WorkflowOutput<W>>;
}

function cloneJson(value: unknown): unknown {
  return copyJson(value, new Set(), { entries: 0 }, 0);
}

function copyJson(value: unknown, ancestors: Set<object>, budget: { entries: number }, depth: number): unknown {
  if (++budget.entries > 100_000) throw new Error("workflow document exceeds 100000 expanded values");
  if (depth > 128) throw new Error("workflow document exceeds nesting depth 128");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) throw new Error("workflow documents must contain only finite JSON values");
  if (utilTypes.isProxy(value)) throw new Error("workflow documents must not contain proxies");
  if (ancestors.has(value)) throw new Error("workflow documents must not contain cycles");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error("workflow documents must contain plain JSON objects");
  if (Object.getOwnPropertySymbols(value).length) throw new Error("workflow documents must not contain symbol properties");
  // Conversion libraries may attach non-enumerable Standard Schema methods to
  // the result. They are not JSON fields and never enter the emitted document.
  const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([, descriptor]) => descriptor.enumerable);
  if (descriptors.some(([, descriptor]) => descriptor.get || descriptor.set)) throw new Error("workflow documents must not contain accessors");
  if (budget.entries + descriptors.length > 100_000) throw new Error("workflow document exceeds 100000 expanded values");
  if (Array.isArray(value) && budget.entries + value.length > 100_000) throw new Error("workflow document exceeds 100000 expanded values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) => copyJson(Object.getOwnPropertyDescriptor(value, String(index))?.value, ancestors, budget, depth + 1));
    }
    return Object.fromEntries(descriptors.map(([key, descriptor]) => [key, copyJson(descriptor.value, ancestors, budget, depth + 1)]));
  } finally { ancestors.delete(value); }
}

function freezeJson(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

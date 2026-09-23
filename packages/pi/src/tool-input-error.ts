/** Owned validation failure, distinct from arbitrary tool/provider exceptions. */
export class ToolInputValidationError extends Error {
  readonly code = 'tool_input_invalid';
  readonly stage: string;
  readonly tool: string;
  readonly problems: string[];
  constructor(stage: string, tool: string, problems: readonly string[]) {
    super('Tool arguments do not satisfy the registered input schema.');
    this.name = 'ToolInputValidationError';
    this.stage = stage.slice(0, 200);
    this.tool = tool.slice(0, 200);
    this.problems = problems.slice(0, 8).map(problem => problem.slice(0, 500));
  }
}

/** Describe the host schema, never submitted values or candidate-controlled keys. */
export function toolInputProblems(errors: Iterable<unknown>): string[] {
  const problems: string[] = [];
  for (const value of errors) {
    if (problems.length === 8) break;
    const error = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    // schemaPath is generated from the registered host schema; instancePath and
    // params can contain unknown property names or submitted values. Omit both.
    const path = typeof error.schemaPath === 'string' ? error.schemaPath.slice(0, 350) : '#';
    const messages: Record<string, string> = {
      type: 'must match the declared type', required: 'missing required properties',
      additionalProperties: 'must not have additional properties',
      enum: 'must match a declared enum value', const: 'must match the declared constant',
      minimum: 'below the declared minimum', maximum: 'above the declared maximum',
      exclusiveMinimum: 'must exceed the declared minimum', exclusiveMaximum: 'must be below the declared maximum',
      minLength: 'shorter than the declared minimum', maxLength: 'longer than the declared maximum',
      minItems: 'too few items', maxItems: 'too many items', uniqueItems: 'items must be unique',
      pattern: 'must match the declared pattern', format: 'must match the declared format',
      anyOf: 'must match an allowed schema', oneOf: 'must match exactly one allowed schema',
    };
    const message = typeof error.keyword === 'string' ? messages[error.keyword] : undefined;
    problems.push(`${path}: ${message ?? 'does not satisfy the declared schema'}`.slice(0, 500));
  }
  return problems.length ? problems : ['#: does not satisfy the declared schema'];
}

// The context pi 1.1 hands a tool's execute(): the extension context plus `tools` and `executeTool`.
// A workflow node runs a tool outside pi's own tool loop, so there is no sibling tool to call; the context says so
// the way pi does, by returning an error outcome instead of rejecting.
export interface NestedToolOutcome {
  toolCall: { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
  result: { content: Array<{ type: 'text'; text: string }>; details: undefined };
  isError: true;
}

export type WorkflowToolContext<C extends object> = C & {
  readonly tools: readonly never[];
  executeTool(name: string, args: unknown): Promise<NestedToolOutcome>;
};

export function workflowToolContext<C extends object>(context: C): WorkflowToolContext<C> {
  return Object.create(context, {
    tools: { value: Object.freeze([]), enumerable: true },
    executeTool: {
      enumerable: true,
      async value(name: string, args: unknown): Promise<NestedToolOutcome> {
        const text = `A workflow node cannot call the tool ${name}: nested tool calls are not available here`;
        const toolCall = { type: 'toolCall' as const, id: 'agentrun-nested', name, arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> };
        return { toolCall, result: { content: [{ type: 'text', text }], details: undefined }, isError: true };
      },
    },
  });
}

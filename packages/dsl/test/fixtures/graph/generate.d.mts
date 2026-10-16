import type { Workflow } from '@parcha/agentrun-dsl';

/** The shapes the fixtures are made of: a workflow, its input, the node whose commit the cut run loses, and the layout. */
export const SHAPES: Record<string, { workflow: Workflow; input: Record<string, unknown>; cut: { label: string; nth: number }; layout?: 'v3' | 'v4' }>;
/** One run of a shape, to its end or cut: the snapshot's frame and the map items' records. */
export function capture(shape: (typeof SHAPES)[string], options?: { cut?: { label: string; nth: number } }): Promise<{ frame: Record<string, unknown>; items: Array<Record<string, unknown>> }>;
/** The fixture files as text, by name; written under `directory` when one is given. */
export function generate(directory?: string): Promise<Record<string, string>>;

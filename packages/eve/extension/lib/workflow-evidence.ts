import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SdkLearningEvent } from '@parcha/agentrun-client/learning';

export interface WorkflowEvidenceScope {
  runId: string; sessionId: string; turnId: string; revision: string | null; token: string;
  names: readonly string[];
  toolName: string;
  aliases: readonly { nativeName: string; name: string }[];
}
export interface WorkflowToolResult {
  text: string;
  isError: boolean;
  agentrun: {
    version: 1; runId: string; sessionId: string; turnId: string; callId: string;
    name: string; revision: string | null; complete: boolean; events: SdkLearningEvent[];
  };
  signature: string;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const signature = (value: Omit<WorkflowToolResult, 'signature'>, token: string) => createHmac('sha256', token).update(JSON.stringify(canonical(value))).digest('hex');
export const workflowInputDigest = (input: unknown): string => createHmac('sha256', 'eve-workflow-input-v1').update(JSON.stringify(canonical(input))).digest('hex');

/** Attestation binds private bridge observations to one eve tool call. No capability or credential is retained. */
export function signWorkflowResult(value: Omit<WorkflowToolResult, 'signature'>, token: string): WorkflowToolResult {
  return { ...value, signature: signature(value, token) };
}

export function readWorkflowResult(output: unknown, scope: WorkflowEvidenceScope, callId: string): WorkflowToolResult | undefined {
  if (!output || typeof output !== 'object' || !('agentrun' in output)) return undefined;
  const value = output as WorkflowToolResult, proof = value.agentrun;
  if (!proof || proof.version !== 1 || proof.runId !== scope.runId || proof.sessionId !== scope.sessionId || proof.turnId !== scope.turnId ||
    proof.callId !== callId || proof.revision !== scope.revision || !scope.names.includes(proof.name) ||
    typeof value.text !== 'string' || typeof value.isError !== 'boolean' || typeof proof.complete !== 'boolean' || !Array.isArray(proof.events) ||
    typeof value.signature !== 'string' || !/^[a-f0-9]{64}$/.test(value.signature) || JSON.stringify(value).length > 256_000)
    throw new Error('invalid_workflow_evidence');
  const expected = signature({ text: value.text, isError: value.isError, agentrun: proof }, scope.token);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(value.signature))) throw new Error('invalid_workflow_evidence');
  return value;
}

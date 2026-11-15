// Native execution is metadata on the ordinary agent revision. Its source remains owned by the user.
import { isAbsolute } from 'node:path';
import type { NativeBinding } from './types.js';

export const NATIVE_TOOL_BUDGET_UNSUPPORTED = 'Native connections cannot enforce the max_tool_calls limit recorded in this older revision. Save the definition without max_tool_calls and start a new run.';
export const NATIVE_MODEL_SETTINGS_UNSUPPORTED = 'Native connections use the model and thinking settings of the source project or profile configuration. Remove the AgentRun model and thinking overrides, configure them in the source CLI, and start a new run.';
export const NATIVE_EXECUTION_SETTINGS_UNSUPPORTED = 'Native connections use the source CLI configuration for tool permissions, grants, approval policy, model tiers and execution settings. AgentRun cannot apply these overrides or provide a different computer, sandbox, checkout or spending limit. Clear the unsupported settings, configure the source project or profile, and start a new run.';

/** Top-level AgentRun overrides are distinct from native.model, which describes source configuration. */
export function nativeModelOverrides(value: unknown): ('model' | 'thinking')[] {
 if (!value || typeof value !== 'object') return [];
 return (['model', 'thinking'] as const).filter(field => (value as Record<string, unknown>)[field] !== undefined);
}

/** Only compatibility defaults are meaningful here; native.model/skills describe the source, not managed overrides.
 * Read both public definitions and pinned stored bodies so canonicalization cannot hide an ignored restriction.
 * Registration supplies its endpoint's selected runtime; other callers use the stored native binding alone. */
export function nativeExecutionOverrides(value: unknown, registrationRuntime?: unknown): string[] {
 if (!value || typeof value !== 'object') return [];
 const body=value as Record<string, unknown>;
 const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 const emptyObject=(v:unknown)=>object(v)&&Object.keys(v).length===0;
 const only=(v:unknown,key:string,expected:string)=>object(v)&&v[key]===expected&&Object.keys(v).length===1;
 const fields:string[]=[];
 const check=(field:string,accept:(v:unknown)=>boolean,...aliases:string[])=>{
  if([field,...aliases].some(key=>body[key]!==undefined&&!accept(body[key])))fields.push(field);
 };
 // Empty per-tool entries canonicalize to no setting too; they express no permission or provider override.
 check('tool_settings',v=>object(v)&&Object.values(v).every(emptyObject),'toolSettings');
 check('tools',v=>Array.isArray(v)&&v.length===0);
 check('skills',v=>emptyObject(v)||(Array.isArray(v)&&v.length===0));
 check('approvals',v=>v==='ask');
 check('model_tiers',emptyObject,'modelTiers');
 check('computer',v=>only(v,'kind','none'));
 check('place',v=>only(v,'mode','runner'));
 const runtime=registrationRuntime??(object(body.native)?body.native.runtime:undefined);
 // An explicit managed-to-native connection adopts the selected source harness. An already native definition may
 // name that same harness, but cannot advertise a different one that native dispatch would ignore.
 if(runtime==='claude-code'||runtime==='codex')check('harness',v=>v===(runtime==='codex'?'codex':'claude-agent'));
 check('checkout',v=>v==='none');
 check('max_cost_usd',v=>v===0,'maxCostUsd');
 return fields;
}

/** Reject hand-edited references instead of launching in a guessed or relative directory. */
export function nativeBindingOf(value: unknown): NativeBinding {
  const b = value as NativeBinding;
  if (!b || typeof b !== 'object' || !['claude-code','codex'].includes(b.runtime) || typeof b.project !== 'string' || !isAbsolute(b.project) || b.project.includes('\0') || typeof b.machine_id !== 'string' || !b.machine_id || !b.selector || !['project','agent','profile'].includes(b.selector.kind) || (b.selector.kind !== 'project' && (typeof b.selector.name !== 'string' || !/^[\w.@+-]{1,160}$/.test(b.selector.name))) || typeof b.connected !== 'boolean' || typeof b.fingerprint !== 'string' || !Array.isArray(b.configuration) || !Array.isArray(b.skills) || !Array.isArray(b.mcp_servers) || !Array.isArray(b.issues) || !b.capabilities) throw new Error('Invalid native connection: connect the source project using /native/connect.');
  // Keep the defined metadata only. Never persist arbitrary configuration, environment or credentials.
  return {runtime:b.runtime,project:b.project,selector:{kind:b.selector.kind,...(b.selector.name ? {name:b.selector.name}: {})},machine_id:b.machine_id,version:typeof b.version==='string'?b.version:null,model:typeof b.model==='string'?b.model:null,fingerprint:b.fingerprint,configuration:b.configuration.map(c=>({path:c.path,sha256:c.sha256})),skills:b.skills.filter(x=>typeof x==='string'),mcp_servers:b.mcp_servers.filter(x=>typeof x==='string'),state:b.state,issues:b.issues.filter(x=>typeof x==='string'),capabilities:{launch:!!b.capabilities.launch,notes:!!b.capabilities.notes,skills:!!b.capabilities.skills,workflows:false,approval:b.capabilities.approval==='native'?'native':'unavailable',usage:!!b.capabilities.usage},connected:b.connected,...(typeof b.verified_at==='string'?{verified_at:b.verified_at}:{})};
}
export function nativeOf(body: unknown): NativeBinding | undefined {
 const value=(body as {native?:unknown}|null)?.native;
 return value === undefined ? undefined : nativeBindingOf(value);
}

// Native execution is metadata on the ordinary agent revision. Its source remains owned by the user.
import { isAbsolute } from 'node:path';
import type { NativeBinding } from './types.js';

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

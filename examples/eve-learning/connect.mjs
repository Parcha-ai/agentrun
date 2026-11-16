import { copyFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';

const root = new URL('./', import.meta.url);
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--workflows') || args.length > 1) throw new Error('Usage: node connect.mjs [--workflows]');
await mkdir(new URL('agent/extensions/', root), { recursive: true });
await copyFile(new URL(args.includes('--workflows') ? 'connection/agentrun-workflows.ts' : 'connection/agentrun.ts', root), new URL('agent/extensions/agentrun.ts', root), constants.COPYFILE_EXCL);
console.log('Added agent/extensions/agentrun.ts. Configure AGENTRUN_BASE_URL, AGENTRUN_API_KEY and AGENTRUN_AGENT_ID, then rebuild or restart eve. Learning starts Off; enable it in the AgentRun console.');

import { copyFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';

const root = new URL('./', import.meta.url);
await mkdir(new URL('agent/extensions/', root), { recursive: true });
await copyFile(new URL('connection/agentrun.ts', root), new URL('agent/extensions/agentrun.ts', root), constants.COPYFILE_EXCL);
console.log('Added agent/extensions/agentrun.ts. Configure AGENTRUN_BASE_URL, AGENTRUN_API_KEY and AGENTRUN_AGENT_ID, then rebuild or restart eve. Learning starts Off; enable it in the AgentRun console.');

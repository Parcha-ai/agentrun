// Pause the native adapter boundary after it returns a real session, before the bridge can retain it.
import { mock } from 'node:test';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as runtime from '../../dist/native/runtime.js';
let paused = false;
mock.module(new URL('../../dist/native/runtime.js', import.meta.url).href, { namedExports: {
  ...runtime,
  openNativeSession: async options => {
    const session = await runtime.openNativeSession(options);
    const close = session.close.bind(session);
    session.close = async () => { await writeFile(join(process.env.NATIVE_BRIDGE_PAUSE_DIR, 'closed'), 'yes'); await close(); };
    if (!paused) {
      paused = true;
      await writeFile(join(process.env.NATIVE_BRIDGE_PAUSE_DIR, 'opened'), 'yes');
      for (;;) {
        try { await access(join(process.env.NATIVE_BRIDGE_PAUSE_DIR, 'release')); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
    }
    return session;
  },
} });
const { runRemoteWorkerBridge } = await import('../../dist/native/remote-worker-bridge.js');
await runRemoteWorkerBridge();

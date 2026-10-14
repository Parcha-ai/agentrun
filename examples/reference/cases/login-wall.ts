// The browser's page judge calls the registry page a login wall: the read is filed `failed`, and the lead cites only
// the scan.
import type { Case } from '../gates.ts';
import { fakes, job, lead } from '../job.ts';

export const loginWall: Case = {
  name: 'login-wall',
  job,
  fakes: {
    ...fakes,
    page: async () => ({ wall: 'login_wall', injection: null, confidence: 0.97, guard: 'scripted: the register asks for a login' }),
    model: lead('Acme Ltd has a filing scan on record; its register page asks for a login.', (_page, scan) => scan),
  },
  expect: { status: 'complete', failing: [], filedFailed: ['browser_read'] },
};

/**
 * Compile-only: `@parcha/pi-transport`'s runner takes `@parcha/agentrun-pi/durable`'s own recorder, as its README says
 * (`runMain(app, { recording: { snapshotLines, recordCommits } })`). Neither package depends on the other, so the check
 * lives here, where `npm run typecheck` sees both.
 */
import { recordCommits, snapshotLines } from '@parcha/agentrun-pi/durable';
import type { Recording } from '@parcha/pi-transport/home';

export const recording: Recording = { snapshotLines, recordCommits };

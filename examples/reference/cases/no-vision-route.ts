// The lead takes no images and the host gives vision no eyes: reading the scan is vision's typed miss
// (`no_vision_route`), its look is filed `failed`, and the lead cites only the page.
import type { Case } from '../gates.ts';
import { fakes, job, lead } from '../job.ts';

export const noVisionRoute: Case = {
  name: 'no-vision-route',
  job,
  fakes: { ...fakes, lead: { input: ['text'] }, model: lead(undefined, (page) => page) },
  expect: { status: 'complete', failing: [], filedFailed: ['look'] },
};

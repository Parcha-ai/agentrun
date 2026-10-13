// The host's `search` tool throws: the workflow's task ends refused at its first step, nothing is delivered, and the
// gate on the record is the one that says so.
import type { Case } from '../gates.ts';
import { fakes, job } from '../job.ts';

export const searchFails: Case = {
  name: 'search-fails',
  job,
  fakes: { ...fakes, tools: { search: () => { throw new Error('the search service is down'); } } },
  expect: { status: 'refused', failing: ['record-matches-output-schema'], filedFailed: [] },
};

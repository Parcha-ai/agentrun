// The host's `search` tool throws: the workflow's task ends refused at its first step, nothing is delivered, and the
// journal holds that step started and never committed: the gates on the record and on the steps say so.
import type { Case } from '../gates.ts';
import { fakes, job } from '../job.ts';

export const searchFails: Case = {
  name: 'search-fails',
  job,
  fakes: { ...fakes, tools: { search: () => { throw new Error('the search service is down'); } } },
  expect: { status: 'refused', failing: ['record-matches-output-schema', 'nodes-end'], filedFailed: [], refused: { code: 'WORKFLOW_FAILED', says: 'the search service is down' } },
};

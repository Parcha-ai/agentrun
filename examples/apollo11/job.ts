// The job: the workflow and its default input, the landing hour (the film's two cuts that hold the descent and the first steps, the
// transcript's forty landing pages, every photo). It is data: no host code, no model named. The tools it calls are in tools/.
import type { Job } from '../reference/index.ts';
import sources from './sources.json' with { type: 'json' };
import { workflowOf } from './workflow.ts';

export const workflow = workflowOf(sources.classes);

export const job: Job = {
  workflow,
  input: {
    film_item: 'film-descent', film_file: 'film-descent.mp4', film_from_s: 1160, film_to_s: 1665, window_s: 20,
    scan_item: 'transcript-tec', scan_file: 'transcript-tec.pdf', pages_from: 303, pages_to: 342,
    photos: sources.items.filter((item) => item.kind === 'photo').map((item) => item.id), photo_ext: '.jpg',
    span_from: '04 06 20 00', span_to: '04 06 50 00',
  },
  files: {},
};

export default job;

// The job: the workflow, its default input and its files. The default reads the committed slice (slice/): the landing's last
// minutes on three scanned pages, 18 s of the descent film in three windows, one photograph of each class. It is data: no host
// code, no model named. The tools it calls are in tools/; the larger inputs are in inputs/.
import type { Job } from '../reference/index.ts';
import { sliceFiles } from './dataset.ts';
import sources from './sources.json' with { type: 'json' };
import { workflowOf } from './workflow.ts';

export const workflow = workflowOf(sources.classes);

export const job: Job = {
  workflow,
  input: {
    film_item: 'film-descent-1206-1224', film_file: 'film-descent-1206-1224.webm', film_from_s: 0, film_to_s: 18, window_s: 6,
    scan_item: 'transcript-tec-p317-319', scan_file: 'transcript-tec-p317-319.pdf', pages_from: 1, pages_to: 3,
    photos: ['photo-AS11-36-5355', 'photo-AS11-44-6581', 'photo-AS11-40-5863', 'photo-AS11-44-6665', 'photo-AS11-45-6704'], photo_ext: '.jpg',
    typed_item: 'transcript-tec-typed-p317-319', typed_file: 'transcript-tec-typed-p317-319.html',
    span_from: '04 06 43 30', span_to: '04 06 48 10',
  },
  files: sliceFiles(),
};

export default job;

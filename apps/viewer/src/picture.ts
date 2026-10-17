// The run's picture (RECORDING.md draft 31): the run's result so far as an image, which the recording's home side draws
// from the run's committed results and writes as a `picture` host line. The panel draws the latest picture at or before
// the stop, a gap before the first, and keeps the last after the run ends. Any job's picture, never one job's. A panel
// (PANELS.md): `accepts`, `reduce` and `view` are pure, so a scrub is a replay. A recording with no picture line draws none.
import type { Line } from './format.ts';
import { h, register, type Node, type Panel } from './panels.ts';

type PicFrame = { blob: string; label?: string; commit?: number; t: number };
type PicState = { latest?: PicFrame; count: number };

const isPicture = (line: Line) => line.source === 'host' && line.channel === 'live' && line.kind === 'picture';
const picFrameOf = (line: Line): PicFrame | undefined => {
  const data = line.data as { blob?: unknown; label?: unknown; commit?: unknown } | null;
  if (typeof data?.blob !== 'string') return undefined;
  return { blob: data.blob, t: line.t, ...(typeof data.label === 'string' ? { label: data.label } : {}), ...(Number.isInteger(data.commit) ? { commit: data.commit as number } : {}) };
};

export const picturePanel: Panel<PicState> = {
  id: 'picture',
  title: 'The run so far',
  init: () => ({ count: 0 }),
  accepts: isPicture,
  // A run that draws its result as it goes is about that picture: the shell shows it first.
  featured: (lines) => lines.some(isPicture),
  reduce(state, line) {
    const frame = picFrameOf(line);
    return frame ? { latest: frame, count: state.count + 1 } : state;
  },
  view(state): Node {
    if (!state.latest) return h('div', { class: 'picture-panel' }, h('div', { class: 'picture-gap', title: 'no picture before this point' }, 'No picture yet.'));
    const { blob, label, commit } = state.latest;
    const caption = [label, commit !== undefined ? `drawn at commit ${commit}` : undefined, `picture ${state.count}`].filter(Boolean).join(' · ');
    return h('figure', { class: 'picture-panel' },
      { tag: 'img', blob, alt: label ?? 'the run so far', class: 'picture' },
      h('figcaption', {}, caption));
  },
};

register(picturePanel);

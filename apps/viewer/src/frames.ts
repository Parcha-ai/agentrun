// A browser session's picture at a stop (RECORDING.md section 5, browser): its `frame.track` (a WebM) when the
// recording has one, else its latest `frame` JPEG, and a `frame.gap` drawn as a gap, never as a frozen frame.
import type { Line } from './format.ts';
import type { Fold } from './replay.ts';

export type Picture =
  | { kind: 'track'; blob: string; offset: number }
  | { kind: 'frame'; blob: string; t: number }
  | { kind: 'gap'; reason: string; from: number; detail?: string }
  | { kind: 'none' };

type Session = { track?: { blob: string; from: number; to: number }; frame?: { blob: string; t: number }; gap?: { reason: string; from: number; detail?: string } };
export type FrameState = Record<string, Session>;

const sessionOf = (line: Line) => {
  const data = line.data as { session?: unknown } | null;
  return typeof data?.session === 'string' ? data.session : undefined;
};

export const frameFold: Fold<FrameState> = {
  init: () => ({}),
  accepts: (line) => line.source === 'browser' && line.kind.startsWith('frame'),
  reduce(state, line) {
    const session = sessionOf(line);
    if (!session) return state;
    const was = state[session] ?? {};
    const data = line.data as { from?: unknown; to?: unknown; reason?: unknown; detail?: unknown };
    if (line.kind === 'frame' && line.blobs?.[0]) return { ...state, [session]: { ...was, frame: { blob: line.blobs[0], t: line.t }, gap: undefined } };
    if (line.kind === 'frame.gap') {
      const detail = typeof data.detail === 'string' ? data.detail : undefined;
      return { ...state, [session]: { ...was, gap: { reason: String(data.reason ?? 'gap'), from: Number(data.from ?? line.t), ...(detail ? { detail } : {}) } } };
    }
    if (line.kind === 'frame.track' && line.blobs?.[0]) {
      const webm = line.blobs.find((blob) => !blob.endsWith('.json')) ?? line.blobs[0];
      return { ...state, [session]: { ...was, track: { blob: webm, from: Number(data.from ?? line.t), to: Number(data.to ?? line.t) } } };
    }
    return state;
  },
};

/** What to draw for `session` at time `t`: a gap wins over the last frame; a track covers its span. */
export function pictureAt(state: FrameState, session: string, t: number): Picture {
  const at = state[session];
  if (!at) return { kind: 'none' };
  if (at.gap && at.gap.from <= t) return { kind: 'gap', reason: at.gap.reason, from: at.gap.from, ...(at.gap.detail ? { detail: at.gap.detail } : {}) };
  if (at.track && at.track.from <= t && t <= at.track.to) return { kind: 'track', blob: at.track.blob, offset: (t - at.track.from) / 1000 };
  if (at.frame) return { kind: 'frame', blob: at.frame.blob, t: at.frame.t };
  return { kind: 'none' };
}

/** Why a `credential_on_page` gap was written, from its `detail` (RECORDING.md section 5): the gap's tooltip. A detail
 *  this viewer does not know is shown as it is; a gap with none has no tooltip. */
const GAP_DETAIL: Record<string, string> = {
  field: 'A credential or code field on the page holds a value.',
  typed: 'A credential or code field held a value since the last check.',
  too_deep: 'The page nests deeper than the check reads, so a credential counts as present.',
  unreadable_frame: 'A visible frame on the page cannot be read (another origin, such as a payment or sign-in widget), so a credential counts as present.',
  host: 'The host paused the session.',
};
export const gapTitle = (detail: string | undefined): string | undefined => (detail === undefined ? undefined : GAP_DETAIL[detail] ?? `Detail: ${detail}`);


// The browser's pictures in a recording (RECORDING.md section 5): pi-browser's frame recorder screencasts every session the
// run's browser opens and hands its `frame` and `frame.gap` lines, each frame's JPEG as a blob, to the recorder's live
// lines; when the process detaches its recorder, `exportFrameTracks` makes one `frame.track` per session from them (a WebM
// and its index). Only a real browser is recorded (a local Chrome or Browserbase): the fake one has no pictures. A frame
// is never worth a browser call or the run: a line the sink cannot keep is dropped (section 7), and a track that cannot be
// made is left out, the frames it would have joined staying in the recording.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserProvider } from '@parcha/pi-browser';
import { exportFrameTracks, frameRecorder, type FrameLine } from '@parcha/pi-browser/recorder';
import type { BrowserPlane } from './host.ts';
import { startedAt, type Recorder } from './record.ts';

/** Frames kept per second per session, at most. The screencast sends a frame only when the page changes, so a still page
 *  costs nothing; this bounds a page that keeps moving (an animation, a video) at FRAME_FPS JPEGs of up to 800 px a second. */
export const FRAME_FPS = 4;

export type FrameTap = {
  /** The plane with every provider it hands out watched by the frame recorder (one watch per provider). */
  plane(browser: BrowserPlane): BrowserPlane;
  /** Stops the capture, waits for the lines still on their way, and writes a `frame.track` line per session that has a frame. */
  finish(): Promise<void>;
  stats(): { frames: number; gaps: number; dropped: number; sessions: number; tracks: number };
};

/** `dir` is the recording's directory, `started` its clock when this process is handed it (`RECORD_STARTED`). The clock is read
 *  at the first line, after the recorder has started: nothing here touches the directory before then. `internals` is for tests. */
export function recordFrames(recorder: Recorder, dir: string, options: { started?: string; fps?: number } = {}, internals: { frameRecorder?: typeof frameRecorder; exportFrameTracks?: typeof exportFrameTracks } = {}): FrameTap {
  let started: number | undefined;
  const clock = () => Math.max(0, Date.now() - (started ??= Date.parse(startedAt(dir, options.started))));
  const fps = options.fps ?? FRAME_FPS;
  const lines: FrameLine[] = [];
  let tracks = 0;
  const frames = (internals.frameRecorder ?? frameRecorder)({
    clock, maxFps: fps,
    sink: (line, blobs) => {
      const kept = Object.values(blobs ?? {}).map((bytes) => recorder.blob(bytes, 'jpg'));
      recorder.live('browser', line.kind, line.data, { conv: line.conv, ...(kept.length ? { blobs: kept } : {}) });
      lines.push(line);
    },
  });
  const watched = new WeakMap<BrowserProvider, BrowserProvider>();
  const watch = (provider: BrowserProvider) => {
    let tapped = watched.get(provider);
    if (!tapped) { tapped = frames.watch(provider); watched.set(provider, tapped); }
    return tapped;
  };
  return {
    plane: (browser) => ({ ...browser, provider: async (target) => watch(await browser.provider(target)) }),
    async finish() {
      await frames.close();
      if (!lines.some((line) => line.kind === 'frame')) return;
      try {
        const made = await (internals.exportFrameTracks ?? exportFrameTracks)({ lines, fps, endAt: clock(), readBlob: (sha256) => readFile(join(dir, 'blobs', `${sha256}.jpg`)) });
        for (const { line, blobs } of made) {
          const [webm, index] = line.blobs;
          recorder.blob(blobs[webm]!, 'webm');
          recorder.blob(blobs[index]!, 'json');
          recorder.live('browser', 'frame.track', line.data, { conv: line.conv, blobs: [webm, index] });
          tracks += 1;
        }
      } catch (error) {
        // No ffmpeg, or one that failed: the frames stay, with no track over them.
        process.emitWarning(`agentrun-reference: no frame.track was made: ${(error as Error).message}`, { code: 'AGENTRUN_FRAME_TRACK' });
      }
    },
    stats: () => ({ ...frames.stats(), tracks }),
  };
}

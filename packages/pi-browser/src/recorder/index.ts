// The host-side frame recorder: it screencasts each browser session over DevTools and hands agentrun.recording/1's `frame` and
// `frame.gap` lines, with the JPEG blobs, to a sink the host passes. It is read-only beside the session's own connections and writes
// nothing of its own.
export { frameRecorder, type FrameData, type FrameGapData, type FrameLine, type FrameRecorder, type FrameRecorderOptions, type FrameSink } from "./frames.js";
export { CREDENTIAL_PROBE } from "./credential.js";
export { jpegSize } from "./jpeg.js";
export { exportFrameTracks, planTrack, TrackExportError, type FrameTrackData, type FrameTrackLine, type Track, type TrackFrame, type TrackGap, type TrackIndex, type TrackOptions, type TrackPlan, type TrackSegment } from "./track.js";

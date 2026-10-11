// Video: what the file is (duration, size, frame rate), frames found by seek, a window by stream copy when it fits and
// one re-encode when it does not, never the whole file; the inline size comes from the request budget. Without ffmpeg
// in the environment a file under the inline budget still goes to a route that takes video, and the rest is a typed
// miss.

export {};

package ai.agentrun.phoned;

import ai.agentrun.phoned.device.Device;

/**
 * The driver waits, never the model. After an act, the screen has settled when the accessibility event stream and the
 * window's frames have both been quiet for QUIET_MS, or when the cap runs out. Never uiautomator's waitForIdle (1 s of
 * silence, up to 10 s, then "could not get idle state"): a caret or a spinner that never stops just reaches the cap,
 * and the answer says it did not settle.
 */
public final class Settle {
	/** How long both streams must be quiet. */
	public static final long QUIET_MS = 150;
	/** How often they are read. */
	static final long POLL_MS = 25;
	/** How long a step waits for a first sign (an event or a frame) that it landed. */
	public static final long SIGN_MS = 400;

	private Settle() {}

	/**
	 * Waits until events and frames have been quiet for QUIET_MS, at most capMs; true when they were. Frames are read
	 * from windowId (-1: events alone).
	 */
	public static boolean quiet(Device.Accessibility a11y, Device.Clock clock, int windowId, long capMs, Wire.Cancel cancel) throws InterruptedException {
		long start = clock.now();
		long lastActivity = start;
		long events = a11y.events();
		if (windowId >= 0) a11y.framesSince(windowId);
		for (;;) {
			cancel.check();
			clock.sleep(POLL_MS);
			long now = clock.now();
			long seen = a11y.events();
			if (seen != events) {
				events = seen;
				lastActivity = now;
			}
			if (windowId >= 0 && a11y.framesSince(windowId) > 0) lastActivity = now;
			if (now - lastActivity >= QUIET_MS) return true;
			if (now - start >= capMs) return false;
		}
	}

	/**
	 * Whether the phone showed a sign within SIGN_MS that a step landed: an accessibility event after eventsBefore, or a
	 * frame presented in windowId.
	 */
	public static boolean sign(Device.Accessibility a11y, Device.Clock clock, int windowId, long eventsBefore, Wire.Cancel cancel) throws InterruptedException {
		long start = clock.now();
		for (;;) {
			if (a11y.events() != eventsBefore) return true;
			if (windowId >= 0 && a11y.framesSince(windowId) > 0) return true;
			if (clock.now() - start >= SIGN_MS) return false;
			cancel.check();
			clock.sleep(POLL_MS);
		}
	}
}

package ai.agentrun.phoned.device;

import ai.agentrun.phoned.RpcError;

/** The words for a UiAutomation connect the phone refused, shared by the phone's Ax and the scripted phone. */
public final class AxRefusal {
	private AxRefusal() {}

	/**
	 * unsupported, in words: "already registered" (the system's UiAutomationManager, while another UiAutomation is
	 * connected) names the one-client rule; anything else says to try again.
	 */
	public static RpcError of(Throwable t) {
		String text = String.valueOf(t.getMessage());
		for (Throwable c = t.getCause(); c != null; c = c.getCause()) text += " " + c.getMessage();
		if (text.contains("already registered")) {
			return RpcError.unsupported("another UiAutomation client holds the phone's accessibility (a `uiautomator dump`, "
					+ "an instrumentation test, Appium or another phoned): only one may connect at a time; stop it and try "
					+ "again");
		}
		return RpcError.unsupported("could not connect to the phone's accessibility service (" + t + "); try again, and "
				+ "reboot the phone if it keeps failing");
	}
}

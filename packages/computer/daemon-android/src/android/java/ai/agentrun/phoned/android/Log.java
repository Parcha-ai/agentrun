package ai.agentrun.phoned.android;

import java.io.PrintStream;

/** Lines to stderr, which the launcher sends to a file. stdout carries protocol lines only. */
final class Log {
	private static final PrintStream ERR = System.err;

	private Log() {}

	static synchronized void i(String message) {
		ERR.println("phoned: " + message);
		ERR.flush();
	}

	static synchronized void w(String message, Throwable t) {
		ERR.println("phoned: " + message + (t == null ? "" : ": " + t));
		if (t != null) t.printStackTrace(ERR);
		ERR.flush();
	}
}

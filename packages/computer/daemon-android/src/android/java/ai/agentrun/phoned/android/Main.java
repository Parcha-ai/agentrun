// The process setup is adapted from scrcpy server/src/main/java/com/genymobile/scrcpy/Server.java at
// a60891aea193d92e7e5c3942700eca63f9d19a5f, Apache-2.0.
package ai.agentrun.phoned.android;

import ai.agentrun.phoned.Phoned;
import ai.agentrun.phoned.Version;
import ai.agentrun.phoned.Wire;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * phoned's entry point on the phone, started over adb as the shell user:
 * {@code CLASSPATH=/data/local/tmp/phoned-<sha>.jar app_process / ai.agentrun.phoned.android.Main}.
 * JSON-RPC lines come in on stdin and go out on stdout; stderr is a log file.
 */
public final class Main {
	private Main() {}

	public static void main(String... args) {
		// stdout carries protocol lines only. Keep its descriptor for the wire and point System.out at stderr, so a
		// stray print from the framework or a library cannot break the protocol.
		OutputStream protocolOut = new FileOutputStream(FileDescriptor.out);
		System.setOut(System.err);

		Thread.setDefaultUncaughtExceptionHandler((t, e) -> Log.w("uncaught on thread " + t.getName(), e));

		int status = 0;
		AndroidDevice device = null;
		try {
			Workarounds.prepareMainLooper();
			Workarounds.apply();
			device = new AndroidDevice();
			AndroidDevice closing = device;
			Runtime.getRuntime().addShutdownHook(new Thread(closing::close, "phoned-close"));
			Log.i("serving " + Version.VALUE + " on " + device.facts().maker + " " + device.facts().model + ", Android "
					+ device.facts().release + " (API " + device.facts().sdk + ")");
			Wire.serve(System.in, protocolOut, new Phoned(device, Version.VALUE));
			Log.i("stdin closed, exiting");
		} catch (Throwable t) {
			Log.w("phoned stopped", t);
			status = 1;
		} finally {
			if (device != null) device.close();
			// The framework starts non-daemon threads of its own; exit explicitly, as scrcpy does.
			System.exit(status);
		}
	}
}

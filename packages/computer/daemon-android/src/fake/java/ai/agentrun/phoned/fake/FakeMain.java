package ai.agentrun.phoned.fake;

import ai.agentrun.phoned.Exec;
import ai.agentrun.phoned.Phoned;
import ai.agentrun.phoned.Version;
import ai.agentrun.phoned.Wire;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.file.Paths;

/**
 * phoned's real core over the scripted phone, on stdio: what a fake adb server starts in place of app_process, so the
 * TypeScript side and the live probe's dry run talk to the Java code that runs on a phone. Its exec.run runs on this
 * machine, in the directory given as the first argument (default /tmp).
 */
public final class FakeMain {
	private FakeMain() {}

	public static void main(String... args) throws Exception {
		OutputStream protocolOut = new FileOutputStream(FileDescriptor.out);
		System.setOut(System.err);
		FakeDevice device = new FakeDevice(false);
		// As a phone does: a launched app is in front before its window reaches the tree, the window animates in, and the
		// accessibility service puts windows in another space from their elements.
		device.windowLagMs = 300;
		device.openAnimationMs = 300;
		device.windowSkewY = 1000;
		// phoned.fake.phone: a directory standing for the phone, which keeps its one UiAutomation registration there for
		// every phoned started on it. phoned.fake.exitMs: how long this phoned holds it after its stdin closes, as a
		// phoned still ending its requests does.
		String phone = System.getProperty("phoned.fake.phone");
		if (phone != null) device.axHolder = Paths.get(phone, "uiautomation");
		long exitMs = Long.getLong("phoned.fake.exitMs", 0L);
		String home = args.length > 0 ? args[0] : "/tmp";
		Wire.serve(System.in, protocolOut, new Phoned(device, Version.VALUE, new Exec(System.getenv(), home)));
		if (exitMs > 0) Thread.sleep(exitMs);
		device.close();
		System.exit(0);
	}
}

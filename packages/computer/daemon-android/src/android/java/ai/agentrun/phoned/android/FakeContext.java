// Adapted from scrcpy server/src/main/java/com/genymobile/scrcpy/FakeContext.java at
// a60891aea193d92e7e5c3942700eca63f9d19a5f, Apache-2.0.
package ai.agentrun.phoned.android;

import android.content.Context;
import android.content.ContextWrapper;

/**
 * The system context, speaking as the shell package (com.android.shell, uid 2000), so the framework's own managers
 * (PackageManager, UserManager) work from app_process. scrcpy's content-resolver and attribution-source overrides are
 * left out: phoned uses neither, and they need classes the API 30 SDK does not have.
 */
final class FakeContext extends ContextWrapper {
	static final String PACKAGE_NAME = "com.android.shell";

	private static FakeContext instance;

	private FakeContext(Context base) {
		super(base);
	}

	/** The context, or null when Workarounds could not build a system context. */
	static synchronized FakeContext get() {
		if (instance == null) {
			Context base = Workarounds.systemContext();
			if (base == null) return null;
			instance = new FakeContext(base);
		}
		return instance;
	}

	@Override
	public String getPackageName() {
		return PACKAGE_NAME;
	}

	@Override
	public String getOpPackageName() {
		return PACKAGE_NAME;
	}

	// Overrides Context.getDeviceId() on Android 14 and later; the API 30 SDK does not have it.
	@SuppressWarnings("unused")
	public int getDeviceId() {
		return 0;
	}

	@Override
	public Context getApplicationContext() {
		return this;
	}

	@Override
	public Context createPackageContext(String packageName, int flags) {
		return this;
	}
}

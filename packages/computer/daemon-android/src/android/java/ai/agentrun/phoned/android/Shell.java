package ai.agentrun.phoned.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * Runs a phone tool (dumpsys, am) as an argv list: never through a shell, so no text is ever parsed as a command.
 * Its stdin is a pipe closed at once, so the tool can never read phoned's protocol input.
 */
final class Shell {
	private static final int MAX_OUTPUT = 16 << 20;

	private Shell() {}

	/** What the tool printed (stdout and stderr together) and how it exited. */
	static final class Result {
		final int exit;
		final String output;

		Result(int exit, String output) {
			this.exit = exit;
			this.output = output;
		}
	}

	static Result run(long timeoutMs, String... argv) throws IOException {
		Process p = new ProcessBuilder(argv).redirectErrorStream(true).start();
		p.getOutputStream().close();
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		Thread reader = new Thread(() -> drain(p.getInputStream(), out), "phoned-shell");
		reader.setDaemon(true);
		reader.start();
		try {
			if (!p.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
				p.destroy();
				throw new IOException(argv[0] + " did not finish within " + timeoutMs + " ms");
			}
			reader.join(1000);
		} catch (InterruptedException e) {
			p.destroy();
			Thread.currentThread().interrupt();
			throw new IOException(argv[0] + " was interrupted");
		}
		synchronized (out) {
			return new Result(p.exitValue(), new String(out.toByteArray(), StandardCharsets.UTF_8));
		}
	}

	private static void drain(InputStream in, ByteArrayOutputStream out) {
		byte[] buf = new byte[64 << 10];
		try {
			int n;
			while ((n = in.read(buf)) > 0) {
				synchronized (out) {
					if (out.size() < MAX_OUTPUT) out.write(buf, 0, Math.min(n, MAX_OUTPUT - out.size()));
				}
			}
		} catch (IOException e) {
			// The process ended or was destroyed; what was read is kept.
		}
	}
}

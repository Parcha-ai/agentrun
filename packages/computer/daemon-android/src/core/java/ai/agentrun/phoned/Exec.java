package ai.agentrun.phoned;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * exec.run on a phone: a program as the shell user, phoned's own user. Never a shell (the caller picks one with
 * ["sh", "-c", ...]). The environment is a minimal default plus env: PATH, HOME, USER and LOGNAME, and the variables
 * Android's own tools need to start (ANDROID_*, BOOTCLASSPATH and the other class paths), none of the rest of
 * phoned's.
 */
public final class Exec {
	/** protocol.ts MAX_OUTPUT_BYTES: the most bytes kept of each stream. */
	static final int MAX_OUTPUT_BYTES = 360 * 1024;
	/** The shell user's home: the one directory it may write. */
	static final String HOME = "/data/local/tmp";
	static final long MAX_TIMEOUT_MS = 24L * 60 * 60 * 1000;

	private final Map<String, String> inherited;
	private final String home;

	/** inherited: phoned's own environment; home: the shell user's home (HOME on a phone, a scratch directory in tests). */
	public Exec(Map<String, String> inherited, String home) {
		this.inherited = inherited;
		this.home = home;
	}

	/** The variables passed on from phoned's own environment. */
	static boolean passed(String name) {
		return name.equals("PATH") || name.startsWith("ANDROID_") || name.equals("BOOTCLASSPATH") || name.equals("DEX2OATBOOTCLASSPATH")
				|| name.equals("SYSTEMSERVERCLASSPATH") || name.equals("STANDALONE_SYSTEMSERVER_JARS") || name.equals("EXTERNAL_STORAGE")
				|| name.equals("ASEC_MOUNTPOINT") || name.equals("TMPDIR");
	}

	public Map<String, Object> run(Params p, Wire.Cancel cancel) throws InterruptedException {
		List<Object> argvRaw = p.list("argv");
		if (argvRaw.isEmpty()) throw RpcError.invalid("params.argv names no program: it is [program, ...arguments]");
		List<String> argv = new ArrayList<>(argvRaw.size());
		for (int i = 0; i < argvRaw.size(); i++) {
			if (!(argvRaw.get(i) instanceof String)) throw RpcError.invalid("params.argv[" + i + "] must be a string");
			argv.add((String) argvRaw.get(i));
		}
		long timeoutMs = p.whole("timeoutMs", 1, MAX_TIMEOUT_MS);
		int maxOutput = (int) p.whole("maxOutput", MAX_OUTPUT_BYTES, 0, MAX_OUTPUT_BYTES);
		String user = p.str("user", null);
		if (user != null && !user.equals("shell") && !user.equals("2000") && !user.equals("2000:2000")) {
			throw RpcError.denied("phoned runs as the shell user and cannot switch to " + Json.write(user) + ": leave user out, or name shell");
		}
		File cwd = new File(home);
		if (p.has("cwd")) {
			String dir = p.str("cwd");
			cwd = dir.startsWith("/") ? new File(dir) : new File(home, dir);
			if (!cwd.isDirectory()) throw RpcError.notFound("cwd " + cwd.getPath() + " is not a directory on the phone");
		}
		ProcessBuilder builder = new ProcessBuilder(argv).directory(cwd);
		Map<String, String> env = builder.environment();
		env.clear();
		for (Map.Entry<String, String> e : inherited.entrySet()) if (passed(e.getKey())) env.put(e.getKey(), e.getValue());
		env.put("HOME", home);
		env.put("USER", "shell");
		env.put("LOGNAME", "shell");
		if (!env.containsKey("PATH")) env.put("PATH", "/product/bin:/apex/com.android.runtime/bin:/apex/com.android.art/bin:/system_ext/bin:/system/bin:/system/xbin:/odm/bin:/vendor/bin:/vendor/xbin");
		if (p.has("env")) {
			for (Map.Entry<String, Object> e : envOf(p).entrySet()) {
				if (!(e.getValue() instanceof String)) throw RpcError.invalid("params.env." + e.getKey() + " must be a string");
				env.put(e.getKey(), (String) e.getValue());
			}
		}
		Process process;
		try {
			process = builder.start();
		} catch (IOException e) {
			throw RpcError.notFound(argv.get(0) + " did not start on the phone: " + e.getMessage());
		}
		try {
			process.getOutputStream().close();
		} catch (IOException e) {
			// The program may already be gone; its exit says what happened.
		}
		Drain out = new Drain(process.getInputStream(), maxOutput);
		Drain err = new Drain(process.getErrorStream(), maxOutput);
		out.start();
		err.start();
		boolean timedOut = false;
		boolean killed = false;
		try {
			long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
			while (!process.waitFor(Math.min(50, Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()))), TimeUnit.MILLISECONDS)) {
				if (cancel.cancelled()) {
					killed = true;
					break;
				}
				if (System.nanoTime() >= deadline) {
					timedOut = true;
					killed = true;
					break;
				}
			}
		} catch (InterruptedException e) {
			killed = true;
		}
		if (killed) {
			killTree(process);
			process.waitFor(5, TimeUnit.SECONDS);
		}
		out.join(5000);
		err.join(5000);
		cancel.check();
		Long code = killed ? null : (long) process.exitValue();
		return Json.obj("exitCode", code, "signal", killed ? "KILL" : Json.OMIT, "stdout", Shots.b64(out.bytes()), "stderr", Shots.b64(err.bytes()),
				"timedOut", timedOut, "truncated", out.truncated || err.truncated);
	}

	/**
	 * Ends the program and every process under it with SIGKILL: a program never outlives its run (stdio.md), and a child
	 * left holding the program's stdout would hold its reply up too. Android has no ProcessHandle, so the tree is read
	 * from /proc.
	 */
	static void killTree(Process process) {
		long pid = pidOf(process);
		List<String> under = pid > 0 ? descendants(pid) : new ArrayList<>();
		process.destroyForcibly();
		if (under.isEmpty()) return;
		List<String> argv = new ArrayList<>();
		argv.add("kill");
		argv.add("-9");
		argv.addAll(under);
		try {
			Process kill = new ProcessBuilder(argv).redirectErrorStream(true).start();
			kill.waitFor(2, TimeUnit.SECONDS);
		} catch (IOException e) {
			// No kill on PATH: the program itself is gone, and its children end when they next write to its pipes.
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
	}

	/** A started program's pid: Process.pid() where the JVM has it, else the Android process class's own field. */
	static long pidOf(Process p) {
		try {
			return ((Number) Process.class.getMethod("pid").invoke(p)).longValue();
		} catch (ReflectiveOperationException | RuntimeException e) {
			// Android's Process has no pid(); its implementation keeps one.
		}
		for (Class<?> c = p.getClass(); c != null; c = c.getSuperclass()) {
			try {
				java.lang.reflect.Field f = c.getDeclaredField("pid");
				f.setAccessible(true);
				return ((Number) f.get(p)).longValue();
			} catch (ReflectiveOperationException | RuntimeException e) {
				// Not on this class; try its parent.
			}
		}
		return -1;
	}

	/** Every process under pid, from each /proc/<pid>/stat's parent field. */
	static List<String> descendants(long pid) {
		Map<String, List<String>> children = new java.util.HashMap<>();
		File[] entries = new File("/proc").listFiles();
		if (entries != null) {
			for (File entry : entries) {
				String name = entry.getName();
				if (name.isEmpty() || !name.chars().allMatch(Character::isDigit)) continue;
				String stat;
				try {
					stat = new String(java.nio.file.Files.readAllBytes(new File(entry, "stat").toPath()), java.nio.charset.StandardCharsets.UTF_8);
				} catch (IOException | RuntimeException e) {
					continue;
				}
				// "pid (comm) state ppid ...": comm may hold spaces and parentheses, so read after the last ")".
				String[] rest = stat.substring(stat.lastIndexOf(')') + 1).trim().split(" ");
				if (rest.length > 1) children.computeIfAbsent(rest[1], k -> new ArrayList<>()).add(name);
			}
		}
		List<String> out = new ArrayList<>();
		List<String> todo = new ArrayList<>();
		todo.add(Long.toString(pid));
		while (!todo.isEmpty() && out.size() < 4096) {
			List<String> kids = children.get(todo.remove(todo.size() - 1));
			if (kids == null) continue;
			for (String k : kids) {
				out.add(k);
				todo.add(k);
			}
		}
		return out;
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> envOf(Params p) {
		Object env = p.raw("env");
		if (!(env instanceof Map)) throw RpcError.invalid("params.env must be an object of strings");
		return (Map<String, Object>) env;
	}

	/** Reads a stream to its end, keeping its first max bytes. */
	private static final class Drain extends Thread {
		private final InputStream in;
		private final int max;
		private final ByteArrayOutputStream kept = new ByteArrayOutputStream();
		volatile boolean truncated;

		Drain(InputStream in, int max) {
			super("phoned-exec-drain");
			setDaemon(true);
			this.in = in;
			this.max = max;
		}

		@Override
		public void run() {
			byte[] buffer = new byte[16 * 1024];
			try {
				for (int n; (n = in.read(buffer)) >= 0;) {
					synchronized (kept) {
						int room = max - kept.size();
						if (n > room) truncated = true;
						if (room > 0) kept.write(buffer, 0, Math.min(n, room));
					}
				}
			} catch (IOException e) {
				// The process ended or was killed: what was read is kept.
			}
		}

		byte[] bytes() {
			synchronized (kept) {
				return kept.toByteArray();
			}
		}
	}
}

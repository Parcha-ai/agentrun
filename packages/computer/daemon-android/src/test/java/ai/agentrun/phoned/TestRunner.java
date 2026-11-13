package ai.agentrun.phoned;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.Arrays;
import java.util.Comparator;

/**
 * The JVM tests' runner, with no library: each named class's static void methods whose names start with "test", in
 * name order. Prints one line per test and exits 1 when any failed.
 */
public final class TestRunner {
	private TestRunner() {}

	public static void main(String... classes) throws Exception {
		int ran = 0;
		int failed = 0;
		for (String name : classes) {
			Method[] methods = Class.forName(name).getDeclaredMethods();
			Arrays.sort(methods, Comparator.comparing(Method::getName));
			for (Method m : methods) {
				if (!m.getName().startsWith("test") || !Modifier.isStatic(m.getModifiers()) || m.getParameterCount() != 0) continue;
				ran++;
				String label = name.substring(name.lastIndexOf('.') + 1) + "." + m.getName();
				try {
					m.setAccessible(true);
					m.invoke(null);
					System.out.println("ok   " + label);
				} catch (InvocationTargetException e) {
					failed++;
					System.out.println("FAIL " + label);
					e.getCause().printStackTrace(System.out);
				}
			}
		}
		System.out.println(ran + " tests, " + failed + " failed");
		System.exit(failed == 0 && ran > 0 ? 0 : 1);
	}
}

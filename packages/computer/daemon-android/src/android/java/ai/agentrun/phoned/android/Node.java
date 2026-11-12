package ai.agentrun.phoned.android;

import ai.agentrun.phoned.RpcError;
import ai.agentrun.phoned.device.AxNode;
import ai.agentrun.phoned.device.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** One element of the tree over AccessibilityNodeInfo. */
final class Node implements AxNode {
	private static final Method SOURCE_NODE_ID = Hidden.method(AccessibilityNodeInfo.class, "getSourceNodeId");
	private static Standard standard;

	private final AccessibilityNodeInfo n;
	private final Object key;

	Node(AccessibilityNodeInfo n) {
		this.n = n;
		this.key = keyOf(n);
	}

	/**
	 * The window id and the hidden source node id, which is what AccessibilityNodeInfo.equals compares: the same
	 * element read twice gives equal keys. When the hidden getter is missing, the node itself (its equals compares the
	 * same two fields).
	 */
	private static Object keyOf(AccessibilityNodeInfo n) {
		if (SOURCE_NODE_ID != null) {
			try {
				return new Key(n.getWindowId(), (Long) SOURCE_NODE_ID.invoke(n));
			} catch (ReflectiveOperationException | RuntimeException e) {
				// fall through to the node's own equality
			}
		}
		return n;
	}

	private static final class Key {
		final int window;
		final long source;

		Key(int window, long source) {
			this.window = window;
			this.source = source;
		}

		@Override
		public boolean equals(Object o) {
			return o instanceof Key && ((Key) o).window == window && ((Key) o).source == source;
		}

		@Override
		public int hashCode() {
			return window * 31 + Long.hashCode(source);
		}

		@Override
		public String toString() {
			return window + ":" + source;
		}
	}

	@Override
	public Object key() {
		return key;
	}

	@Override
	public boolean refresh() {
		try {
			return n.refresh();
		} catch (RuntimeException e) {
			return false;
		}
	}

	private static String str(CharSequence s) {
		return s == null ? null : s.toString();
	}

	@Override
	public String className() {
		return str(n.getClassName());
	}

	@Override
	public String packageName() {
		return str(n.getPackageName());
	}

	@Override
	public String text() {
		return str(n.getText());
	}

	@Override
	public String description() {
		return str(n.getContentDescription());
	}

	@Override
	public String hint() {
		return str(n.getHintText());
	}

	@Override
	public String viewId() {
		return n.getViewIdResourceName();
	}

	@Override
	public String stateDescription() {
		return str(n.getStateDescription());
	}

	@Override
	public boolean heading() {
		return n.isHeading();
	}

	@Override
	public Rect bounds() {
		android.graphics.Rect r = new android.graphics.Rect();
		n.getBoundsInScreen(r);
		return new Rect(r.left, r.top, r.right, r.bottom);
	}

	@Override
	public boolean visible() {
		return n.isVisibleToUser();
	}

	@Override
	public boolean clickable() {
		return n.isClickable();
	}

	@Override
	public boolean longClickable() {
		return n.isLongClickable();
	}

	@Override
	public boolean editable() {
		return n.isEditable();
	}

	@Override
	public boolean checkable() {
		return n.isCheckable();
	}

	@SuppressWarnings("deprecation")
	@Override
	public boolean checked() {
		return n.isChecked();
	}

	@Override
	public boolean enabled() {
		return n.isEnabled();
	}

	@Override
	public boolean focused() {
		return n.isFocused();
	}

	@Override
	public boolean selected() {
		return n.isSelected();
	}

	@Override
	public boolean scrollable() {
		return n.isScrollable();
	}

	@Override
	public boolean password() {
		return n.isPassword();
	}

	@Override
	public List<String> actions() {
		List<AccessibilityAction> actions = n.getActionList();
		if (actions == null || actions.isEmpty()) return Collections.emptyList();
		Map<Integer, String> names = standard().byId;
		List<String> out = new ArrayList<>(actions.size());
		for (AccessibilityAction a : actions) {
			String name = names.get(a.getId());
			if (name != null) out.add(name);
			else if (a.getLabel() != null) out.add(a.getLabel().toString());
		}
		return out;
	}

	/** The platform's actions by name and by id: the public AccessibilityAction constants of this phone's framework. */
	private static final class Standard {
		final Map<Integer, String> byId = new HashMap<>();
		final Map<String, Integer> byName = new HashMap<>();
	}

	private static synchronized Standard standard() {
		if (standard == null) {
			Standard s = new Standard();
			for (Field f : AccessibilityAction.class.getFields()) {
				if (f.getType() != AccessibilityAction.class || !Modifier.isStatic(f.getModifiers())) continue;
				try {
					Object a = f.get(null);
					if (a == null) continue;
					int id = ((AccessibilityAction) a).getId();
					s.byId.put(id, f.getName());
					s.byName.put(f.getName(), id);
				} catch (ReflectiveOperationException | RuntimeException e) {
					// skip the one constant
				}
			}
			standard = s;
		}
		return standard;
	}

	@Override
	public int childCount() {
		return n.getChildCount();
	}

	@Override
	public AxNode child(int i) {
		try {
			AccessibilityNodeInfo c = n.getChild(i);
			return c == null ? null : new Node(c);
		} catch (RuntimeException e) {
			return null;
		}
	}

	@Override
	public boolean perform(String action, String argument) {
		if ("ACTION_SET_TEXT".equals(action)) {
			Bundle args = new Bundle();
			args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, argument == null ? "" : argument);
			return n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
		}
		Integer id = standard().byName.get(action);
		if (id != null) return n.performAction(id);
		List<AccessibilityAction> actions = n.getActionList();
		if (actions != null) {
			Map<Integer, String> names = standard().byId;
			for (AccessibilityAction a : actions) {
				if (a.getLabel() != null && !names.containsKey(a.getId()) && action.equals(a.getLabel().toString())) {
					return n.performAction(a.getId());
				}
			}
		}
		throw RpcError.notFound("this element has no action \"" + action + "\": it has " + actions());
	}
}

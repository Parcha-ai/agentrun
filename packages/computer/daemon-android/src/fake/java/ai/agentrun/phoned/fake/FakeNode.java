package ai.agentrun.phoned.fake;

import ai.agentrun.phoned.RpcError;
import ai.agentrun.phoned.device.AxNode;
import ai.agentrun.phoned.device.Rect;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.Consumer;

/** One element of a scripted screen, as phoned's core reads an AccessibilityNodeInfo. */
public final class FakeNode implements AxNode {
	private static int next;

	public final int id;
	public String cls;
	public String pkg = "com.android.settings";
	public String text;
	public String desc;
	public String hint;
	public String viewId;
	/** Its stateDescription, or null. */
	public String state;
	public boolean heading;
	/** Its state counts the injected taps that reached it (the ui fixture's canvas): an accessibility action never does. */
	public boolean counts;
	public Rect bounds = new Rect(0, 0, 0, 0);
	public boolean visible = true;
	public boolean clickable;
	public boolean longClickable;
	public boolean editable;
	public boolean checkable;
	public boolean checked;
	public boolean enabled = true;
	public boolean focused;
	public boolean selected;
	public boolean scrollable;
	public boolean password;
	/** False once the element left the screen: refresh() says so, and actions fail. */
	public boolean alive = true;
	public final List<String> extra = new ArrayList<>();
	public final List<FakeNode> children = new ArrayList<>();
	/** What the app does on an action, by its name. */
	public Consumer<String> onAction = action -> {};
	/** Every action performed on it, in order. */
	public final List<String> performed = new ArrayList<>();

	public FakeNode(String cls) {
		synchronized (FakeNode.class) {
			id = ++next;
		}
		this.cls = cls;
	}

	public static FakeNode of(String cls) {
		return new FakeNode(cls);
	}

	public FakeNode at(int left, int top, int right, int bottom) {
		bounds = new Rect(left, top, right, bottom);
		return this;
	}

	public FakeNode text(String t) {
		text = t;
		return this;
	}

	public FakeNode desc(String d) {
		desc = d;
		return this;
	}

	public FakeNode id(String v) {
		viewId = v;
		return this;
	}

	public FakeNode pkg(String p) {
		pkg = p;
		for (FakeNode c : children) c.pkg(p);
		return this;
	}

	public FakeNode tappable() {
		clickable = true;
		return this;
	}

	public FakeNode on(Consumer<String> handler) {
		onAction = handler;
		return this;
	}

	public FakeNode add(FakeNode... kids) {
		children.addAll(Arrays.asList(kids));
		for (FakeNode k : kids) k.pkg = pkg;
		return this;
	}

	/** It and everything under it are scrolled out of view: still in the tree, not visible to the user. */
	public FakeNode hidden() {
		visible = false;
		for (FakeNode c : children) c.hidden();
		return this;
	}

	/** It and everything under it move down by dy pixels (up when negative), as a window animating in moves them. */
	public void shift(int dy) {
		bounds = new Rect(bounds.left, bounds.top + dy, bounds.right, bounds.bottom + dy);
		for (FakeNode c : children) c.shift(dy);
	}

	/** It and everything under it leave the screen. */
	public void gone() {
		alive = false;
		for (FakeNode c : children) c.gone();
	}

	@Override
	public Object key() {
		return id;
	}

	@Override
	public boolean refresh() {
		return alive;
	}

	@Override
	public String className() {
		return cls;
	}

	@Override
	public String packageName() {
		return pkg;
	}

	@Override
	public String text() {
		return text;
	}

	@Override
	public String description() {
		return desc;
	}

	@Override
	public String hint() {
		return hint;
	}

	@Override
	public String viewId() {
		return viewId;
	}

	@Override
	public String stateDescription() {
		return state;
	}

	@Override
	public boolean heading() {
		return heading;
	}

	@Override
	public Rect bounds() {
		return alive ? bounds : new Rect(0, 0, 0, 0);
	}

	@Override
	public boolean visible() {
		return visible;
	}

	@Override
	public boolean clickable() {
		return clickable;
	}

	@Override
	public boolean longClickable() {
		return longClickable;
	}

	@Override
	public boolean editable() {
		return editable;
	}

	@Override
	public boolean checkable() {
		return checkable;
	}

	@Override
	public boolean checked() {
		return checked;
	}

	@Override
	public boolean enabled() {
		return enabled;
	}

	@Override
	public boolean focused() {
		return focused;
	}

	@Override
	public boolean selected() {
		return selected;
	}

	@Override
	public boolean scrollable() {
		return scrollable;
	}

	@Override
	public boolean password() {
		return password;
	}

	@Override
	public List<String> actions() {
		List<String> out = new ArrayList<>();
		if (editable) out.add("ACTION_FOCUS");
		if (clickable) out.add("ACTION_CLICK");
		if (longClickable) out.add("ACTION_LONG_CLICK");
		if (editable) out.add("ACTION_SET_TEXT");
		if (scrollable) {
			out.add("ACTION_SCROLL_FORWARD");
			out.add("ACTION_SCROLL_BACKWARD");
		}
		out.add("ACTION_ACCESSIBILITY_FOCUS");
		out.addAll(extra);
		return out;
	}

	@Override
	public int childCount() {
		return children.size();
	}

	@Override
	public AxNode child(int i) {
		return i < children.size() ? children.get(i) : null;
	}

	@Override
	public boolean perform(String action, String argument) {
		if (!alive) return false;
		if (!actions().contains(action)) throw RpcError.notFound("this element has no action \"" + action + "\": it has " + actions());
		performed.add(argument == null ? action : action + " " + argument);
		if (action.equals("ACTION_SET_TEXT")) text = argument;
		if (action.equals("ACTION_FOCUS")) focused = true;
		if (action.equals("ACTION_CLICK") && checkable) checked = !checked;
		onAction.accept(action);
		return true;
	}
}

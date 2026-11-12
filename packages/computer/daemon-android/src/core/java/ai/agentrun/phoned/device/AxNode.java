package ai.agentrun.phoned.device;

import java.util.List;

/**
 * One element of the accessibility tree as the phone holds it (an AccessibilityNodeInfo on a phone). The driver keeps
 * the AxNode behind each ref, so a ref stays good while its element exists: refresh() says whether it still does.
 */
public interface AxNode {
	/**
	 * The element's identity: equal (equals and hashCode) for the same element read twice, in this read or a later one.
	 * On a phone, the window id and the source node id.
	 */
	Object key();

	/** Reads the element again from the app; false when it is gone. */
	boolean refresh();

	String className();

	String packageName();

	/** The element's own text, or null. */
	String text();

	/** content-desc, or null. */
	String description();

	/** An empty field's hint, or null. */
	String hint();

	/** The resource id ("com.android.settings:id/title"), or null. */
	String viewId();

	/** What state it is in, in the app's words (a count, "On", "50 percent"), or null: stateDescription. */
	String stateDescription();

	/** Whether the app marks it a heading. */
	boolean heading();

	/** In screen pixels. */
	Rect bounds();

	boolean visible();

	boolean clickable();

	boolean longClickable();

	boolean editable();

	boolean checkable();

	boolean checked();

	boolean enabled();

	boolean focused();

	boolean selected();

	boolean scrollable();

	boolean password();

	/**
	 * The element's actions: the platform's by their names ("ACTION_CLICK", "ACTION_SCROLL_FORWARD"), and the app's own
	 * by their labels. Empty when it has none.
	 */
	List<String> actions();

	int childCount();

	/** The child at i, or null when it is gone. */
	AxNode child(int i);

	/**
	 * Performs one action by a name actions() lists, or one of the platform's ("ACTION_CLICK", "ACTION_FOCUS",
	 * "ACTION_SET_TEXT" with argument the text). False when the app refused it; not_found when the element has no such
	 * action.
	 */
	boolean perform(String action, String argument);
}

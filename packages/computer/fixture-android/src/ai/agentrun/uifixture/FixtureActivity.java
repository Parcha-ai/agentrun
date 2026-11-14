package ai.agentrun.uifixture;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The ui fixture (src/conformance/ui-fixture.ts) as an Android app: its windows in plain views, each element at the
 * spec's bounds in points (dp), with its id as the resource id a driver reads ("ai.agentrun.uifixture:id/next").
 *
 * <ul>
 *   <li>home: the "UI fixture" heading, the Name field, the Code field (which takes back any value set into it
 *       TAKES_BACK_MS later), the Wi-Fi switch (a row the app reports as a Switch, its two texts its name and its
 *       secondary text), Save, Next, and the Canvas, which no accessibility action reaches: its state description is
 *       the number of touches that reached it, "0" at launch. No New window: a phone app has one window.
 *   <li>Save shows the text "Saved" SAVED_MS after its press; Next opens the second page NEXT_MS after its press,
 *       fading in over NEXT_ANIMATE_MS.
 *   <li>second: the "Second page" heading and Back, which returns home, as the system's back does.
 * </ul>
 */
public final class FixtureActivity extends Activity {
	private static final String PACKAGE = "ai.agentrun.uifixture";
	private static final int SIZE = 320;
	static final long SAVED_MS = 300;
	static final long NEXT_MS = 200;
	static final long NEXT_ANIMATE_MS = 300;
	static final long TAKES_BACK_MS = 150;

	private final Handler handler = new Handler(Looper.getMainLooper());
	private FrameLayout home;
	private FrameLayout second;
	private TextView saved;
	private boolean onSecond;

	@Override
	protected void onCreate(Bundle state) {
		super.onCreate(state);
		// Tapping outside the window leaves it where it is: only Back or the system's back move it.
		setFinishOnTouchOutside(false);
		// A plain background: the dialog theme's own is inset, which would pad the window past its size.
		getWindow().setBackgroundDrawable(new ColorDrawable(Color.WHITE));
		// No keyboard opens over the window on its own: the Name field may take focus at launch, and the window stays still.
		getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
		home = homePage();
		second = secondPage();
		showHome();
		// After the first setContentView: installing the decor sets a floating window's layout to wrap its content,
		// which would size the window to the elements (316 by 280 points) and not SIZE by SIZE.
		getWindow().setLayout(px(SIZE), px(SIZE));
	}

	@Override
	protected void onDestroy() {
		handler.removeCallbacksAndMessages(null);
		super.onDestroy();
	}

	/** The system's back: the second page returns home, and home leaves the app. */
	@Override
	@SuppressWarnings("deprecation")
	public void onBackPressed() {
		if (onSecond) showHome();
		else super.onBackPressed();
	}

	private void showHome() {
		onSecond = false;
		setTitle("UI fixture");
		setContentView(home);
	}

	private void showSecond() {
		onSecond = true;
		setTitle("Second page");
		second.setAlpha(0f);
		setContentView(second);
		second.animate().alpha(1f).setDuration(NEXT_ANIMATE_MS).start();
	}

	private FrameLayout homePage() {
		FrameLayout page = page();
		place(page, heading("UI fixture"), 16, 16, 300, 24);

		place(page, field("Name", "name"), 16, 56, 200, 28);
		place(page, code(), 228, 56, 76, 28);

		place(page, wifi(), 16, 96, 60, 28);

		place(page, button("Save", "save", () -> handler.postDelayed(this::showSaved, SAVED_MS)), 16, 136, 80, 28);
		place(page, button("Next", "next", () -> handler.postDelayed(this::showSecond, NEXT_MS)), 112, 136, 80, 28);

		place(page, new Canvas(this), 16, 180, 200, 100);

		saved = text("Saved", 12);
		saved.setVisibility(View.GONE);
		place(page, saved, 208, 136, 80, 28);
		return page;
	}

	private FrameLayout secondPage() {
		FrameLayout page = page();
		place(page, heading("Second page"), 16, 16, 300, 24);
		place(page, button("Back", "back", this::showHome), 16, 56, 80, 28);
		return page;
	}

	/** Save's effect: the text Saved beside it, once. */
	private void showSaved() {
		if (!onSecond) saved.setVisibility(View.VISIBLE);
	}

	/**
	 * The Wi-Fi switch: a row of two texts that reports itself as a Switch, checkable, its check toggled by a click. Its
	 * name and secondary text are its children's, as a settings row's are.
	 */
	private View wifi() {
		LinearLayout row = new LinearLayout(this);
		row.setOrientation(LinearLayout.VERTICAL);
		row.addView(text("Wi-Fi", 10), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
		row.addView(text("Networks nearby", 8), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
		boolean[] checked = {false};
		row.setOnClickListener((view) -> {
			checked[0] = !checked[0];
			row.setBackgroundColor(checked[0] ? 0xFFCCE5FF : Color.TRANSPARENT);
			// Its checked state is read through the delegate, so a reader is told the content changed.
			row.sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
		});
		return identified(row, "wifi", (info) -> {
			info.setClassName("android.widget.Switch");
			info.setCheckable(true);
			info.setChecked(checked[0]);
		});
	}

	private EditText field(String hint, String id) {
		EditText field = new EditText(this);
		field.setHint(hint);
		field.setSingleLine(true);
		field.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
		field.setPadding(px(4), 0, px(4), 0);
		return identified(field, id, null);
	}

	/**
	 * The Code field, which refuses its input as such an app does: TAKES_BACK_MS after the newest change to a value,
	 * set or typed, it is empty again.
	 */
	private EditText code() {
		EditText code = field("Code", "code");
		Runnable takeBack = () -> code.setText("");
		code.addTextChangedListener(new TextWatcher() {
			@Override
			public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

			@Override
			public void onTextChanged(CharSequence s, int start, int before, int count) {}

			@Override
			public void afterTextChanged(Editable s) {
				handler.removeCallbacks(takeBack);
				if (s.length() > 0) handler.postDelayed(takeBack, TAKES_BACK_MS);
			}
		});
		return code;
	}

	private Button button(String words, String id, Runnable click) {
		Button button = new Button(this);
		button.setText(words);
		button.setAllCaps(false);
		button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
		button.setPadding(0, 0, 0, 0);
		button.setMinHeight(0);
		button.setMinimumHeight(0);
		button.setMinWidth(0);
		button.setMinimumWidth(0);
		button.setOnClickListener((view) -> click.run());
		return identified(button, id, null);
	}

	private TextView heading(String words) {
		TextView heading = text(words, 16);
		heading.setAccessibilityHeading(true);
		return heading;
	}

	private TextView text(String words, int sp) {
		TextView text = new TextView(this);
		text.setText(words);
		text.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
		text.setTextColor(Color.BLACK);
		text.setSingleLine(true);
		text.setGravity(Gravity.CENTER_VERTICAL);
		return text;
	}

	private FrameLayout page() {
		FrameLayout page = new FrameLayout(this);
		page.setBackgroundColor(Color.WHITE);
		return page;
	}

	/** Puts view on page at (x, y), w by h, in points. */
	private void place(FrameLayout page, View view, int x, int y, int w, int h) {
		FrameLayout.LayoutParams at = new FrameLayout.LayoutParams(px(w), px(h), Gravity.TOP | Gravity.START);
		at.leftMargin = px(x);
		at.topMargin = px(y);
		page.addView(view, at);
	}

	private interface Info {
		void fill(AccessibilityNodeInfo info);
	}

	/** The view, reporting the fixture's id as its resource id (the app has no resources to name it), and more by extra. */
	private static <V extends View> V identified(V view, String id, Info extra) {
		view.setAccessibilityDelegate(new View.AccessibilityDelegate() {
			@Override
			public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
				super.onInitializeAccessibilityNodeInfo(host, info);
				info.setViewIdResourceName(PACKAGE + ":id/" + id);
				if (extra != null) extra.fill(info);
			}
		});
		return view;
	}

	private int px(int dp) {
		return Math.round(dp * getResources().getDisplayMetrics().density);
	}

	/**
	 * The canvas: an image no accessibility action reaches (not clickable, not focusable), whose state description
	 * counts the touches that reached it, so a driver reads back whether its tap landed.
	 */
	private static final class Canvas extends View {
		private int count;

		Canvas(Context context) {
			super(context);
			setBackgroundColor(0xFFE0E0E0);
			setContentDescription("Canvas");
			setStateDescription("0");
			identified(this, "canvas", null);
		}

		@Override
		public CharSequence getAccessibilityClassName() {
			return "android.widget.ImageView";
		}

		@Override
		@SuppressWarnings("ClickableViewAccessibility")
		public boolean onTouchEvent(MotionEvent event) {
			if (event.getActionMasked() == MotionEvent.ACTION_UP) {
				count++;
				setBackgroundColor(count % 2 == 0 ? 0xFFE0E0E0 : 0xFFC8C8C8);
				setStateDescription(String.valueOf(count));
			}
			return true;
		}
	}
}

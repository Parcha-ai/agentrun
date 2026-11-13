package ai.agentrun.phoned.device;

/** A rectangle in screen pixels, edges as Android keeps them: left and top inside, right and bottom outside. */
public final class Rect {
	public final int left;
	public final int top;
	public final int right;
	public final int bottom;

	public Rect(int left, int top, int right, int bottom) {
		this.left = left;
		this.top = top;
		this.right = right;
		this.bottom = bottom;
	}

	public int width() {
		return right - left;
	}

	public int height() {
		return bottom - top;
	}

	/** No pixels: a node of zero size, which observe drops. */
	public boolean empty() {
		return right <= left || bottom <= top;
	}

	public boolean contains(int x, int y) {
		return x >= left && x < right && y >= top && y < bottom;
	}

	public int centerX() {
		return left + width() / 2;
	}

	public int centerY() {
		return top + height() / 2;
	}

	/** This rectangle cut to the part inside other, or an empty one when they do not meet. */
	public Rect intersect(Rect other) {
		int l = Math.max(left, other.left);
		int t = Math.max(top, other.top);
		int r = Math.min(right, other.right);
		int b = Math.min(bottom, other.bottom);
		return r <= l || b <= t ? new Rect(l, t, l, t) : new Rect(l, t, r, b);
	}

	/** The protocol's shape: [x, y, w, h]. */
	public long[] xywh() {
		return new long[] {left, top, width(), height()};
	}

	@Override
	public boolean equals(Object o) {
		if (!(o instanceof Rect)) return false;
		Rect r = (Rect) o;
		return r.left == left && r.top == top && r.right == right && r.bottom == bottom;
	}

	@Override
	public int hashCode() {
		return ((left * 31 + top) * 31 + right) * 31 + bottom;
	}

	@Override
	public String toString() {
		return "[" + left + "," + top + "][" + right + "," + bottom + "]";
	}
}

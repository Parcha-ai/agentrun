package desktop

// FrameGapForTest is the least time between two frames of a watch on a screen with DAMAGE: the frame rate's cap.
var FrameGapForTest = frameGap

// SetChunkForTest makes screen.shot and screen.read give at most n bytes, and returns what puts it back.
func SetChunkForTest(n int) func() {
	was := chunk
	chunk = n
	return func() { chunk = was }
}

// SetDuringShotForTest runs f while each screen.shot holds the display, and returns what puts it back.
func SetDuringShotForTest(f func()) func() {
	was := duringShot
	duringShot = f
	return func() { duringShot = was }
}

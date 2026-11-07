package desktop

// SetChunkForTest makes screen.shot and screen.read give at most n bytes, and returns what puts it back.
func SetChunkForTest(n int) func() {
	was := chunk
	chunk = n
	return func() { chunk = was }
}

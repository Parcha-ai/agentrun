package daemon

import "testing"

// SetAfterHalfClose runs fn in the bridge right after it half-closes the connection, for the test's duration.
func SetAfterHalfClose(t *testing.T, fn func()) {
	afterHalfClose = fn
	t.Cleanup(func() { afterHalfClose = nil })
}

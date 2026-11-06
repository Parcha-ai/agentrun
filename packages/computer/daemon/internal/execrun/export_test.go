package execrun

import "testing"

// SetStartHooks runs admitted in Start once it is let in, and started once its program runs, for the test's duration.
func SetStartHooks(t *testing.T, admitted, started func(p Program)) {
	afterAdmit, afterStarted = admitted, started
	t.Cleanup(func() { afterAdmit, afterStarted = nil, nil })
}

// SetEndHooks runs began in EndAll once it refuses new starts, and termed once it has sent every guard SIGTERM, for the
// test's duration; after the test, starts are let in again.
func SetEndHooks(t *testing.T, began, termed func()) {
	endingBegan, guardsTermed = began, termed
	t.Cleanup(func() {
		endingBegan, guardsTermed = nil, nil
		admission.Lock()
		admission.closed = false
		admission.Unlock()
	})
}

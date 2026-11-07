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

// SetGuardHooks runs forked in Start right after a guard's fork, with the registry's lock held, and reaping in follow
// right before it reaps the guard, for the test's duration.
func SetGuardHooks(t *testing.T, forked, reaping func(guardPid int)) {
	afterGuardFork, beforeGuardWait = forked, reaping
	t.Cleanup(func() { afterGuardFork, beforeGuardWait = nil, nil })
}

// GuardPid is the pid of g's guard.
func GuardPid(g *Guarded) int { return g.guard.Process.Pid }

// SetGuardArgs has Start add what args returns for p to the guard's argv, after GuardCommand, for the test's duration.
func SetGuardArgs(t *testing.T, args func(p Program) []string) {
	guardArgs = args
	t.Cleanup(func() { guardArgs = nil })
}

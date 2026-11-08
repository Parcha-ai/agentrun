// Package lifetime is init's deadline: when the computer ends, and the most the provider let it move to at start.
// deadline.extend moves it; init's loop waits on Changed to re-arm its timer. Init's decision to end the computer (End,
// Stop) and every extension share one lock: once init has decided, no extension succeeds.
package lifetime

import (
	"sync"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// ISO is how a deadline is written back: JavaScript's toISOString, the form a provider passes.
const ISO = "2006-01-02T15:04:05.000Z07:00"

// Deadline is init's own deadline. The zero maximum means the provider gave none: the deadline cannot move.
type Deadline struct {
	mu      sync.Mutex
	at      time.Time
	most    time.Time
	changed chan struct{}
	// ending is why init is ending the computer, once it has decided to; "" before.
	ending string
}

// New is a deadline at at that deadline.extend may move up to most; a zero most keeps it where it is.
func New(at, most time.Time) *Deadline {
	return &Deadline{at: at, most: most, changed: make(chan struct{}, 1)}
}

// At is the deadline now.
func (d *Deadline) At() time.Time {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.at
}

// Changed fires after Extend moves the deadline.
func (d *Deadline) Changed() <-chan struct{} {
	return d.changed
}

// End decides, when the deadline has come by now, that the computer ends: every Extend after it is refused. It returns
// false, deciding nothing, when the deadline is still after now, as when an extension moved it as the old one came.
func (d *Deadline) End(now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if now.Before(d.at) {
		return false
	}
	if d.ending == "" {
		d.ending = "its deadline passed"
	}
	return true
}

// Stop decides that the computer ends now, for why, whatever the deadline: every Extend after it is refused.
func (d *Deadline) Stop(why string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.ending == "" {
		d.ending = why
	}
}

// Extend moves the deadline to to, which must be no earlier than it is and no later than the maximum. It returns the
// deadline after the call; a refusal says why in words and moves nothing. Once init has decided to end the computer
// (End, Stop), every extension is refused.
func (d *Deadline) Extend(to time.Time) (time.Time, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.ending != "" {
		return d.at, rpc.Errorf(rpc.KindUnsupported, "the computer is ending: %s, so its deadline no longer moves", d.ending)
	}
	if d.most.IsZero() {
		return d.at, rpc.Errorf(rpc.KindUnsupported, "this computer's deadline cannot move: its provider started init with no --max-deadline, so it ends at %s", d.at.UTC().Format(ISO))
	}
	if to.Before(d.at) {
		return d.at, rpc.Errorf(rpc.KindInvalid, "%s is earlier than the deadline %s: deadline.extend only moves it later", to.UTC().Format(ISO), d.at.UTC().Format(ISO))
	}
	if to.After(d.most) {
		return d.at, rpc.Errorf(rpc.KindLimit, "%s is past %s, the maximum deadline this computer's provider gave at start", to.UTC().Format(ISO), d.most.UTC().Format(ISO))
	}
	if !to.Equal(d.at) {
		d.at = to
		select {
		case d.changed <- struct{}{}:
		default:
		}
	}
	return d.at, nil
}

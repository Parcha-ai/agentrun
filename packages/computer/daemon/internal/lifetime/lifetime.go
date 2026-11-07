// Package lifetime is init's deadline: when the computer ends, and the most the provider let it move to at start.
// deadline.extend moves it; init's loop waits on Changed to re-arm its timer.
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

// Extend moves the deadline to to, which must be no earlier than it is and no later than the maximum. It returns the
// deadline after the call; a refusal says why in words and moves nothing.
func (d *Deadline) Extend(to time.Time) (time.Time, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
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

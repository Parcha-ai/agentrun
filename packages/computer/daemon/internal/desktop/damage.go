package desktop

import (
	"context"
	"errors"
	"image"
	"sync"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
)

// damages is where the display's pixels changed, for the watches: a connection of its own to the display with one
// DAMAGE object on the root, at the raw rectangles level, whose events it reads and hands to each watch subscribed. A
// watch reads the screen only once one says something changed, and only there.
type damages struct {
	conn *x11.Conn

	mu    sync.Mutex
	subs  map[*watching]struct{}
	ended bool
}

// damageFor subscribes w to the display's damage, starting it on the first watch or after it ended. An X server with
// no DAMAGE extension is refused, unsupported, in words: the watch has no other way to learn what changed. The start
// talks to the X server outside dmu, so Close never waits for it; a watch that asks while another starts it waits for
// that start, or its own cancel.
func (d *Display) damageFor(ctx context.Context, w *watching) error {
	d.dmu.Lock()
	defer d.dmu.Unlock()
	for {
		if m := d.damage; m != nil && !m.isEnded() {
			if w.damage == m || m.subscribe(w) {
				return nil
			}
			// It ended since: started again below.
		}
		if starting := d.damageStarting; starting != nil {
			d.dmu.Unlock()
			select {
			case <-starting:
				d.dmu.Lock()
				continue
			case <-ctx.Done():
				d.dmu.Lock()
				return rpc.Errorf(rpc.KindAborted, "screen.watch was cancelled while it waited for the display's damage to start")
			}
		}
		starting := make(chan struct{})
		d.damageStarting = starting
		d.dmu.Unlock()
		m, err := d.startDamage()
		d.dmu.Lock()
		d.damageStarting = nil
		close(starting)
		if err != nil {
			return err
		}
		d.mu.Lock()
		closed := d.closed
		d.mu.Unlock()
		if closed {
			// Close ran while the damage started: it is not kept.
			m.close()
			return d.closedError()
		}
		d.damage = m
	}
}

// subscribe adds w to the watches told of each change, unless the damage ended, and says whether it did.
func (m *damages) subscribe(w *watching) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ended {
		return false
	}
	m.subs[w] = struct{}{}
	w.damage = m
	// Nothing is known of what changed before this subscription: the next read is the whole screen.
	w.damaged(everything)
	return true
}

// everything is a rectangle past any screen: a read of it is the whole screen.
var everything = image.Rect(0, 0, 1<<16, 1<<16)

// startDamage is a connection of its own to the display, with one DAMAGE object on the root. Each failure is
// unsupported, in words; a server without DAMAGE says so.
func (d *Display) startDamage() (*damages, error) {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return nil, d.closedError()
	}
	if d.name == "" {
		return nil, rpc.Errorf(rpc.KindUnsupported, "this computer has no display: DISPLAY was not set when computerd started")
	}
	c, err := x11.Dial(d.name)
	if err != nil {
		return nil, rpc.Errorf(rpc.KindUnsupported, "this computer has no display it can use: %v", err)
	}
	if err := c.InitDamage(); err != nil {
		_ = c.Close()
		if errors.Is(err, x11.ErrNoDamage) {
			return nil, rpc.Errorf(rpc.KindUnsupported, "%v: screen.watch learns from it where the screen changed, and has no other way to see a change on the display %s", err, d.name)
		}
		return nil, rpc.Errorf(rpc.KindUnsupported, "screen.watch could not start the display's DAMAGE: %v", err)
	}
	c.EnableEvents()
	if _, err := c.CreateDamage(c.Screen().Root, x11.DamageReportRawRectangles); err != nil {
		_ = c.Close()
		return nil, rpc.Errorf(rpc.KindUnsupported, "screen.watch could not start the display's DAMAGE: %v", err)
	}
	m := &damages{conn: c, subs: map[*watching]struct{}{}}
	go m.run()
	return m, nil
}

// run hands each damaged rectangle to every watch subscribed, until the connection ends; then every watch is told the
// whole screen changed, and the next one to ask starts the damage again.
func (m *damages) run() {
	for {
		e, err := m.conn.NextEvent()
		if err != nil {
			break
		}
		area, ok := m.conn.DamageArea(e)
		if !ok || area.Empty() {
			continue
		}
		m.mu.Lock()
		for w := range m.subs {
			w.damaged(area)
		}
		m.mu.Unlock()
	}
	m.mu.Lock()
	m.ended = true
	for w := range m.subs {
		w.damaged(everything)
	}
	m.subs = nil
	m.mu.Unlock()
}

func (m *damages) isEnded() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ended
}

// unsubscribe ends w's subscription. The last watch to leave ends the damage, so the X server stops sending what it
// draws while nobody watches; the next watch starts it again.
func (m *damages) unsubscribe(w *watching) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.subs, w)
	if len(m.subs) == 0 && !m.ended {
		m.ended = true
		_ = m.conn.Close()
	}
}

func (m *damages) close() {
	_ = m.conn.Close()
}

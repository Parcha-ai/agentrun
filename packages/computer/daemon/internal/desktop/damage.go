package desktop

import (
	"image"
	"sync"
	"time"

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

// retryDamage is how long a display whose DAMAGE could not be had is polled before it is asked again.
const retryDamage = 10 * time.Second

// damageFor subscribes w to the display's damage, starting it on the first watch or after it ended, and says whether
// w has it. A display with no DAMAGE extension (or none that answers) is polled: false, and it is asked again only
// after retryDamage. The start talks to the X server outside dmu, so Close never waits for it; a watch that asks
// while another starts it is polled until it has started.
func (d *Display) damageFor(w *watching) bool {
	d.dmu.Lock()
	defer d.dmu.Unlock()
	if m := d.damage; m != nil && w.damage == m && !m.isEnded() {
		return true
	}
	if d.damage == nil || d.damage.isEnded() {
		if d.damageStarting || time.Now().Before(d.noDamageUntil) {
			return false
		}
		d.damageStarting = true
		d.dmu.Unlock()
		m, err := d.startDamage()
		d.dmu.Lock()
		d.damageStarting = false
		if err != nil {
			d.noDamageUntil = time.Now().Add(retryDamage)
			return false
		}
		d.mu.Lock()
		closed := d.closed
		d.mu.Unlock()
		if closed {
			// Close ran while the damage started: it is not kept.
			m.close()
			return false
		}
		d.damage = m
	}
	m := d.damage
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

func (d *Display) startDamage() (*damages, error) {
	d.mu.Lock()
	closed := d.closed
	d.mu.Unlock()
	if closed {
		return nil, d.closedError()
	}
	c, err := x11.Dial(d.name)
	if err != nil {
		return nil, err
	}
	if err := c.InitDamage(); err != nil {
		_ = c.Close()
		return nil, err
	}
	c.EnableEvents()
	if _, err := c.CreateDamage(c.Screen().Root, x11.DamageReportRawRectangles); err != nil {
		_ = c.Close()
		return nil, err
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

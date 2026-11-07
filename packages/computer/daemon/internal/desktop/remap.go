package desktop

import (
	"context"
	"slices"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
)

// settle is how long a remapped keycode is left alone after its last key event before it is moved to another
// keysym. A client reads the keyboard map when it handles the MappingNotify a change sends, not when the key event was
// made: moving a keycode before every client has read the key events still bound to it would make them read the new
// keysym. xdotool sleeps between its binding and its unbinding for the same reason.
const settle = 250 * time.Millisecond

// remap is the keysym remap xdotool does: a character no keycode gives (é on a US map, any CJK character) is bound to
// a keycode with no keysym at all, with ChangeKeyboardMapping, and typed with that keycode. Unlike xdotool, the binding
// is not undone after the key, which would race every client still reading the map; it stays, so the character has a
// key from then on. When no keycode is free, the binding used longest ago that the action does not need is moved, once
// it has settled. A text needing more keycodes at once than the map can give is refused in words before any key.
type remap struct {
	// bound is every keycode this connection took.
	bound []binding
}

type binding struct {
	code byte
	sym  uint32
	used time.Time
}

// used notes that sym's keycode was just pressed, when the remap bound it.
func (r *remap) use(sym uint32) {
	for i := range r.bound {
		if r.bound[i].sym == sym {
			r.bound[i].used = time.Now()
		}
	}
}

// room refuses, in words, a set of keysyms that needs more keycodes than are free or movable.
func (r *remap) room(km *x11.Keymap, syms map[uint32]bool) error {
	need := 0
	for sym := range syms {
		if _, _, ok := km.Find(sym); !ok {
			need++
		}
	}
	movable := 0
	for _, b := range r.bound {
		if !syms[b.sym] {
			movable++
		}
	}
	if have := len(km.Unused()) + movable; need > have {
		return stopf(rpc.KindLimit, "it has %d characters the keyboard map has no key for, and the keysym remap has %d keycodes for them: type it in parts", need, have)
	}
	return nil
}

// bind gives sym a keycode, never one bound to a keysym in busy, and writes it into km too.
func (r *remap) bind(ctx context.Context, c *x11.Conn, km *x11.Keymap, sym uint32, busy map[uint32]bool) (byte, error) {
	var code byte
	if free := km.Unused(); len(free) > 0 {
		code = free[0]
	} else {
		oldest := -1
		for i, b := range r.bound {
			if !busy[b.sym] && (oldest < 0 || b.used.Before(r.bound[oldest].used)) {
				oldest = i
			}
		}
		if oldest < 0 {
			return 0, stopf(rpc.KindLimit, "it needs keys for more characters the keyboard map lacks than it has keycodes for: type it in parts")
		}
		if wait := settle - time.Since(r.bound[oldest].used); wait > 0 {
			if err := c.Flush(); err != nil {
				return 0, err
			}
			timer := time.NewTimer(wait)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return 0, ctx.Err()
			}
		}
		code = r.bound[oldest].code
		r.bound = slices.Delete(r.bound, oldest, oldest+1)
	}
	if err := c.ChangeKeyboardMapping(code, 2, []uint32{sym, sym}); err != nil {
		return 0, err
	}
	at := (int(code) - int(km.Min)) * km.PerCode
	clear(km.Syms[at : at+km.PerCode])
	km.Syms[at] = sym
	if km.PerCode > 1 {
		km.Syms[at+1] = sym
	}
	r.bound = append(r.bound, binding{code, sym, time.Now()})
	return code, nil
}

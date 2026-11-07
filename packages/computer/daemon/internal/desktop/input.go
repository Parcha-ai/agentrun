package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/keys"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
)

type actionsParams struct {
	Actions json.RawMessage `json:"actions"`
}

// ActionsResult is input.actions' answer.
type ActionsResult struct {
	Done   int      `json:"done"`
	Failed *Failure `json:"failed,omitempty"`
}

var buttonOf = map[string]byte{"left": 1, "middle": 2, "right": 3}

const (
	shiftSym    = 0xffe1
	capsLockSym = 0xffe5
	// Wheel buttons: up, down, left, right.
	wheelUp, wheelDown, wheelLeft, wheelRight = 4, 5, 6, 7
)

// stop is a failure of one action: its kind and why.
type stop struct {
	kind rpc.Kind
	why  string
}

func (s *stop) Error() string { return s.why }

func stopf(kind rpc.Kind, format string, args ...any) error {
	return &stop{kind, fmt.Sprintf(format, args...)}
}

// actions checks the whole batch, then runs it in order until the first failure. A failure releases every button and
// key the batch pressed and did not release; success keeps them, so a down with no up stays down into the next batch.
// A cancel stops at the next key, click or point of the action running, or before the next action, releases the same
// way, and answers aborted.
//
// The server answers a request with no reply only when it refuses one, so the batch waits for it (a Sync) after each
// action that sent one the server may refuse: a button or key, or a keyboard map change. A refused action stops the
// batch before the next one runs, and done and failed say what ran. Motions, which it checks itself, are confirmed with
// the next such action, or once at the end.
func (d *Display) actions(ctx context.Context, raw json.RawMessage) (any, error) {
	var params actionsParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	if _, err := d.connection(); err != nil {
		return nil, err
	}
	actions, failed := check(params.Actions, Groups)
	if failed != nil {
		return ActionsResult{Failed: failed}, nil
	}
	if len(actions) == 0 {
		return ActionsResult{}, nil
	}
	if err := d.hold(ctx, "input.actions"); err != nil {
		return nil, err
	}
	defer d.letGo()
	c, err := d.connection()
	if err != nil {
		return nil, err
	}
	if d.remapped != c {
		// A new connection: the keycodes the last one bound are no longer known to be ours.
		d.remap, d.remapped = remap{}, c
	}
	b := &batch{ctx: ctx, d: d, c: c}
	if b.width, b.height, err = c.RootSize(); err != nil {
		return nil, d.gone(c, err)
	}
	// from is the first action the server has not confirmed, and start the sequence number before its requests; ends
	// is the last sequence number of each action's requests.
	from, start := 0, c.Seq()
	ends := make([]uint16, 0, len(actions))
	confirm := func(last int) *ActionsResult {
		errs, err := c.Sync()
		if err != nil {
			return &ActionsResult{Done: last, Failed: &Failure{last, rpc.KindUnsupported, fmt.Sprintf("the round trip after action %d (%s): %v", last, actions[last].Type, d.gone(c, err))}}
		}
		if len(errs) > 0 {
			// An X error names its request; the action that sent it is the first whose requests reach it.
			at := last
			for i := from; i <= last; i++ {
				if errs[0].Seq-start <= ends[i]-start {
					at = i
					break
				}
			}
			b.release()
			return &ActionsResult{Done: at, Failed: &Failure{at, rpc.KindInvalid, fmt.Sprintf("action %d (%s): %v", at, actions[at].Type, errs[0])}}
		}
		from, start = last+1, c.Seq()
		return nil
	}
	for i, a := range actions {
		if ctx.Err() != nil {
			b.release()
			return nil, rpc.Errorf(rpc.KindAborted, "input.actions was cancelled before action %d; what the batch held was released", i)
		}
		b.refusable = false
		if err := b.run(ctx, a); err != nil {
			b.release()
			var s *stop
			switch {
			case errors.As(err, &s):
				return ActionsResult{Done: i, Failed: &Failure{i, s.kind, fmt.Sprintf("action %d (%s): %s", i, a.Type, s.why)}}, nil
			case ctx.Err() != nil:
				return nil, rpc.Errorf(rpc.KindAborted, "input.actions was cancelled in action %d; what the batch held was released", i)
			default:
				return ActionsResult{Done: i, Failed: &Failure{i, rpc.KindUnsupported, fmt.Sprintf("action %d (%s): %v", i, a.Type, d.gone(c, err))}}, nil
			}
		}
		ends = append(ends, c.Seq())
		if b.refusable {
			if failed := confirm(i); failed != nil {
				return *failed, nil
			}
		}
	}
	if ctx.Err() != nil {
		b.release()
		return nil, rpc.Errorf(rpc.KindAborted, "input.actions was cancelled after its last action; what the batch held was released")
	}
	if c.Seq() != start {
		if failed := confirm(len(actions) - 1); failed != nil {
			return *failed, nil
		}
	}
	return ActionsResult{Done: len(actions)}, nil
}

// batch is one input.actions run: the display's size at its start, its keyboard map once a key needs it, what it
// pressed and has not released, and whether the action running sent a request the server may refuse.
type batch struct {
	ctx           context.Context
	d             *Display
	c             *x11.Conn
	width, height int
	keymap        *x11.Keymap
	buttons       []byte
	keys          []byte
	refusable     bool
}

// live is the batch's cancel, checked at each key, click and point of a long action.
func (b *batch) live() error { return b.ctx.Err() }

func (b *batch) input(kind, detail byte, x, y int) error {
	if kind != x11.MotionNotify {
		b.refusable = true
	}
	switch kind {
	case x11.ButtonPress:
		b.buttons = append(b.buttons, detail)
	case x11.ButtonRelease:
		b.buttons = slices.DeleteFunc(b.buttons, func(held byte) bool { return held == detail })
	case x11.KeyPress:
		b.keys = append(b.keys, detail)
	case x11.KeyRelease:
		if i := slices.Index(b.keys, detail); i >= 0 {
			b.keys = slices.Delete(b.keys, i, i+1)
		}
	}
	return b.c.FakeInput(kind, detail, x, y)
}

// release lets go of every key and button the batch holds, keys last pressed first, and waits for the server.
func (b *batch) release() {
	for i := len(b.keys) - 1; i >= 0; i-- {
		_ = b.c.FakeInput(x11.KeyRelease, b.keys[i], 0, 0)
	}
	for i := len(b.buttons) - 1; i >= 0; i-- {
		_ = b.c.FakeInput(x11.ButtonRelease, b.buttons[i], 0, 0)
	}
	b.keys, b.buttons = nil, nil
	_, _ = b.c.Sync()
}

func (b *batch) inside(p point) error {
	if p[0] < 0 || p[1] < 0 || p[0] >= b.width || p[1] >= b.height {
		return stopf(rpc.KindInvalid, "(%d, %d) is outside the %dx%d display", p[0], p[1], b.width, b.height)
	}
	return nil
}

func (b *batch) move(p point) error {
	if err := b.inside(p); err != nil {
		return err
	}
	return b.input(x11.MotionNotify, 0, p[0], p[1])
}

// wait sleeps, with what is buffered written first; a cancel ends it early.
func (b *batch) wait(ctx context.Context, ms int) error {
	if err := b.c.Flush(); err != nil {
		return err
	}
	timer := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *batch) run(ctx context.Context, a action) error {
	switch a.Type {
	case "move":
		return b.move(*a.At)
	case "down":
		return b.input(x11.ButtonPress, buttonOf[a.Button], 0, 0)
	case "up":
		return b.input(x11.ButtonRelease, buttonOf[a.Button], 0, 0)
	case "click":
		if a.At != nil {
			if err := b.inside(*a.At); err != nil {
				return err
			}
		}
		return b.holding(a.Keys, func() error {
			if a.At != nil {
				if err := b.move(*a.At); err != nil {
					return err
				}
			}
			for range a.Count {
				if err := b.live(); err != nil {
					return err
				}
				if err := b.press(buttonOf[a.Button]); err != nil {
					return err
				}
			}
			return nil
		})
	case "drag":
		for _, p := range a.Path {
			if err := b.inside(p); err != nil {
				return err
			}
		}
		return b.holding(a.Keys, func() error {
			if err := b.move(a.Path[0]); err != nil {
				return err
			}
			if err := b.input(x11.ButtonPress, buttonOf[a.Button], 0, 0); err != nil {
				return err
			}
			for _, p := range a.Path[1:] {
				if err := b.live(); err != nil {
					return err
				}
				if err := b.move(p); err != nil {
					return err
				}
			}
			return b.input(x11.ButtonRelease, buttonOf[a.Button], 0, 0)
		})
	case "scroll":
		if a.At != nil {
			if err := b.inside(*a.At); err != nil {
				return err
			}
		}
		return b.holding(a.Keys, func() error {
			if a.At != nil {
				if err := b.move(*a.At); err != nil {
					return err
				}
			}
			for _, turn := range []struct {
				clicks          int
				negative, ahead byte
			}{{a.DY, wheelUp, wheelDown}, {a.DX, wheelLeft, wheelRight}} {
				button, n := turn.ahead, turn.clicks
				if n < 0 {
					button, n = turn.negative, -n
				}
				for range n {
					if err := b.live(); err != nil {
						return err
					}
					if err := b.press(button); err != nil {
						return err
					}
				}
			}
			return nil
		})
	case "key":
		for range a.Repeat {
			if err := b.live(); err != nil {
				return err
			}
			if err := b.holding(a.Keys, func() error { return nil }); err != nil {
				return err
			}
		}
		return nil
	case "hold":
		return b.holding(a.Keys, func() error { return b.wait(ctx, a.MS) })
	case "type":
		return b.typeText(a.Text)
	case "wait":
		return b.wait(ctx, a.MS)
	}
	return stopf(rpc.KindUnsupported, "%s is not an action this display runs", a.Type)
}

// press clicks a button once: down, then up.
func (b *batch) press(button byte) error {
	if err := b.input(x11.ButtonPress, button, 0, 0); err != nil {
		return err
	}
	return b.input(x11.ButtonRelease, button, 0, 0)
}

// holding presses keys in order (with shift before a key that needs it), runs then, and releases them in reverse.
func (b *batch) holding(names []string, then func() error) error {
	busy := map[uint32]bool{}
	for _, name := range names {
		sym, _ := keys.Keysym(name)
		busy[sym] = true
	}
	var codes []byte
	for _, name := range names {
		sym, _ := keys.Keysym(name)
		code, shift, err := b.codeFor(sym, busy)
		if err != nil {
			return err
		}
		if shift {
			shiftCode, _, err := b.codeFor(shiftSym, busy)
			if err != nil {
				return err
			}
			if !slices.Contains(codes, shiftCode) {
				codes = append(codes, shiftCode)
			}
		}
		if !slices.Contains(codes, code) {
			codes = append(codes, code)
		}
	}
	for _, code := range codes {
		if err := b.input(x11.KeyPress, code, 0, 0); err != nil {
			return err
		}
	}
	if err := then(); err != nil {
		return err
	}
	for i := len(codes) - 1; i >= 0; i-- {
		if err := b.input(x11.KeyRelease, codes[i], 0, 0); err != nil {
			return err
		}
	}
	return nil
}

// typeText types each character: its key, with shift when the key needs it. A character no key gives gets one
// through the keysym remap. Caps Lock, when on, is turned off for the typing and back on after it, as xdotool does, so
// the text typed is exactly the text asked.
func (b *batch) typeText(text string) error {
	busy := map[uint32]bool{}
	for _, r := range text {
		sym, _ := keys.ForRune(r)
		busy[sym] = true
	}
	// Refused before any key when the remap cannot give every character a key at once.
	if err := b.loadKeymap(); err != nil {
		return err
	}
	if err := b.d.remap.room(b.keymap, busy); err != nil {
		return err
	}
	restore, err := b.capsOff()
	if err != nil {
		return err
	}
	err = b.typeRunes(text, busy)
	if again := restore(); err == nil {
		err = again
	}
	return err
}

// capsOff turns Caps Lock off, when it is on, by tapping the key that gives Caps_Lock, and gives what taps it again.
// Caps Lock that the tap does not turn off (a Lock that another key holds, or Shift Lock) is refused in words, with the
// tap undone.
func (b *batch) capsOff() (restore func() error, err error) {
	none := func() error { return nil }
	state, err := b.c.State()
	if err != nil || state&x11.LockMask == 0 {
		return none, err
	}
	code, shift, ok := b.keymap.Find(capsLockSym)
	if !ok || shift {
		return nil, stopf(rpc.KindUnsupported, "Caps Lock is on, and no key gives Caps_Lock to turn it off for the typing: turn it off first")
	}
	tap := func() error {
		if err := b.input(x11.KeyPress, code, 0, 0); err != nil {
			return err
		}
		return b.input(x11.KeyRelease, code, 0, 0)
	}
	if err := tap(); err != nil {
		return nil, err
	}
	if state, err = b.c.State(); err != nil {
		return nil, err
	}
	if state&x11.LockMask != 0 {
		if err := tap(); err != nil {
			return nil, err
		}
		return nil, stopf(rpc.KindUnsupported, "Caps Lock is on, and tapping Caps_Lock does not turn it off for the typing: turn it off first")
	}
	return tap, nil
}

// typeRunes types text, each character's keys pressed and released, until a cancel.
func (b *batch) typeRunes(text string, busy map[uint32]bool) error {
	for _, r := range text {
		if err := b.live(); err != nil {
			return err
		}
		sym, _ := keys.ForRune(r)
		code, shift, err := b.codeFor(sym, busy)
		if err != nil {
			return err
		}
		var shiftCode byte
		if shift {
			if shiftCode, _, err = b.codeFor(shiftSym, nil); err != nil {
				return err
			}
			if err := b.input(x11.KeyPress, shiftCode, 0, 0); err != nil {
				return err
			}
		}
		if err := b.input(x11.KeyPress, code, 0, 0); err != nil {
			return err
		}
		if err := b.input(x11.KeyRelease, code, 0, 0); err != nil {
			return err
		}
		if shift {
			if err := b.input(x11.KeyRelease, shiftCode, 0, 0); err != nil {
				return err
			}
		}
	}
	return nil
}

// codeFor is the keycode that gives sym and whether it needs shift, read from the keyboard map; one with no keycode is
// given an unused one by the keysym remap. busy are the keysyms of the whole action, whose remapped keycodes it keeps.
func (b *batch) codeFor(sym uint32, busy map[uint32]bool) (byte, bool, error) {
	if err := b.loadKeymap(); err != nil {
		return 0, false, err
	}
	if code, shift, ok := b.keymap.Find(sym); ok {
		b.d.remap.use(sym)
		return code, shift, nil
	}
	b.refusable = true
	code, err := b.d.remap.bind(b.ctx, b.c, b.keymap, sym, busy)
	return code, false, err
}

// loadKeymap reads the keyboard map once a batch: another client may have changed it since the last.
func (b *batch) loadKeymap() error {
	if b.keymap != nil {
		return nil
	}
	km, err := b.c.KeyboardMapping()
	if err != nil {
		return err
	}
	b.keymap = km
	return nil
}

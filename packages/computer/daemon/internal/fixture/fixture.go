// Package fixture is the desktop fixture of src/conformance/fixture.ts: a 200x200 override-redirect window at (0, 0)
// in four known colors that takes the keyboard focus and logs every input event it gets as one JSON line, so a case
// checks what input.actions did with no model. It is test-only: computerd-fixture (cmd/fixture) runs it.
package fixture

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/keys"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
)

const (
	// Size is the window's width and height; it is at (0, 0).
	Size = 200
	half = Size / 2
)

// Colors are the window's quadrants in RGB: top left, top right, bottom left, bottom right (FIXTURE_COLORS).
var Colors = [4][3]byte{{255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {255, 255, 0}}

var buttons = map[byte]string{1: "left", 2: "middle", 3: "right"}

// wheel is each wheel button's turn: up, down, left, right.
var wheel = map[byte][2]int{4: {0, -1}, 5: {0, 1}, 6: {-1, 0}, 7: {1, 0}}

// Run shows the window on display and logs its events to logPath until ctx ends or the display goes.
func Run(ctx context.Context, display, logPath string) error {
	out, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	c, err := x11.Dial(display)
	if err != nil {
		return err
	}
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	f := &fixture{c: c, out: out}
	if err := f.start(); err != nil {
		return err
	}
	for {
		e, err := c.NextEvent()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if err := f.handle(e); err != nil {
			return err
		}
	}
}

type fixture struct {
	c      *x11.Conn
	out    *os.File
	window uint32
	gc     uint32
	keymap *x11.Keymap
	ready  bool
}

func (f *fixture) start() error {
	c := f.c
	c.EnableEvents()
	km, err := c.KeyboardMapping()
	if err != nil {
		return err
	}
	f.keymap = km
	f.window, f.gc = c.NewID(), c.NewID()
	mask := uint32(x11.KeyPressMask | x11.KeyReleaseMask | x11.ButtonPressMask | x11.ButtonReleaseMask | x11.ExposureMask | x11.StructureNotifyMask | x11.FocusChangeMask)
	if err := c.CreateWindow(f.window, 0, 0, Size, Size, x11.CWBackPixel|x11.CWOverrideRedirect|x11.CWEventMask, c.Pixel(0, 0, 0), 1, mask); err != nil {
		return err
	}
	if err := c.CreateGC(f.gc, f.window); err != nil {
		return err
	}
	if err := c.MapWindow(f.window); err != nil {
		return err
	}
	return f.sync("showing the window")
}

func (f *fixture) sync(what string) error {
	errs, err := f.c.Sync()
	if err != nil {
		return err
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s: %v", what, errs[0])
	}
	return nil
}

func (f *fixture) paint() error {
	for i, color := range Colors {
		x, y := (i%2)*half, (i/2)*half
		if err := f.c.FillRectangle(f.window, f.gc, f.c.Pixel(color[0], color[1], color[2]), x, y, half, half); err != nil {
			return err
		}
	}
	return nil
}

func (f *fixture) log(event map[string]any) error {
	line, _ := json.Marshal(event)
	_, err := f.out.Write(append(line, '\n'))
	return err
}

func (f *fixture) handle(e []byte) error {
	at := func() []int { return []int{int(int16(le16(e[20:]))), int(int16(le16(e[22:])))} }
	switch e[0] {
	case x11.Expose:
		if le16(e[16:]) != 0 { // more Expose events of this one follow
			return nil
		}
		if err := f.paint(); err != nil {
			return err
		}
		if !f.ready {
			if err := f.c.SetInputFocus(f.window); err != nil {
				return err
			}
		}
		if err := f.sync("painting the window"); err != nil {
			return err
		}
		if !f.ready {
			f.ready = true
			return f.log(map[string]any{"event": "ready"})
		}
	case x11.ButtonPress, x11.ButtonRelease:
		if turn, ok := wheel[e[1]]; ok {
			if e[0] == x11.ButtonPress {
				return f.log(map[string]any{"event": "wheel", "at": at(), "dx": turn[0], "dy": turn[1]})
			}
			return nil
		}
		name, ok := buttons[e[1]]
		if !ok {
			return nil
		}
		kind := "down"
		if e[0] == x11.ButtonRelease {
			kind = "up"
		}
		return f.log(map[string]any{"event": kind, "button": name, "at": at()})
	case x11.KeyPress, x11.KeyRelease:
		state := le16(e[28:])
		shift, lock, ctrl, alt := state&1 != 0, state&2 != 0, state&4 != 0, state&8 != 0
		sym := f.keymap.Sym(e[1], shift)
		if lock && !shift {
			sym = f.keymap.Sym(e[1], true)
			if plain := f.keymap.Sym(e[1], false); plain == sym || !isLetter(plain) {
				sym = plain
			}
		}
		down := e[0] == x11.KeyPress
		if err := f.log(map[string]any{"event": "key", "key": keys.Name(sym), "down": down}); err != nil {
			return err
		}
		if r, ok := keys.Rune(sym); ok && down && !ctrl && !alt {
			return f.log(map[string]any{"event": "text", "text": string(r)})
		}
	case x11.MappingNotify:
		km, err := f.c.KeyboardMapping()
		if err != nil {
			return err
		}
		f.keymap = km
	}
	return nil
}

func isLetter(sym uint32) bool {
	r, ok := keys.Rune(sym)
	return ok && (r >= 'a' && r <= 'z' || r >= 0xe0 && r <= 0xfe && r != 0xf7)
}

func le16(b []byte) uint16 { return uint16(b[0]) | uint16(b[1])<<8 }

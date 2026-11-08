package desktop_test

// The keysym remap against the fake X server, whose keyboard map another program can change while the daemon holds
// keycodes it bound.

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/desktop"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/x11fake"
)

const (
	eacute, ntilde, udiaeresis = 0xe9, 0xf1, 0xfc
	// theirs is the keysym another program binds a keycode the remap took to.
	theirs = 0x1008ff13
)

// onFullKeyboard serves the fake with every keycode bound except free, and returns it, the display and input.actions.
// hold, when set, runs as the fake's Hold.
func onFullKeyboard(t *testing.T, hold func(f *x11fake.Server, r x11fake.Request), free ...int) (*x11fake.Server, *desktop.Display, func(actions ...map[string]any) desktop.ActionsResult) {
	t.Helper()
	t.Setenv("XAUTHORITY", "")
	f, name := x11fake.Listen(t, func(s *x11fake.Server) {
		s.Keymap = make([]uint32, (x11fake.MaxKey-x11fake.MinKey+1)*2)
		set := func(code int, syms ...uint32) { copy(s.Keymap[(code-x11fake.MinKey)*2:], syms) }
		for code := x11fake.MinKey; code <= x11fake.MaxKey; code++ {
			if !slices.Contains(free, code) {
				set(code, 0x1008ff00+uint32(code), 0)
			}
		}
		set(38, 'a', 'A')
		set(50, 0xffe1, 0)
		if hold != nil {
			s.Hold = func(r x11fake.Request) { hold(s, r) }
		}
	})
	d := desktop.New(name)
	t.Cleanup(d.Close)
	handle := d.Handlers()["input.actions"]
	return f, d, func(actions ...map[string]any) desktop.ActionsResult {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"actions": actions})
		got, err := handle(context.Background(), raw)
		if err != nil {
			t.Fatal(err)
		}
		return got.(desktop.ActionsResult)
	}
}

// changesTo is every ChangeKeyboardMapping the fake read from the n-th request on that covers code.
func changesTo(f *x11fake.Server, n int, code byte) []x11fake.Request {
	var out []x11fake.Request
	for _, r := range f.Got()[n:] {
		if r.Opcode == 100 && code >= r.Body[0] && int(code) < int(r.Body[0])+int(r.Data) {
			out = append(out, r)
		}
	}
	return out
}

func pressed(f *x11fake.Server, n int) []byte {
	var out []byte
	for _, r := range f.Got()[n:] {
		if r.Opcode == x11fake.XTest && r.Data == 2 && r.Body[0] == x11.KeyPress {
			out = append(out, r.Body[1])
		}
	}
	return out
}

// A keycode the remap bound that another program has since rebound is that program's: with no other keycode to give,
// the type is refused in words before any key, and neither it nor anything after it (the settle, Close) moves or
// restores that keycode.
func TestOnTheFakeTheRemapNeverTakesBackAKeycodeAnotherProgramRebound(t *testing.T) {
	f, d, act := onFullKeyboard(t, nil, 200)
	if r := act(map[string]any{"type": "type", "text": "é"}); r.Done != 1 || r.Failed != nil {
		t.Fatalf("typing é with keycode 200 free: done %d, failed %+v", r.Done, r.Failed)
	}
	if got := f.Keys(200); !slices.Equal(got, []uint32{eacute, eacute}) {
		t.Fatalf("keycode 200 after typing é: %#x", got)
	}
	f.Rebind(200, theirs, 0)
	n := len(f.Got())
	r := act(map[string]any{"type": "type", "text": "ñ"})
	if r.Done != 0 || r.Failed == nil || r.Failed.Kind != "limit" || !strings.Contains(r.Failed.Message, "in parts") {
		t.Errorf("typing ñ with no keycode the remap may take: done %d, failed %+v; want limit, in words", r.Done, r.Failed)
	}
	if keys := pressed(f, n); len(keys) != 0 {
		t.Errorf("the refused type pressed keycodes %v", keys)
	}
	// Past the settle, and past Close: nothing puts the remap's binding back over the other program's.
	time.Sleep(300 * time.Millisecond)
	d.Close()
	if got := f.Keys(200); !slices.Equal(got, []uint32{theirs, 0}) {
		t.Errorf("keycode 200, which another program rebound, now gives %#x; want %#x", got, []uint32{theirs, 0})
	}
	if changes := changesTo(f, n, 200); len(changes) != 0 {
		t.Errorf("the daemon changed keycode 200 after another program rebound it: %+v", changes)
	}
}

// A keycode another program rebinds while a batch runs, after the batch read the keyboard map, is still never
// moved: the remap moves one that is still its own instead.
func TestOnTheFakeTheRemapChecksAKeycodeIsStillItsOwnBeforeMovingIt(t *testing.T) {
	var mu sync.Mutex
	armed, read, done := false, false, false
	hold := func(f *x11fake.Server, r x11fake.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case !armed || done:
		case r.Opcode == 101:
			read = true
		case read:
			// The batch has read the map: another program rebinds keycode 200 before the type moves a keycode.
			done = true
			f.Rebind(200, theirs, 0)
		}
	}
	f, _, act := onFullKeyboard(t, hold, 200, 201)
	if r := act(map[string]any{"type": "type", "text": "éñ"}); r.Done != 1 || r.Failed != nil {
		t.Fatalf("typing éñ with keycodes 200 and 201 free: done %d, failed %+v", r.Done, r.Failed)
	}
	if e, n := f.Keys(200), f.Keys(201); !slices.Equal(e, []uint32{eacute, eacute}) || !slices.Equal(n, []uint32{ntilde, ntilde}) {
		t.Fatalf("keycodes 200 and 201 after typing éñ: %#x, %#x", e, n)
	}
	mu.Lock()
	armed = true
	mu.Unlock()
	n := len(f.Got())
	if r := act(map[string]any{"type": "type", "text": "ü"}); r.Done != 1 || r.Failed != nil {
		t.Fatalf("typing ü with keycode 201 still the remap's: done %d, failed %+v", r.Done, r.Failed)
	}
	mu.Lock()
	rebound := done
	mu.Unlock()
	if !rebound {
		t.Fatal("the fake never rebound keycode 200 during the batch")
	}
	if got := f.Keys(200); !slices.Equal(got, []uint32{theirs, 0}) {
		t.Errorf("keycode 200, which another program rebound mid-batch, now gives %#x; want %#x", got, []uint32{theirs, 0})
	}
	if got := f.Keys(201); !slices.Equal(got, []uint32{udiaeresis, udiaeresis}) {
		t.Errorf("keycode 201 after typing ü: %#x; want ü moved onto it", got)
	}
	if keys := pressed(f, n); !slices.Equal(keys, []byte{201}) {
		t.Errorf("typing ü pressed keycodes %v; want [201]", keys)
	}
}

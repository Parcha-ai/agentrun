package desktop_test

// input.actions against the fake X server, for what Xvfb does not do on demand: refuse a request, or stop reading.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/desktop"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/x11fake"
)

// fakeInput is one XTEST FakeInput the fake read: its type and detail.
type fakeInput struct{ kind, detail byte }

func inputs(f *x11fake.Server) []fakeInput {
	var out []fakeInput
	for _, r := range f.Got() {
		if r.Opcode == x11fake.XTest && r.Data == 2 {
			out = append(out, fakeInput{r.Body[0], r.Body[1]})
		}
	}
	return out
}

// onFake serves the fake as a display and returns input.actions on it, called directly with the context it is given.
func onFake(t *testing.T, configure func(*x11fake.Server)) (*x11fake.Server, func(ctx context.Context, actions ...map[string]any) (any, error)) {
	t.Helper()
	t.Setenv("XAUTHORITY", "")
	f, name := x11fake.Listen(t, func(f *x11fake.Server) {
		// The keyboard: a and A on keycode 38, Shift_L on 50, Caps_Lock on 66; nothing else.
		f.Keymap = make([]uint32, (x11fake.MaxKey-x11fake.MinKey+1)*2)
		set := func(code int, syms ...uint32) { copy(f.Keymap[(code-x11fake.MinKey)*2:], syms) }
		set(38, 'a', 'A')
		set(50, 0xffe1)
		set(66, 0xffe5)
		if configure != nil {
			configure(f)
		}
	})
	d := desktop.New(name)
	t.Cleanup(d.Close)
	handle := d.Handlers()["input.actions"]
	return f, func(ctx context.Context, actions ...map[string]any) (any, error) {
		raw, _ := json.Marshal(map[string]any{"actions": actions})
		return handle(ctx, raw)
	}
}

// An X error stops the batch at the action that caused it: the next action never reaches the server, and done and
// failed say which ran.
func TestOnTheFakeAServerErrorStopsTheBatchBeforeItsNextAction(t *testing.T) {
	f, act := onFake(t, func(f *x11fake.Server) {
		// A pointer with no horizontal wheel: buttons 6 and 7 are BadValue, as XTEST answers for a button past the device's.
		f.ErrorFor = func(r x11fake.Request) (byte, bool) {
			return 2, r.Opcode == x11fake.XTest && r.Data == 2 && (r.Body[0] == x11.ButtonPress || r.Body[0] == x11.ButtonRelease) && r.Body[1] >= 6
		}
	})
	got, err := act(context.Background(),
		map[string]any{"type": "scroll", "at": []int{10, 10}, "dx": 1, "unit": "clicks"},
		map[string]any{"type": "click", "at": []int{20, 20}},
		map[string]any{"type": "key", "keys": []string{"a"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	r := got.(desktop.ActionsResult)
	if r.Done != 0 || r.Failed == nil || r.Failed.Index != 0 || !strings.Contains(r.Failed.Message, "BadValue") {
		t.Fatalf("done %d, failed %+v; want done 0 and action 0 failed with BadValue", r.Done, r.Failed)
	}
	for _, in := range inputs(f) {
		if (in.kind == x11.ButtonPress && in.detail == 1) || in.kind == x11.KeyPress {
			t.Fatalf("an action after the failed one reached the server: %+v in %+v", in, inputs(f))
		}
	}
}

// cancelledMidAction runs one long action, stops the fake reading once 200 FakeInputs are in, cancels, and lets the
// fake read again: the action stops within the next key or click, releases what the batch held, and answers aborted.
func cancelledMidAction(t *testing.T, action map[string]any, total int) {
	t.Helper()
	reached, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	n := 0
	f, act := onFake(t, func(f *x11fake.Server) {
		f.Hold = func(r x11fake.Request) {
			if r.Opcode != x11fake.XTest || r.Data != 2 {
				return
			}
			if n++; n == 200 {
				once.Do(func() { close(reached) })
				<-resume
			}
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type answer struct {
		got any
		err error
	}
	done := make(chan answer, 1)
	go func() {
		got, err := act(ctx, action)
		done <- answer{got, err}
	}()
	select {
	case <-reached:
	case a := <-done:
		t.Fatalf("the action ended before the fake held it: %+v", a)
	case <-time.After(patience):
		t.Fatal("the fake never got 200 FakeInputs")
	}
	cancel()
	close(resume)
	var a answer
	select {
	case a = <-done:
	case <-time.After(patience):
		t.Fatal("the cancelled action did not end")
	}
	var e *rpc.Error
	if !errors.As(a.err, &e) || e.Kind != rpc.KindAborted {
		t.Fatalf("the cancelled action answered %+v, %v; want aborted", a.got, a.err)
	}
	sent := inputs(f)
	if len(sent) >= total {
		t.Fatalf("all %d FakeInputs were sent after the cancel", len(sent))
	}
	held := map[fakeInput]int{}
	for _, in := range sent {
		switch in.kind {
		case x11.KeyPress, x11.ButtonPress:
			held[fakeInput{in.kind + 1, in.detail}]++
		case x11.KeyRelease, x11.ButtonRelease:
			held[in]--
		}
	}
	for in, n := range held {
		if n > 0 {
			t.Errorf("%+v was left pressed", in)
		}
	}
}

func TestOnTheFakeACancelStopsALongTypeMidAction(t *testing.T) {
	cancelledMidAction(t, map[string]any{"type": "type", "text": strings.Repeat("aA", desktop.MaxTypeRunes/2)}, 3*desktop.MaxTypeRunes)
}

func TestOnTheFakeACancelStopsALongScrollMidAction(t *testing.T) {
	cancelledMidAction(t, map[string]any{"type": "scroll", "dx": 10000, "dy": -10000, "unit": "clicks"}, 40000)
}

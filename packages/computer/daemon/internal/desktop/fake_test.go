package desktop_test

// input.actions against the fake X server, for what Xvfb does not do on demand: refuse a request, or stop reading.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image/png"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
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

// shotOn is screen.shot on the display, called directly with the context it is given.
func shotOn(d *desktop.Display) func(ctx context.Context) (any, error) {
	handle := d.Handlers()["screen.shot"]
	return func(ctx context.Context) (any, error) { return handle(ctx, json.RawMessage(`{}`)) }
}

// gray is the fake's image: every pixel mid-gray.
func gray(x, y, w, h int) []byte {
	out := make([]byte, w*h*4)
	for i := range out {
		out[i] = 0x80
	}
	return out
}

// onFakeDisplay serves the fake as a display and returns it, with input.actions and screen.shot on it.
func onFakeDisplay(t *testing.T, configure func(*x11fake.Server)) (*desktop.Display, func(ctx context.Context, actions ...map[string]any) (any, error), func(ctx context.Context) (any, error)) {
	t.Helper()
	t.Setenv("XAUTHORITY", "")
	_, name := x11fake.Listen(t, func(f *x11fake.Server) {
		f.Image = gray
		if configure != nil {
			configure(f)
		}
	})
	d := desktop.New(name)
	t.Cleanup(d.Close)
	handle := d.Handlers()["input.actions"]
	return d, func(ctx context.Context, actions ...map[string]any) (any, error) {
		raw, _ := json.Marshal(map[string]any{"actions": actions})
		return handle(ctx, raw)
	}, shotOn(d)
}

// within runs f, and fails the test when it has not returned within bound.
func within(t *testing.T, bound time.Duration, what string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f()
	}()
	select {
	case <-done:
	case <-time.After(bound):
		t.Fatalf("%s did not return within %v", what, bound)
	}
}

// A screen.shot that panics while it holds the display (the rpc layer recovers a handler's panic) lets the display go:
// the next input.actions runs.
func TestOnTheFakeAShotThatPanicsLetsTheDisplayGo(t *testing.T) {
	_, act, shot := onFakeDisplay(t, nil)
	defer desktop.SetDuringShotForTest(func() { panic("a shot failed") })()
	func() {
		defer func() {
			if recover() == nil {
				t.Error("the shot did not panic")
			}
		}()
		_, _ = shot(context.Background())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var got any
	var err error
	within(t, 10*time.Second, "input.actions after a shot panicked", func() {
		got, err = act(ctx, map[string]any{"type": "move", "at": []int{5, 5}})
	})
	if r, ok := got.(desktop.ActionsResult); err != nil || !ok || r.Done != 1 || r.Failed != nil {
		t.Fatalf("input.actions after a shot panicked: %+v, %v; want done 1", got, err)
	}
}

// While one input.actions holds the display (the server is slow to answer its round trip), another input.actions or a
// screen.shot waits for it no longer than its own context, and answers aborted.
func TestOnTheFakeWaitingForTheDisplayEndsWithTheContext(t *testing.T) {
	reached, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	_, act, shot := onFakeDisplay(t, func(f *x11fake.Server) {
		f.Hold = func(r x11fake.Request) {
			if r.Opcode == 43 { // the batch's round trip, GetInputFocus
				once.Do(func() { close(reached) })
				<-resume
			}
		}
	})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(resume) }) })
	held := make(chan error, 1)
	go func() {
		_, err := act(context.Background(), map[string]any{"type": "move", "at": []int{1, 1}})
		held <- err
	}()
	select {
	case <-reached:
	case err := <-held:
		t.Fatalf("the first batch ended before the fake held it: %v", err)
	case <-time.After(patience):
		t.Fatal("the fake never got the first batch's round trip")
	}
	aborted := func(what string, err error) {
		t.Helper()
		var e *rpc.Error
		if !errors.As(err, &e) || e.Kind != rpc.KindAborted {
			t.Errorf("%s while the display is held: %v; want aborted", what, err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var err error
	within(t, 10*time.Second, "input.actions with a 2 s context", func() {
		_, err = act(ctx, map[string]any{"type": "move", "at": []int{5, 5}})
	})
	aborted("input.actions", err)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()
	within(t, 10*time.Second, "screen.shot with a 2 s context", func() { _, err = shot(ctx2) })
	aborted("screen.shot", err)
	release.Do(func() { close(resume) })
	if err := <-held; err != nil {
		t.Fatalf("the first batch: %v", err)
	}
}

// fifo makes a FIFO in a fresh directory. Its cleanup opens the FIFO's other end and closes it, so a reader still
// blocked opening it is let go when the test ends.
func fifo(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "Xauthority")
	if err := syscall.Mkfifo(path, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if fd, err := syscall.Open(path, syscall.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
			_ = syscall.Close(fd)
		}
	})
	return path
}

// A FIFO at $XAUTHORITY hangs neither hello's look at the display nor Close: the display is refused, in words, at once.
func TestOnTheFakeAFIFOAsTheXauthorityFileHangsNothing(t *testing.T) {
	_, name := x11fake.Listen(t, nil)
	t.Setenv("XAUTHORITY", fifo(t))
	d := desktop.New(name)
	var groups []string
	within(t, 10*time.Second, "Groups", func() { groups = d.Groups() })
	if len(groups) != 0 {
		t.Errorf("groups %v with a FIFO as the Xauthority file", groups)
	}
	var err error
	within(t, 10*time.Second, "screen.shot", func() { _, err = shotOn(d)(context.Background()) })
	if err == nil || !strings.Contains(err.Error(), "Xauthority") {
		t.Errorf("screen.shot with a FIFO as the Xauthority file: %v; want unsupported, naming the Xauthority file", err)
	}
	within(t, 10*time.Second, "Close", d.Close)
}

// Close does not wait for a dial in flight (here, a server slow to answer the connection setup), and the connection
// that dial makes afterwards is closed, not kept.
func TestOnTheFakeCloseDoesNotWaitForADial(t *testing.T) {
	reached, resume := make(chan struct{}), make(chan struct{})
	var once, release sync.Once
	_, name := x11fake.Listen(t, func(f *x11fake.Server) {
		f.SetupHold = func() {
			once.Do(func() { close(reached) })
			<-resume
		}
	})
	t.Cleanup(func() { release.Do(func() { close(resume) }) })
	t.Setenv("XAUTHORITY", "")
	d := desktop.New(name)
	looked := make(chan []string, 1)
	go func() { looked <- d.Groups() }()
	select {
	case <-reached:
	case <-time.After(patience):
		t.Fatal("the fake never got the connection setup")
	}
	within(t, 3*time.Second, "Close during a dial", d.Close)
	release.Do(func() { close(resume) })
	select {
	case groups := <-looked:
		if len(groups) != 0 {
			t.Errorf("a dial that finished after Close declared %v", groups)
		}
	case <-time.After(patience):
		t.Fatal("the dial never ended")
	}
	if _, err := shotOn(d)(context.Background()); err == nil {
		t.Error("screen.shot after Close succeeded")
	}
}

// A null where a batch takes a number, a point, a name or a list is refused as invalid, as checkActions refuses it, and
// nothing in the batch runs: not even the click before it.
func TestOnTheFakeANullInABatchRunsNothing(t *testing.T) {
	f, act := onFake(t, nil)
	click := map[string]any{"type": "click", "at": []int{10, 10}}
	for _, bad := range []map[string]any{
		{"type": "move", "at": []any{nil, 20}},
		{"type": "wait", "ms": nil},
		{"type": "key", "keys": []string{"a"}, "repeat": nil},
		{"type": "down", "button": nil},
	} {
		got, err := act(context.Background(), click, bad)
		if err != nil {
			t.Fatal(err)
		}
		r := got.(desktop.ActionsResult)
		if r.Done != 0 || r.Failed == nil || r.Failed.Index != 1 || r.Failed.Kind != rpc.KindInvalid || r.Failed.Message == "" {
			t.Errorf("a click, then %v: done %d, failed %+v; want done 0 and action 1 invalid, in words", bad, r.Done, r.Failed)
		}
	}
	if in := inputs(f); len(in) != 0 {
		t.Fatalf("a refused batch reached the server: %+v", in)
	}
}

// A long scroll on a pointer without the wheel's buttons is refused at every click: an honest server's errors, as many
// as the requests. The batch stops at the scroll with the server's BadValue, in words; the display is not taken for gone.
func TestOnTheFakeALongRefusedScrollStopsAtItsAction(t *testing.T) {
	_, act := onFake(t, func(f *x11fake.Server) {
		f.ErrorFor = func(r x11fake.Request) (byte, bool) {
			return 2, r.Opcode == x11fake.XTest && r.Data == 2 && (r.Body[0] == x11.ButtonPress || r.Body[0] == x11.ButtonRelease) && r.Body[1] >= 6
		}
	})
	got, err := act(context.Background(),
		map[string]any{"type": "move", "at": []int{5, 5}},
		map[string]any{"type": "scroll", "at": []int{10, 10}, "dx": 500, "unit": "clicks"},
	)
	if err != nil {
		t.Fatal(err)
	}
	r := got.(desktop.ActionsResult)
	if r.Done != 1 || r.Failed == nil || r.Failed.Index != 1 || r.Failed.Kind != rpc.KindInvalid || !strings.Contains(r.Failed.Message, "BadValue") {
		t.Fatalf("done %d, failed %+v; want done 1 and action 1 invalid with BadValue", r.Done, r.Failed)
	}
}

// A shot this connection holds is read to its end though the X server exits after screen.shot gave its first part:
// computerd already has every byte. A new screen.shot needs the display, and says it is gone.
func TestOnTheFakeASavedShotIsReadAfterTheDisplayExits(t *testing.T) {
	defer desktop.SetChunkForTest(100)()
	t.Setenv("XAUTHORITY", "")
	f, name := x11fake.Listen(t, func(f *x11fake.Server) { f.Image = gray })
	d := desktop.New(name)
	t.Cleanup(d.Close)
	c := serve(t, d)
	var s shot
	c.ok("screen.shot", map[string]any{}, &s)
	if s.EOF || len(s.Data) != 100 || s.Size <= 100 {
		t.Fatalf("a %d-byte shot gave %d bytes, eof %v; want more than one part", s.Size, len(s.Data), s.EOF)
	}
	f.Exit()
	deadline := time.Now().Add(patience)
	for d.Groups() != nil {
		if time.Now().After(deadline) {
			t.Fatalf("the display still answers %v after it exited", patience)
		}
		time.Sleep(10 * time.Millisecond)
	}
	got := append([]byte{}, s.Data...)
	for eof := false; !eof; {
		var part struct {
			Data []byte `json:"data"`
			EOF  bool   `json:"eof"`
		}
		c.ok("screen.read", map[string]any{"id": s.ID, "offset": len(got)}, &part)
		if len(part.Data) == 0 && !part.EOF {
			t.Fatalf("screen.read at %d gave nothing and no eof", len(got))
		}
		got, eof = append(got, part.Data...), part.EOF
	}
	if len(got) != s.Size {
		t.Fatalf("read %d bytes of a %d-byte shot", len(got), s.Size)
	}
	if _, err := png.Decode(bytes.NewReader(got)); err != nil {
		t.Fatalf("the shot read after the display exited: %v", err)
	}
	unsupported(t, c.call("screen.shot", map[string]any{}), name)
}

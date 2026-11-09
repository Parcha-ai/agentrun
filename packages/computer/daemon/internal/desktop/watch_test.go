package desktop_test

// screen.watch: the screen as JPEG frames, one after each ack (the caller asks again with after set to the last seq it
// has), sent only when the screen changed, over the same connection as every other call.

import (
	"bytes"
	"encoding/json"
	"image/jpeg"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/desktop"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/x11fake"
)

// watchResult is screen.watch's answer, as a caller reads it.
type watchResult struct {
	Seq         int     `json:"seq"`
	Changed     bool    `json:"changed"`
	ID          string  `json:"id"`
	Size        int     `json:"size"`
	Data        []byte  `json:"data"`
	EOF         bool    `json:"eof"`
	Format      string  `json:"format"`
	FrameWidth  int     `json:"frameWidth"`
	FrameHeight int     `json:"frameHeight"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	Cursor      *[2]int `json:"cursor"`
}

// shaded is a fake whose every pixel is the shade it holds now: a test changes the screen by storing another.
func shaded(t *testing.T) (*client, *atomic.Int32) {
	t.Helper()
	t.Setenv("XAUTHORITY", "")
	shade := &atomic.Int32{}
	shade.Store(0x80)
	_, name := x11fake.Listen(t, func(f *x11fake.Server) {
		f.Image = func(x, y, w, h int) []byte {
			out := make([]byte, w*h*4)
			v := byte(shade.Load())
			for i := range out {
				out[i] = v
			}
			return out
		}
		f.Pointer = [2]int{12, 34}
	})
	d := desktop.New(name)
	t.Cleanup(d.Close)
	return serve(t, d), shade
}

// frameOf is the whole JPEG of a changed frame, read on with screen.read when the first chunk was not all of it.
func frameOf(t *testing.T, c *client, r watchResult) []byte {
	t.Helper()
	data := append([]byte{}, r.Data...)
	for eof := r.EOF; !eof; {
		var more desktop.ReadResult
		c.ok("screen.read", map[string]any{"id": r.ID, "offset": len(data)}, &more)
		data = append(data, more.Data...)
		eof = more.EOF
	}
	if len(data) != r.Size {
		t.Fatalf("the frame is %d bytes; its size says %d", len(data), r.Size)
	}
	return data
}

func TestOnTheFakeTheFirstWatchIsAJPEGOfTheScreenWithItsSizeAndCursor(t *testing.T) {
	c, _ := shaded(t)
	var r watchResult
	c.ok("screen.watch", map[string]any{"after": 0}, &r)
	if r.Seq != 1 || !r.Changed || r.Format != "jpeg" {
		t.Fatalf("seq %d, changed %v, format %q; want 1, true, jpeg", r.Seq, r.Changed, r.Format)
	}
	if r.Width != x11fake.Width || r.Height != x11fake.Height || r.FrameWidth != x11fake.Width || r.FrameHeight != x11fake.Height {
		t.Fatalf("width %dx%d, frame %dx%d; want the %dx%d screen, unscaled", r.Width, r.Height, r.FrameWidth, r.FrameHeight, x11fake.Width, x11fake.Height)
	}
	if r.Cursor == nil || *r.Cursor != [2]int{12, 34} {
		t.Fatalf("cursor %v; want the pointer at 12,34", r.Cursor)
	}
	img, err := jpeg.Decode(bytes.NewReader(frameOf(t, c, r)))
	if err != nil {
		t.Fatalf("the frame does not decode as a JPEG: %v", err)
	}
	if b := img.Bounds(); b.Dx() != r.FrameWidth || b.Dy() != r.FrameHeight {
		t.Fatalf("the JPEG is %dx%d; the frame says %dx%d", b.Dx(), b.Dy(), r.FrameWidth, r.FrameHeight)
	}
}

func TestOnTheFakeAnUnchangedScreenAnswersNoFrameOnceItsWaitIsOver(t *testing.T) {
	c, _ := shaded(t)
	var first, idle watchResult
	c.ok("screen.watch", map[string]any{"after": 0}, &first)
	start := time.Now()
	c.ok("screen.watch", map[string]any{"after": first.Seq, "waitMs": 400}, &idle)
	took := time.Since(start)
	if idle.Changed || idle.Seq != first.Seq || len(idle.Data) != 0 || idle.ID != "" {
		t.Fatalf("an unchanged screen: %+v; want changed false, seq %d and no frame", idle, first.Seq)
	}
	if idle.Width != x11fake.Width || idle.Height != x11fake.Height {
		t.Fatalf("an unchanged screen's size %dx%d; want the screen's", idle.Width, idle.Height)
	}
	if took < 400*time.Millisecond {
		t.Fatalf("answered after %v: before its waitMs of 400 ms", took)
	}
}

func TestOnTheFakeAChangedScreenIsTheNextFrameAndAnOldAckGetsTheCurrentOneAtOnce(t *testing.T) {
	c, shade := shaded(t)
	var first, next, again watchResult
	c.ok("screen.watch", map[string]any{"after": 0}, &first)
	id := c.send("screen.watch", map[string]any{"after": first.Seq, "waitMs": 10_000})
	time.Sleep(300 * time.Millisecond) // the watch reads the unchanged screen at least once first
	shade.Store(0x20)
	r := c.wait(id)
	if r.Error != nil {
		t.Fatalf("screen.watch: %s", r.Error.Message)
	}
	if err := json.Unmarshal(r.Result, &next); err != nil {
		t.Fatal(err)
	}
	if !next.Changed || next.Seq != first.Seq+1 {
		t.Fatalf("after a change: seq %d, changed %v; want %d, true", next.Seq, next.Changed, first.Seq+1)
	}
	img, err := jpeg.Decode(bytes.NewReader(frameOf(t, c, next)))
	if err != nil {
		t.Fatal(err)
	}
	if r, _, _, _ := img.At(10, 10).RGBA(); r>>8 > 0x40 {
		t.Fatalf("the new frame's pixel is %#x; want the new, darker shade", r>>8)
	}
	// A caller that never got seq 2 (its ack is 1) is given the current frame at once, not after a wait.
	start := time.Now()
	c.ok("screen.watch", map[string]any{"after": first.Seq, "waitMs": 10_000}, &again)
	if !again.Changed || again.Seq != next.Seq || time.Since(start) > 5*time.Second {
		t.Fatalf("an old ack: %+v after %v; want frame %d at once", again, time.Since(start), next.Seq)
	}
}

func TestOnTheFakeMaxWidthScalesTheFrameAndTheSizeStaysTheScreens(t *testing.T) {
	c, _ := shaded(t)
	var r watchResult
	c.ok("screen.watch", map[string]any{"after": 0, "maxWidth": 160, "quality": 30}, &r)
	if r.FrameWidth != 160 || r.FrameHeight != 120 || r.Width != x11fake.Width || r.Height != x11fake.Height {
		t.Fatalf("frame %dx%d of a %dx%d screen; want 160x120 of the 320x240 screen", r.FrameWidth, r.FrameHeight, r.Width, r.Height)
	}
	img, err := jpeg.Decode(bytes.NewReader(frameOf(t, c, r)))
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 160 || b.Dy() != 120 {
		t.Fatalf("the JPEG is %dx%d; want 160x120", b.Dx(), b.Dy())
	}
}

func TestOnTheFakeAFrameOverAChunkIsReadOnWithScreenRead(t *testing.T) {
	defer desktop.SetChunkForTest(100)()
	c, _ := shaded(t)
	var r watchResult
	c.ok("screen.watch", map[string]any{"after": 0}, &r)
	if r.EOF || r.ID == "" || len(r.Data) != 100 || r.Size <= 100 {
		t.Fatalf("a frame over a chunk: eof %v, id %q, %d bytes of %d; want the first 100 and an id", r.EOF, r.ID, len(r.Data), r.Size)
	}
	if _, err := jpeg.Decode(bytes.NewReader(frameOf(t, c, r))); err != nil {
		t.Fatal(err)
	}
}

// awaitEither is the next reply, which must be one of ids: a waiting watch does not answer in order.
func (c *client) awaitEither(ids ...int) reply {
	c.t.Helper()
	select {
	case r, ok := <-c.replies:
		if !ok {
			c.t.Fatal("the server closed")
		}
		for _, id := range ids {
			if r.ID == id {
				return r
			}
		}
		c.t.Fatalf("reply %d, want one of %v", r.ID, ids)
	case <-time.After(patience):
		c.t.Fatalf("no reply to %v", ids)
	}
	return reply{}
}

func TestOnTheFakeInputRunsWhileAWatchWaitsOnTheSameConnection(t *testing.T) {
	c, shade := shaded(t)
	var first watchResult
	c.ok("screen.watch", map[string]any{"after": 0}, &first)
	watch := c.send("screen.watch", map[string]any{"after": first.Seq, "waitMs": 10_000})
	time.Sleep(300 * time.Millisecond)
	act := c.send("input.actions", map[string]any{"actions": []any{map[string]any{"type": "move", "at": []int{5, 5}}}})
	if r := c.awaitEither(watch, act); r.ID != act || r.Error != nil {
		t.Fatalf("input.actions during a watch: %+v; want it answered first, ok", r)
	}
	shade.Store(0x30)
	if r := c.awaitEither(watch); r.Error != nil {
		t.Fatalf("the watch: %s", r.Error.Message)
	}
}

func TestOnTheFakeACancelledWatchAnswersAbortedAtOnce(t *testing.T) {
	c, _ := shaded(t)
	var first watchResult
	c.ok("screen.watch", map[string]any{"after": 0}, &first)
	id := c.send("screen.watch", map[string]any{"after": first.Seq, "waitMs": 10_000})
	time.Sleep(300 * time.Millisecond)
	start := time.Now()
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "$/cancelRequest", "params": map[string]any{"id": id}})
	if _, err := c.w.Write(append(line, '\n')); err != nil {
		t.Fatal(err)
	}
	r := c.wait(id)
	if r.Error == nil || r.Error.Data.Kind != "aborted" || time.Since(start) > 5*time.Second {
		t.Fatalf("a cancelled watch: %+v after %v; want aborted at once", r, time.Since(start))
	}
}

func TestOnTheFakeAWatchRefusesParamsItCannotTakeInWords(t *testing.T) {
	c, _ := shaded(t)
	var first watchResult
	c.ok("screen.watch", map[string]any{"after": 0}, &first)
	for _, params := range []map[string]any{
		{},
		{"after": -1},
		{"after": first.Seq + 1},
		{"after": 0, "waitMs": 10_001},
		{"after": 0, "waitMs": -1},
		{"after": 0, "quality": 0},
		{"after": 0, "quality": 101},
		{"after": 0, "maxWidth": 0},
		{"after": 0, "region": []int{0, 0, 1, 1}},
	} {
		r := c.call("screen.watch", params)
		if r.Error == nil || r.Error.Data.Kind != "invalid" || r.Error.Message == "" {
			t.Errorf("screen.watch %v: %+v; want invalid, in words", params, r)
		}
	}
}

func TestWithNoDisplayAWatchIsUnsupportedInWords(t *testing.T) {
	c := serve(t, desktop.New(""))
	unsupported(t, c.call("screen.watch", map[string]any{"after": 0}), "DISPLAY")
}

// On Xvfb: a pointer moved by input.actions is a new frame, with the cursor where it went, though no pixel changed.
func TestOnXvfbAPointerMoveIsANewFrameWithTheCursorWhereItWent(t *testing.T) {
	k := onXvfb(t)
	var first, moved watchResult
	k.c.ok("screen.watch", map[string]any{"after": 0}, &first)
	id := k.c.send("screen.watch", map[string]any{"after": first.Seq, "waitMs": 10_000})
	time.Sleep(300 * time.Millisecond)
	act := k.c.send("input.actions", map[string]any{"actions": []any{map[string]any{"type": "move", "at": []int{201, 99}}}})
	if r := k.c.awaitEither(id, act); r.ID != act || r.Error != nil {
		t.Fatalf("the move: %+v", r)
	}
	r := k.c.awaitEither(id)
	if r.Error != nil {
		t.Fatal(r.Error.Message)
	}
	if err := json.Unmarshal(r.Result, &moved); err != nil {
		t.Fatal(err)
	}
	if !moved.Changed || moved.Seq != first.Seq+1 || moved.Cursor == nil || *moved.Cursor != [2]int{201, 99} {
		t.Fatalf("after a pointer move: %+v; want frame %d with the cursor at 201,99", moved, first.Seq+1)
	}
}

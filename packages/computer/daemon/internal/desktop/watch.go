package desktop

// screen.watch: the live view's frames. The caller asks with after, the seq of the last frame it has whole (its ack);
// the answer is the next frame once the screen changed, or changed false once waitMs passed with none. An after older
// than the newest frame gets the newest at once. An after one past the newest is an ask ahead (screen.ahead): a caller
// keeps it waiting while the ask before it answers, so frames come at the computer's pace and not one each round trip,
// and it waits as an ask for the newest does. A frame is a JPEG of the screen, scaled down to maxWidth at most; width
// and height stay the screen's, the space input.actions takes. The pointer's place is part of what changes, so a move
// with no pixel changed is a frame too.
//
// The X server says where the screen changed (DAMAGE, damage.go): a watch reads only the rectangles drawn since its last
// read, into its own copy of the screen, and makes a frame when a pixel or the pointer's place changed, at most one
// each frameGap. While nothing changes it reads no pixels at all, and looks only where the pointer is, each frameGap.
// A display with no DAMAGE is read whole each pollEvery instead. Each read holds the display only while it reads, so
// input.actions and screen.shot go on meanwhile. One connection keeps one watch (its seq, its copy of the screen and
// the newest frame); a second watch on it waits its turn. The rest of each of the last two frames over a chunk is held
// for screen.read, as screen.shot's PNG is, so an ask ahead never drops the frame before it.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"sync"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

const (
	defaultWaitMs   = 2_000
	maxWaitMs       = 10_000
	defaultMaxWidth = 1_280
	defaultQuality  = 60
	// maxFrameWidth bounds maxWidth: the largest screen a GetImage reads.
	maxFrameWidth = 16_384
)

// frameGap is the least time between two frames of a watch on a display with DAMAGE: at most 15 frames a second.
// Typing and a moving pointer look smooth at it, and each frame is one JPEG of the whole screen, the watch's cost on
// the computer (about 20 ms of one core at 1280x800).
var frameGap = time.Second / 15

// pollEvery is how often a watch reads the whole screen on a display with no DAMAGE: at most 5 frames a second.
var pollEvery = 200 * time.Millisecond

type watchParams struct {
	After    *int `json:"after"`
	WaitMs   *int `json:"waitMs"`
	MaxWidth *int `json:"maxWidth"`
	Quality  *int `json:"quality"`
}

// WatchResult is screen.watch's answer. A frame (changed true) carries its JPEG as screen.shot carries its PNG: the
// first chunk in data, the rest through screen.read by id. EOF is on every frame, false included: a caller that reads a
// missing field as true must read on.
type WatchResult struct {
	Seq         int     `json:"seq"`
	Changed     bool    `json:"changed"`
	ID          string  `json:"id,omitempty"`
	Size        int     `json:"size,omitempty"`
	Data        []byte  `json:"data,omitempty"`
	EOF         *bool   `json:"eof,omitempty"`
	Format      string  `json:"format,omitempty"`
	FrameWidth  int     `json:"frameWidth,omitempty"`
	FrameHeight int     `json:"frameHeight,omitempty"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	Cursor      *[2]int `json:"cursor,omitempty"`
}

// watching is one connection's watch: one call at a time (turn), its seq, its copy of the screen as last read, when it
// last read pixels or made a frame (read), the newest frame, and the rests of the last two frames for screen.read
// (held: its own, so a screen.shot never evicts them; next is the one the next frame's rest goes in). damage is the
// display's damage it is subscribed to, nil while the display is polled; dirty is where the screen changed since its
// last read, and wake is told of each change. dmu guards dirty.
type watching struct {
	turn   chan struct{}
	read   time.Time
	held   [2]held
	next   int
	seq    int
	screen *image.RGBA
	jpeg   []byte
	frameW int
	frameH int
	width  int
	height int
	cursor *[2]int

	damage *damages
	dmu    sync.Mutex
	dirty  image.Rectangle
	wake   chan struct{}
}

func newWatching() *watching {
	return &watching{turn: make(chan struct{}, 1), wake: make(chan struct{}, 1)}
}

// Close ends the watch's subscription to the display's damage, when the connection ends.
func (w *watching) Close() error {
	if w.damage != nil {
		w.damage.unsubscribe(w)
	}
	return nil
}

// damaged is the screen changed in r: added to what the next read reads, and the waiting watch woken.
func (w *watching) damaged(r image.Rectangle) {
	w.dmu.Lock()
	w.dirty = w.dirty.Union(r)
	w.dmu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// take is where the screen changed since the last take, and forgets it: a change after it is the next take's.
func (w *watching) take() image.Rectangle {
	w.dmu.Lock()
	defer w.dmu.Unlock()
	r := w.dirty
	w.dirty = image.Rectangle{}
	return r
}

type watchKey struct{}

func watchingOf(ctx context.Context) *watching {
	return rpc.Local(ctx, watchKey{}, func() io.Closer { return newWatching() }).(*watching)
}

func (d *Display) watch(ctx context.Context, raw json.RawMessage) (any, error) {
	var params watchParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	waitMs, maxWidth, quality := defaultWaitMs, defaultMaxWidth, defaultQuality
	switch {
	case params.After == nil || *params.After < 0:
		return nil, rpc.Errorf(rpc.KindInvalid, "screen.watch takes after: the seq of the last frame the caller has, 0 for none")
	case params.WaitMs != nil && (*params.WaitMs < 0 || *params.WaitMs > maxWaitMs):
		return nil, rpc.Errorf(rpc.KindInvalid, "waitMs %d is outside 0 to %d", *params.WaitMs, maxWaitMs)
	case params.MaxWidth != nil && (*params.MaxWidth < 1 || *params.MaxWidth > maxFrameWidth):
		return nil, rpc.Errorf(rpc.KindInvalid, "maxWidth %d is outside 1 to %d", *params.MaxWidth, maxFrameWidth)
	case params.Quality != nil && (*params.Quality < 1 || *params.Quality > 100):
		return nil, rpc.Errorf(rpc.KindInvalid, "quality %d is outside 1 to 100", *params.Quality)
	}
	if params.WaitMs != nil {
		waitMs = *params.WaitMs
	}
	if params.MaxWidth != nil {
		maxWidth = *params.MaxWidth
	}
	if params.Quality != nil {
		quality = *params.Quality
	}
	w := watchingOf(ctx)
	select {
	case w.turn <- struct{}{}:
	case <-ctx.Done():
		return nil, rpc.Errorf(rpc.KindAborted, "screen.watch was cancelled while another watch on this connection waited")
	}
	defer func() { <-w.turn }()
	after := *params.After
	switch {
	case after > w.seq+1:
		return nil, rpc.Errorf(rpc.KindInvalid, "after %d is past the newest frame, %d, by more than the one an ask ahead may be", after, w.seq)
	case after == w.seq+1:
		// An ask ahead whose ask before it answered no change: it waits for the next frame.
		after = w.seq
	}
	if after < w.seq {
		return d.frame(w), nil
	}
	deadline := time.Now().Add(time.Duration(waitMs) * time.Millisecond)
	for {
		damage := d.damageFor(w)
		gap := pollEvery
		if damage {
			gap = frameGap
		}
		// Pixels are read, and frames made, at most once each gap, across calls too: an animated screen acked at once
		// is no faster than the cap.
		if wait := time.Until(w.read.Add(gap)); wait > 0 {
			if err := pause(ctx, wait, nil); err != nil {
				return nil, err
			}
		}
		region := everything
		if damage {
			region = w.take()
		}
		cursor, changed, at, err := d.look(ctx, w, region)
		if err != nil {
			if damage {
				// Not read (a cancel while input held the display, or the display went): the next look reads it.
				w.damaged(region)
			}
			return nil, err
		}
		if changed || w.cursor == nil || *w.cursor != cursor {
			frame, fw, fh, err := encodeFrame(w.screen, maxWidth, quality)
			if err != nil {
				return nil, err
			}
			if !changed {
				// A frame of the pointer alone read no pixels, but it is a whole JPEG all the same: it keeps the cap too.
				w.read = at
			}
			w.seq++
			w.jpeg, w.frameW, w.frameH, w.cursor = frame, fw, fh, &cursor
			return d.frame(w), nil
		}
		left := time.Until(deadline)
		if left <= 0 {
			return WatchResult{Seq: w.seq, Width: w.width, Height: w.height}, nil
		}
		// Until the screen changes, the pointer is looked at each gap; a change wakes the watch at once.
		var wake chan struct{}
		if damage {
			wake = w.wake
		}
		if err := pause(ctx, min(left, gap), wake); err != nil {
			return nil, err
		}
		if time.Until(deadline) <= 0 {
			return WatchResult{Seq: w.seq, Width: w.width, Height: w.height}, nil
		}
	}
}

// pause waits for d, or until wake says something (a nil wake never does); a cancelled call answers aborted.
func pause(ctx context.Context, d time.Duration, wake chan struct{}) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-wake:
	case <-ctx.Done():
		return rpc.Errorf(rpc.KindAborted, "screen.watch was cancelled while it waited for the screen to change")
	}
	return nil
}

// look holds the display while it reads the region of the screen into the watch's copy (the whole screen on the first
// read, or once its size changed) and where the pointer is; an empty region reads no pixels. changed says whether a
// pixel of the copy changed; at is when it had the display.
func (d *Display) look(ctx context.Context, w *watching, region image.Rectangle) (cursor [2]int, changed bool, at time.Time, err error) {
	if err := d.hold(ctx, "screen.watch"); err != nil {
		return cursor, false, at, err
	}
	defer d.letGo()
	at = time.Now()
	c, err := d.connection()
	if err != nil {
		return cursor, false, at, err
	}
	width, height, err := c.RootSize()
	if err != nil {
		return cursor, false, at, d.gone(c, err)
	}
	whole := image.Rect(0, 0, width, height)
	if w.screen == nil || w.screen.Bounds() != whole {
		w.screen, region = nil, whole
	}
	region = region.Intersect(whole)
	var img *image.RGBA
	if !region.Empty() {
		// The cap counts from the read's start, so the read and the frame's encode are inside the gap, not added to it.
		started := time.Now()
		if img, err = c.GetImage(region.Min.X, region.Min.Y, region.Dx(), region.Dy()); err != nil {
			return cursor, false, at, d.gone(c, err)
		}
		w.read = started
	}
	x, y, err := c.QueryPointer()
	if err != nil {
		return cursor, false, at, d.gone(c, err)
	}
	w.width, w.height = width, height
	switch {
	case w.screen == nil:
		w.screen, changed = img, true
	case img != nil:
		changed = patch(w.screen, img, region.Min)
	}
	return [2]int{x, y}, changed, at, nil
}

// patch copies img into screen at at, row by row, and says whether any pixel differed.
func patch(screen, img *image.RGBA, at image.Point) bool {
	changed := false
	b := img.Bounds()
	for y := 0; y < b.Dy(); y++ {
		src := img.Pix[y*img.Stride : y*img.Stride+b.Dx()*4]
		o := screen.PixOffset(at.X, at.Y+y)
		dst := screen.Pix[o : o+len(src)]
		if !bytes.Equal(src, dst) {
			copy(dst, src)
			changed = true
		}
	}
	return changed
}

// watchHeldOf is the rests of this connection's last two frames, for screen.read: the watch's own, apart from the
// shot's.
func watchHeldOf(ctx context.Context) []*held {
	w := watchingOf(ctx)
	return []*held{&w.held[0], &w.held[1]}
}

// frame is the newest frame as an answer: its first chunk, and the rest held for screen.read when it is over one, in
// the slot the frame before last had.
func (d *Display) frame(w *watching) WatchResult {
	data := w.jpeg
	first := data[:min(chunk, len(data))]
	eof := len(first) == len(data)
	id := ""
	if !eof {
		id = fmt.Sprintf("w%d", d.shots.Add(1))
		h := &w.held[w.next]
		w.next = 1 - w.next
		h.mu.Lock()
		h.id, h.data = id, data
		h.mu.Unlock()
	}
	return WatchResult{
		Seq: w.seq, Changed: true, ID: id, Size: len(data), Data: append([]byte{}, first...), EOF: &eof, Format: "jpeg",
		FrameWidth: w.frameW, FrameHeight: w.frameH, Width: w.width, Height: w.height, Cursor: w.cursor,
	}
}

// encodeFrame is the image as a JPEG, scaled down (nearest pixel) to maxWidth at most, and its size.
func encodeFrame(img *image.RGBA, maxWidth, quality int) ([]byte, int, int, error) {
	b := img.Bounds()
	var src image.Image = img
	fw, fh := b.Dx(), b.Dy()
	if fw > maxWidth {
		fh = max(1, fh*maxWidth/fw)
		fw = maxWidth
		scaled := image.NewRGBA(image.Rect(0, 0, fw, fh))
		for y := range fh {
			sy := b.Min.Y + y*b.Dy()/fh
			for x := range fw {
				sx := b.Min.X + x*b.Dx()/fw
				so := img.PixOffset(sx, sy)
				do := scaled.PixOffset(x, y)
				copy(scaled.Pix[do:do+4], img.Pix[so:so+4])
			}
		}
		src = scaled
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, src, &jpeg.Options{Quality: quality}); err != nil {
		return nil, 0, 0, fmt.Errorf("cannot encode the frame as JPEG: %w", err)
	}
	return out.Bytes(), fw, fh, nil
}

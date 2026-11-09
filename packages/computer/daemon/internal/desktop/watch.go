package desktop

// screen.watch: the live view's frames. The caller asks with after, the seq of the last frame it has whole (its ack);
// the answer is the next frame once the screen changed, or changed false once waitMs passed with none. An after older
// than the newest frame gets the newest at once. A frame is a JPEG of the screen, scaled down to maxWidth at most;
// width and height stay the screen's, the space input.actions takes. The pointer's place is part of what changes, so
// a move with no pixel changed is a frame too.
//
// The screen is read every pollEvery while a watch waits, holding the display only for each read, so input.actions and
// screen.shot go on meanwhile. One connection keeps one watch (its seq, the last frame and what it was read from);
// a second watch on it waits its turn. A frame over a chunk is held as screen.shot's PNG is, for screen.read.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hash/maphash"
	"image"
	"image/jpeg"
	"io"
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

// pollEvery is how often a waiting watch reads the screen: at most 5 frames a second.
var pollEvery = 200 * time.Millisecond

type watchParams struct {
	After    *int `json:"after"`
	WaitMs   *int `json:"waitMs"`
	MaxWidth *int `json:"maxWidth"`
	Quality  *int `json:"quality"`
}

// WatchResult is screen.watch's answer. A frame (changed true) carries its JPEG as screen.shot carries its PNG: the
// first chunk in data, the rest through screen.read by id.
type WatchResult struct {
	Seq         int     `json:"seq"`
	Changed     bool    `json:"changed"`
	ID          string  `json:"id,omitempty"`
	Size        int     `json:"size,omitempty"`
	Data        []byte  `json:"data,omitempty"`
	EOF         bool    `json:"eof,omitempty"`
	Format      string  `json:"format,omitempty"`
	FrameWidth  int     `json:"frameWidth,omitempty"`
	FrameHeight int     `json:"frameHeight,omitempty"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	Cursor      *[2]int `json:"cursor,omitempty"`
}

// watching is one connection's watch: one call at a time (turn), its seq, the newest frame, and the hash of what that
// frame was read from (the pixels and the pointer's place).
type watching struct {
	turn   chan struct{}
	seq    int
	hash   uint64
	jpeg   []byte
	frameW int
	frameH int
	width  int
	height int
	cursor *[2]int
}

func (w *watching) Close() error { return nil }

type watchKey struct{}

var seed = maphash.MakeSeed()

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
	w := rpc.Local(ctx, watchKey{}, func() io.Closer { return &watching{turn: make(chan struct{}, 1)} }).(*watching)
	select {
	case w.turn <- struct{}{}:
	case <-ctx.Done():
		return nil, rpc.Errorf(rpc.KindAborted, "screen.watch was cancelled while another watch on this connection waited")
	}
	defer func() { <-w.turn }()
	after := *params.After
	if after > w.seq {
		return nil, rpc.Errorf(rpc.KindInvalid, "after %d is past the newest frame, %d", after, w.seq)
	}
	if after < w.seq {
		return d.frame(ctx, w), nil
	}
	deadline := time.Now().Add(time.Duration(waitMs) * time.Millisecond)
	for {
		img, cursor, err := d.shoot(ctx, "screen.watch", nil)
		if err != nil {
			return nil, err
		}
		b := img.Bounds()
		w.width, w.height = b.Dx(), b.Dy()
		if hash := hashOf(img, cursor); w.seq == 0 || hash != w.hash {
			frame, fw, fh, err := encodeFrame(img, maxWidth, quality)
			if err != nil {
				return nil, err
			}
			w.seq++
			w.hash, w.jpeg, w.frameW, w.frameH, w.cursor = hash, frame, fw, fh, cursor
			return d.frame(ctx, w), nil
		}
		left := time.Until(deadline)
		if left <= 0 {
			return WatchResult{Seq: w.seq, Width: w.width, Height: w.height}, nil
		}
		select {
		case <-time.After(min(left, pollEvery)):
		case <-ctx.Done():
			return nil, rpc.Errorf(rpc.KindAborted, "screen.watch was cancelled while it waited for the screen to change")
		}
	}
}

// frame is the newest frame as an answer: its first chunk, and the rest held for screen.read when it is over one.
func (d *Display) frame(ctx context.Context, w *watching) WatchResult {
	data := w.jpeg
	first := data[:min(chunk, len(data))]
	eof := len(first) == len(data)
	id := ""
	if !eof {
		id = fmt.Sprintf("s%d", d.shots.Add(1))
		h := heldOf(ctx)
		h.mu.Lock()
		h.id, h.data = id, data
		h.mu.Unlock()
	}
	return WatchResult{
		Seq: w.seq, Changed: true, ID: id, Size: len(data), Data: append([]byte{}, first...), EOF: eof, Format: "jpeg",
		FrameWidth: w.frameW, FrameHeight: w.frameH, Width: w.width, Height: w.height, Cursor: w.cursor,
	}
}

// hashOf is what a frame was read from: its size (a screen resized may keep its bytes), its pixels and the pointer's
// place.
func hashOf(img *image.RGBA, cursor *[2]int) uint64 {
	var h maphash.Hash
	h.SetSeed(seed)
	_, _ = fmt.Fprintf(&h, "%dx%d|", img.Bounds().Dx(), img.Bounds().Dy())
	_, _ = h.Write(img.Pix)
	if cursor != nil {
		_, _ = fmt.Fprintf(&h, "|%d,%d", cursor[0], cursor[1])
	}
	return h.Sum64()
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

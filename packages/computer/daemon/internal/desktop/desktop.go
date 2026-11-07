// Package desktop is the daemon's X11 shim: screen.shot, screen.read and input.actions on the display computerd got
// in DISPLAY, through the pure-Go client in package x11. Pixels come from GetImage on the root window, input from XTEST,
// with no program started for any action: a batch is written as it runs, with one round trip after each action the
// server may refuse, so a refused one stops the batch before the next.
//
// The display is reached when it is first asked for, and again after it goes: a provider may start its X server
// through process.start after init is up. hello declares screen, input.pointer and input.keys only while the display
// answers with XTEST; otherwise each method is unsupported, in words.
package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"slices"
	"sync"
	"sync/atomic"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/files"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
)

// Groups is what a computer with a display offers past computerd's own.
var Groups = []string{"screen", "input.pointer", "input.keys"}

// chunk is the most bytes one screen.shot or screen.read gives: files.MaxChunk, which in base64 fits a line.
var chunk = files.MaxChunk

// Display is one X display, connected on demand.
type Display struct {
	name string

	// mu guards conn, briefly: hello may ask for the display while a batch holds it.
	mu   sync.Mutex
	conn *x11.Conn

	// use is held by each screen.shot and input.actions: one at a time drives the display. remap is the keysym remap's
	// state for remapped, the connection it was made on.
	use      sync.Mutex
	remap    remap
	remapped *x11.Conn

	shots atomic.Int64
}

// New is the display DISPLAY named when computerd started; "" is none.
func New(name string) *Display {
	return &Display{name: name}
}

// Close ends the connection to the display, if there is one.
func (d *Display) Close() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.conn != nil {
		_ = d.conn.Close()
		d.conn = nil
	}
}

// connection is the open connection to the display, made now if there is none or the last one ended.
func (d *Display) connection() (*x11.Conn, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.conn != nil && d.conn.Err() == nil {
		return d.conn, nil
	}
	if d.conn != nil {
		_ = d.conn.Close()
		d.conn = nil
	}
	if d.name == "" {
		return nil, rpc.Errorf(rpc.KindUnsupported, "this computer has no display: DISPLAY was not set when computerd started")
	}
	c, err := x11.Dial(d.name)
	if err == nil {
		if err = c.InitXTest(); err != nil {
			_ = c.Close()
		}
	}
	if err != nil {
		return nil, rpc.Errorf(rpc.KindUnsupported, "this computer has no display it can use: %v", err)
	}
	d.conn = c
	return c, nil
}

// gone turns a failure of the connection into the method's error, and drops the connection so the next call dials
// again; any other error is returned as it is.
func (d *Display) gone(c *x11.Conn, err error) error {
	if c.Err() == nil {
		return err
	}
	d.mu.Lock()
	if d.conn == c {
		d.conn = nil
	}
	d.mu.Unlock()
	return rpc.Errorf(rpc.KindUnsupported, "the display %s went away: %v", d.name, err)
}

// Groups is Groups when the display answers with XTEST, else none.
func (d *Display) Groups() []string {
	if _, err := d.connection(); err != nil {
		return nil
	}
	return slices.Clone(Groups)
}

// Handlers are screen.shot, screen.read and input.actions.
func (d *Display) Handlers() map[string]rpc.Handler {
	return map[string]rpc.Handler{
		"screen.shot":   d.shot,
		"screen.read":   d.read,
		"input.actions": d.actions,
	}
}

func strict(raw json.RawMessage, into any) error {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return rpc.Errorf(rpc.KindInvalid, "invalid params: %v", err)
	}
	return nil
}

type shotParams struct {
	Region []int `json:"region,omitempty"`
}

// ShotResult is screen.shot's answer.
type ShotResult struct {
	ID     string  `json:"id"`
	Size   int     `json:"size"`
	Data   []byte  `json:"data"`
	EOF    bool    `json:"eof"`
	Width  int     `json:"width"`
	Height int     `json:"height"`
	Scale  int     `json:"scale"`
	Cursor *[2]int `json:"cursor,omitempty"`
}

type readParams struct {
	ID     string `json:"id"`
	Offset *int   `json:"offset"`
}

// ReadResult is screen.read's answer.
type ReadResult struct {
	Data []byte `json:"data"`
	EOF  bool   `json:"eof"`
}

// held is the one shot a connection holds, until it is read to its end or the next shot.
type held struct {
	mu   sync.Mutex
	id   string
	data []byte
}

func (h *held) Close() error { return nil }

type heldKey struct{}

func heldOf(ctx context.Context) *held {
	return rpc.Local(ctx, heldKey{}, func() io.Closer { return &held{} }).(*held)
}

// duringShot is nil outside tests: it runs while screen.shot holds the display, so a test can make it fail there.
var duringShot func()

func (d *Display) shot(ctx context.Context, raw json.RawMessage) (any, error) {
	var params shotParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	d.use.Lock()
	c, err := d.connection()
	if err != nil {
		d.use.Unlock()
		return nil, err
	}
	img, cursor, err := capture(c, params.Region)
	if duringShot != nil {
		duringShot()
	}
	d.use.Unlock()
	if err != nil {
		return nil, d.gone(c, err)
	}
	var out bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&out, img); err != nil {
		return nil, fmt.Errorf("cannot encode the shot as PNG: %w", err)
	}
	data := out.Bytes()
	id := fmt.Sprintf("s%d", d.shots.Add(1))
	h := heldOf(ctx)
	h.mu.Lock()
	h.id, h.data = id, data
	first := data[:min(chunk, len(data))]
	eof := len(first) == len(data)
	if eof {
		h.id, h.data = "", nil
	}
	h.mu.Unlock()
	b := img.Bounds()
	return ShotResult{ID: id, Size: len(data), Data: first, EOF: eof, Width: b.Dx(), Height: b.Dy(), Scale: 1, Cursor: cursor}, nil
}

// capture reads the region (the whole screen when nil) and where the pointer is.
func capture(c *x11.Conn, region []int) (*image.RGBA, *[2]int, error) {
	width, height, err := c.RootSize()
	if err != nil {
		return nil, nil, err
	}
	x, y, w, h := 0, 0, width, height
	if region != nil {
		if len(region) != 4 {
			return nil, nil, rpc.Errorf(rpc.KindInvalid, "region %v is not [x, y, width, height]", region)
		}
		x, y, w, h = region[0], region[1], region[2], region[3]
		if w < 1 || h < 1 || x < 0 || y < 0 || x+w > width || y+h > height {
			return nil, nil, rpc.Errorf(rpc.KindInvalid, "region %v is not a rectangle of at least one pixel inside the %dx%d screen", region, width, height)
		}
	}
	img, err := c.GetImage(x, y, w, h)
	if err != nil {
		return nil, nil, err
	}
	px, py, err := c.QueryPointer()
	if err != nil {
		return nil, nil, err
	}
	return img, &[2]int{px, py}, nil
}

func (d *Display) read(ctx context.Context, raw json.RawMessage) (any, error) {
	var params readParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	if params.ID == "" || params.Offset == nil {
		return nil, rpc.Errorf(rpc.KindInvalid, "screen.read takes the shot's id and an offset")
	}
	if _, err := d.connection(); err != nil {
		return nil, err
	}
	h := heldOf(ctx)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.id != params.ID {
		return nil, rpc.Errorf(rpc.KindNotFound, "no shot %s: a connection holds one shot, until it is read to its end or the next screen.shot", params.ID)
	}
	offset := *params.Offset
	if offset < 0 || offset > len(h.data) {
		return nil, rpc.Errorf(rpc.KindInvalid, "offset %d is outside the %d-byte shot", offset, len(h.data))
	}
	data := h.data[offset:min(offset+chunk, len(h.data))]
	eof := offset+len(data) == len(h.data)
	result := ReadResult{Data: append([]byte{}, data...), EOF: eof}
	if eof {
		h.id, h.data = "", nil
	}
	return result, nil
}

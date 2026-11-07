package desktop_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/desktop"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/fixture"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/xvfbtest"
)

// patience bounds every wait: the host may be loaded, so it is never a claim about speed.
const patience = 30 * time.Second

type reply struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
		Data    struct {
			Kind string `json:"kind"`
		} `json:"data"`
	} `json:"error"`
}

// client is one connection to a server of the display's methods.
type client struct {
	t       *testing.T
	w       io.WriteCloser
	replies chan reply
	nextID  int
}

func serve(t *testing.T, d *desktop.Display) *client {
	t.Helper()
	cr, cw := io.Pipe()
	sr, sw := io.Pipe()
	server := rpc.NewServer(d.Handlers(), log.New(io.Discard, "", 0))
	go func() {
		_ = server.Serve(context.Background(), cr, sw)
		_ = sw.Close()
	}()
	c := &client{t: t, w: cw, replies: make(chan reply, 16)}
	go func() {
		scanner := bufio.NewScanner(sr)
		scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)
		for scanner.Scan() {
			var r reply
			if err := json.Unmarshal(scanner.Bytes(), &r); err == nil {
				c.replies <- r
			}
		}
		close(c.replies)
	}()
	t.Cleanup(func() { _ = cw.Close() })
	return c
}

func (c *client) send(method string, params any) int {
	c.t.Helper()
	c.nextID++
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": c.nextID, "method": method, "params": params})
	if _, err := c.w.Write(append(line, '\n')); err != nil {
		c.t.Fatal(err)
	}
	return c.nextID
}

func (c *client) wait(id int) reply {
	c.t.Helper()
	select {
	case r, ok := <-c.replies:
		if !ok {
			c.t.Fatalf("the server closed before replying to %d", id)
		}
		if r.ID != id {
			c.t.Fatalf("reply %d, want %d", r.ID, id)
		}
		return r
	case <-time.After(patience):
		c.t.Fatalf("no reply to %d", id)
	}
	return reply{}
}

func (c *client) call(method string, params any) reply {
	c.t.Helper()
	return c.wait(c.send(method, params))
}

func (c *client) ok(method string, params any, into any) {
	c.t.Helper()
	r := c.call(method, params)
	if r.Error != nil {
		c.t.Fatalf("%s %v: %s: %s", method, params, r.Error.Data.Kind, r.Error.Message)
	}
	if err := json.Unmarshal(r.Result, into); err != nil {
		c.t.Fatalf("%s: %v in %s", method, err, r.Result)
	}
}

func unsupported(t *testing.T, r reply, words string) {
	t.Helper()
	if r.Error == nil || r.Error.Data.Kind != "unsupported" || !strings.Contains(r.Error.Message, words) {
		t.Fatalf("want unsupported, in words naming %q; got %+v", words, r)
	}
}

func TestWithNoDisplayNothingIsDeclaredAndEachMethodIsUnsupportedInWords(t *testing.T) {
	for name, words := range map[string]string{"": "DISPLAY", ":4242": ":4242", "not a display": "DISPLAY"} {
		d := desktop.New(name)
		if groups := d.Groups(); len(groups) != 0 {
			t.Errorf("DISPLAY %q: groups %v", name, groups)
		}
		c := serve(t, d)
		unsupported(t, c.call("screen.shot", map[string]any{}), words)
		unsupported(t, c.call("screen.read", map[string]any{"id": "s1", "offset": 0}), words)
		unsupported(t, c.call("input.actions", map[string]any{"actions": []any{map[string]any{"type": "wait", "ms": 1}}}), words)
	}
}

// event is one line of the fixture's log.
type event struct {
	Event  string `json:"event"`
	Button string `json:"button"`
	At     []int  `json:"at"`
	DX     int    `json:"dx"`
	DY     int    `json:"dy"`
	Key    string `json:"key"`
	Down   bool   `json:"down"`
	Text   string `json:"text"`
}

type desk struct {
	t       *testing.T
	display *desktop.Display
	c       *client
	log     string
}

// onXvfb starts Xvfb, the fixture on it, and a server of the display's methods.
func onXvfb(t *testing.T) *desk {
	t.Helper()
	name := xvfbtest.Start(t, 320, 240)
	t.Setenv("XAUTHORITY", "")
	logPath := filepath.Join(t.TempDir(), "events.jsonl")
	ctx, cancel := context.WithCancel(context.Background())
	ran := make(chan error, 1)
	go func() { ran <- fixture.Run(ctx, name, logPath) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-ran:
		case <-time.After(patience):
			t.Error("the fixture did not end")
		}
	})
	d := desktop.New(name)
	t.Cleanup(d.Close)
	k := &desk{t: t, display: d, c: serve(t, d), log: logPath}
	k.until(func(events []event) bool { return len(events) > 0 && events[0].Event == "ready" }, "the fixture logged ready")
	return k
}

func (k *desk) events() []event {
	data, err := os.ReadFile(k.log)
	if err != nil {
		return nil
	}
	var out []event
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var e event
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			k.t.Fatalf("a log line that is not JSON: %q", line)
		}
		out = append(out, e)
	}
	return out
}

func (k *desk) until(done func([]event) bool, what string) []event {
	k.t.Helper()
	deadline := time.Now().Add(patience)
	for {
		events := k.events()
		if done(events) {
			return events
		}
		if time.Now().After(deadline) {
			k.t.Fatalf("%s: not within %v; the log: %+v", what, patience, events)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// since waits until done holds for the events logged after the first from.
func (k *desk) since(from int, done func([]event) bool, what string) []event {
	k.t.Helper()
	return k.until(func(events []event) bool { return len(events) >= from && done(events[from:]) }, what)[from:]
}

type result struct {
	Done   int `json:"done"`
	Failed *struct {
		Index   int    `json:"index"`
		Kind    string `json:"kind"`
		Message string `json:"message"`
	} `json:"failed"`
}

func (k *desk) act(actions ...map[string]any) result {
	k.t.Helper()
	var r result
	k.c.ok("input.actions", map[string]any{"actions": actions}, &r)
	return r
}

func (k *desk) allRan(actions ...map[string]any) {
	k.t.Helper()
	if r := k.act(actions...); r.Done != len(actions) || r.Failed != nil {
		k.t.Fatalf("input.actions %v: done %d, failed %+v", actions, r.Done, r.Failed)
	}
}

func pointer(events []event) []string {
	var out []string
	for _, e := range events {
		if e.Event == "down" || e.Event == "up" {
			out = append(out, fmt.Sprintf("%s %s %d,%d", e.Event, e.Button, e.At[0], e.At[1]))
		}
	}
	return out
}

func text(events []event) string {
	var out strings.Builder
	for _, e := range events {
		if e.Event == "text" {
			out.WriteString(e.Text)
		}
	}
	return out.String()
}

func ups(events []event) int {
	n := 0
	for _, e := range events {
		if e.Event == "up" {
			n++
		}
	}
	return n
}

type shot struct {
	ID     string `json:"id"`
	Size   int    `json:"size"`
	Data   []byte `json:"data"`
	EOF    bool   `json:"eof"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Scale  int    `json:"scale"`
	Cursor []int  `json:"cursor"`
}

// shoot takes a shot and reads it whole.
func (k *desk) shoot(region []int) (shot, image.Image) {
	k.t.Helper()
	params := map[string]any{}
	if region != nil {
		params["region"] = region
	}
	var s shot
	k.c.ok("screen.shot", params, &s)
	data := append([]byte(nil), s.Data...)
	for eof := s.EOF; !eof; {
		var read struct {
			Data []byte `json:"data"`
			EOF  bool   `json:"eof"`
		}
		k.c.ok("screen.read", map[string]any{"id": s.ID, "offset": len(data)}, &read)
		if len(read.Data) == 0 && !read.EOF {
			k.t.Fatalf("screen.read at %d: no bytes and no eof", len(data))
		}
		data = append(data, read.Data...)
		eof = read.EOF
	}
	if len(data) != s.Size {
		k.t.Fatalf("read %d bytes of a %d-byte shot", len(data), s.Size)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		k.t.Fatalf("the shot is not a PNG: %v", err)
	}
	return s, img
}

func rgb(img image.Image, x, y int) [3]int {
	r, g, b, _ := img.At(x, y).RGBA()
	return [3]int{int(r >> 8), int(g >> 8), int(b >> 8)}
}

func TestOnXvfbTheDisplayIsDeclared(t *testing.T) {
	k := onXvfb(t)
	if got := strings.Join(k.display.Groups(), ","); got != "screen,input.pointer,input.keys" {
		t.Fatalf("groups %q", got)
	}
}

func TestOnXvfbAShotIsAPNGOfTheScreenWithTheFixturesColors(t *testing.T) {
	k := onXvfb(t)
	k.allRan(map[string]any{"type": "move", "at": []int{250, 30}})
	s, img := k.shoot(nil)
	if s.Width != 320 || s.Height != 240 || img.Bounds().Dx() != 320 || img.Bounds().Dy() != 240 || s.Scale != 1 {
		t.Fatalf("shot %dx%d scale %d, PNG %v", s.Width, s.Height, s.Scale, img.Bounds())
	}
	if len(s.Cursor) != 2 || s.Cursor[0] != 250 || s.Cursor[1] != 30 {
		t.Fatalf("cursor %v, want [250 30]", s.Cursor)
	}
	for i, at := range [][2]int{{50, 50}, {150, 50}, {50, 150}, {150, 150}} {
		want := [][3]int{{255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {255, 255, 0}}[i]
		if got := rgb(img, at[0], at[1]); got != want {
			t.Errorf("quadrant %d at %v: %v, want %v", i, at, got, want)
		}
	}
	region, part := k.shoot([]int{80, 60, 160, 120})
	if region.Width != 160 || region.Height != 120 || part.Bounds().Dx() != 160 || part.Bounds().Dy() != 120 {
		t.Fatalf("region shot %dx%d, PNG %v", region.Width, region.Height, part.Bounds())
	}
	if got := rgb(part, 0, 0); got != [3]int{255, 0, 0} {
		t.Errorf("the region's (0, 0) is the screen's (80, 60): %v", got)
	}
	if got := rgb(part, 100, 100); got != rgb(img, 180, 160) {
		t.Errorf("the region's (100, 100) is the screen's (180, 160): %v, %v", got, rgb(img, 180, 160))
	}
	for _, bad := range [][]int{{0, 0, 0, 10}, {300, 0, 30, 10}, {-1, 0, 10, 10}, {0, 0, 320, 241}} {
		if r := k.c.call("screen.shot", map[string]any{"region": bad}); r.Error == nil || r.Error.Data.Kind != "invalid" {
			t.Errorf("region %v: %+v; want invalid", bad, r)
		}
	}
}

func TestOnXvfbAShotOverAChunkIsReadInPartsAndDroppedAtEOF(t *testing.T) {
	defer desktop.SetChunkForTest(1000)()
	k := onXvfb(t)
	s, img := k.shoot(nil)
	if s.Size <= 1000 || len(s.Data) != 1000 || s.EOF {
		t.Fatalf("a %d-byte shot gave %d bytes, eof %v", s.Size, len(s.Data), s.EOF)
	}
	if img.Bounds().Dx() != 320 {
		t.Fatal(img.Bounds())
	}
	// Read whole, it is dropped: its id is not found any more, and neither is a made-up one.
	for _, params := range []map[string]any{{"id": s.ID, "offset": 0}, {"id": "s999", "offset": 0}} {
		if r := k.c.call("screen.read", params); r.Error == nil || r.Error.Data.Kind != "not_found" {
			t.Errorf("screen.read %v: %+v; want not_found", params, r)
		}
	}
	// A new shot replaces the one held.
	var first, second shot
	k.c.ok("screen.shot", map[string]any{}, &first)
	k.c.ok("screen.shot", map[string]any{}, &second)
	if r := k.c.call("screen.read", map[string]any{"id": first.ID, "offset": 1000}); r.Error == nil || r.Error.Data.Kind != "not_found" {
		t.Errorf("the first shot after a second: %+v", r)
	}
	if r := k.c.call("screen.read", map[string]any{"id": second.ID, "offset": second.Size + 1}); r.Error == nil || r.Error.Data.Kind != "invalid" {
		t.Errorf("an offset past the shot: %+v", r)
	}
}

func TestOnXvfbAClickLandsWhereAndAsOftenAsAsked(t *testing.T) {
	k := onXvfb(t)
	before := len(k.events())
	k.allRan(map[string]any{"type": "click", "at": []int{40, 60}})
	single := k.since(before, func(e []event) bool { return ups(e) >= 1 }, "a click")
	if got := strings.Join(pointer(single), "; "); got != "down left 40,60; up left 40,60" {
		t.Fatalf("a click at 40,60: %s", got)
	}
	middle := before + len(single)
	k.allRan(map[string]any{"type": "click", "at": []int{140, 120}, "count": 2, "button": "right"})
	double := k.since(middle, func(e []event) bool { return ups(e) >= 2 }, "a double click")
	if got := strings.Join(pointer(double), "; "); got != "down right 140,120; up right 140,120; down right 140,120; up right 140,120" {
		t.Fatalf("a double right click at 140,120: %s", got)
	}
}

func TestOnXvfbTypedTextArrivesExactlyASCIIOrNot(t *testing.T) {
	k := onXvfb(t)
	for _, typed := range []string{"Hello, agentrun! 123", "~`!@#$%^&*()_+-=[]{}|\\;':\",./<>?", "é ñ € 日本 😀 Ünïcödé"} {
		before := len(k.events())
		k.allRan(map[string]any{"type": "type", "text": typed})
		events := k.since(before, func(e []event) bool { return len([]rune(text(e))) >= len([]rune(typed)) }, fmt.Sprintf("%q in the log", typed))
		if got := text(events); got != typed {
			t.Errorf("typed %q, the fixture got %q", typed, got)
		}
	}
	// A key combo: shift with a is A, released in reverse.
	before := len(k.events())
	k.allRan(map[string]any{"type": "key", "keys": []string{"shift", "a"}}, map[string]any{"type": "key", "keys": []string{"b"}, "repeat": 2})
	events := k.since(before, func(e []event) bool { return len(text(e)) >= 3 }, "Abb")
	if got := text(events); got != "Abb" {
		t.Errorf("shift+a then b twice: %q", got)
	}
	var keyLog []string
	for _, e := range events {
		if e.Event == "key" {
			keyLog = append(keyLog, fmt.Sprintf("%s %v", e.Key, e.Down))
		}
	}
	if got := strings.Join(keyLog[:4], ", "); got != "shift true, A true, A false, shift false" {
		t.Errorf("the combo's keys: %s", got)
	}
}

func TestOnXvfbABatchWithAnUnknownKeyRunsNothing(t *testing.T) {
	k := onXvfb(t)
	before := len(k.events())
	r := k.act(map[string]any{"type": "click", "at": []int{100, 100}}, map[string]any{"type": "key", "keys": []string{"Hyper_Q"}})
	if r.Done != 0 || r.Failed == nil || r.Failed.Index != 1 || r.Failed.Kind != "invalid" || r.Failed.Message == "" {
		t.Fatalf("the refused batch: %+v %+v", r, r.Failed)
	}
	k.allRan(map[string]any{"type": "type", "text": "z"})
	events := k.since(before, func(e []event) bool { return strings.Contains(text(e), "z") }, "z")
	if p := pointer(events); len(p) != 0 || text(events) != "z" {
		t.Fatalf("the refused batch's click ran: %v, %q", p, text(events))
	}
}

func TestOnXvfbABatchStopsAtItsFirstFailureWithNothingLeftHeld(t *testing.T) {
	k := onXvfb(t)
	before := len(k.events())
	r := k.act(
		map[string]any{"type": "move", "at": []int{20, 20}},
		map[string]any{"type": "down", "button": "middle"},
		map[string]any{"type": "click", "at": []int{50, 50}},
		map[string]any{"type": "move", "at": []int{100000, 100000}},
		map[string]any{"type": "click", "at": []int{150, 150}},
	)
	if r.Done != 3 || r.Failed == nil || r.Failed.Index != 3 || r.Failed.Message == "" || !strings.Contains(r.Failed.Message, "320x240") {
		t.Fatalf("the stopped batch: done %d, failed %+v", r.Done, r.Failed)
	}
	k.allRan(map[string]any{"type": "click", "at": []int{100, 100}})
	events := k.since(before, func(e []event) bool {
		for _, one := range e {
			if one.Event == "up" && one.Button == "left" && one.At[0] == 100 {
				return true
			}
		}
		return false
	}, "the later click")
	// The middle button the stopped batch pressed was released when it stopped.
	if got := strings.Join(pointer(events), "; "); got != "down middle 20,20; down left 50,50; up left 50,50; up middle 50,50; down left 100,100; up left 100,100" {
		t.Fatalf("the log: %s", got)
	}
}

func TestOnXvfbDownStaysDownAcrossBatchesAndDragAndScrollLand(t *testing.T) {
	k := onXvfb(t)
	before := len(k.events())
	k.allRan(map[string]any{"type": "move", "at": []int{10, 10}}, map[string]any{"type": "down"})
	k.allRan(map[string]any{"type": "move", "at": []int{30, 40}})
	k.allRan(map[string]any{"type": "up"})
	k.allRan(map[string]any{"type": "drag", "path": [][]int{{60, 60}, {90, 70}, {120, 30}}})
	k.allRan(map[string]any{"type": "scroll", "at": []int{20, 180}, "dy": 2, "dx": -1, "unit": "clicks"})
	events := k.since(before, func(e []event) bool {
		n := 0
		for _, one := range e {
			if one.Event == "wheel" {
				n++
			}
		}
		return n >= 3
	}, "the scroll")
	if got := strings.Join(pointer(events), "; "); got != "down left 10,10; up left 30,40; down left 60,60; up left 120,30" {
		t.Fatalf("the pointer's log: %s", got)
	}
	var wheel []string
	for _, e := range events {
		if e.Event == "wheel" {
			wheel = append(wheel, fmt.Sprintf("%d,%d %d %d", e.At[0], e.At[1], e.DX, e.DY))
		}
	}
	if got := strings.Join(wheel, "; "); got != "20,180 0 1; 20,180 0 1; 20,180 -1 0" {
		t.Fatalf("the wheel's log: %s", got)
	}
}

func TestOnXvfbACancelledHoldReleasesItsKeys(t *testing.T) {
	k := onXvfb(t)
	before := len(k.events())
	id := k.c.send("input.actions", map[string]any{"actions": []map[string]any{{"type": "hold", "keys": []string{"shift"}, "ms": 60000}}})
	k.since(before, func(e []event) bool {
		for _, one := range e {
			if one.Event == "key" && one.Key == "shift" && one.Down {
				return true
			}
		}
		return false
	}, "shift down")
	if _, err := k.c.w.Write([]byte(`{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":` + fmt.Sprint(id) + "}}\n")); err != nil {
		t.Fatal(err)
	}
	if r := k.c.wait(id); r.Error == nil || r.Error.Data.Kind != "aborted" {
		t.Fatalf("the cancelled hold: %+v", r)
	}
	from := len(k.events())
	k.allRan(map[string]any{"type": "type", "text": "a"})
	if got := text(k.since(from, func(e []event) bool { return text(e) != "" }, "a")); got != "a" {
		t.Fatalf("after the cancelled hold, typing a gave %q: shift was left down", got)
	}
}

func TestOnXvfbAPixelScrollIsUnsupportedAndNothingRuns(t *testing.T) {
	k := onXvfb(t)
	r := k.act(map[string]any{"type": "wait", "ms": 1}, map[string]any{"type": "scroll", "dy": 120, "unit": "px"})
	if r.Done != 0 || r.Failed == nil || r.Failed.Index != 1 || r.Failed.Kind != "unsupported" {
		t.Fatalf("a pixel scroll: %+v %+v", r, r.Failed)
	}
}

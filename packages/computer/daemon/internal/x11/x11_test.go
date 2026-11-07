package x11_test

import (
	"errors"
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
)

func TestParseDisplay(t *testing.T) {
	for name, want := range map[string]x11.Address{
		":0":              {Number: 0},
		":1.0":            {Number: 1},
		":12.1":           {Number: 12, Screen: 1},
		"unix:3":          {Host: "unix", Number: 3},
		"localhost:10.0":  {Host: "localhost", Number: 10},
		"192.0.2.7:2":     {Host: "192.0.2.7", Number: 2},
		"display.test:99": {Host: "display.test", Number: 99},
	} {
		got, err := x11.ParseDisplay(name)
		if err != nil || got != want {
			t.Errorf("ParseDisplay(%q) = %+v, %v; want %+v", name, got, err, want)
		}
	}
	for _, name := range []string{"", "0", ":", ":x", ":1.", ":-1", "host", ":1.x", ":99999999999"} {
		if got, err := x11.ParseDisplay(name); err == nil {
			t.Errorf("ParseDisplay(%q) = %+v; want an error", name, got)
		} else if !strings.Contains(err.Error(), "DISPLAY") {
			t.Errorf("ParseDisplay(%q): %v does not name DISPLAY", name, err)
		}
	}
}

// authority writes an Xauthority file of entries: family, address, display number, name, data.
func authority(t *testing.T, entries ...[5]any) string {
	t.Helper()
	var out []byte
	field := func(b []byte) {
		out = append(out, byte(len(b)>>8), byte(len(b)))
		out = append(out, b...)
	}
	for _, e := range entries {
		family := e[0].(int)
		out = append(out, byte(family>>8), byte(family))
		field([]byte(e[1].(string)))
		field([]byte(e[2].(string)))
		field([]byte(e[3].(string)))
		field(e[4].([]byte))
	}
	path := filepath.Join(t.TempDir(), "Xauthority")
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReadAuthorityPicksThisDisplaysCookie(t *testing.T) {
	cookie := []byte("0123456789abcdef")
	path := authority(t,
		[5]any{256, "other-host", "0", "MIT-MAGIC-COOKIE-1", []byte("wrong host......")},
		[5]any{256, "box", "1", "MIT-MAGIC-COOKIE-1", []byte("wrong display...")},
		[5]any{256, "box", "0", "XDM-AUTHORIZATION-1", []byte("another scheme..")},
		[5]any{256, "box", "0", "MIT-MAGIC-COOKIE-1", cookie},
	)
	auth, ok, err := x11.ReadAuthority(path, x11.Address{Number: 0}, "box")
	if err != nil || !ok || auth.Name != "MIT-MAGIC-COOKIE-1" || string(auth.Data) != string(cookie) {
		t.Fatalf("ReadAuthority = %+v, %v, %v", auth, ok, err)
	}
	// A wildcard entry (family 65535) is any host's.
	wild := authority(t, [5]any{65535, "", "4", "MIT-MAGIC-COOKIE-1", cookie})
	if auth, ok, err := x11.ReadAuthority(wild, x11.Address{Number: 4}, "anything"); err != nil || !ok || string(auth.Data) != string(cookie) {
		t.Fatalf("a wildcard entry: %+v, %v, %v", auth, ok, err)
	}
	// None for this display: no auth, and no error.
	if _, ok, err := x11.ReadAuthority(path, x11.Address{Number: 7}, "box"); ok || err != nil {
		t.Fatalf("no entry: %v, %v", ok, err)
	}
	// A missing file is no auth either; a cut-short one is an error in words.
	if _, ok, err := x11.ReadAuthority(filepath.Join(t.TempDir(), "none"), x11.Address{}, "box"); ok || err != nil {
		t.Fatalf("a missing file: %v, %v", ok, err)
	}
	short := filepath.Join(t.TempDir(), "short")
	_ = os.WriteFile(short, []byte{1, 0, 0, 9, 'b'}, 0o600)
	if _, _, err := x11.ReadAuthority(short, x11.Address{}, "box"); err == nil || !strings.Contains(err.Error(), "Xauthority") {
		t.Fatalf("a cut-short file: %v", err)
	}
}

func TestOpenSendsTheCookieAndReadsTheSetup(t *testing.T) {
	f, conn := startFake(t, nil)
	c, err := x11.Open(conn, x11.Auth{Name: "MIT-MAGIC-COOKIE-1", Data: []byte("0123456789abcdef")}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	f.mu.Lock()
	order, name, data := f.byteOrder, f.authName, string(f.authData)
	f.mu.Unlock()
	if order != 'l' || name != "MIT-MAGIC-COOKIE-1" || data != "0123456789abcdef" {
		t.Fatalf("setup request: byte order %q, auth %q %q", order, name, data)
	}
	s := c.Screen()
	if s.Root != fakeRoot || s.Width != fakeWidth || s.Height != fakeHeight || s.Depth != 24 || s.Visual != fakeVisual {
		t.Fatalf("screen %+v", s)
	}
	if lo, hi := c.Keycodes(); lo != fakeMinKey || hi != fakeMaxKey {
		t.Fatalf("keycodes %d-%d", lo, hi)
	}
}

func TestARefusedSetupSaysWhyInWords(t *testing.T) {
	_, conn := startFake(t, func(f *fakeServer) { f.setupFail = "Authorization required, but no authorization protocol specified" })
	_, err := x11.Open(conn, x11.Auth{}, 0)
	if err == nil || !strings.Contains(err.Error(), "Authorization required") {
		t.Fatalf("Open: %v", err)
	}
}

func TestAScreenTheServerDoesNotHaveIsRefused(t *testing.T) {
	_, conn := startFake(t, nil)
	if _, err := x11.Open(conn, x11.Auth{}, 1); err == nil || !strings.Contains(err.Error(), "screen 1") {
		t.Fatalf("Open screen 1: %v", err)
	}
}

func xtestConn(t *testing.T, configure func(*fakeServer)) (*fakeServer, *x11.Conn) {
	t.Helper()
	f, conn := startFake(t, configure)
	c, err := x11.Open(conn, x11.Auth{}, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	if err := c.InitXTest(); err != nil {
		t.Fatal(err)
	}
	return f, c
}

func TestFakeInputIsXTESTsWireFormat(t *testing.T) {
	f, c := xtestConn(t, nil)
	if err := c.FakeInput(x11.MotionNotify, 0, 17, 23); err != nil {
		t.Fatal(err)
	}
	if err := c.FakeInput(x11.ButtonPress, 1, 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := c.FakeInput(x11.KeyRelease, 38, 0, 0); err != nil {
		t.Fatal(err)
	}
	if errs, err := c.Sync(); err != nil || len(errs) != 0 {
		t.Fatalf("Sync: %v %v", errs, err)
	}
	var fakes []request
	for _, r := range f.got() {
		if r.opcode == fakeXTest && r.data == 2 {
			fakes = append(fakes, r)
		}
	}
	if len(fakes) != 3 {
		t.Fatalf("%d FakeInput requests, want 3: %+v", len(fakes), f.got())
	}
	for i, want := range []struct {
		kind, detail byte
		x, y         int16
	}{{6, 0, 17, 23}, {4, 1, 0, 0}, {3, 38, 0, 0}} {
		b := fakes[i].body
		// type, detail, 2 unused, time, root, 8 unused, rootX, rootY, 7 unused, deviceid: 32 bytes after the header.
		if len(b) != 32 || b[0] != want.kind || b[1] != want.detail || le.Uint32(b[4:]) != 0 || int16(le.Uint16(b[20:])) != want.x || int16(le.Uint16(b[22:])) != want.y {
			t.Errorf("FakeInput %d: % x", i, b)
		}
		if want.kind == 6 && le.Uint32(b[8:]) != fakeRoot {
			t.Errorf("a motion is on the root window: % x", b)
		}
	}
}

func TestNoXTESTIsAnErrorInWords(t *testing.T) {
	_, conn := startFake(t, func(f *fakeServer) { f.noXTest = true })
	c, err := x11.Open(conn, x11.Auth{}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ext, err := c.QueryExtension("XTEST")
	if err != nil || ext.Present {
		t.Fatalf("QueryExtension(XTEST) on a server without it: %+v %v", ext, err)
	}
	if err := c.InitXTest(); err == nil || !strings.Contains(err.Error(), "XTEST") {
		t.Fatalf("InitXTest on a server without it: %v", err)
	}
}

func TestSyncReportsTheErrorsOfRequestsWithNoReply(t *testing.T) {
	f, c := xtestConn(t, func(f *fakeServer) {
		f.errorFor = func(r request) (byte, bool) {
			return 2, r.opcode == fakeXTest && r.data == 2 && r.body[1] == 7 // BadValue for keycode 7
		}
	})
	_ = f
	if err := c.FakeInput(x11.KeyPress, 38, 0, 0); err != nil {
		t.Fatal(err)
	}
	bad := c.Seq() + 1
	if err := c.FakeInput(x11.KeyPress, 7, 0, 0); err != nil {
		t.Fatal(err)
	}
	errs, err := c.Sync()
	if err != nil || len(errs) != 1 || errs[0].Seq != bad || errs[0].Code != 2 {
		t.Fatalf("Sync: %+v %v", errs, err)
	}
	if !strings.Contains(errs[0].Error(), "BadValue") {
		t.Fatalf("the error in words: %q", errs[0].Error())
	}
	if errs, err := c.Sync(); err != nil || len(errs) != 0 {
		t.Fatalf("a second Sync reports again: %+v %v", errs, err)
	}
}

func TestGetImageReadsZPixmapIntoRGBA(t *testing.T) {
	_, c := xtestConn(t, func(f *fakeServer) {
		f.image = func(x, y, w, h int) []byte {
			var out []byte
			for row := 0; row < h; row++ {
				for col := 0; col < w; col++ {
					// 32 bits a pixel, LSBFirst: blue, green, red, unused.
					out = append(out, byte(col+x), byte(row+y), 0xc8, 0xff)
				}
			}
			return out
		}
	})
	img, err := c.GetImage(5, 7, 3, 2)
	if err != nil {
		t.Fatal(err)
	}
	if b := img.Bounds(); b.Dx() != 3 || b.Dy() != 2 || b.Min.X != 0 || b.Min.Y != 0 {
		t.Fatalf("bounds %v", b)
	}
	if got := img.RGBAAt(2, 1); got != (color.RGBA{0xc8, 8, 7, 0xff}) {
		t.Fatalf("pixel (2, 1) = %v", got)
	}
}

func TestQueryPointerAndRootSize(t *testing.T) {
	_, c := xtestConn(t, func(f *fakeServer) { f.pointer = [2]int{31, 9} })
	if x, y, err := c.QueryPointer(); err != nil || x != 31 || y != 9 {
		t.Fatalf("QueryPointer = %d, %d, %v", x, y, err)
	}
	if w, h, err := c.RootSize(); err != nil || w != fakeWidth || h != fakeHeight {
		t.Fatalf("RootSize = %d, %d, %v", w, h, err)
	}
}

func TestKeyboardMappingFindsKeysymsAndUnusedKeycodes(t *testing.T) {
	keymap := make([]uint32, (fakeMaxKey-fakeMinKey+1)*2)
	set := func(code int, syms ...uint32) { copy(keymap[(code-fakeMinKey)*2:], syms) }
	for code := fakeMinKey; code <= fakeMaxKey; code++ {
		set(code, 0x1008ff00+uint32(code), 0) // every keycode has some keysym...
	}
	set(38, 'a', 'A')
	set(65, ' ', 0)
	set(50, 0xffe1, 0)
	set(200, 0, 0) // ...but these two
	set(201, 0, 0)
	f, c := xtestConn(t, func(f *fakeServer) { f.keymap = keymap })
	km, err := c.KeyboardMapping()
	if err != nil {
		t.Fatal(err)
	}
	for sym, want := range map[uint32]struct {
		code  byte
		shift bool
	}{'a': {38, false}, 'A': {38, true}, ' ': {65, false}, 0xffe1: {50, false}} {
		code, shift, ok := km.Find(sym)
		if !ok || code != want.code || shift != want.shift {
			t.Errorf("Find(%#x) = %d, %v, %v; want %+v", sym, code, shift, ok, want)
		}
	}
	if _, _, ok := km.Find(0xe9); ok {
		t.Error("Find(eacute) found a keycode the map does not have")
	}
	if got := km.Unused(); len(got) != 2 || got[0] != 200 || got[1] != 201 {
		t.Errorf("Unused() = %v", got)
	}
	if err := c.ChangeKeyboardMapping(200, 2, []uint32{0xe9, 0xe9}); err != nil {
		t.Fatal(err)
	}
	if errs, err := c.Sync(); err != nil || len(errs) != 0 {
		t.Fatal(errs, err)
	}
	var change *request
	for _, r := range f.got() {
		if r.opcode == 100 {
			change = &r
		}
	}
	if change == nil || change.data != 1 || change.body[0] != 200 || change.body[1] != 2 || le.Uint32(change.body[4:]) != 0xe9 || le.Uint32(change.body[8:]) != 0xe9 {
		t.Fatalf("ChangeKeyboardMapping on the wire: %+v", change)
	}
}

func TestALostConnectionFailsEveryCallInWords(t *testing.T) {
	_, conn := startFake(t, nil)
	c, err := x11.Open(conn, x11.Auth{}, 0)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if _, _, err := c.QueryPointer(); err == nil {
		t.Fatal("QueryPointer on a closed connection succeeded")
	}
	if c.Err() == nil || !errors.Is(c.Err(), x11.ErrClosed) {
		t.Fatalf("Err() = %v", c.Err())
	}
}

package x11_test

import (
	"encoding/binary"
	"errors"
	"image/color"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/x11fake"
)

var le = binary.LittleEndian

func TestParseDisplay(t *testing.T) {
	for name, want := range map[string]x11.Address{
		":0":              {Number: 0},
		":1.0":            {Number: 1},
		":12.1":           {Number: 12, Screen: 1},
		"unix:3":          {Host: "unix", Number: 3},
		"x.test:10.0":     {Host: "x.test", Number: 10},
		"y.test:2":        {Host: "y.test", Number: 2},
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
	f, conn := x11fake.Start(t, nil)
	c, err := x11.Open(conn, x11.Auth{Name: "MIT-MAGIC-COOKIE-1", Data: []byte("0123456789abcdef")}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	order, name, raw := f.Setup()
	data := string(raw)
	if order != 'l' || name != "MIT-MAGIC-COOKIE-1" || data != "0123456789abcdef" {
		t.Fatalf("setup request: byte order %q, auth %q %q", order, name, data)
	}
	s := c.Screen()
	if s.Root != x11fake.Root || s.Width != x11fake.Width || s.Height != x11fake.Height || s.Depth != 24 || s.Visual != x11fake.Visual {
		t.Fatalf("screen %+v", s)
	}
	if lo, hi := c.Keycodes(); lo != x11fake.MinKey || hi != x11fake.MaxKey {
		t.Fatalf("keycodes %d-%d", lo, hi)
	}
}

func TestARefusedSetupSaysWhyInWords(t *testing.T) {
	_, conn := x11fake.Start(t, func(f *x11fake.Server) {
		f.SetupFail = "Authorization required, but no authorization protocol specified"
	})
	_, err := x11.Open(conn, x11.Auth{}, 0)
	if err == nil || !strings.Contains(err.Error(), "Authorization required") {
		t.Fatalf("Open: %v", err)
	}
}

func TestAScreenTheServerDoesNotHaveIsRefused(t *testing.T) {
	_, conn := x11fake.Start(t, nil)
	if _, err := x11.Open(conn, x11.Auth{}, 1); err == nil || !strings.Contains(err.Error(), "screen 1") {
		t.Fatalf("Open screen 1: %v", err)
	}
}

func xtestConn(t *testing.T, configure func(*x11fake.Server)) (*x11fake.Server, *x11.Conn) {
	t.Helper()
	f, conn := x11fake.Start(t, configure)
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
	var fakes []x11fake.Request
	for _, r := range f.Got() {
		if r.Opcode == x11fake.XTest && r.Data == 2 {
			fakes = append(fakes, r)
		}
	}
	if len(fakes) != 3 {
		t.Fatalf("%d FakeInput requests, want 3: %+v", len(fakes), f.Got())
	}
	for i, want := range []struct {
		kind, detail byte
		x, y         int16
	}{{6, 0, 17, 23}, {4, 1, 0, 0}, {3, 38, 0, 0}} {
		b := fakes[i].Body
		// type, detail, 2 unused, time, root, 8 unused, rootX, rootY, 7 unused, deviceid: 32 bytes after the header.
		if len(b) != 32 || b[0] != want.kind || b[1] != want.detail || le.Uint32(b[4:]) != 0 || int16(le.Uint16(b[20:])) != want.x || int16(le.Uint16(b[22:])) != want.y {
			t.Errorf("FakeInput %d: % x", i, b)
		}
		if want.kind == 6 && le.Uint32(b[8:]) != x11fake.Root {
			t.Errorf("a motion is on the root window: % x", b)
		}
	}
}

func TestNoXTESTIsAnErrorInWords(t *testing.T) {
	_, conn := x11fake.Start(t, func(f *x11fake.Server) { f.NoXTest = true })
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
	f, c := xtestConn(t, func(f *x11fake.Server) {
		f.ErrorFor = func(r x11fake.Request) (byte, bool) {
			return 2, r.Opcode == x11fake.XTest && r.Data == 2 && r.Body[1] == 7 // BadValue for keycode 7
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
	_, c := xtestConn(t, func(f *x11fake.Server) {
		f.Image = func(x, y, w, h int) []byte {
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
	_, c := xtestConn(t, func(f *x11fake.Server) { f.Pointer = [2]int{31, 9} })
	if x, y, err := c.QueryPointer(); err != nil || x != 31 || y != 9 {
		t.Fatalf("QueryPointer = %d, %d, %v", x, y, err)
	}
	if w, h, err := c.RootSize(); err != nil || w != x11fake.Width || h != x11fake.Height {
		t.Fatalf("RootSize = %d, %d, %v", w, h, err)
	}
}

func TestKeyboardMappingFindsKeysymsAndUnusedKeycodes(t *testing.T) {
	keymap := make([]uint32, (x11fake.MaxKey-x11fake.MinKey+1)*2)
	set := func(code int, syms ...uint32) { copy(keymap[(code-x11fake.MinKey)*2:], syms) }
	for code := x11fake.MinKey; code <= x11fake.MaxKey; code++ {
		set(code, 0x1008ff00+uint32(code), 0) // every keycode has some keysym...
	}
	set(38, 'a', 'A')
	set(65, ' ', 0)
	set(50, 0xffe1, 0)
	set(200, 0, 0) // ...but these two
	set(201, 0, 0)
	f, c := xtestConn(t, func(f *x11fake.Server) { f.Keymap = keymap })
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
	var change *x11fake.Request
	for _, r := range f.Got() {
		if r.Opcode == 100 {
			change = &r
		}
	}
	if change == nil || change.Data != 1 || change.Body[0] != 200 || change.Body[1] != 2 || le.Uint32(change.Body[4:]) != 0xe9 || le.Uint32(change.Body[8:]) != 0xe9 {
		t.Fatalf("ChangeKeyboardMapping on the wire: %+v", change)
	}
}

func TestALostConnectionFailsEveryCallInWords(t *testing.T) {
	_, conn := x11fake.Start(t, nil)
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

// A display on another host never gets this host's cookie: ReadAuthority reads a Local or wildcard entry only for a
// display in this computer (a unix socket, or TCP to a loopback address), and Dial refuses any other display before
// it sends anything.
func TestALocalCookieNeverGoesToAnotherHost(t *testing.T) {
	cookie := []byte("0123456789abcdef")
	path := authority(t,
		[5]any{256, "box", "0", "MIT-MAGIC-COOKIE-1", cookie},
		[5]any{65535, "", "0", "MIT-MAGIC-COOKIE-1", cookie},
	)
	for _, host := range []string{"x.test", "box"} {
		if auth, ok, err := x11.ReadAuthority(path, x11.Address{Host: host, Number: 0}, "box"); ok || err != nil || len(auth.Data) != 0 {
			t.Errorf("DISPLAY %s:0 got this host's cookie: %+v, %v, %v", host, auth, ok, err)
		}
	}
	for _, host := range []string{"", "unix", "127.0.0.1", "::1"} {
		if auth, ok, err := x11.ReadAuthority(path, x11.Address{Host: host, Number: 0}, "box"); !ok || err != nil || string(auth.Data) != string(cookie) {
			t.Errorf("DISPLAY %s:0 is this host's display, and has its cookie: %+v, %v, %v", host, auth, ok, err)
		}
	}
	t.Setenv("XAUTHORITY", path)
	if c, err := x11.Dial("x.test:0"); err == nil {
		_ = c.Close()
		t.Error("Dial(x.test:0) connected")
	} else if !strings.Contains(err.Error(), "only a display in this computer") {
		t.Errorf("Dial(x.test:0): %v does not say a display elsewhere is refused", err)
	}
}

// totalAlloc is how many bytes the process has allocated so far.
func totalAlloc() uint64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.TotalAlloc
}

// A reply or GenericEvent whose 32-bit length is past what this client reads is refused in words, and the connection
// closed, before anything is allocated for it: the largest a server may send is the most data any request asks for.
func TestAnAnnouncedLengthIsBoundedBeforeAnythingIsAllocated(t *testing.T) {
	for name, head := range map[string]func(seq uint16) []byte{
		"a reply": func(seq uint16) []byte {
			out := []byte{1, 1}
			out = le.AppendUint16(out, seq)
			return append(le.AppendUint32(out, 0xffffffff), make([]byte, 24)...)
		},
		"a GenericEvent": func(seq uint16) []byte {
			out := []byte{35, 131}
			out = le.AppendUint16(out, seq)
			return append(le.AppendUint32(out, 0xffffffff), make([]byte, 24)...)
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, conn := x11fake.Start(t, func(f *x11fake.Server) {
				f.Misbehave = func(r x11fake.Request) []byte {
					if r.Opcode == 43 { // the Sync's GetInputFocus
						return head(r.Seq)
					}
					return nil
				}
			})
			c, err := x11.Open(conn, x11.Auth{}, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			before := totalAlloc()
			_, err = c.Sync()
			grew := totalAlloc() - before
			if err == nil || !strings.Contains(err.Error(), "over the") {
				t.Errorf("Sync on a server announcing 16 GiB: %v; want a refusal of the length in words", err)
			}
			if !errors.Is(c.Err(), x11.ErrClosed) {
				t.Errorf("the connection is still open: %v", c.Err())
			}
			if grew > 64<<20 {
				t.Errorf("the client allocated %d bytes for a length the server only announced", grew)
			}
		})
	}
}

// fifo makes a FIFO in a fresh directory. Its cleanup opens the FIFO's other end and closes it, so a reader still
// blocked opening it (a client that waits for a writer) is let go when the test ends.
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

// An Xauthority path is in the computer user's own home, so any program there may put something other than a file at
// it. What is not a regular file (a FIFO, a device, a symbolic link to either or to anything) is refused in words at
// once, with nothing read: a FIFO never makes the read wait for a writer, and a device never makes it read without end.
func TestAnXauthorityThatIsNotARegularFileIsRefusedAtOnce(t *testing.T) {
	regular := authority(t, [5]any{256, "box", "0", "MIT-MAGIC-COOKIE-1", []byte("0123456789abcdef")})
	for name, path := range map[string]func(t *testing.T) string{
		"a FIFO":   fifo,
		"a device": func(t *testing.T) string { return "/dev/zero" },
		"a link to a device": func(t *testing.T) string {
			link := filepath.Join(t.TempDir(), "Xauthority")
			if err := os.Symlink("/dev/zero", link); err != nil {
				t.Fatal(err)
			}
			return link
		},
		"a link to a file": func(t *testing.T) string {
			link := filepath.Join(t.TempDir(), "Xauthority")
			if err := os.Symlink(regular, link); err != nil {
				t.Fatal(err)
			}
			return link
		},
	} {
		t.Run(name, func(t *testing.T) {
			p := path(t)
			before := totalAlloc()
			var err error
			within(t, 10*time.Second, "ReadAuthority", func() { _, _, err = x11.ReadAuthority(p, x11.Address{Number: 0}, "box") })
			if grew := totalAlloc() - before; grew > 16<<20 {
				t.Errorf("reading %s allocated %d bytes", name, grew)
			}
			if err == nil || !strings.Contains(err.Error(), "Xauthority") || !strings.Contains(err.Error(), p) {
				t.Fatalf("ReadAuthority of %s: %v; want a refusal in words naming the file", name, err)
			}
		})
	}
}

// An Xauthority file is tens of bytes an entry: one past the most this client reads is refused in words before any of
// it is read, so a sparse file of a GiB costs nothing.
func TestAHugeXauthorityIsRefusedBeforeItIsRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Xauthority")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(1 << 30); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	before := totalAlloc()
	_, _, err = x11.ReadAuthority(path, x11.Address{Number: 0}, "box")
	if grew := totalAlloc() - before; grew > 16<<20 {
		t.Errorf("a 1 GiB Xauthority file allocated %d bytes", grew)
	}
	if err == nil || !strings.Contains(err.Error(), "Xauthority") || !strings.Contains(err.Error(), "over") {
		t.Fatalf("ReadAuthority of a 1 GiB file: %v; want a refusal of its size in words", err)
	}
}

// A FIFO at $XAUTHORITY does not hang Dial: it is refused, in words, at once.
func TestDialRefusesAFIFOAsTheXauthorityFileAtOnce(t *testing.T) {
	_, name := x11fake.Listen(t, nil)
	path := fifo(t)
	t.Setenv("XAUTHORITY", path)
	var err error
	within(t, 10*time.Second, "Dial", func() {
		var c *x11.Conn
		if c, err = x11.Dial(name); err == nil {
			_ = c.Close()
		}
	})
	if err == nil || !strings.Contains(err.Error(), "Xauthority") {
		t.Fatalf("Dial with a FIFO as the Xauthority file: %v; want a refusal in words", err)
	}
}

// A setup whose scanline pad is not 8, 16 or 32, or whose keycodes are not a range from 8 up, is refused in words:
// GetImage divides by the pad, and KeyboardMapping counts the keycodes.
func TestASetupWithABadScanlinePadOrKeycodeRangeIsRefused(t *testing.T) {
	for name, c := range map[string]struct {
		configure func(*x11fake.Server)
		words     string
	}{
		"pad 0":             {func(f *x11fake.Server) { f.ScanlinePad = 0 }, "scanline pad"},
		"pad 7":             {func(f *x11fake.Server) { f.ScanlinePad = 7 }, "scanline pad"},
		"pad 64":            {func(f *x11fake.Server) { f.ScanlinePad = 64 }, "scanline pad"},
		"max under min":     {func(f *x11fake.Server) { f.MinKeycode, f.MaxKeycode = 9, 8 }, "keycode"},
		"min 0":             {func(f *x11fake.Server) { f.MinKeycode = 0 }, "keycode"},
		"min 7":             {func(f *x11fake.Server) { f.MinKeycode = 7 }, "keycode"},
		"max 0 and min 255": {func(f *x11fake.Server) { f.MinKeycode, f.MaxKeycode = 255, 0 }, "keycode"},
	} {
		t.Run(name, func(t *testing.T) {
			_, conn := x11fake.Start(t, c.configure)
			got, err := x11.Open(conn, x11.Auth{}, 0)
			if err == nil {
				_ = got.Close()
				t.Fatalf("Open accepted a setup with %s", name)
			}
			if !strings.Contains(err.Error(), c.words) {
				t.Fatalf("Open with %s: %v; want a refusal naming the %s", name, err, c.words)
			}
		})
	}
	// The edges are allowed: one keycode, 8 to 8; and pads of 8 and 16.
	for name, configure := range map[string]func(*x11fake.Server){
		"keycodes 8 to 8": func(f *x11fake.Server) { f.MinKeycode, f.MaxKeycode = 8, 8 },
		"pad 8":           func(f *x11fake.Server) { f.ScanlinePad = 8 },
		"pad 16":          func(f *x11fake.Server) { f.ScanlinePad = 16 },
	} {
		_, conn := x11fake.Start(t, configure)
		got, err := x11.Open(conn, x11.Auth{}, 0)
		if err != nil {
			t.Fatalf("Open with %s: %v", name, err)
		}
		_ = got.Close()
	}
}

// Each request's reply is bounded by the most it can carry: a reply of a fixed 32 bytes, a GetKeyboardMapping's by its
// keycodes, a GetImage's by its rectangle. One announced past its request's bound is refused, and the connection
// closed, before anything is allocated for it, though it is under the bound of the largest request.
func TestEachRepliesLengthIsBoundedByItsRequest(t *testing.T) {
	const announced = 256 << 20
	for name, call := range map[string]struct {
		opcode byte
		call   func(c *x11.Conn) error
	}{
		"QueryPointer": {38, func(c *x11.Conn) error { _, _, err := c.QueryPointer(); return err }},
		"GetGeometry":  {14, func(c *x11.Conn) error { _, _, err := c.RootSize(); return err }},
		"GetKeyboardMapping": {101, func(c *x11.Conn) error {
			_, err := c.KeyboardMapping()
			return err
		}},
		"GetImage": {73, func(c *x11.Conn) error { _, err := c.GetImage(0, 0, 2, 2); return err }},
	} {
		t.Run(name, func(t *testing.T) {
			_, conn := x11fake.Start(t, func(f *x11fake.Server) {
				f.Misbehave = func(r x11fake.Request) []byte {
					if r.Opcode != call.opcode {
						return nil
					}
					out := []byte{1, 1}
					out = le.AppendUint16(out, r.Seq)
					return append(le.AppendUint32(out, announced/4), make([]byte, 24)...)
				}
			})
			c, err := x11.Open(conn, x11.Auth{}, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			before := totalAlloc()
			err = call.call(c)
			grew := totalAlloc() - before
			if err == nil || !strings.Contains(err.Error(), "over the") {
				t.Errorf("%s answered with %d bytes: %v; want a refusal of the length in words", name, announced, err)
			}
			if grew > 16<<20 {
				t.Errorf("the client allocated %d bytes for a %s reply the server only announced", grew, name)
			}
		})
	}
}

// A server that sends errors no request caused is not an honest X server: one error is sent only for a request, so a
// connection that has had more errors than requests with no reply is closed in words. What the client keeps for Sync
// stays bounded however many it sends.
func TestErrorsNoRequestCausedCloseTheConnectionInWords(t *testing.T) {
	f, conn := x11fake.Start(t, nil)
	c, err := x11.Open(conn, x11.Auth{}, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	e := make([]byte, 32)
	e[1] = 2 // BadValue
	le.PutUint16(e[2:], 0xbeef)
	before := totalAlloc()
	sent := 0
	for ; sent < 100_000; sent++ {
		if f.Send(e) != nil {
			break
		}
	}
	grew := totalAlloc() - before
	if !errors.Is(c.Err(), x11.ErrClosed) || !strings.Contains(c.Err().Error(), "error") {
		t.Fatalf("after %d errors no request caused, the connection: %v; want closed, in words", sent, c.Err())
	}
	if sent > 64 {
		t.Errorf("the client read %d errors no request caused before it closed the connection", sent)
	}
	if grew > 1<<20 {
		t.Errorf("the client allocated %d bytes for %d errors", grew, sent)
	}
}

// Many requests the server refuses at once (a long scroll on a pointer without the wheel's buttons) are an honest
// server's errors: the connection stays open, and Sync hands back the first of them, at most 64, in order.
func TestSyncKeepsAtMost64ErrorsAndTheFirst(t *testing.T) {
	_, c := xtestConn(t, func(f *x11fake.Server) {
		f.ErrorFor = func(r x11fake.Request) (byte, bool) {
			return 2, r.Opcode == x11fake.XTest && r.Data == 2 && r.Body[1] == 6
		}
	})
	first := c.Seq() + 1
	for i := 0; i < 500; i++ {
		if err := c.FakeInput(x11.ButtonPress, 6, 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	errs, err := c.Sync()
	if err != nil || c.Err() != nil {
		t.Fatalf("Sync after 500 refused requests: %v, the connection %v; want it open", err, c.Err())
	}
	if len(errs) == 0 || len(errs) > 64 || errs[0].Seq != first {
		var at uint16
		if len(errs) > 0 {
			at = errs[0].Seq
		}
		t.Fatalf("Sync handed back %d errors, the first for request %d; want 1 to 64, the first for %d", len(errs), at, first)
	}
	if errs, err := c.Sync(); err != nil || len(errs) != 0 {
		t.Fatalf("a second Sync: %+v %v", errs, err)
	}
}

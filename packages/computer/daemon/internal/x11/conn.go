// Package x11 is a small X11 client in pure Go: the connection setup with an MIT-MAGIC-COOKIE-1 from the Xauthority
// file, the core requests the daemon's screen and input methods and the desktop fixture need, and the XTEST
// extension's FakeInput. It is written by hand against the X Window System Protocol (X11R7.7) and the XTEST Extension
// Protocol 2.2, with no cgo and no dependency, so computerd stays one static binary.
//
// A connection is little-endian. Requests are written in order through one buffer; a reader goroutine hands each reply
// to the request that waits for it, keeps the errors of requests that have no reply for Sync, and queues events only
// when EnableEvents asked for them.
package x11

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var le = binary.LittleEndian

// ErrClosed is wrapped by every error of a connection that has ended.
var ErrClosed = errors.New("the X connection is closed")

const (
	// setupTimeout bounds the dial and the connection setup: hello asks for the display, and must not wait long for one
	// that does not answer.
	setupTimeout = 5 * time.Second
	// ioTimeout bounds every write, and the wait for every reply: an X server that stops answering fails the call
	// instead of hanging it.
	ioTimeout = 30 * time.Second
	// flushAt is how much a batch of requests buffers before it is written anyway.
	flushAt = 64 << 10
	// MaxImagePixels is the most pixels one GetImage reads: 16384 x 16384, the largest image a screen shot is read back
	// as (MAX_SIDE in src/conformance/png.ts).
	MaxImagePixels = 16384 * 16384
	// Each request with a reply gives the most bytes its reply may carry past the first 32; a longer one is refused, and
	// the connection closed, before anything is allocated for it. smallReply is the bound of a reply the protocol makes
	// 32 bytes in all (GetInputFocus, QueryPointer, GetGeometry, QueryExtension, XTEST's GetVersion): 4 KiB, a margin a
	// server that pads one stays inside. GetKeyboardMapping's is 4 bytes a keysym for each keycode it asks for, at most
	// 255 keysyms each; GetImage's is 4 bytes a pixel of its rectangle.
	smallReply = 4 << 10
	// maxReply is the largest bound of any request: a GetImage of MaxImagePixels, 1 GiB (2^30 bytes, 2^28 words). A
	// reply no request waits for is read past up to it, and never kept.
	maxReply = MaxImagePixels * 4
	// noReply is a request's bound when it has no reply.
	noReply = -1
	// maxEvent is the most bytes a GenericEvent may carry past its first 32. This client asks for none: the X Input 2
	// and Present events that are GenericEvents are a few hundred bytes. Its bytes are read and dropped, never kept.
	maxEvent = 1 << 20
)

// Event types, as in an event's first byte and XTEST's FakeInput.
const (
	KeyPress      = 2
	KeyRelease    = 3
	ButtonPress   = 4
	ButtonRelease = 5
	MotionNotify  = 6
	FocusIn       = 9
	Expose        = 12
	MapNotify     = 19
	MappingNotify = 34
)

// Screen is the screen a connection is on.
type Screen struct {
	Root          uint32
	Width, Height int
	Depth         byte
	Visual        uint32
}

type format struct{ bpp, pad int }

// visual is a visual's class and its red, green and blue masks, each as where it starts and how many bits it has.
type visual struct {
	class    byte
	depth    byte
	channels [3]channel
}

type channel struct {
	mask        uint32
	shift, bits int
}

type packet struct {
	data []byte
	err  error
}

// waiter is a request that waits for its reply: where to hand it, and the most bytes it may carry past its first 32.
type waiter struct {
	ch    chan packet
	limit int
}

// Conn is one connection to an X server.
type Conn struct {
	sock net.Conn

	screen         Screen
	minKey, maxKey byte
	idBase, idMask uint32
	nextID         uint32
	imageMSB       bool
	formats        map[byte]format
	visuals        map[uint32]visual
	xtest          byte

	// wmu orders requests: their sequence numbers are the order they are buffered in.
	wmu sync.Mutex
	out []byte
	seq uint16

	mu        sync.Mutex
	cond      *sync.Cond
	pending   map[uint16]waiter
	errs      []*Error
	err       error
	keep      bool
	events    [][]byte
	closeOnce sync.Once
}

// Address is a parsed DISPLAY: [host]:number[.screen].
type Address struct {
	Host   string
	Number int
	Screen int
}

// ParseDisplay reads a DISPLAY such as ":0", ":1.0", "unix:2" or "host:10.0".
func ParseDisplay(name string) (Address, error) {
	bad := func() (Address, error) {
		return Address{}, fmt.Errorf("DISPLAY %q is not [host]:display[.screen], such as :0", name)
	}
	colon := strings.LastIndex(name, ":")
	if colon < 0 {
		return bad()
	}
	number, screen, dotted := strings.Cut(name[colon+1:], ".")
	n, ok := smallNumber(number)
	if !ok {
		return bad()
	}
	a := Address{Host: name[:colon], Number: n}
	if dotted {
		if a.Screen, ok = smallNumber(screen); !ok {
			return bad()
		}
	}
	return a, nil
}

func smallNumber(s string) (int, bool) {
	if s == "" || len(s) > 5 || strings.TrimLeft(s, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	return n, err == nil && n < 1<<16
}

// Dial connects to the X server a DISPLAY names, with the cookie for it in $XAUTHORITY (or ~/.Xauthority) when there
// is one. A local display is the unix socket /tmp/.X11-unix/X<n>, its abstract name first, as libxcb does on Linux.
//
// Only a display in this computer is dialled: the unix socket, or TCP to a host that is, or resolves only to, loopback
// addresses. computerd drives the display of its own computer, and the cookie it sends is this host's; any other
// DISPLAY is refused before anything is sent.
func Dial(name string) (*Conn, error) {
	addr, err := ParseDisplay(name)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: setupTimeout}
	var sock net.Conn
	if addr.Host == "" || addr.Host == "unix" {
		path := fmt.Sprintf("/tmp/.X11-unix/X%d", addr.Number)
		if sock, err = dialer.Dial("unix", "@"+path); err != nil {
			sock, err = dialer.Dial("unix", path)
		}
	} else {
		if addr.Host, err = loopback(addr.Host); err != nil {
			return nil, fmt.Errorf("DISPLAY %s: computerd drives only a display in this computer (a unix socket, or TCP to a loopback address): %w", name, err)
		}
		sock, err = dialer.Dial("tcp", net.JoinHostPort(addr.Host, strconv.Itoa(6000+addr.Number)))
	}
	if err != nil {
		return nil, fmt.Errorf("no X server answers at DISPLAY %s: %w", name, err)
	}
	auth, err := authFor(addr)
	if err != nil {
		_ = sock.Close()
		return nil, err
	}
	c, err := Open(sock, auth, addr.Screen)
	if err != nil {
		_ = sock.Close()
		return nil, fmt.Errorf("the X server at DISPLAY %s: %w", name, err)
	}
	return c, nil
}

// loopback is the address to dial for a TCP display's host: the host itself when it is a loopback address, else the
// first address it resolves to, when every one is loopback.
func loopback(host string) (string, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		if !ip.Unmap().IsLoopback() {
			return "", fmt.Errorf("%s is not a loopback address", host)
		}
		return ip.String(), nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), setupTimeout)
	defer cancel()
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return "", err
	}
	for _, ip := range ips {
		if !ip.Unmap().IsLoopback() {
			return "", fmt.Errorf("%s resolves to %s, which is not a loopback address", host, ip)
		}
	}
	if len(ips) == 0 {
		return "", fmt.Errorf("%s resolves to no address", host)
	}
	return ips[0].Unmap().String(), nil
}

func authFor(addr Address) (Auth, error) {
	path := os.Getenv("XAUTHORITY")
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return Auth{}, nil
		}
		path = filepath.Join(home, ".Xauthority")
	}
	hostname, _ := os.Hostname()
	auth, _, err := ReadAuthority(path, addr, hostname)
	return auth, err
}

// Open runs the connection setup over sock and starts reading it. It takes the screen'th screen.
func Open(sock net.Conn, auth Auth, screen int) (*Conn, error) {
	_ = sock.SetDeadline(time.Now().Add(setupTimeout))
	req := []byte{'l', 0}
	req = le.AppendUint16(req, 11)
	req = le.AppendUint16(req, 0)
	req = le.AppendUint16(req, uint16(len(auth.Name)))
	req = le.AppendUint16(req, uint16(len(auth.Data)))
	req = append(req, 0, 0)
	req = append(req, auth.Name...)
	req = append(req, make([]byte, pad(len(auth.Name)))...)
	req = append(req, auth.Data...)
	req = append(req, make([]byte, pad(len(auth.Data)))...)
	if _, err := sock.Write(req); err != nil {
		return nil, fmt.Errorf("the connection setup: %w", err)
	}
	head := make([]byte, 8)
	if _, err := io.ReadFull(sock, head); err != nil {
		return nil, fmt.Errorf("the connection setup: %w", err)
	}
	body := make([]byte, int(le.Uint16(head[6:]))*4)
	if _, err := io.ReadFull(sock, body); err != nil {
		return nil, fmt.Errorf("the connection setup: %w", err)
	}
	switch head[0] {
	case 0:
		reason := body[:min(int(head[1]), len(body))]
		return nil, fmt.Errorf("the X server refused the connection: %s", strings.TrimSpace(string(reason)))
	case 2:
		return nil, fmt.Errorf("the X server asks for more authentication: %s", strings.TrimSpace(strings.TrimRight(string(body), "\x00")))
	case 1:
	default:
		return nil, fmt.Errorf("the X server's setup reply has status %d", head[0])
	}
	c := &Conn{sock: sock, pending: map[uint16]waiter{}, formats: map[byte]format{}, visuals: map[uint32]visual{}}
	c.cond = sync.NewCond(&c.mu)
	if err := c.parseSetup(body, screen); err != nil {
		return nil, err
	}
	_ = sock.SetDeadline(time.Time{})
	go c.read()
	return c, nil
}

func (c *Conn) parseSetup(b []byte, want int) error {
	short := errors.New("the X server's setup reply is cut short")
	if len(b) < 32 {
		return short
	}
	c.idBase, c.idMask = le.Uint32(b[4:]), le.Uint32(b[8:])
	vendor := int(le.Uint16(b[16:]))
	screens, formats := int(b[20]), int(b[21])
	c.imageMSB = b[22] == 1
	c.minKey, c.maxKey = b[26], b[27]
	if c.minKey < 8 || c.maxKey < c.minKey {
		return fmt.Errorf("the X server's setup announces keycodes %d to %d; X11's are a range from 8 up", c.minKey, c.maxKey)
	}
	at := 32 + vendor + pad(vendor)
	for i := 0; i < formats; i++ {
		if at+8 > len(b) {
			return short
		}
		if p := b[at+2]; p != 8 && p != 16 && p != 32 {
			return fmt.Errorf("the X server's setup announces a scanline pad of %d bits for depth %d; X11's is 8, 16 or 32", p, b[at])
		}
		c.formats[b[at]] = format{bpp: int(b[at+1]), pad: int(b[at+2])}
		at += 8
	}
	for s := 0; s < screens; s++ {
		if at+40 > len(b) {
			return short
		}
		scr := Screen{Root: le.Uint32(b[at:]), Width: int(le.Uint16(b[at+20:])), Height: int(le.Uint16(b[at+22:])), Visual: le.Uint32(b[at+32:]), Depth: b[at+38]}
		depths := int(b[at+39])
		at += 40
		for d := 0; d < depths; d++ {
			if at+8 > len(b) {
				return short
			}
			depth, visuals := b[at], int(le.Uint16(b[at+2:]))
			at += 8
			for v := 0; v < visuals; v++ {
				if at+24 > len(b) {
					return short
				}
				c.visuals[le.Uint32(b[at:])] = newVisual(b[at+4], depth, le.Uint32(b[at+8:]), le.Uint32(b[at+12:]), le.Uint32(b[at+16:]))
				at += 24
			}
		}
		if s == want {
			c.screen = scr
		}
	}
	if want < 0 || want >= screens {
		return fmt.Errorf("the X server has %d screens and no screen %d", screens, want)
	}
	return nil
}

func newVisual(class, depth byte, masks ...uint32) visual {
	v := visual{class: class, depth: depth}
	for i, mask := range masks {
		v.channels[i] = channel{mask: mask}
		for m := mask; m != 0 && m&1 == 0; m >>= 1 {
			v.channels[i].shift++
		}
		for m := mask >> v.channels[i].shift; m&1 == 1; m >>= 1 {
			v.channels[i].bits++
		}
	}
	return v
}

func pad(n int) int { return (4 - n%4) % 4 }

// Screen is the screen this connection took.
func (c *Conn) Screen() Screen { return c.screen }

// Keycodes is the server's keycode range.
func (c *Conn) Keycodes() (lowest, highest byte) { return c.minKey, c.maxKey }

// Close ends the connection; every call waiting on it fails with ErrClosed.
func (c *Conn) Close() error {
	var err error
	c.closeOnce.Do(func() { err = c.sock.Close() })
	return err
}

// Err is why the connection ended, wrapping ErrClosed, or nil while it is open.
func (c *Conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// read hands each reply and error to its request, and queues events, until the connection ends.
func (c *Conn) read() {
	var failure error
	for {
		head := make([]byte, 32)
		if _, err := io.ReadFull(c.sock, head); err != nil {
			failure = err
			break
		}
		seq := le.Uint16(head[2:])
		switch head[0] {
		case 0:
			e := &Error{Code: head[1], Seq: seq, Value: le.Uint32(head[4:]), Minor: le.Uint16(head[8:]), Major: head[10]}
			c.mu.Lock()
			if w, ok := c.pending[seq]; ok {
				delete(c.pending, seq)
				w.ch <- packet{err: e}
			} else {
				c.errs = append(c.errs, e)
			}
			c.mu.Unlock()
		case 1:
			c.mu.Lock()
			w, waited := c.pending[seq]
			c.mu.Unlock()
			limit := maxReply
			if waited {
				limit = w.limit
			}
			n, err := announced(head, "a reply", limit)
			if err != nil {
				failure = err
				break
			}
			if !waited { // a reply nothing waits for: read past it
				if _, err := io.CopyN(io.Discard, c.sock, int64(n)); err != nil {
					failure = err
				}
				break
			}
			data := make([]byte, 32+n)
			copy(data, head)
			if _, err := io.ReadFull(c.sock, data[32:]); err != nil {
				failure = err
				break
			}
			c.mu.Lock()
			if w, ok := c.pending[seq]; ok {
				delete(c.pending, seq)
				w.ch <- packet{data: data}
			}
			c.mu.Unlock()
		default:
			if head[0]&0x7f == 35 { // GenericEvent: more bytes follow, which no event this client keeps needs
				n, err := announced(head, "a GenericEvent", maxEvent)
				if err == nil {
					_, err = io.CopyN(io.Discard, c.sock, int64(n))
				}
				if err != nil {
					failure = err
					break
				}
			}
			c.mu.Lock()
			if c.keep {
				c.events = append(c.events, head)
				c.cond.Broadcast()
			}
			c.mu.Unlock()
		}
		if failure != nil {
			break
		}
	}
	c.fail(failure)
	c.mu.Lock()
	for seq, w := range c.pending {
		w.ch <- packet{err: c.err}
		delete(c.pending, seq)
	}
	c.cond.Broadcast()
	c.mu.Unlock()
}

// announced is how many bytes follow a reply's or GenericEvent's first 32, from its 32-bit length in words: at most
// limit, else an error in words that ends the connection.
func announced(head []byte, what string, limit int) (int, error) {
	words := uint64(le.Uint32(head[4:]))
	if words*4 > uint64(limit) {
		return 0, fmt.Errorf("the X server announced %s of %d bytes, over the %d this client reads", what, words*4, limit)
	}
	return int(words) * 4, nil
}

// Seq is the sequence number of the last request buffered.
func (c *Conn) Seq() uint16 {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return c.seq
}

// buffer adds one request, padded to 4 bytes: opcode, data, then body. A request with a reply gives the most bytes
// the reply may carry past its first 32 as limit (noReply for none); it is flushed at once and the reply's channel
// returned.
func (c *Conn) buffer(opcode, data byte, body []byte, limit int) (chan packet, error) {
	reply := limit != noReply
	if err := c.Err(); err != nil {
		return nil, err
	}
	body = append(body, make([]byte, pad(len(body)))...)
	words := (4 + len(body)) / 4
	if words > 0xffff {
		return nil, fmt.Errorf("a request of %d bytes is over the core protocol's 256 KiB", words*4)
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.seq++
	var ch chan packet
	if reply {
		ch = make(chan packet, 1)
		c.mu.Lock()
		if c.err != nil {
			c.mu.Unlock()
			return nil, c.err
		}
		c.pending[c.seq] = waiter{ch, limit}
		c.mu.Unlock()
	}
	c.out = append(c.out, opcode, data)
	c.out = le.AppendUint16(c.out, uint16(words))
	c.out = append(c.out, body...)
	if reply || len(c.out) >= flushAt {
		return ch, c.flushLocked()
	}
	return ch, nil
}

// Flush writes every buffered request.
func (c *Conn) Flush() error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return c.flushLocked()
}

func (c *Conn) flushLocked() error {
	if len(c.out) == 0 {
		return nil
	}
	_ = c.sock.SetWriteDeadline(time.Now().Add(ioTimeout))
	_, err := c.sock.Write(c.out)
	c.out = c.out[:0]
	if err != nil {
		return c.fail(err)
	}
	return nil
}

// fail closes the connection for why, and returns the error every call gets from then on.
func (c *Conn) fail(why error) error {
	_ = c.Close()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err == nil {
		c.err = fmt.Errorf("%w: %v", ErrClosed, why)
	}
	return c.err
}

// call sends a request with a reply of at most limit bytes past its first 32, and waits for it.
func (c *Conn) call(opcode, data byte, body []byte, limit int) ([]byte, error) {
	ch, err := c.buffer(opcode, data, body, limit)
	if err != nil {
		return nil, err
	}
	select {
	case p := <-ch:
		if p.err != nil {
			return nil, p.err
		}
		return p.data, nil
	case <-time.After(ioTimeout):
		return nil, c.fail(fmt.Errorf("the X server did not answer within %v", ioTimeout))
	}
}

// Sync waits until the server has handled every request sent before it, with one round trip (GetInputFocus), and
// returns the errors of requests with no reply since the last Sync.
func (c *Conn) Sync() ([]*Error, error) {
	if _, err := c.call(43, 0, nil, smallReply); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	errs := c.errs
	c.errs = nil
	return errs, nil
}

// Error is an X error.
type Error struct {
	Code  byte
	Seq   uint16
	Major byte
	Minor uint16
	Value uint32
}

var errorNames = []string{1: "BadRequest", "BadValue", "BadWindow", "BadPixmap", "BadAtom", "BadCursor", "BadFont", "BadMatch", "BadDrawable", "BadAccess", "BadAlloc", "BadColor", "BadGC", "BadIDChoice", "BadName", "BadLength", "BadImplementation"}

func (e *Error) Error() string {
	name := fmt.Sprintf("X error %d", e.Code)
	if int(e.Code) < len(errorNames) && errorNames[e.Code] != "" {
		name = errorNames[e.Code]
	}
	return fmt.Sprintf("the X server answered %s to request %d.%d (value %#x)", name, e.Major, e.Minor, e.Value)
}

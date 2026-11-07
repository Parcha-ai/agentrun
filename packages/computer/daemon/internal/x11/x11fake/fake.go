// Package x11fake is a fake X server for tests, written against the X Window System Protocol (X11R7.7) and the XTEST
// extension protocol: it answers the connection setup and the requests a client sends, and records what it got. No X
// server is needed. Start serves one end of a pipe; Listen serves a local display, which a client dials by its DISPLAY.
package x11fake

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
)

var le = binary.LittleEndian

// The fake's screen, keycodes and XTEST.
const (
	Root   = 0x2b0
	Visual = 0x21
	XTest  = 140
	Width  = 320
	Height = 240
	MinKey = 8
	MaxKey = 255
)

func pad4(n int) int { return (4 - n%4) % 4 }

// setupReply is a successful setup: one screen of Width x Height, depth 24 TrueColor in 32 bits a pixel, with the
// keycodes and scanline pad the server's fields give.
func (f *Server) setupReply() []byte {
	vendor := "fake"
	var body []byte
	u32 := func(v uint32) { body = le.AppendUint32(body, v) }
	u16 := func(v uint16) { body = le.AppendUint16(body, v) }
	u8 := func(v byte) { body = append(body, v) }
	u32(1)          // release
	u32(0x00400000) // resource-id-base
	u32(0x001fffff) // resource-id-mask
	u32(0)          // motion-buffer-size
	u16(uint16(len(vendor)))
	u16(0xffff) // maximum-request-length
	u8(1)       // screens
	u8(2)       // formats
	u8(0)       // image-byte-order LSBFirst
	u8(0)       // bitmap-format-bit-order
	u8(32)      // scanline unit
	u8(32)      // scanline pad
	u8(f.MinKeycode)
	u8(f.MaxKeycode)
	u32(0)
	body = append(body, vendor...)
	body = append(body, make([]byte, pad4(len(vendor)))...)
	// formats: depth 1 in 1 bit, depth 24 in 32 bits
	body = append(body, 1, 1, f.ScanlinePad, 0, 0, 0, 0, 0)
	body = append(body, 24, 32, f.ScanlinePad, 0, 0, 0, 0, 0)
	// the screen
	u32(Root)
	u32(0x20)     // default colormap
	u32(0xffffff) // white
	u32(0)        // black
	u32(0)        // current input masks
	u16(Width)    // width in pixels
	u16(Height)   // height in pixels
	u16(85)
	u16(64)
	u16(1)
	u16(1)
	u32(Visual)
	u8(0)
	u8(0)
	u8(24) // root depth
	u8(1)  // depths
	// depth 24, one TrueColor visual
	u8(24)
	u8(0)
	u16(1)
	u32(0)
	u32(Visual)
	u8(4) // TrueColor
	u8(8)
	u16(256)
	u32(0xff0000)
	u32(0x00ff00)
	u32(0x0000ff)
	u32(0)
	head := []byte{1, 0}
	head = le.AppendUint16(head, 11)
	head = le.AppendUint16(head, 0)
	head = le.AppendUint16(head, uint16(len(body)/4))
	return append(head, body...)
}

// Request is one request the fake read: its sequence number, its opcode, its second byte, and what follows the 4-byte
// header.
type Request struct {
	Seq    uint16
	Opcode byte
	Data   byte
	Body   []byte
}

// Server is the fake. Its exported fields are set before a client connects.
type Server struct {
	SetupFail string
	// SetupHold runs once the client's setup request is read, before the setup reply, and may block.
	SetupHold func()
	// MinKeycode, MaxKeycode and ScanlinePad are what the setup announces: MinKey, MaxKey and 32 unless set.
	MinKeycode, MaxKeycode, ScanlinePad byte
	NoXTest                             bool
	// Keymap is the keysyms, PerCode a keycode, from MinKey; nil is a map with no keysym at all.
	Keymap  []uint32
	PerCode int
	Image   func(x, y, w, h int) []byte
	Pointer [2]int
	// ErrorFor answers a request with an X error of the code it gives, instead of its reply.
	ErrorFor func(r Request) (code byte, ok bool)
	// Hold runs before each request is answered, and may block: while it does, the fake reads nothing more.
	Hold func(r Request)
	// Misbehave gives the bytes a broken server answers a request with, after which it hangs up; nil answers as usual.
	Misbehave func(r Request) []byte

	mu        sync.Mutex
	authName  string
	authData  []byte
	requests  []Request
	byteOrder byte
}

func newServer(configure func(*Server)) *Server {
	f := &Server{PerCode: 2, MinKeycode: MinKey, MaxKeycode: MaxKey, ScanlinePad: 32}
	if configure != nil {
		configure(f)
	}
	return f
}

// Start returns the client's end of a pipe whose other end the fake serves.
func Start(t *testing.T, configure func(*Server)) (*Server, net.Conn) {
	t.Helper()
	client, server := net.Pipe()
	f := newServer(configure)
	go f.serve(server)
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
	})
	return f, client
}

// Listen serves the fake as a local display, on the abstract unix socket a client dials first for one, and returns
// its DISPLAY: the first display number from 6100 that no other server has. Each connection is served alone, and
// every one is closed with the test.
func Listen(t *testing.T, configure func(*Server)) (*Server, string) {
	t.Helper()
	f := newServer(configure)
	for n := 6100; n < 6400; n++ {
		l, err := net.Listen("unix", fmt.Sprintf("@/tmp/.X11-unix/X%d", n))
		if err != nil {
			continue
		}
		var mu sync.Mutex
		var open []net.Conn
		go func() {
			for {
				conn, err := l.Accept()
				if err != nil {
					return
				}
				mu.Lock()
				open = append(open, conn)
				mu.Unlock()
				go f.serve(conn)
			}
		}()
		t.Cleanup(func() {
			_ = l.Close()
			mu.Lock()
			defer mu.Unlock()
			for _, conn := range open {
				_ = conn.Close()
			}
		})
		return f, fmt.Sprintf(":%d", n)
	}
	t.Fatal("no display number from 6100 to 6399 is free for the fake X server")
	return nil, ""
}

// Got is every request the fake has read, in order.
func (f *Server) Got() []Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Request(nil), f.requests...)
}

// Setup is what the client's connection setup sent: its byte order, and its authorization's name and data.
func (f *Server) Setup() (order byte, name string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.byteOrder, f.authName, append([]byte(nil), f.authData...)
}

func (f *Server) serve(conn net.Conn) {
	head := make([]byte, 12)
	if _, err := io.ReadFull(conn, head); err != nil {
		return
	}
	nameLen, dataLen := int(le.Uint16(head[6:])), int(le.Uint16(head[8:]))
	rest := make([]byte, nameLen+pad4(nameLen)+dataLen+pad4(dataLen))
	if _, err := io.ReadFull(conn, rest); err != nil {
		return
	}
	f.mu.Lock()
	f.byteOrder = head[0]
	f.authName = string(rest[:nameLen])
	f.authData = append([]byte(nil), rest[nameLen+pad4(nameLen):nameLen+pad4(nameLen)+dataLen]...)
	f.mu.Unlock()
	if f.SetupHold != nil {
		f.SetupHold()
	}
	if f.SetupFail != "" {
		reason := f.SetupFail
		out := []byte{0, byte(len(reason))}
		out = le.AppendUint16(out, 11)
		out = le.AppendUint16(out, 0)
		out = le.AppendUint16(out, uint16((len(reason)+pad4(len(reason)))/4))
		out = append(out, reason...)
		out = append(out, make([]byte, pad4(len(reason)))...)
		_, _ = conn.Write(out)
		return
	}
	if _, err := conn.Write(f.setupReply()); err != nil {
		return
	}
	var seq uint16
	for {
		h := make([]byte, 4)
		if _, err := io.ReadFull(conn, h); err != nil {
			return
		}
		length := int(le.Uint16(h[2:])) * 4
		body := make([]byte, length-4)
		if _, err := io.ReadFull(conn, body); err != nil {
			return
		}
		seq++
		r := Request{Seq: seq, Opcode: h[0], Data: h[1], Body: body}
		f.mu.Lock()
		f.requests = append(f.requests, r)
		f.mu.Unlock()
		if f.Hold != nil {
			f.Hold(r)
		}
		if f.Misbehave != nil {
			if out := f.Misbehave(r); out != nil {
				_, _ = conn.Write(out)
				_ = conn.Close()
				return
			}
		}
		if f.ErrorFor != nil {
			if code, ok := f.ErrorFor(r); ok {
				e := make([]byte, 32)
				e[1] = code
				le.PutUint16(e[2:], seq)
				e[10] = r.Opcode
				if _, err := conn.Write(e); err != nil {
					return
				}
				continue
			}
		}
		if out := f.answer(r); out != nil {
			if _, err := conn.Write(out); err != nil {
				return
			}
		}
	}
}

// Reply is a reply to seq: data in its second byte, then 24 bytes of fixed fields and extra.
func Reply(seq uint16, data byte, fixed []byte, extra []byte) []byte {
	out := []byte{1, data}
	out = le.AppendUint16(out, seq)
	out = le.AppendUint32(out, uint32(len(extra)/4))
	fixed = append(fixed, make([]byte, 24-len(fixed))...)
	return append(append(out, fixed...), extra...)
}

func (f *Server) answer(r Request) []byte {
	switch r.Opcode {
	case 43: // GetInputFocus
		return Reply(r.Seq, 1, le.AppendUint32(nil, Root), nil)
	case 98: // QueryExtension
		n := int(le.Uint16(r.Body[0:]))
		if string(r.Body[4:4+n]) == "XTEST" && !f.NoXTest {
			return Reply(r.Seq, 0, []byte{1, XTest, 0, 0}, nil)
		}
		return Reply(r.Seq, 0, []byte{0, 0, 0, 0}, nil)
	case XTest:
		if r.Data == 0 { // GetVersion
			return Reply(r.Seq, 2, le.AppendUint16(nil, 2), nil)
		}
		return nil // FakeInput has no reply
	case 14: // GetGeometry
		fixed := le.AppendUint32(nil, Root)
		fixed = le.AppendUint16(fixed, 0)
		fixed = le.AppendUint16(fixed, 0)
		fixed = le.AppendUint16(fixed, Width)
		fixed = le.AppendUint16(fixed, Height)
		return Reply(r.Seq, 24, fixed, nil)
	case 38: // QueryPointer
		fixed := le.AppendUint32(nil, Root)
		fixed = le.AppendUint32(fixed, 0)
		fixed = le.AppendUint16(fixed, uint16(f.Pointer[0]))
		fixed = le.AppendUint16(fixed, uint16(f.Pointer[1]))
		return Reply(r.Seq, 1, fixed, nil)
	case 73: // GetImage
		x, y := int(int16(le.Uint16(r.Body[4:]))), int(int16(le.Uint16(r.Body[6:])))
		w, h := int(le.Uint16(r.Body[8:])), int(le.Uint16(r.Body[10:]))
		return Reply(r.Seq, 24, le.AppendUint32(nil, Visual), f.Image(x, y, w, h))
	case 101: // GetKeyboardMapping
		first, count := int(r.Body[0]), int(r.Body[1])
		from := (first - MinKey) * f.PerCode
		keymap := f.Keymap
		if keymap == nil {
			keymap = make([]uint32, (MaxKey-MinKey+1)*f.PerCode)
		}
		var extra []byte
		for _, sym := range keymap[from : from+count*f.PerCode] {
			extra = le.AppendUint32(extra, sym)
		}
		return Reply(r.Seq, byte(f.PerCode), nil, extra)
	}
	return nil
}

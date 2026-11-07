package x11_test

// A fake X server over net.Pipe, written against the X Window System Protocol (X11R7.7) and the XTEST extension
// protocol: it answers the connection setup and the requests the client sends, and records what it got. No X server
// is needed.

import (
	"encoding/binary"
	"io"
	"net"
	"sync"
	"testing"
)

var le = binary.LittleEndian

const (
	fakeRoot   = 0x2b0
	fakeVisual = 0x21
	fakeXTest  = 140
	fakeWidth  = 320
	fakeHeight = 240
	fakeMinKey = 8
	fakeMaxKey = 255
)

func pad4(n int) int { return (4 - n%4) % 4 }

// setupReply is a successful setup: one screen of fakeWidth x fakeHeight, depth 24 TrueColor in 32 bits a pixel.
func setupReply() []byte {
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
	u8(fakeMinKey)
	u8(fakeMaxKey)
	u32(0)
	body = append(body, vendor...)
	body = append(body, make([]byte, pad4(len(vendor)))...)
	// formats: depth 1 in 1 bit, depth 24 in 32 bits
	body = append(body, 1, 1, 32, 0, 0, 0, 0, 0)
	body = append(body, 24, 32, 32, 0, 0, 0, 0, 0)
	// the screen
	u32(fakeRoot)
	u32(0x20)       // default colormap
	u32(0xffffff)   // white
	u32(0)          // black
	u32(0)          // current input masks
	u16(fakeWidth)  // width in pixels
	u16(fakeHeight) // height in pixels
	u16(85)
	u16(64)
	u16(1)
	u16(1)
	u32(fakeVisual)
	u8(0)
	u8(0)
	u8(24) // root depth
	u8(1)  // depths
	// depth 24, one TrueColor visual
	u8(24)
	u8(0)
	u16(1)
	u32(0)
	u32(fakeVisual)
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

// request is one request the fake read: its opcode, its second byte, and what follows the 4-byte header.
type request struct {
	seq    uint16
	opcode byte
	data   byte
	body   []byte
}

type fakeServer struct {
	t    *testing.T
	conn net.Conn

	// Set before the client connects.
	setupFail string
	noXTest   bool
	keymap    []uint32 // keysyms, perCode a keycode, from fakeMinKey
	perCode   int
	image     func(x, y, w, h int) []byte
	pointer   [2]int
	errorFor  func(r request) (code byte, ok bool)

	mu        sync.Mutex
	authName  string
	authData  []byte
	requests  []request
	byteOrder byte
}

// startFake returns the client's end of a pipe whose other end the fake serves.
func startFake(t *testing.T, configure func(*fakeServer)) (*fakeServer, net.Conn) {
	t.Helper()
	client, server := net.Pipe()
	f := &fakeServer{t: t, conn: server, perCode: 2}
	if configure != nil {
		configure(f)
	}
	go f.serve()
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
	})
	return f, client
}

func (f *fakeServer) got() []request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]request(nil), f.requests...)
}

func (f *fakeServer) serve() {
	head := make([]byte, 12)
	if _, err := io.ReadFull(f.conn, head); err != nil {
		return
	}
	nameLen, dataLen := int(le.Uint16(head[6:])), int(le.Uint16(head[8:]))
	rest := make([]byte, nameLen+pad4(nameLen)+dataLen+pad4(dataLen))
	if _, err := io.ReadFull(f.conn, rest); err != nil {
		return
	}
	f.mu.Lock()
	f.byteOrder = head[0]
	f.authName = string(rest[:nameLen])
	f.authData = append([]byte(nil), rest[nameLen+pad4(nameLen):nameLen+pad4(nameLen)+dataLen]...)
	f.mu.Unlock()
	if f.setupFail != "" {
		reason := f.setupFail
		out := []byte{0, byte(len(reason))}
		out = le.AppendUint16(out, 11)
		out = le.AppendUint16(out, 0)
		out = le.AppendUint16(out, uint16((len(reason)+pad4(len(reason)))/4))
		out = append(out, reason...)
		out = append(out, make([]byte, pad4(len(reason)))...)
		_, _ = f.conn.Write(out)
		return
	}
	if _, err := f.conn.Write(setupReply()); err != nil {
		return
	}
	var seq uint16
	for {
		h := make([]byte, 4)
		if _, err := io.ReadFull(f.conn, h); err != nil {
			return
		}
		length := int(le.Uint16(h[2:])) * 4
		body := make([]byte, length-4)
		if _, err := io.ReadFull(f.conn, body); err != nil {
			return
		}
		seq++
		r := request{seq: seq, opcode: h[0], data: h[1], body: body}
		f.mu.Lock()
		f.requests = append(f.requests, r)
		f.mu.Unlock()
		if f.errorFor != nil {
			if code, ok := f.errorFor(r); ok {
				e := make([]byte, 32)
				e[1] = code
				le.PutUint16(e[2:], seq)
				e[10] = r.opcode
				if _, err := f.conn.Write(e); err != nil {
					return
				}
				continue
			}
		}
		if out := f.answer(r); out != nil {
			if _, err := f.conn.Write(out); err != nil {
				return
			}
		}
	}
}

// reply is a reply to seq: data in its second byte, then 24 bytes of fixed fields and extra.
func reply(seq uint16, data byte, fixed []byte, extra []byte) []byte {
	out := []byte{1, data}
	out = le.AppendUint16(out, seq)
	out = le.AppendUint32(out, uint32(len(extra)/4))
	fixed = append(fixed, make([]byte, 24-len(fixed))...)
	return append(append(out, fixed...), extra...)
}

func (f *fakeServer) answer(r request) []byte {
	switch r.opcode {
	case 43: // GetInputFocus
		return reply(r.seq, 1, le.AppendUint32(nil, fakeRoot), nil)
	case 98: // QueryExtension
		n := int(le.Uint16(r.body[0:]))
		if string(r.body[4:4+n]) == "XTEST" && !f.noXTest {
			return reply(r.seq, 0, []byte{1, fakeXTest, 0, 0}, nil)
		}
		return reply(r.seq, 0, []byte{0, 0, 0, 0}, nil)
	case fakeXTest:
		if r.data == 0 { // GetVersion
			return reply(r.seq, 2, le.AppendUint16(nil, 2), nil)
		}
		return nil // FakeInput has no reply
	case 14: // GetGeometry
		fixed := le.AppendUint32(nil, fakeRoot)
		fixed = le.AppendUint16(fixed, 0)
		fixed = le.AppendUint16(fixed, 0)
		fixed = le.AppendUint16(fixed, fakeWidth)
		fixed = le.AppendUint16(fixed, fakeHeight)
		return reply(r.seq, 24, fixed, nil)
	case 38: // QueryPointer
		fixed := le.AppendUint32(nil, fakeRoot)
		fixed = le.AppendUint32(fixed, 0)
		fixed = le.AppendUint16(fixed, uint16(f.pointer[0]))
		fixed = le.AppendUint16(fixed, uint16(f.pointer[1]))
		return reply(r.seq, 1, fixed, nil)
	case 73: // GetImage
		x, y := int(int16(le.Uint16(r.body[4:]))), int(int16(le.Uint16(r.body[6:])))
		w, h := int(le.Uint16(r.body[8:])), int(le.Uint16(r.body[10:]))
		return reply(r.seq, 24, le.AppendUint32(nil, fakeVisual), f.image(x, y, w, h))
	case 101: // GetKeyboardMapping
		first, count := int(r.body[0]), int(r.body[1])
		from := (first - fakeMinKey) * f.perCode
		var extra []byte
		for _, sym := range f.keymap[from : from+count*f.perCode] {
			extra = le.AppendUint32(extra, sym)
		}
		return reply(r.seq, byte(f.perCode), nil, extra)
	}
	return nil
}

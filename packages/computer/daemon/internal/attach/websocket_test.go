package attach

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

const subprotocol = "agentrun.computer.0.2"

// The two codes of attach.md's table this side never sends or acts on: both are redialed.
const (
	CloseNormal   = 1000
	CloseReplaced = 4409
)

// testToken is a fake-looking machine token, made here, never a real one.
var testToken = "art_" + strings.Repeat("A", 43)

func testOptions() Options {
	return Options{Token: testToken, Subprotocol: subprotocol, MaxMessage: 64, Heartbeat: time.Hour, Idle: time.Hour}
}

// fakeNet is a net.Conn whose reads come from in and whose writes collect in out: the reader, with no network.
type fakeNet struct {
	in  io.Reader
	mu  sync.Mutex
	out bytes.Buffer
}

func (f *fakeNet) Read(p []byte) (int, error) { return f.in.Read(p) }
func (f *fakeNet) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.out.Write(p)
}
func (f *fakeNet) Close() error                     { return nil }
func (f *fakeNet) LocalAddr() net.Addr              { return nil }
func (f *fakeNet) RemoteAddr() net.Addr             { return nil }
func (f *fakeNet) SetDeadline(time.Time) error      { return nil }
func (f *fakeNet) SetReadDeadline(time.Time) error  { return nil }
func (f *fakeNet) SetWriteDeadline(time.Time) error { return nil }

// reading is a Conn that reads stream as the server's bytes; what it sends is in the fakeNet.
func reading(stream []byte, o Options) (*Conn, *fakeNet) {
	f := &fakeNet{in: bytes.NewReader(stream)}
	return &Conn{nc: f, br: bufio.NewReader(f), o: o, done: make(chan struct{})}, f
}

// serverFrame is one frame as a server sends it: unmasked.
func serverFrame(fin bool, op byte, payload []byte) []byte {
	head := op
	if fin {
		head |= 0x80
	}
	frame := []byte{head}
	switch n := len(payload); {
	case n < 126:
		frame = append(frame, byte(n))
	case n <= 0xffff:
		frame = binary.BigEndian.AppendUint16(append(frame, 126), uint16(n))
	default:
		frame = binary.BigEndian.AppendUint64(append(frame, 127), uint64(n))
	}
	return append(frame, payload...)
}

func closeFrame(code int, reason string) []byte {
	return serverFrame(true, opClose, append(binary.BigEndian.AppendUint16(nil, uint16(code)), reason...))
}

type sent struct {
	op      byte
	payload []byte
}

// readClient reads one frame as a server does: it must be final and masked, and is unmasked here.
func readClient(r io.Reader) (sent, error) {
	var head [2]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return sent{}, err
	}
	if head[0]&0x80 == 0 || head[1]&0x80 == 0 {
		return sent{}, errors.New("a client frame not final or not masked")
	}
	n := uint64(head[1] & 0x7f)
	switch n {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return sent{}, err
		}
		n = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return sent{}, err
		}
		n = binary.BigEndian.Uint64(ext[:])
	}
	var mask [4]byte
	if _, err := io.ReadFull(r, mask[:]); err != nil {
		return sent{}, err
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return sent{}, err
	}
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
	return sent{op: head[0] & 0x0f, payload: payload}, nil
}

// sentFrames is every frame a Conn sent into f.
func sentFrames(t *testing.T, f *fakeNet) []sent {
	t.Helper()
	f.mu.Lock()
	r := bytes.NewReader(f.out.Bytes())
	f.mu.Unlock()
	var frames []sent
	for r.Len() > 0 {
		frame, err := readClient(r)
		if err != nil {
			t.Fatalf("the client's frames: %v", err)
		}
		frames = append(frames, frame)
	}
	return frames
}

// closedWith checks the read ended with code and that the client sent its close frame with that code.
func closedWith(t *testing.T, f *fakeNet, err error, code int) {
	t.Helper()
	var closed *Closed
	if !errors.As(err, &closed) || closed.Code != code {
		t.Fatalf("the read ended %v, want a close %d", err, code)
	}
	frames := sentFrames(t, f)
	last := frames[len(frames)-1]
	if last.op != opClose || len(last.payload) < 2 || int(binary.BigEndian.Uint16(last.payload)) != code {
		t.Fatalf("the client's last frame %+v, want a close %d", last, code)
	}
}

func TestClientFramesAreMaskedAndRoundTrip(t *testing.T) {
	for _, n := range []int{0, 1, 125, 126, 127, 0xffff, 0x10000, 70000} {
		payload := bytes.Repeat([]byte("ab\x00\xff"), n/4+1)[:n]
		c, f := reading(nil, testOptions())
		if err := c.write(opText, payload); err != nil {
			t.Fatal(err)
		}
		if raw := f.out.Bytes(); n > 0 && bytes.Contains(raw, payload) && n > 8 {
			t.Fatalf("%d bytes went out unmasked", n)
		}
		frames := sentFrames(t, f)
		if len(frames) != 1 || frames[0].op != opText || !bytes.Equal(frames[0].payload, payload) {
			t.Fatalf("%d bytes: the server reads %d frames, not the payload", n, len(frames))
		}
	}
}

func TestAWriteSendsEachLineAsOneMessage(t *testing.T) {
	c, f := reading(nil, testOptions())
	for _, chunk := range []string{`{"id":1,`, `"result":{}}` + "\n" + `{"id":2}`, "\n", `{"id":3`} {
		if _, err := c.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	frames := sentFrames(t, f)
	if len(frames) != 2 || string(frames[0].payload) != `{"id":1,"result":{}}` || string(frames[1].payload) != `{"id":2}` {
		t.Fatalf("frames %+v", frames)
	}
}

func TestAReadGivesEachMessageAsALine(t *testing.T) {
	stream := append(serverFrame(true, opText, []byte(`{"id":1}`)), serverFrame(true, opText, []byte(`{"id":2}`))...)
	c, _ := reading(stream, testOptions())
	got, err := io.ReadAll(io.LimitReader(c, int64(len(`{"id":1}`+"\n"+`{"id":2}`+"\n"))))
	if err != nil || string(got) != `{"id":1}`+"\n"+`{"id":2}`+"\n" {
		t.Fatalf("read %q, %v", got, err)
	}
}

// fragmented is msg cut at cuts (ascending, within it), each piece a frame, with a ping after the first piece.
func fragmented(msg []byte, cuts []int, ping []byte) []byte {
	var stream []byte
	from := 0
	for i, cut := range append(cuts, len(msg)) {
		op := byte(opContinuation)
		if i == 0 {
			op = opText
		}
		stream = append(stream, serverFrame(i == len(cuts), op, msg[from:cut])...)
		if i == 0 && ping != nil {
			stream = append(stream, serverFrame(true, opPing, ping)...)
		}
		from = cut
	}
	return stream
}

func TestAMessageFragmentedAtEverySplitWithAPingInsideComesWhole(t *testing.T) {
	msg := []byte(`{"jsonrpc":"2.0","id":7,"method":"hello","params":{"name":"Ada’s ✓"}}`)
	for i := 0; i <= len(msg); i++ {
		for j := i; j <= len(msg); j += 7 {
			o := testOptions()
			o.MaxMessage = len(msg)
			c, f := reading(fragmented(msg, []int{i, j}, []byte("p")), o)
			got, err := c.ReadMessage()
			if err != nil || !bytes.Equal(got, msg) {
				t.Fatalf("cut at %d and %d: %q, %v", i, j, got, err)
			}
			if frames := sentFrames(t, f); len(frames) != 1 || frames[0].op != opPong || string(frames[0].payload) != "p" {
				t.Fatalf("cut at %d and %d: the ping's answer %+v", i, j, frames)
			}
		}
	}
}

func TestEveryCloseCodeIsReadAndAnswered(t *testing.T) {
	for _, code := range []int{CloseNormal, CloseGoingAway, CloseBinary, CloseTooBig, CloseMismatch, CloseUnauthorized, CloseIdle, CloseReplaced, CloseVersion} {
		c, f := reading(closeFrame(code, "why"), testOptions())
		_, err := c.ReadMessage()
		var closed *Closed
		if !errors.As(err, &closed) || *closed != (Closed{Code: code, Reason: "why", ByServer: true}) {
			t.Fatalf("close %d read as %v", code, err)
		}
		closedWith(t, f, err, code)
	}
	c, f := reading(serverFrame(true, opClose, nil), testOptions())
	if _, err := c.ReadMessage(); c.Ended().Code != CloseNoStatus || err == nil {
		t.Fatalf("an empty close read as %v", err)
	}
	if frames := sentFrames(t, f); len(frames) != 1 || frames[0].op != opClose || len(frames[0].payload) != 0 {
		t.Fatalf("an empty close answered %+v", frames)
	}
}

func TestFramesTheReaderRefusesCloseTheSocket(t *testing.T) {
	text := serverFrame(true, opText, []byte("x"))
	for _, tc := range []struct {
		name   string
		stream []byte
		code   int
	}{
		{"binary", serverFrame(true, opBinary, []byte("x")), CloseBinary},
		{"over the limit", serverFrame(true, opText, bytes.Repeat([]byte("x"), 65)), CloseTooBig},
		{"over the limit in two fragments", append(serverFrame(false, opText, bytes.Repeat([]byte("x"), 40)), serverFrame(true, opContinuation, bytes.Repeat([]byte("x"), 40))...), CloseTooBig},
		{"a 64-bit length, header only", []byte{0x81, 127, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}, CloseTooBig},
		{"a 64-bit length with its top bit", []byte{0x81, 127, 0x80, 0, 0, 0, 0, 0, 0, 1}, CloseProtocol},
		{"a 16-bit length that fits in 7 bits", []byte{0x81, 126, 0, 1, 'x'}, CloseProtocol},
		{"a 64-bit length that fits in 16 bits", []byte{0x81, 127, 0, 0, 0, 0, 0, 0, 0, 1, 'x'}, CloseProtocol},
		{"a ping over 125 bytes", serverFrame(true, opPing, bytes.Repeat([]byte("x"), 126)), CloseProtocol},
		{"a fragmented ping", serverFrame(false, opPing, nil), CloseProtocol},
		{"a masked frame", []byte{0x81, 0x81, 1, 2, 3, 4, 'x'}, CloseProtocol},
		{"a reserved bit", []byte{0xc1, 1, 'x'}, CloseProtocol},
		{"an unknown opcode", serverFrame(true, 0x3, nil), CloseProtocol},
		{"a continuation with nothing begun", serverFrame(true, opContinuation, []byte("x")), CloseProtocol},
		{"a message begun inside another", append(serverFrame(false, opText, []byte("x")), text...), CloseProtocol},
		{"a close of one byte", serverFrame(true, opClose, []byte{3}), CloseProtocol},
		{"a close code under 1000", closeFrame(999, ""), CloseProtocol},
		{"a close code no peer sends", closeFrame(1006, ""), CloseProtocol},
		{"an unassigned close code", closeFrame(1015, ""), CloseProtocol},
		{"a close code over 4999", closeFrame(5000, ""), CloseProtocol},
		{"a close reason that is not UTF-8", closeFrame(CloseGoingAway, "\xff"), CloseBadText},
		{"text that is not UTF-8", serverFrame(true, opText, []byte{0xff, 0xfe}), CloseBadText},
	} {
		c, f := reading(tc.stream, testOptions())
		got, err := c.ReadMessage()
		if got != nil {
			t.Fatalf("%s: handed up %q", tc.name, got)
		}
		closedWith(t, f, err, tc.code)
	}
}

func TestATruncatedStreamHandsNothingUp(t *testing.T) {
	msg := []byte(strings.Repeat("y", 60))
	stream := fragmented(msg, []int{1, 30}, []byte("ping"))
	for n := 0; n < len(stream); n++ {
		c, _ := reading(stream[:n], testOptions())
		got, err := c.ReadMessage()
		if got != nil || c.Ended() == nil || c.Ended().Code != CloseDropped {
			t.Fatalf("cut to %d bytes: %q, %v", n, got, err)
		}
	}
}

// readAll reads stream until the socket ends, checking every message handed up is whole: text, within the limit, and
// the next of want when want is given. It gives how many it read.
func readAll(t *testing.T, stream []byte, want [][]byte) int {
	c, _ := reading(stream, testOptions())
	for read := 0; read <= len(stream); read++ {
		got, err := c.ReadMessage()
		if err != nil {
			if c.Ended() == nil {
				t.Fatalf("an error %v with the socket open", err)
			}
			return read
		}
		if !utf8.Valid(got) {
			t.Fatalf("handed up %q, not UTF-8", got)
		}
		if len(got) > c.o.MaxMessage {
			t.Fatalf("handed up %d bytes over the limit", len(got))
		}
		if want != nil && !bytes.Equal(got, want[0]) {
			t.Fatalf("handed up %q, want %q", got, want[0])
		}
		if want != nil {
			want = want[1:]
		}
	}
	t.Fatalf("read past the stream's end")
	return 0
}

func FuzzTheReader(f *testing.F) {
	f.Add(serverFrame(true, opText, []byte(`{"id":1}`)))
	f.Add(fragmented([]byte("abcdef"), []int{2, 4}, []byte("p")))
	f.Add(append(serverFrame(true, opPing, nil), closeFrame(CloseReplaced, "again")...))
	f.Add([]byte{0x81, 127, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff})
	f.Fuzz(func(t *testing.T, stream []byte) {
		readAll(t, stream, nil)
	})
}

func FuzzFragmentsPingsAndCuts(f *testing.F) {
	f.Add([]byte(`{"id":1}`), []byte{3, 5}, true, uint16(0))
	f.Add([]byte("ü✓"), []byte{1, 2, 3}, false, uint16(9))
	f.Add([]byte("0"), []byte{}, true, uint16(75)) // cut after the whole message, inside the ping after it
	f.Fuzz(func(t *testing.T, msg []byte, cutBytes []byte, ping bool, truncate uint16) {
		if len(msg) > testOptions().MaxMessage {
			msg = msg[:testOptions().MaxMessage]
		}
		cuts := make([]int, 0, len(cutBytes))
		for _, b := range cutBytes {
			cut := int(b) % (len(msg) + 1)
			if len(cuts) > 0 && cut < cuts[len(cuts)-1] {
				cut = cuts[len(cuts)-1]
			}
			cuts = append(cuts, cut)
		}
		var p []byte
		if ping {
			p = []byte("p")
		}
		stream := fragmented(msg, cuts, p)
		// Where the message's last frame ends: the stream's end, but for a ping after a message of one frame.
		end := len(stream)
		if len(cuts) == 0 && ping {
			end -= len(serverFrame(true, opPing, p))
		}
		if truncate > 0 {
			stream = stream[:int(truncate)%len(stream)]
		}
		read := readAll(t, stream, [][]byte{msg})
		if whole := len(stream) >= end && utf8.Valid(msg); whole != (read == 1) {
			t.Fatalf("%d messages from %q cut at %v (truncated to %d bytes)", read, msg, cuts, truncate)
		}
	})
}

// upgrade is a server that answers the upgrade as serve does (upgrading).
func upgrade(t *testing.T, then func(conn net.Conn, r *bufio.Reader)) *httptest.Server {
	srv := httptest.NewServer(upgrading(t, then))
	t.Cleanup(srv.Close)
	return srv
}

// upgrading answers the upgrade as serve does: the token and subprotocol checked (401 with WWW-Authenticate: Bearer,
// 426), the subprotocol echoed. then has the socket and its reader.
func upgrading(t *testing.T, then func(conn net.Conn, r *bufio.Reader)) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer "+testToken {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unknown token", http.StatusUnauthorized)
			return
		}
		if req.Header.Get("Sec-WebSocket-Protocol") != subprotocol || req.Header.Get("Sec-WebSocket-Version") != "13" {
			http.Error(w, "update the driver", http.StatusUpgradeRequired)
			return
		}
		sum := sha1.Sum([]byte(req.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\nSec-WebSocket-Protocol: " + subprotocol + "\r\n\r\n")
		_ = rw.Flush()
		then(conn, rw.Reader)
	}
}

func wsURL(srv *httptest.Server) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/v2/computers/attach"
}

func TestTheUpgradeCarriesTheTokenAndSubprotocolAndThenMessages(t *testing.T) {
	srv := upgrade(t, func(conn net.Conn, r *bufio.Reader) {
		_, _ = conn.Write(serverFrame(true, opText, []byte(`{"method":"hello"}`)))
		got, err := readClient(r)
		if err != nil || got.op != opText || string(got.payload) != `{"result":{}}` {
			t.Errorf("the client's answer %+v, %v", got, err)
		}
		_, _ = conn.Write(closeFrame(CloseNormal, "done"))
		_, _ = readClient(r)
	})
	c, err := Dial(context.Background(), wsURL(srv), testOptions())
	if err != nil {
		t.Fatal(err)
	}
	msg, err := c.ReadMessage()
	if err != nil || string(msg) != `{"method":"hello"}` {
		t.Fatalf("%q, %v", msg, err)
	}
	if _, err := c.Write([]byte(`{"result":{}}` + "\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ReadMessage(); c.Ended() == nil || *c.Ended() != (Closed{Code: CloseNormal, Reason: "done", ByServer: true}) {
		t.Fatalf("ended %v", err)
	}
}

func TestARefusedUpgradeSaysItsStatus(t *testing.T) {
	srv := upgrade(t, func(net.Conn, *bufio.Reader) {})
	o := testOptions()
	o.Token = "art_" + strings.Repeat("B", 43)
	_, err := Dial(context.Background(), wsURL(srv), o)
	var refused *Refused
	if !errors.As(err, &refused) || refused.Status != 401 || refused.Words != "unknown token" {
		t.Fatalf("%v", err)
	}
	o = testOptions()
	o.Subprotocol = "agentrun.computer.0.1"
	if _, err = Dial(context.Background(), wsURL(srv), o); !errors.As(err, &refused) || refused.Status != 426 {
		t.Fatalf("%v", err)
	}
}

func TestAnUpgradeThatIsNotOneFails(t *testing.T) {
	for _, answer := range []string{
		"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\nSec-WebSocket-Protocol: " + subprotocol + "\r\n\r\n",
		"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\n\r\n",
		"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: " + subprotocol + "\r\n\r\n",
		"HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: " + subprotocol + "\r\n\r\n",
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			sum := sha1.Sum([]byte(req.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
			conn, rw, _ := w.(http.Hijacker).Hijack()
			defer conn.Close()
			_, _ = rw.WriteString(strings.Replace(answer, "{accept}", base64.StdEncoding.EncodeToString(sum[:]), 1))
			_ = rw.Flush()
		}))
		_, err := Dial(context.Background(), wsURL(srv), testOptions())
		srv.Close()
		if err == nil {
			t.Fatalf("the answer %q was taken for an upgrade", answer)
		}
	}
}

func TestAnUpgradeWithConnectionOnTwoLinesIsTaken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		sum := sha1.Sum([]byte(req.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		conn, rw, _ := w.(http.Hijacker).Hijack()
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: keep-alive\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\nSec-WebSocket-Protocol: " + subprotocol + "\r\n\r\n")
		_ = rw.Flush()
	}))
	defer srv.Close()
	conn, err := Dial(context.Background(), wsURL(srv), testOptions())
	if err != nil {
		t.Fatal(err)
	}
	conn.Close(CloseGoingAway, "")
}

func TestItPingsAndClosesWith4408WhenNothingIsHeard(t *testing.T) {
	pings := make(chan sent, 64)
	srv := upgrade(t, func(conn net.Conn, r *bufio.Reader) {
		for {
			frame, err := readClient(r)
			if err != nil {
				close(pings)
				return
			}
			pings <- frame
		}
	})
	o := testOptions()
	o.Heartbeat, o.Idle = 20*time.Millisecond, 150*time.Millisecond
	c, err := Dial(context.Background(), wsURL(srv), o)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.ReadMessage(); c.Ended() == nil || c.Ended().Code != CloseIdle || c.Ended().ByServer {
		t.Fatalf("ended %v", err)
	}
	var ops []byte
	for frame := range pings {
		ops = append(ops, frame.op)
	}
	if len(ops) < 3 || ops[0] != opPing || ops[len(ops)-1] != opClose {
		t.Fatalf("the server read the opcodes %v: pings, then the close", ops)
	}
}

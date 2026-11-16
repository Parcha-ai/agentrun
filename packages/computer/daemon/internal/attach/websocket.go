package attach

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// The close codes of spec/computer/attach.md's table, and RFC 6455's that this side sends or reads.
const (
	CloseGoingAway    = 1001
	CloseProtocol     = 1002
	CloseBinary       = 1003
	CloseNoStatus     = 1005
	CloseDropped      = 1006
	CloseBadText      = 1007
	CloseTooBig       = 1009
	CloseInternal     = 1011
	CloseMismatch     = 4400
	CloseUnauthorized = 4401
	CloseIdle         = 4408
	CloseVersion      = 4426
)

const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
	// handshakeFor bounds the TCP and TLS connect and the upgrade; writeFor each frame's write.
	handshakeFor = 30 * time.Second
	writeFor     = 10 * time.Second
)

// Closed is how a socket ended: the close frame the server sent (ByServer), the one this side sent, or a drop (1006).
type Closed struct {
	Code     int
	Reason   string
	ByServer bool
}

func (c *Closed) Error() string {
	return fmt.Sprintf("closed %d by %s: %s", c.Code, map[bool]string{true: "the server", false: "this side"}[c.ByServer], c.Reason)
}

// Refused is an upgrade the server answered with a status other than 101, and the start of its body.
type Refused struct {
	Status int
	Words  string
}

func (r *Refused) Error() string {
	return fmt.Sprintf("the server refused the upgrade: %d %s", r.Status, r.Words)
}

// Options are a dial's: the token and subprotocol of the upgrade, the largest message read, and the liveness numbers.
type Options struct {
	Token, Subprotocol string
	MaxMessage         int
	Heartbeat, Idle    time.Duration
}

// Conn is the client side of one WebSocket (RFC 6455) that carries text messages. As an io.Reader it gives each message
// the server sends followed by a newline, and as an io.Writer it sends each line written as one message: the stdio
// binding's lines, framed. One goroutine reads and one writes; pongs, pings and closes may come from any.
type Conn struct {
	nc      net.Conn
	br      *bufio.Reader
	o       Options
	wmu     sync.Mutex
	closed  *Closed
	done    chan struct{}
	pending []byte // what Read has yet to give of the last message, its newline included
	line    []byte // what Write holds of a line not yet ended
}

// Dial opens a WebSocket to rawURL (ws:// or wss://, TLS with the system's roots) with the token as a bearer and asks
// for the subprotocol; any status but 101 is a *Refused. It pings every Heartbeat until the socket ends.
func Dial(ctx context.Context, rawURL string, o Options) (*Conn, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") {
		return nil, errors.New("the attach URL is not a ws:// or wss:// URL")
	}
	var dialer interface {
		DialContext(context.Context, string, string) (net.Conn, error)
	} = &net.Dialer{Timeout: handshakeFor}
	port := "80"
	if u.Scheme == "wss" {
		dialer, port = &tls.Dialer{NetDialer: &net.Dialer{Timeout: handshakeFor}}, "443"
	}
	nc, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(u.Hostname(), cmp.Or(u.Port(), port)))
	if err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { _ = nc.Close() })
	c, err := handshake(nc, u, o)
	stop()
	if err != nil {
		_ = nc.Close()
		return nil, err
	}
	go c.heartbeat()
	return c, nil
}

func handshake(nc net.Conn, u *url.URL, o Options) (*Conn, error) {
	_ = nc.SetDeadline(time.Now().Add(handshakeFor))
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	key := base64.StdEncoding.EncodeToString(nonce)
	request := "GET " + u.RequestURI() + " HTTP/1.1\r\nHost: " + u.Host + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: " + o.Subprotocol + "\r\n" +
		"Authorization: Bearer " + o.Token + "\r\n\r\n"
	if _, err := io.WriteString(nc, request); err != nil {
		return nil, err
	}
	br := bufio.NewReader(nc)
	res, err := http.ReadResponse(br, nil)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusSwitchingProtocols {
		words, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return nil, &Refused{Status: res.StatusCode, Words: strings.TrimSpace(string(words))}
	}
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	accept, protocol := res.Header.Get("Sec-WebSocket-Accept"), res.Header.Get("Sec-WebSocket-Protocol")
	upgrades := slices.ContainsFunc(strings.Split(res.Header.Get("Connection"), ","), func(token string) bool { return strings.EqualFold(strings.TrimSpace(token), "upgrade") })
	if !upgrades || !strings.EqualFold(res.Header.Get("Upgrade"), "websocket") || accept != base64.StdEncoding.EncodeToString(sum[:]) || protocol != o.Subprotocol {
		return nil, fmt.Errorf("the server's 101 is not a WebSocket of the subprotocol %s (Sec-WebSocket-Protocol %q)", o.Subprotocol, protocol)
	}
	_ = nc.SetDeadline(time.Time{})
	return &Conn{nc: nc, br: br, o: o, done: make(chan struct{})}, nil
}

func (c *Conn) heartbeat() {
	tick := time.NewTicker(c.o.Heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-tick.C:
			_ = c.write(opPing, nil)
		}
	}
}

// ReadMessage gives the next whole text message, its fragments joined; ping is answered with pong on the way. Anything
// else ends the socket and gives its *Closed: the server's close (answered), a binary frame (1003), one over MaxMessage
// (1009), text that is not UTF-8 (1007), a frame RFC 6455 forbids (1002), Idle with nothing heard (4408), a drop (1006).
func (c *Conn) ReadMessage() ([]byte, error) {
	var msg []byte
	started := false
	for {
		_ = c.nc.SetReadDeadline(time.Now().Add(c.o.Idle))
		fin, op, payload, err := c.frame(c.o.MaxMessage - len(msg))
		var timeout net.Error
		switch {
		case errors.As(err, &timeout) && timeout.Timeout():
			return nil, c.end(&Closed{Code: CloseIdle, Reason: fmt.Sprintf("nothing heard for %s", c.o.Idle)}, true)
		case err != nil:
			return nil, c.end(&Closed{Code: CloseDropped, Reason: err.Error()}, false)
		}
		switch op {
		case opPing:
			_ = c.write(opPong, payload)
		case opPong:
		case opClose:
			return nil, c.closeFrom(payload)
		case opBinary:
			return nil, c.end(&Closed{Code: CloseBinary, Reason: "a binary frame: messages are text"}, true)
		case opText, opContinuation:
			if (op == opText) == started {
				return nil, c.end(&Closed{Code: CloseProtocol, Reason: "a continuation with no message begun, or a message begun inside another"}, true)
			}
			started = true
			msg = append(msg, payload...)
			if !fin {
				continue
			}
			if !utf8.Valid(msg) {
				return nil, c.end(&Closed{Code: CloseBadText, Reason: "a text message that is not UTF-8"}, true)
			}
			return msg, nil
		default:
			return nil, c.end(&Closed{Code: CloseProtocol, Reason: fmt.Sprintf("an unknown opcode %#x", op)}, true)
		}
	}
}

// frame reads one frame, whose payload may hold room more bytes of a message. A frame it refuses ends the socket and
// comes back as the *Closed.
func (c *Conn) frame(room int) (fin bool, op byte, payload []byte, err error) {
	var head [10]byte
	if _, err = io.ReadFull(c.br, head[:2]); err != nil {
		return
	}
	fin, op = head[0]&0x80 != 0, head[0]&0x0f
	n := uint64(head[1] & 0x7f)
	if head[0]&0x70 != 0 || head[1]&0x80 != 0 {
		return fin, op, nil, c.end(&Closed{Code: CloseProtocol, Reason: "a reserved bit set, or a masked frame from the server"}, true)
	}
	// An extended length is in its shortest form, and a 64-bit one has its top bit clear (RFC 6455 5.2).
	short := false
	switch n {
	case 126:
		if _, err = io.ReadFull(c.br, head[2:4]); err != nil {
			return
		}
		n = uint64(binary.BigEndian.Uint16(head[2:4]))
		short = n < 126
	case 127:
		if _, err = io.ReadFull(c.br, head[2:10]); err != nil {
			return
		}
		n = binary.BigEndian.Uint64(head[2:10])
		short = n <= 0xffff || n>>63 != 0
	}
	switch {
	case short:
		return fin, op, nil, c.end(&Closed{Code: CloseProtocol, Reason: "a frame length not in its shortest form"}, true)
	case op >= opClose && (!fin || n > 125):
		return fin, op, nil, c.end(&Closed{Code: CloseProtocol, Reason: "a control frame fragmented or over 125 bytes"}, true)
	case op < opClose && n > uint64(max(room, 0)):
		return fin, op, nil, c.end(&Closed{Code: CloseTooBig, Reason: fmt.Sprintf("a message over %d bytes", c.o.MaxMessage)}, true)
	}
	payload = make([]byte, n)
	_, err = io.ReadFull(c.br, payload)
	return
}

// closeFrom answers the server's close frame with the same code and ends the socket; a code a peer may not send (RFC
// 6455 7.4) is 1002, a reason that is not UTF-8 1007.
func (c *Conn) closeFrom(payload []byte) error {
	if len(payload) == 0 {
		return c.end(&Closed{Code: CloseNoStatus, ByServer: true}, true)
	}
	code := 0
	if len(payload) >= 2 {
		code = int(binary.BigEndian.Uint16(payload))
	}
	switch {
	case code < 1000 || code > 4999 || (code < 3000 && (code == 1004 || code == 1005 || code == 1006 || code > 1014)):
		return c.end(&Closed{Code: CloseProtocol, Reason: fmt.Sprintf("a close frame of %d bytes with the code %d", len(payload), code)}, true)
	case !utf8.Valid(payload[2:]):
		return c.end(&Closed{Code: CloseBadText, Reason: "a close reason that is not UTF-8"}, true)
	}
	return c.end(&Closed{Code: code, Reason: string(payload[2:]), ByServer: true}, true)
}

// Close ends the socket with code and reason, unless it has ended already, and gives how it ended.
func (c *Conn) Close(code int, reason string) *Closed {
	return c.end(&Closed{Code: code, Reason: reason}, true)
}

// Ended is how the socket ended, or nil while it is open.
func (c *Conn) Ended() *Closed {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return c.closed
}

// end ends the socket the first time, as closed says, sending a close frame when send is set (none for 1005 or 1006),
// and gives how it ended, the first time's.
func (c *Conn) end(closed *Closed, send bool) *Closed {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.closed != nil {
		return c.closed
	}
	c.closed = closed
	if send && closed.Code != CloseDropped {
		var payload []byte
		if closed.Code != CloseNoStatus {
			payload = append(binary.BigEndian.AppendUint16(nil, uint16(closed.Code)), closed.Reason[:min(len(closed.Reason), 123)]...)
		}
		_ = c.writeFrame(opClose, payload)
	}
	_ = c.nc.Close()
	close(c.done)
	return closed
}

// write sends one frame while the socket is open; a failed write drops it.
func (c *Conn) write(op byte, payload []byte) error {
	c.wmu.Lock()
	if c.closed != nil {
		c.wmu.Unlock()
		return c.closed
	}
	err := c.writeFrame(op, payload)
	c.wmu.Unlock()
	if err != nil {
		return c.end(&Closed{Code: CloseDropped, Reason: err.Error()}, false)
	}
	return nil
}

// writeFrame writes one final frame, masked with a fresh key as a client's must be. The caller holds wmu.
func (c *Conn) writeFrame(op byte, payload []byte) error {
	frame := []byte{0x80 | op}
	switch n := len(payload); {
	case n < 126:
		frame = append(frame, 0x80|byte(n))
	case n <= 0xffff:
		frame = binary.BigEndian.AppendUint16(append(frame, 0x80|126), uint16(n))
	default:
		frame = binary.BigEndian.AppendUint64(append(frame, 0x80|127), uint64(n))
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	frame = append(frame, mask[:]...)
	for i, b := range payload {
		frame = append(frame, b^mask[i%4])
	}
	_ = c.nc.SetWriteDeadline(time.Now().Add(writeFor))
	_, err := c.nc.Write(frame)
	return err
}

// Read gives the server's messages, each followed by a newline.
func (c *Conn) Read(p []byte) (int, error) {
	if len(c.pending) == 0 {
		msg, err := c.ReadMessage()
		if err != nil {
			return 0, err
		}
		c.pending = append(msg, '\n')
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

// Write sends each whole line in what is written as one text message, without its newline, and holds the rest.
func (c *Conn) Write(p []byte) (int, error) {
	c.line = append(c.line, p...)
	for {
		i := bytes.IndexByte(c.line, '\n')
		if i < 0 {
			return len(p), nil
		}
		if err := c.write(opText, c.line[:i]); err != nil {
			return 0, err
		}
		c.line = c.line[i+1:]
	}
}

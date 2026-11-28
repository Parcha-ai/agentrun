package egress

// The egress proxy of a hosted computer whose network is open or a host list: `computerd egress-serve`, run as root in
// the machine's own network before init starts, leaves this proxy on a Unix socket, as nobody. Init's relay (Relay)
// carries its programs' connections there from their own loopback, the one way out of a network namespace whose
// loopback alone is up. It is the Docker computer's proxy (src/docker/egress-proxy.ts), written again in Go so it runs
// on any image computerd runs on: HTTP CONNECT, plain HTTP forwarding and SOCKS5 CONNECT, told apart by the first byte,
// each to the public internet only (table.go):
//   - a host is resolved once, every address in the answer is checked, and the connection goes to exactly the address
//     that was checked; an IP literal is checked the same way;
//   - a refusal is an answer, sent before any socket opens: 403 (or SOCKS reply 2) with the class in its reason;
//   - plain HTTP goes to the request URI's host, the request line in origin form, its Host header that host;
//   - SOCKS5 BIND and UDP ASSOCIATE are refused by name, and so is an HTTP upgrade;
//   - connections open at once have a cap and connections in all a budget, each refused by name; the clients answered at
//     once have a cap too, one past it closed unread, and a request's head a size, past which it is refused 431;
//   - an upload that waits for 100 Continue is told to go on, and the upstream's interim replies are dropped, so the
//     client gets the final reply (Node's server does both for Docker's proxy);
//   - a log line holds the host, the port, the address and the class, never a path, a query, a header or a body;
//   - with a host list, a host off it and any port but 80 and 443 are refused before any lookup, so a name off the list
//     never leaves the machine; an IP literal is reached only inside a CIDR on the list, of its own family;
//   - with a public egress (the operator's <IPv4>:<port>, for a vendor whose machines reach only addresses the operator
//     allows), a tunnel to port 443 (HTTP CONNECT or SOCKS5 CONNECT) that every check above passed opens TCP to that
//     address instead of the checked one, and carries the client's bytes unchanged: the TLS a program speaks inside the
//     tunnel, its ClientHello's server name included, reaches the operator's gate as the program sent it, and the
//     certificate check stays the program's, end to end. The gate admits by that server name, so the proxy reads the
//     ClientHello first and carries the tunnel only when its server name is the host the checks passed; a tunnel to an
//     IP literal, one whose first bytes are no ClientHello, one that names no host or another host is closed with
//     nothing sent to the gate. Plain HTTP and every other port dial the checked address.
// The machine's own addresses (every interface's, read at each dial) are refused as this-host, so a program reaches
// neither the vendor's agent nor any service of the machine by the network.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ListedPorts are the ports a host list opens: plain HTTP and HTTPS.
var ListedPorts = []int{80, 443}

// Options are a proxy's policy and its seams.
type Options struct {
	// Allow is the host list; nil is every public host (open).
	Allow *Allow
	// MaxTunnels bounds the connections open at once; MaxConnections the connections in all, for the proxy's life.
	MaxTunnels     int
	MaxConnections int
	// MaxClients bounds the connections answered at once, a handler and its buffers each, tunnels and requests still
	// being read alike; one past it is closed unread. Default twice MaxTunnels: every tunnel and as many first requests.
	MaxClients int
	// Log takes one line per decision.
	Log func(string)
	// Lookup resolves a name to every address it has. Default the system resolver.
	Lookup func(ctx context.Context, host string) ([]netip.Addr, error)
	// Dial connects to an address the table passed. Default a TCP dial.
	Dial func(ctx context.Context, address netip.Addr, port int) (net.Conn, error)
	// Local is the machine's own addresses at this moment. Default every interface's.
	Local func() []netip.Addr
	// PublicEgress is where a tunnel to PublicEgressPort goes once its checks pass, in place of the checked address:
	// the operator's <IPv4>:<port>. The zero value is none, and every connection dials the address it was checked at.
	PublicEgress netip.AddrPort
}

// PublicEgressPort is the one port a public egress carries: HTTPS, whose ClientHello names the host for the gate.
const PublicEgressPort = 443

// MaxTunnels and MaxConnections are a computer's bounds: Docker's proxy's.
const (
	MaxTunnels     = 64
	MaxConnections = 20_000
)

// greetFor bounds the first request of a connection; resolveFor a lookup; dialFor a dial.
const (
	greetFor   = 30 * time.Second
	resolveFor = 10 * time.Second
	proxyDial  = 10 * time.Second
	// helloFor bounds the wait for a ClientHello on a tunnel to the public egress.
	helloFor = 10 * time.Second
)

// maxHead bounds the bytes read for a request's head (its line and headers), as net/http's MaxHeaderBytes and Node's
// header limit bound Docker's proxy's.
const maxHead = 64 << 10

type refusal struct {
	status int
	reason string
	socks  byte
	words  string
}

type proxy struct {
	Options
	mu   sync.Mutex
	open int
	used int
}

// Serve answers connections on l until it is closed, then returns nil.
func Serve(l net.Listener, options Options) error {
	p := &proxy{Options: options}
	if p.MaxTunnels <= 0 {
		p.MaxTunnels = MaxTunnels
	}
	if p.MaxConnections <= 0 {
		p.MaxConnections = MaxConnections
	}
	if p.Log == nil {
		p.Log = func(string) {}
	}
	if p.Lookup == nil {
		p.Lookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		}
	}
	if p.Dial == nil {
		p.Dial = func(ctx context.Context, address netip.Addr, port int) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", netip.AddrPortFrom(address, uint16(port)).String())
		}
	}
	if p.Local == nil {
		p.Local = interfaceAddresses
	}
	if p.MaxClients <= 0 {
		p.MaxClients = 2 * p.MaxTunnels
	}
	clients := make(chan struct{}, p.MaxClients)
	for {
		conn, err := l.Accept()
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		if err != nil {
			time.Sleep(acceptPause)
			continue
		}
		select {
		case clients <- struct{}{}:
			go func() {
				defer func() { <-clients }()
				p.handle(conn)
			}()
		default:
			p.logLine("client", "-", 0, "-", "client cap")
			_ = conn.Close()
		}
	}
}

// interfaceAddresses is every address of every interface of this machine's network.
func interfaceAddresses() []netip.Addr {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		if prefix, err := netip.ParsePrefix(a.String()); err == nil {
			out = append(out, prefix.Addr())
		}
	}
	return out
}

func (p *proxy) handle(conn net.Conn) {
	_ = conn.SetReadDeadline(time.Now().Add(greetFor))
	// A request's head is read through head, whose budget is lifted once the head is in (a SOCKS greeting has its own).
	head := &io.LimitedReader{R: conn, N: maxHead}
	reader := bufio.NewReader(head)
	first, err := reader.Peek(1)
	if err != nil {
		_ = conn.Close()
		return
	}
	if first[0] == 5 {
		head.N = math.MaxInt64
		p.socks(conn, reader)
		return
	}
	p.http(conn, reader, head)
}

// offList is the refusal of a target off the list, or nil: checked before any lookup.
func (p *proxy) offList(host string, port int) *refusal {
	if p.Allow == nil {
		return nil
	}
	shown := host
	if !plainHost.MatchString(host) {
		shown = "the host"
	}
	var words string
	if address, ok := literal(host); ok {
		switch {
		case len(p.Allow.CIDRs) == 0:
			words = shown + " is an address, not a name on this computer's network list"
		case !p.Allow.inCIDRs(address):
			words = shown + " is not on this computer's network list"
		}
	} else if !p.Allow.listed(host) {
		words = shown + " is not on this computer's network list"
	}
	if words == "" && port != ListedPorts[0] && port != ListedPorts[1] {
		words = fmt.Sprintf("%s:%d is not open on this computer's network list, which takes ports 80 and 443 only", shown, port)
	}
	if words == "" {
		return nil
	}
	return &refusal{status: 403, reason: "not-listed", socks: 2, words: words}
}

var plainHost = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
var nameHost = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// resolve looks host up once and checks every answer: the address to dial, or the refusal (with the address refused).
func (p *proxy) resolve(host string) (netip.Addr, *refusal) {
	var answers []netip.Addr
	if address, ok := literal(host); ok {
		answers = []netip.Addr{address}
	} else {
		if !nameHost.MatchString(host) || len(host) > 253 {
			return netip.Addr{}, &refusal{status: 400, reason: "invalid host", socks: 4}
		}
		ctx, cancel := context.WithTimeout(context.Background(), resolveFor)
		found, err := p.Lookup(ctx, host)
		cancel()
		if err != nil || len(found) == 0 {
			return netip.Addr{}, &refusal{status: 502, reason: "name not resolved", socks: 4}
		}
		for _, address := range found {
			answers = append(answers, address.Unmap())
		}
	}
	local := p.Local()
	for _, address := range answers {
		if class := Check(address, local); class != "" {
			return address, &refusal{status: 403, reason: class, socks: 2}
		}
	}
	return answers[0], nil
}

// admit takes a slot when a connection may open now (the cap and the budget); release gives it back.
func (p *proxy) admit() *refusal {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.open >= p.MaxTunnels {
		return &refusal{status: 429, reason: "tunnel cap", socks: 2}
	}
	if p.used >= p.MaxConnections {
		return &refusal{status: 429, reason: "connection budget", socks: 2}
	}
	p.open++
	p.used++
	return nil
}

func (p *proxy) release() {
	p.mu.Lock()
	p.open--
	p.mu.Unlock()
}

func (p *proxy) logLine(kind, host string, port int, address string, class string) {
	if len(host) > 255 {
		host = host[:255]
	}
	p.Log(fmt.Sprintf("egress %s host=%s port=%d ip=%s class=%s", kind, strconv.Quote(host), port, address, class))
}

// reach resolves, checks, admits and dials: the upstream connection (whose close gives its slot back), or the refusal.
func (p *proxy) reach(kind, host string, port int) (net.Conn, *refusal) {
	if unlisted := p.offList(host, port); unlisted != nil {
		p.logLine(kind, host, port, "-", unlisted.reason)
		return nil, unlisted
	}
	address, refused := p.resolve(host)
	if refused != nil {
		shown := "-"
		if address.IsValid() {
			shown = address.String()
		}
		p.logLine(kind, host, port, shown, refused.reason)
		return nil, refused
	}
	if full := p.admit(); full != nil {
		p.logLine(kind, host, port, address.String(), full.reason)
		return nil, full
	}
	p.logLine(kind, host, port, address.String(), "ok")
	ctx, cancel := context.WithTimeout(context.Background(), proxyDial)
	var upstream net.Conn
	var err error
	if p.throughPublicEgress(kind, port) {
		upstream, err = p.Dial(ctx, p.PublicEgress.Addr(), int(p.PublicEgress.Port()))
	} else {
		upstream, err = p.Dial(ctx, address, port)
	}
	cancel()
	if err != nil {
		p.release()
		return nil, &refusal{status: 502, reason: "dial failed", socks: 5}
	}
	return &released{Conn: upstream, release: p.release}, nil
}

// throughPublicEgress is whether a connection whose checks passed opens TCP to the public egress: a tunnel (an HTTP
// CONNECT or a SOCKS5 CONNECT, whose bytes the proxy carries unread) to PublicEgressPort, when there is one.
func (p *proxy) throughPublicEgress(kind string, port int) bool {
	return p.PublicEgress.IsValid() && kind != "http" && port == PublicEgressPort
}

// released gives its slot back once, at its first close.
type released struct {
	net.Conn
	once    sync.Once
	release func()
}

func (r *released) Close() error {
	r.once.Do(r.release)
	return r.Conn.Close()
}

func (r *released) CloseWrite() error {
	if half, ok := r.Conn.(interface{ CloseWrite() error }); ok {
		return half.CloseWrite()
	}
	return nil
}

// refuseHTTP answers a refusal as a whole response, and closes.
func refuseHTTP(conn net.Conn, r *refusal) {
	words := r.words
	if words == "" {
		words = "egress refused: " + r.reason
	}
	phrase := r.words
	if phrase == "" {
		phrase = "Egress refused: " + r.reason
	}
	body := words + "\n"
	_, _ = fmt.Fprintf(conn, "HTTP/1.1 %d %s\r\nx-egress-refused: %s\r\ncontent-type: text/plain\r\ncontent-length: %d\r\nconnection: close\r\n\r\n%s", r.status, phrase, r.reason, len(body), body)
	_ = conn.Close()
}

// hop is the fixed hop-by-hop headers; every name a Connection header lists is one too.
var hop = []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authorization", "Proxy-Authenticate", "Te", "Trailer", "Upgrade", "Transfer-Encoding"}

func dropHop(header http.Header) {
	for _, value := range header.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			if name = strings.TrimSpace(name); name != "" {
				header.Del(name)
			}
		}
	}
	for _, name := range hop {
		header.Del(name)
	}
}

var connectTarget = regexp.MustCompile(`^(?:\[([0-9A-Fa-f:.%a-zA-Z]+)\]|([^:\[\]/@\s]+)):(\d{1,5})$`)

func (p *proxy) http(conn net.Conn, reader *bufio.Reader, head *io.LimitedReader) {
	req, err := http.ReadRequest(reader)
	if err != nil && head.N <= 0 {
		refuseHTTP(conn, &refusal{status: 431, reason: "header too large", socks: 1})
		return
	}
	if err != nil {
		refuseHTTP(conn, &refusal{status: 400, reason: "not a request", socks: 1})
		return
	}
	head.N = math.MaxInt64
	_ = conn.SetReadDeadline(time.Time{})
	if req.Method == http.MethodConnect {
		found := connectTarget.FindStringSubmatch(req.RequestURI)
		port := 0
		if found != nil {
			port, _ = strconv.Atoi(found[3])
		}
		if found == nil || port < 1 || port > 65535 {
			refuseHTTP(conn, &refusal{status: 400, reason: "invalid target", socks: 1})
			return
		}
		host := found[1] + found[2]
		upstream, refused := p.reach("connect", host, port)
		if refused != nil {
			refuseHTTP(conn, refused)
			return
		}
		if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			_ = upstream.Close()
			_ = conn.Close()
			return
		}
		if p.throughPublicEgress("connect", port) {
			hello, ok := p.helloNaming(conn, reader, "connect", host, port)
			if ok {
				_, err = upstream.Write(hello)
			}
			if !ok || err != nil {
				_ = upstream.Close()
				_ = conn.Close()
				return
			}
		}
		splice(conn, reader, upstream)
		return
	}
	if req.Header.Get("Upgrade") != "" {
		refuseHTTP(conn, &refusal{status: 400, reason: "upgrade not supported", socks: 7})
		return
	}
	if req.URL == nil || !req.URL.IsAbs() || req.URL.Host == "" {
		refuseHTTP(conn, &refusal{status: 400, reason: "not an absolute URI", socks: 1})
		return
	}
	if req.URL.Scheme != "http" {
		refuseHTTP(conn, &refusal{status: 400, reason: "not an http URI", socks: 1})
		return
	}
	host := req.URL.Hostname()
	port := 80
	if req.URL.Port() != "" {
		port, err = strconv.Atoi(req.URL.Port())
		if err != nil || port < 1 || port > 65535 {
			refuseHTTP(conn, &refusal{status: 400, reason: "invalid target", socks: 1})
			return
		}
	}
	upstream, refused := p.reach("http", host, port)
	if refused != nil {
		refuseHTTP(conn, refused)
		return
	}
	defer upstream.Close()
	defer conn.Close()
	// An upload that waits for 100 Continue is told to go on here: the proxy carries its body on its own.
	waits := req.ProtoAtLeast(1, 1) && strings.EqualFold(req.Header.Get("Expect"), "100-continue")
	if waits {
		if _, err := io.WriteString(conn, "HTTP/1.1 100 Continue\r\n\r\n"); err != nil {
			return
		}
	}
	// The request goes over the connection dialled to the checked address, in origin form, its Host the URI's host.
	out := req.Clone(context.Background())
	out.RequestURI = ""
	out.Host = req.URL.Host
	dropHop(out.Header)
	if waits {
		out.Header.Del("Expect")
	}
	out.Header.Set("Connection", "close")
	out.Close = true
	if err := out.Write(upstream); err != nil {
		refuseHTTP(conn, &refusal{status: 502, reason: "upstream failed", socks: 1})
		return
	}
	// The upstream's interim replies (100 Continue, 103 Early Hints) are dropped: the client gets the final one.
	replies := bufio.NewReader(upstream)
	answer, err := http.ReadResponse(replies, out)
	for err == nil && answer.StatusCode >= 100 && answer.StatusCode < 200 && answer.StatusCode != http.StatusSwitchingProtocols {
		answer, err = http.ReadResponse(replies, out)
	}
	if err != nil {
		refuseHTTP(conn, &refusal{status: 502, reason: "upstream failed", socks: 1})
		return
	}
	defer answer.Body.Close()
	dropHop(answer.Header)
	answer.Close = true
	_ = answer.Write(conn)
}

// splice carries bytes both ways until each side has ended; what reader buffered past the request goes first.
func splice(client net.Conn, reader *bufio.Reader, upstream net.Conn) {
	defer client.Close()
	defer upstream.Close()
	if n := reader.Buffered(); n > 0 {
		buffered, _ := reader.Peek(n)
		if _, err := upstream.Write(buffered); err != nil {
			return
		}
	}
	done := make(chan error, 2)
	pass := func(to net.Conn, from io.Reader) {
		_, err := io.Copy(to, from)
		if half, ok := to.(interface{ CloseWrite() error }); ok && err == nil {
			_ = half.CloseWrite()
		}
		done <- err
	}
	go pass(upstream, client)
	go pass(client, upstream)
	if err := <-done; err != nil {
		_ = client.Close()
		_ = upstream.Close()
	}
	<-done
}

// socks answers one SOCKS5 greeting (offering "no authentication") and one CONNECT.
func (p *proxy) socks(conn net.Conn, reader *bufio.Reader) {
	limited := bufio.NewReader(io.LimitReader(reader, 1024))
	reply := func(code byte) { _, _ = conn.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0}) }
	head := make([]byte, 2)
	if _, err := io.ReadFull(limited, head); err != nil {
		_ = conn.Close()
		return
	}
	methods := make([]byte, head[1])
	if _, err := io.ReadFull(limited, methods); err != nil {
		_ = conn.Close()
		return
	}
	noAuth := false
	for _, method := range methods {
		noAuth = noAuth || method == 0
	}
	if !noAuth {
		_, _ = conn.Write([]byte{5, 0xff})
		_ = conn.Close()
		return
	}
	if _, err := conn.Write([]byte{5, 0}); err != nil {
		_ = conn.Close()
		return
	}
	request := make([]byte, 4)
	if _, err := io.ReadFull(limited, request); err != nil || request[0] != 5 {
		_ = conn.Close()
		return
	}
	var host string
	switch request[3] {
	case 1, 4:
		raw := make([]byte, map[byte]int{1: 4, 4: 16}[request[3]])
		if _, err := io.ReadFull(limited, raw); err != nil {
			_ = conn.Close()
			return
		}
		address, _ := netip.AddrFromSlice(raw)
		host = address.String()
	case 3:
		size, err := limited.ReadByte()
		if err != nil {
			_ = conn.Close()
			return
		}
		raw := make([]byte, size)
		if _, err := io.ReadFull(limited, raw); err != nil {
			_ = conn.Close()
			return
		}
		host = string(raw)
	default:
		reply(8)
		_ = conn.Close()
		return
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(limited, portBytes); err != nil {
		_ = conn.Close()
		return
	}
	port := int(portBytes[0])<<8 | int(portBytes[1])
	if request[1] != 1 {
		name := map[byte]string{2: "socks bind", 3: "socks udp associate"}[request[1]]
		if name == "" {
			name = "socks command"
		}
		p.logLine("socks", host, port, "-", name)
		reply(7)
		_ = conn.Close()
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	upstream, refused := p.reach("socks", host, port)
	if refused != nil {
		reply(refused.socks)
		_ = conn.Close()
		return
	}
	reply(0)
	// What the client sent past its request: the limited reader's buffer, then the rest of the connection's.
	rest := io.MultiReader(bytesOf(limited), reader)
	if p.throughPublicEgress("socks", port) {
		hello, ok := p.helloNaming(conn, rest, "socks", host, port)
		if !ok {
			_ = upstream.Close()
			_ = conn.Close()
			return
		}
		rest = io.MultiReader(bytes.NewReader(hello), rest)
	}
	spliceReader(conn, rest, upstream)
}

// helloNaming reads the client's TLS ClientHello from client, within helloFor, and answers the bytes it read, which the
// tunnel then carries first, when its server name is host (any case, a trailing dot aside); else it logs the tunnel
// refused, by its class, and answers false. The public egress admits by that name, so a tunnel that passed its checks
// for one host may not name another there. Nothing is written to the client.
func (p *proxy) helloNaming(conn net.Conn, client io.Reader, kind, host string, port int) ([]byte, bool) {
	_ = conn.SetReadDeadline(time.Now().Add(helloFor))
	defer conn.SetReadDeadline(time.Time{})
	read := &recording{from: client}
	name, err := serverNameOf(read)
	class := ""
	switch {
	case err != nil:
		class = "not a tls client hello"
	case name == "":
		class = "no server name"
	case !strings.EqualFold(strings.TrimSuffix(name, "."), strings.TrimSuffix(host, ".")):
		class = "server name not the host"
	}
	if class != "" {
		p.logLine(kind, host, port, "-", class)
		return nil, false
	}
	return read.bytes.Bytes(), true
}

// errHelloRead stops the handshake serverNameOf runs once the ClientHello is in.
var errHelloRead = errors.New("client hello read")

// serverNameOf reads a TLS ClientHello from client, as crypto/tls's server reads one (a hello over several records
// included), and answers its server name, "" where it names none. Nothing is written back: the handshake stops at the
// hello, and what the server would send goes nowhere.
func serverNameOf(client io.Reader) (string, error) {
	name, read := "", false
	err := tls.Server(helloConn{client}, &tls.Config{GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
		name, read = hello.ServerName, true
		return nil, errHelloRead
	}}).Handshake()
	if !read {
		return "", err
	}
	return name, nil
}

// recording is a reader that keeps every byte it reads.
type recording struct {
	from  io.Reader
	bytes bytes.Buffer
}

func (r *recording) Read(b []byte) (int, error) {
	n, err := r.from.Read(b)
	r.bytes.Write(b[:n])
	return n, err
}

// helloConn is a net.Conn that reads from a reader and drops what is written: serverNameOf's handshake's.
type helloConn struct{ io.Reader }

func (helloConn) Write(b []byte) (int, error)      { return len(b), nil }
func (helloConn) Close() error                     { return nil }
func (helloConn) LocalAddr() net.Addr              { return &net.TCPAddr{} }
func (helloConn) RemoteAddr() net.Addr             { return &net.TCPAddr{} }
func (helloConn) SetDeadline(time.Time) error      { return nil }
func (helloConn) SetReadDeadline(time.Time) error  { return nil }
func (helloConn) SetWriteDeadline(time.Time) error { return nil }

func bytesOf(reader *bufio.Reader) io.Reader {
	n := reader.Buffered()
	buffered, _ := reader.Peek(n)
	return strings.NewReader(string(buffered))
}

// spliceReader is splice with the client's bytes read from client.
func spliceReader(conn net.Conn, client io.Reader, upstream net.Conn) {
	defer conn.Close()
	defer upstream.Close()
	done := make(chan error, 2)
	go func() {
		_, err := io.Copy(upstream, client)
		if half, ok := upstream.(interface{ CloseWrite() error }); ok && err == nil {
			_ = half.CloseWrite()
		}
		done <- err
	}()
	go func() {
		_, err := io.Copy(conn, upstream)
		if half, ok := conn.(interface{ CloseWrite() error }); ok && err == nil {
			_ = half.CloseWrite()
		}
		done <- err
	}()
	if err := <-done; err != nil {
		_ = conn.Close()
		_ = upstream.Close()
	}
	<-done
}

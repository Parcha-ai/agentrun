// Package probe is what a provider asks of a computer from inside it, where the vendor's API reads nothing back: who
// the daemon's programs run as, the kernel (gVisor names itself in its release), and which outbound addresses answer.
// For a computer with network none, nothing answering within 10 s is the only read-back there is; it shows those
// addresses are blocked, not that every one is.
//
// A target is reached only when bytes come back from it. A TCP accept alone says nothing: some vendors' firewalls (E2B's,
// by its own docs: network/internet-access, "Behavior of blocked TCP connections") accept every outbound connection
// first and decide after, closing a denied one with nothing sent back. Such a target is accepted, reported apart and
// never counted as reached.
//
// A target is host:port, tried over TCP, or host:port/udp, sent a DNS query in one datagram. UDP has no accept: a UDP
// target is answered when a datagram comes back and refused when none does.
package probe

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/netstate"
)

// Bounds bounds each target: its connect, its answer (from the request's send), and the bytes read from it; and, for a
// diagnosis, the whole of it (zero: no bound but each target's).
type Bounds struct {
	Connect time.Duration
	Read    time.Duration
	Whole   time.Duration
	MaxRead int
}

// ConnectBounds are `computerd probe --connect`'s: 10 s to connect, 10 s to answer, 4 KiB read per target. It runs once
// per create, so its window is wide: a proxy that connects onward lazily, under load, still answers within it.
var ConnectBounds = Bounds{Connect: 10 * time.Second, Read: 10 * time.Second, MaxRead: 4096}

// UDP is the suffix that makes a target UDP: host:port/udp.
const UDP = "/udp"

// ParseTarget reads a target, host:port (TCP) or host:port/udp, into its address and network ("tcp" or "udp"). The
// port is a number.
func ParseTarget(target string) (address, network string, err error) {
	address, network = target, "tcp"
	if strings.HasSuffix(target, UDP) {
		address, network = strings.TrimSuffix(target, UDP), "udp"
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", "", err
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return "", "", fmt.Errorf("the port %q is not a number from 0 to 65535", port)
	}
	return address, network, nil
}

// Target is one target's result. Outcome is refused (no connection; for UDP, no reply), accepted (a TCP connection, and
// no byte back within the read bound) or answered (bytes came back); Detail says what, in words.
type Target struct {
	Target   string `json:"target"`
	Protocol string `json:"protocol"`
	Outcome  string `json:"outcome"`
	Bytes    int    `json:"bytes"`
	Detail   string `json:"detail"`
}

// Result is the probe's report, one JSON line. Reached holds the targets that answered, Accepted those that accepted
// a connection and sent nothing back, each in the order given; Results has every target, refused ones too. Interfaces
// names the live network interfaces of the probe's network namespace, those up or addressed: ["lo"] alone in a
// computer whose programs have a network of their own (init --own-network); null when they cannot be listed. Quiet
// names the rest, down with no address (a kernel's fallback tunnels, on some kernels), and Raised the quiet ones the
// probe could bring up as its user (it puts each back): none for a program with no CAP_NET_ADMIN.
type Result struct {
	UID        int      `json:"uid"`
	GID        int      `json:"gid"`
	Kernel     string   `json:"kernel"`
	Interfaces []string `json:"interfaces"`
	Quiet      []string `json:"quiet"`
	Raised     []string `json:"raised"`
	Reached    []string `json:"reached"`
	Accepted   []string `json:"accepted"`
	Results    []Target `json:"results"`
}

// ProtocolOf is the request a target gets: a UDP target dns (a DNS query, the request a UDP server most commonly
// answers), a TCP one by its port: tls (443), http (80), dns (53), else any (an HTTP HEAD, the most common protocol
// where the client speaks first; a server that speaks first answers whatever is sent). The port is chosen by its
// number, as Dial connects to it: 00053 is 53.
func ProtocolOf(target string) string {
	if strings.HasSuffix(target, UDP) {
		return "dns"
	}
	_, text, _ := net.SplitHostPort(target)
	port, err := strconv.ParseUint(text, 10, 16)
	if err != nil {
		return "any"
	}
	switch port {
	case 443:
		return "tls"
	case 80:
		return "http"
	case 53:
		return "dns"
	}
	return "any"
}

// Run tries each target (host:port or host:port/udp) at once, each by its port's protocol and within bounds, and reports them in the
// order given.
func Run(targets []string, bounds Bounds) Result {
	results := make([]Target, len(targets))
	var wg sync.WaitGroup
	for i, target := range targets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = Try(target, ProtocolOf(target), bounds)
		}()
	}
	wg.Wait()
	live, quiet, raised := interfaces()
	result := Result{UID: os.Getuid(), GID: os.Getgid(), Kernel: kernel(), Interfaces: live, Quiet: quiet, Raised: raised, Reached: []string{}, Accepted: []string{}, Results: results}
	for _, one := range results {
		switch one.Outcome {
		case "answered":
			result.Reached = append(result.Reached, one.Target)
		case "accepted":
			result.Accepted = append(result.Accepted, one.Target)
		}
	}
	return result
}

// Try connects to target (host:port over TCP, host:port/udp over UDP), sends protocol's request and reads what comes
// back, within bounds.
func Try(target, protocol string, bounds Bounds) Target {
	result := Target{Target: target, Protocol: protocol, Outcome: "refused"}
	address, network, err := ParseTarget(target)
	if err != nil {
		result.Detail = fmt.Sprintf("%q is not host:port or host:port/udp", target)
		return result
	}
	host, _, _ := net.SplitHostPort(address)
	ask, ok := askFor(protocol, host, network)
	if !ok {
		result.Detail = fmt.Sprintf("%q is no protocol over %s: tls, http, dns or any over TCP, dns over UDP", protocol, network)
		return result
	}
	outcome, n, detail := exchange(network, address, ask, bounds, time.Time{})
	result.Outcome, result.Bytes, result.Detail = outcome, n, detail
	return result
}

// asking is what a target is sent, and how what comes back is named: name says what read is, "" when it is not (yet)
// the protocol's answer, and how many bytes it needs to judge; expected is that answer in words.
type asking struct {
	request  []byte
	name     func(read []byte) (string, int)
	expected string
}

// askFor is protocol's request to host over network. A TLS ClientHello names host as the server only when it is a name:
// an IP literal is no server name (RFC 6066, section 3). Over UDP only dns is asked: one bare query in one datagram.
func askFor(protocol, host, network string) (asking, bool) {
	if network == "udp" {
		if protocol != "dns" {
			return asking{}, false
		}
		query, id := dnsQuery()
		return asking{request: query, name: dnsResponse(id), expected: "a DNS response with the query's id"}, true
	}
	switch protocol {
	case "tls":
		name := host
		if net.ParseIP(host) != nil {
			name = ""
		}
		return asking{request: clientHello(name), name: tlsRecord, expected: "a TLS record"}, true
	case "http", "any":
		return asking{request: httpHead(host), name: statusLine, expected: "an HTTP status line"}, true
	case "dns":
		query, id := dnsQuery()
		length := binary.BigEndian.AppendUint16(nil, uint16(len(query)))
		return asking{request: append(length, query...), name: framedDNS(id), expected: "a DNS response with the query's id"}, true
	}
	return asking{}, false
}

// exchange dials network ("tcp" or "udp") address within bounds.Connect, sends ask's request, and reads what comes
// back within bounds.Read, at most bounds.MaxRead bytes, never past end (zero: no end but these). It reports refused
// (no connection; for UDP, also no reply), accepted (a TCP connection, and no byte back) or answered (any byte back:
// the far side spoke, whatever it said), the bytes read, and what in words. --connect and --diagnose both judge by it.
func exchange(network, address string, ask asking, bounds Bounds, end time.Time) (string, int, string) {
	dialer := net.Dialer{Deadline: within(bounds.Connect, end)}
	conn, err := dialer.Dial(network, address)
	if err != nil {
		return "refused", 0, "no connection: " + reason(err)
	}
	defer conn.Close()
	// UDP has no accept: no reply is refused.
	silent, nothing := "refused", "no reply"
	if network == "tcp" {
		silent, nothing = "accepted", "no bytes"
	}
	readBy := within(bounds.Read, end)
	window := max(time.Until(readBy).Round(time.Millisecond), 0)
	_ = conn.SetDeadline(readBy)
	_, sent := conn.Write(ask.request)
	got, err := readAnswer(conn, network, bounds.MaxRead, ask.name)
	if len(got) > 0 {
		if what, _ := ask.name(got); what != "" {
			return "answered", len(got), what + " came back"
		}
		return "answered", len(got), fmt.Sprintf("%d bytes came back, not %s (first byte 0x%02x)", len(got), ask.expected, got[0])
	}
	switch {
	case sent != nil:
		return silent, 0, "the request was not sent: " + reason(sent)
	case errors.Is(err, io.EOF):
		return silent, 0, "the connection closed with no bytes"
	case isTimeout(err):
		return silent, 0, fmt.Sprintf("%s within %v", nothing, window)
	case err != nil:
		return silent, 0, nothing + ": " + reason(err)
	}
	return silent, 0, nothing
}

// within is now plus d, never past end (zero: no end).
func within(d time.Duration, end time.Time) time.Time {
	if at := time.Now().Add(d); end.IsZero() || at.Before(end) {
		return at
	}
	return end
}

// readAnswer reads until name can judge what came (it says how many bytes it needs), the peer ends, or the deadline
// passes; never more than most bytes. UDP reads one datagram.
func readAnswer(conn net.Conn, network string, most int, name func([]byte) (string, int)) ([]byte, error) {
	buffer := make([]byte, most)
	if network == "udp" {
		n, err := conn.Read(buffer)
		return buffer[:n], err
	}
	read := 0
	for read < most {
		n, err := conn.Read(buffer[read:])
		read += n
		if _, need := name(buffer[:read]); (read > 0 && read >= need) || err != nil {
			return buffer[:read], err
		}
	}
	return buffer[:read], nil
}

func isTimeout(err error) bool {
	var timeout interface{ Timeout() bool }
	return errors.As(err, &timeout) && timeout.Timeout()
}

// reason is an error in a few words: refused, reset, unreachable or a timeout, else the error itself.
func reason(err error) string {
	switch {
	case isTimeout(err):
		return "no answer within the bound"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "refused"
	case errors.Is(err, syscall.ECONNRESET):
		return "reset"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		return "unreachable"
	}
	return err.Error()
}

// clientHello is a TLS 1.2 ClientHello record a server of today answers: ECDHE with AES-GCM and ChaCha20, the usual
// groups and signature schemes, a random nonce, and the server name when there is one.
func clientHello(name string) []byte {
	random := make([]byte, 32)
	_, _ = rand.Read(random)
	u16 := func(v int) []byte { return binary.BigEndian.AppendUint16(nil, uint16(v)) }
	extension := func(kind int, data []byte) []byte { return append(append(u16(kind), u16(len(data))...), data...) }
	var extensions []byte
	if name != "" {
		entry := append([]byte{0}, append(u16(len(name)), name...)...)
		extensions = append(extensions, extension(0x0000, append(u16(len(entry)), entry...))...)
	}
	groups := []byte{0x00, 0x1d, 0x00, 0x17, 0x00, 0x18}
	schemes := []byte{0x04, 0x03, 0x05, 0x03, 0x06, 0x03, 0x08, 0x04, 0x08, 0x05, 0x08, 0x06, 0x04, 0x01, 0x05, 0x01, 0x06, 0x01}
	extensions = append(extensions, extension(0x000a, append(u16(len(groups)), groups...))...)
	extensions = append(extensions, extension(0x000b, []byte{0x01, 0x00})...)
	extensions = append(extensions, extension(0x000d, append(u16(len(schemes)), schemes...))...)
	extensions = append(extensions, extension(0xff01, []byte{0x00})...)
	suites := []byte{0xc0, 0x2b, 0xc0, 0x2f, 0xc0, 0x2c, 0xc0, 0x30, 0xcc, 0xa9, 0xcc, 0xa8, 0xc0, 0x13, 0xc0, 0x14, 0x00, 0x9c, 0x00, 0x9d, 0x00, 0x2f, 0x00, 0x35}
	body := []byte{0x03, 0x03}
	body = append(body, random...)
	body = append(body, 0x00) // no session id
	body = append(body, u16(len(suites))...)
	body = append(body, suites...)
	body = append(body, 0x01, 0x00) // compression: none
	body = append(body, u16(len(extensions))...)
	body = append(body, extensions...)
	handshake := append([]byte{0x01, byte(len(body) >> 16), byte(len(body) >> 8), byte(len(body))}, body...)
	return append(append([]byte{0x16, 0x03, 0x01}, u16(len(handshake))...), handshake...)
}

// tlsRecord names a TLS answer: a handshake record (0x16, version 3.x) whose first message is a ServerHello (0x02), or
// an alert record (0x15, version 3.x), which a server sends a ClientHello it will not serve; 6 bytes judge it.
func tlsRecord(read []byte) (string, int) {
	switch {
	case len(read) >= 6 && read[0] == 0x16 && read[1] == 0x03 && read[5] == 0x02:
		return "a TLS ServerHello", 6
	case len(read) >= 5 && read[0] == 0x15 && read[1] == 0x03:
		return "a TLS alert", 6
	}
	return "", 6
}

// httpHead is an HTTP/1.0 HEAD of / with host as its Host.
func httpHead(host string) []byte {
	if host == "" {
		return []byte("HEAD / HTTP/1.0\r\n\r\n")
	}
	if net.ParseIP(host) != nil && net.ParseIP(host).To4() == nil {
		host = "[" + host + "]"
	}
	return []byte("HEAD / HTTP/1.0\r\nHost: " + host + "\r\n\r\n")
}

// statusLine names an answer that starts as an HTTP/1.x status line does; 7 bytes judge it.
func statusLine(read []byte) (string, int) {
	if bytes.HasPrefix(read, []byte("HTTP/1.")) {
		return "an HTTP status line", 7
	}
	return "", 7
}

// dnsQuery is a recursive query for example.com's A records, with a random id.
func dnsQuery() ([]byte, uint16) {
	var id [2]byte
	_, _ = rand.Read(id[:])
	query := append(id[:], 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
	query = append(query, "\x07example\x03com\x00\x00\x01\x00\x01"...)
	return query, binary.BigEndian.Uint16(id[:])
}

// dnsResponse names a DNS message with the query's id and the response bit set; 12 bytes judge it.
func dnsResponse(id uint16) func([]byte) (string, int) {
	return func(read []byte) (string, int) {
		if len(read) >= 12 && binary.BigEndian.Uint16(read) == id && read[2]&0x80 != 0 {
			return "a DNS response with the query's id", 12
		}
		return "", 12
	}
}

// framedDNS is dnsResponse over TCP, behind its 2-byte length.
func framedDNS(id uint16) func([]byte) (string, int) {
	response := dnsResponse(id)
	return func(read []byte) (string, int) {
		if len(read) < 2 {
			return "", 14
		}
		what, need := response(read[2:])
		return what, need + 2
	}
}

// interfaces names the probe's network namespace's live interfaces (up or addressed), its quiet ones (down, no
// address) and the quiet ones it could raise, each in the kernel's order; nil, and empty lists, when they cannot be read.
func interfaces() (live, quiet, raised []string) {
	ifaces, err := netstate.Read()
	if err != nil {
		return nil, []string{}, []string{}
	}
	raised = []string{}
	quiet = netstate.Quiet(ifaces)
	for _, name := range quiet {
		if up, _ := netstate.Raise(name); up {
			raised = append(raised, name)
		}
	}
	return netstate.Live(ifaces), quiet, raised
}

// kernel is uname's release, or "" when it cannot be read.
func kernel() string {
	var name syscall.Utsname
	if err := syscall.Uname(&name); err != nil {
		return ""
	}
	release := make([]byte, 0, len(name.Release))
	for _, c := range name.Release {
		if c == 0 {
			break
		}
		release = append(release, byte(c))
	}
	return string(release)
}

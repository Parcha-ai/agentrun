package probe_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/probe"
)

// quick bounds the tests' targets: an accept held open with no bytes is judged within a second.
var quick = probe.Bounds{Connect: 2 * time.Second, Read: time.Second, MaxRead: 4096}

// serve listens on address (port 0) and runs answer on each connection, closing it after; "" when address cannot be
// listened on.
func serve(t *testing.T, address string, answer func(net.Conn)) string {
	t.Helper()
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return ""
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				answer(conn)
			}()
		}
	}()
	return listener.Addr().String()
}

// listening serves answer on this machine's IPv4 loopback.
func listening(t *testing.T, answer func(net.Conn)) string {
	t.Helper()
	address := serve(t, "127.0.0.1:0", answer)
	if address == "" {
		t.Fatal("cannot listen on the IPv4 loopback")
	}
	return address
}

// acceptsSilently accepts and closes at once, having read nothing and sent nothing: what a firewall that accepts
// first and passes nothing looks like from inside.
func acceptsSilently(net.Conn) {}

// holding accepts and keeps the connection open, sending nothing, until the probe gives up.
func holding(conn net.Conn) { _, _ = io.Copy(io.Discard, conn) }

// banner speaks first, as SSH and SMTP do, whatever the probe sends.
func banner(conn net.Conn) { _, _ = conn.Write([]byte("SSH-2.0-test\r\n")) }

// afterRequest reads the request (up to 4 KiB, 2 s) and then writes reply.
func afterRequest(reply []byte, got chan<- []byte) func(net.Conn) {
	return func(conn net.Conn) {
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		buffer := make([]byte, 4096)
		n, _ := conn.Read(buffer)
		if got != nil {
			got <- buffer[:n]
		}
		_, _ = conn.Write(reply)
	}
}

// refusing is an address nothing listens on any more.
func refusing(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	return address
}

// helloRecord is the head of a TLS handshake record whose first message is a ServerHello, as a server sends it.
var helloRecord = []byte{0x16, 0x03, 0x03, 0x00, 0x2a, 0x02, 0x00, 0x00, 0x26, 0x03, 0x03}

// alert is a TLS fatal alert record (handshake_failure), what a server sends a ClientHello it will not serve.
var alert = []byte{0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28}

func TestProtocolIsChosenByThePort(t *testing.T) {
	for address, want := range map[string]string{
		"1.1.1.1:443":                 "tls",
		"[2606:4700:4700::1111]:443":  "tls",
		"example.com:80":              "http",
		"8.8.8.8:53":                  "dns",
		"9.9.9.9:22":                  "any",
		"[2606:4700:4700::1111]:8080": "any",
		"151.101.1.57:65535":          "any",
	} {
		if got := probe.ProtocolOf(address); got != want {
			t.Errorf("ProtocolOf(%q) = %q; want %q", address, got, want)
		}
	}
}

func TestASilentAcceptIsAcceptedAndNeverReached(t *testing.T) {
	address := listening(t, acceptsSilently)
	result := probe.Run([]string{address}, quick)
	if len(result.Reached) != 0 {
		t.Fatalf("reached %q: an accept that sent nothing back is no answer", result.Reached)
	}
	if !reflect.DeepEqual(result.Accepted, []string{address}) {
		t.Fatalf("accepted %q; want [%s], recorded, never hidden", result.Accepted, address)
	}
	if len(result.Results) != 1 || result.Results[0].Outcome != "accepted" || result.Results[0].Bytes != 0 {
		t.Fatalf("results %+v; want one accepted with 0 bytes", result.Results)
	}
}

func TestAnAcceptHeldOpenWithNoBytesIsAcceptedWithinTheReadBound(t *testing.T) {
	address := listening(t, holding)
	start := time.Now()
	result := probe.Run([]string{address}, quick)
	if took := time.Since(start); took > quick.Read+time.Second {
		t.Fatalf("the probe took %v; the read bound is %v", took, quick.Read)
	}
	if len(result.Reached) != 0 || !reflect.DeepEqual(result.Accepted, []string{address}) {
		t.Fatalf("reached %q, accepted %q; want nothing reached and [%s] accepted", result.Reached, result.Accepted, address)
	}
	if !strings.Contains(result.Results[0].Detail, "no bytes") {
		t.Fatalf("detail %q; want it to say no bytes came back", result.Results[0].Detail)
	}
}

func TestAClosedPortIsRefused(t *testing.T) {
	address := refusing(t)
	result := probe.Run([]string{address}, quick)
	if len(result.Reached) != 0 || len(result.Accepted) != 0 {
		t.Fatalf("reached %q, accepted %q; want neither where nothing listens", result.Reached, result.Accepted)
	}
	if len(result.Results) != 1 || result.Results[0].Outcome != "refused" {
		t.Fatalf("results %+v; want one refused", result.Results)
	}
}

func TestAServerHelloIsAnAnswerAndTheClientHelloCarriesNoNameForAnAddress(t *testing.T) {
	got := make(chan []byte, 1)
	address := listening(t, afterRequest(helloRecord, got))
	result := probe.Try(address, "tls", quick)
	if result.Outcome != "answered" || !strings.Contains(result.Detail, "ServerHello") {
		t.Fatalf("%+v; want answered, a ServerHello", result)
	}
	hello := <-got
	if len(hello) < 6 || hello[0] != 0x16 || hello[1] != 0x03 || hello[5] != 0x01 {
		t.Fatalf("the probe sent % x; want a TLS handshake record holding a ClientHello", hello[:min(len(hello), 16)])
	}
	// An IP literal is no server name (RFC 6066, section 3): no server_name extension, type 0x0000.
	if extensionsOf(t, hello)[0x0000] {
		t.Fatal("the ClientHello to an address names a server; an address is no SNI")
	}
}

func TestATLSAlertIsAnAnswer(t *testing.T) {
	address := listening(t, afterRequest(alert, nil))
	result := probe.Try(address, "tls", quick)
	if result.Outcome != "answered" || !strings.Contains(result.Detail, "alert") {
		t.Fatalf("%+v; want answered, a TLS alert: bytes came back from the far side", result)
	}
}

func TestAnHTTPStatusLineIsAnAnswer(t *testing.T) {
	got := make(chan []byte, 1)
	address := listening(t, afterRequest([]byte("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"), got))
	result := probe.Try(address, "http", quick)
	if result.Outcome != "answered" || !strings.Contains(result.Detail, "HTTP status line") {
		t.Fatalf("%+v; want answered, an HTTP status line", result)
	}
	if request := string(<-got); !strings.HasPrefix(request, "HEAD / HTTP/1.0\r\n") {
		t.Fatalf("the probe sent %q; want an HTTP HEAD", request)
	}
}

func TestADNSResponseOverTCPWithTheQuerysIdIsAnAnswer(t *testing.T) {
	address := listening(t, func(conn net.Conn) {
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		var length [2]byte
		if _, err := io.ReadFull(conn, length[:]); err != nil {
			return
		}
		query := make([]byte, binary.BigEndian.Uint16(length[:]))
		if _, err := io.ReadFull(conn, query); err != nil || len(query) < 12 {
			return
		}
		response := append([]byte{query[0], query[1], 0x81, 0x80}, query[4:]...)
		_, _ = conn.Write(append(binary.BigEndian.AppendUint16(nil, uint16(len(response))), response...))
	})
	result := probe.Try(address, "dns", quick)
	if result.Outcome != "answered" || !strings.Contains(result.Detail, "DNS response") {
		t.Fatalf("%+v; want answered, a DNS response with the query's id", result)
	}
}

func TestBytesThatAreNotTheProtocolsAnswerStillCountAsAnAnswer(t *testing.T) {
	address := listening(t, afterRequest([]byte("garbage"), nil))
	result := probe.Try(address, "tls", quick)
	if result.Outcome != "answered" || result.Bytes == 0 || !strings.Contains(result.Detail, "not") {
		t.Fatalf("%+v; want answered: something on the far side spoke, in no TLS", result)
	}
}

func TestAnyByteBackOnAPortOfNoKnownProtocolIsAnAnswer(t *testing.T) {
	speaksFirst := listening(t, banner)
	answersHTTP := listening(t, afterRequest([]byte("HTTP/1.0 200 OK\r\n\r\n"), nil))
	quiet := listening(t, acceptsSilently)
	result := probe.Run([]string{speaksFirst, quiet, answersHTTP}, quick)
	if !reflect.DeepEqual(result.Reached, []string{speaksFirst, answersHTTP}) || !reflect.DeepEqual(result.Accepted, []string{quiet}) {
		t.Fatalf("reached %q, accepted %q; want reached [%s %s], accepted [%s]", result.Reached, result.Accepted, speaksFirst, answersHTTP, quiet)
	}
	if result.Results[0].Protocol != "any" {
		t.Fatalf("protocol %q for a port of no known protocol; want any", result.Results[0].Protocol)
	}
}

func TestTheAnswerReadIsBounded(t *testing.T) {
	address := listening(t, func(conn net.Conn) {
		chunk := bytes.Repeat([]byte{'x'}, 1024)
		for i := 0; i < 64; i++ {
			if _, err := conn.Write(chunk); err != nil {
				return
			}
		}
	})
	result := probe.Try(address, "any", quick)
	if result.Outcome != "answered" || result.Bytes == 0 || result.Bytes > quick.MaxRead {
		t.Fatalf("%+v; want answered with at most %d bytes read", result, quick.MaxRead)
	}
}

func TestAnIPv6TargetIsTriedAsAnyOther(t *testing.T) {
	quiet := serve(t, "[::1]:0", acceptsSilently)
	if quiet == "" {
		t.Skip("this host has no IPv6 loopback to listen on, so the IPv6 case is not run here")
	}
	speaks := serve(t, "[::1]:0", banner)
	result := probe.Run([]string{quiet, speaks}, quick)
	if !reflect.DeepEqual(result.Reached, []string{speaks}) || !reflect.DeepEqual(result.Accepted, []string{quiet}) {
		t.Fatalf("reached %q, accepted %q; want reached [%s], accepted [%s]", result.Reached, result.Accepted, speaks, quiet)
	}
}

func TestRunReportsEachTargetInTheOrderAsked(t *testing.T) {
	closed, quiet, speaks := refusing(t), listening(t, acceptsSilently), listening(t, banner)
	asked := []string{speaks, closed, quiet}
	result := probe.Run(asked, quick)
	outcomes := []string{}
	for i, one := range result.Results {
		if one.Target != asked[i] {
			t.Fatalf("result %d is %s; want the order asked", i, one.Target)
		}
		outcomes = append(outcomes, one.Outcome)
	}
	if !reflect.DeepEqual(outcomes, []string{"answered", "refused", "accepted"}) {
		t.Fatalf("outcomes %q; want answered, refused, accepted", outcomes)
	}
}

func TestRunReportsItsOwnUserAndTheKernel(t *testing.T) {
	result := probe.Run(nil, quick)
	if result.UID != os.Getuid() || result.GID != os.Getgid() {
		t.Fatalf("uid:gid %d:%d; want this process's %d:%d", result.UID, result.GID, os.Getuid(), os.Getgid())
	}
	if strings.TrimSpace(result.Kernel) == "" {
		t.Fatal("no kernel release in the report")
	}
}

func TestRunWithNothingReachedIsEmptyListsInJSON(t *testing.T) {
	encoded, err := json.Marshal(probe.Run([]string{refusing(t)}, quick))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"reached":[]`, `"accepted":[]`, `"outcome":"refused"`} {
		if !strings.Contains(string(encoded), want) {
			t.Fatalf("%s: want %s; an empty list is [], never null", encoded, want)
		}
	}
}

func TestTheConnectBoundsAreThreeSecondsAndFourKiB(t *testing.T) {
	if probe.ConnectBounds != (probe.Bounds{Connect: 3 * time.Second, Read: 3 * time.Second, MaxRead: 4096}) {
		t.Fatalf("ConnectBounds %+v; want 3 s to connect, 3 s to answer, 4 KiB read", probe.ConnectBounds)
	}
}

// extensionsOf reads a ClientHello record's extension types.
func extensionsOf(t *testing.T, record []byte) map[uint16]bool {
	t.Helper()
	at := 5 + 4 + 2 + 32 // record header, handshake header, version, random
	need := func(n int) {
		if len(record) < n {
			t.Fatalf("not a whole ClientHello: % x", record)
		}
	}
	need(at + 1)
	at += 1 + int(record[at]) // session id
	need(at + 2)
	at += 2 + int(binary.BigEndian.Uint16(record[at:])) // cipher suites
	need(at + 1)
	at += 1 + int(record[at]) // compression methods
	need(at + 2)
	end := at + 2 + int(binary.BigEndian.Uint16(record[at:]))
	at += 2
	found := map[uint16]bool{}
	for at+4 <= end && at+4 <= len(record) {
		found[binary.BigEndian.Uint16(record[at:])] = true
		at += 4 + int(binary.BigEndian.Uint16(record[at+2:]))
	}
	return found
}

package probe_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"io"
	"math/big"
	"net"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/probe"
)

// short bounds a diagnosis against this machine's own listeners.
var short = probe.Bounds{Connect: time.Second, Read: time.Second, Whole: 5 * time.Second, MaxRead: 4096}

// tcpServer accepts every connection and hands it to serve, then closes it; it ends with the test.
func tcpServer(t *testing.T, serve func(net.Conn)) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
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
				serve(conn)
			}()
		}
	}()
	return listener.Addr().String()
}

// silent accepts and says nothing until the test ends: what a firewall that accepts first looks like.
func silent(t *testing.T) string {
	t.Helper()
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	return tcpServer(t, func(conn net.Conn) {
		_, _ = io.Copy(io.Discard, conn)
		<-done
	})
}

// closedTCP is a TCP port nothing listens on any more.
func closedTCP(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	return address
}

// clientHello reads one TLS record from conn and reports its handshake type and the SNI it names, if any.
func clientHello(conn net.Conn) (record []byte, sni string, ok bool) {
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	header := make([]byte, 5)
	if _, err := io.ReadFull(conn, header); err != nil || header[0] != 0x16 || header[1] != 0x03 {
		return nil, "", false
	}
	body := make([]byte, binary.BigEndian.Uint16(header[3:5]))
	if _, err := io.ReadFull(conn, body); err != nil || len(body) < 4 || body[0] != 0x01 {
		return nil, "", false
	}
	return append(header, body...), sniOf(body), true
}

// sniOf finds the server_name extension of a ClientHello handshake message, "" when it has none.
func sniOf(hello []byte) string {
	at := 4 + 2 + 32 // handshake header, client_version, random
	if len(hello) < at+1 {
		return ""
	}
	at += 1 + int(hello[at]) // session id
	if len(hello) < at+2 {
		return ""
	}
	at += 2 + int(binary.BigEndian.Uint16(hello[at:])) // cipher suites
	if len(hello) < at+1 {
		return ""
	}
	at += 1 + int(hello[at]) // compression methods
	if len(hello) < at+2 {
		return ""
	}
	end := at + 2 + int(binary.BigEndian.Uint16(hello[at:]))
	for at += 2; at+4 <= end && end <= len(hello); {
		kind, size := binary.BigEndian.Uint16(hello[at:]), int(binary.BigEndian.Uint16(hello[at+2:]))
		data := hello[at+4 : at+4+size]
		if kind == 0 && len(data) >= 5 && data[2] == 0 {
			return string(data[5 : 5+int(binary.BigEndian.Uint16(data[3:]))])
		}
		at += 4 + size
	}
	return ""
}

// serverHello is the start of a TLS record carrying a ServerHello, as a TLS server answers a ClientHello.
var serverHello = []byte{0x16, 0x03, 0x03, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00}

// udpServer answers each datagram with what answer makes of it (nothing when it gives nil); it ends with the test.
func udpServer(t *testing.T, answer func([]byte) []byte) string {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	go func() {
		buffer := make([]byte, 2048)
		for {
			n, from, err := conn.ReadFrom(buffer)
			if err != nil {
				return
			}
			if reply := answer(append([]byte(nil), buffer[:n]...)); reply != nil {
				_, _ = conn.WriteTo(reply, from)
			}
		}
	}()
	return conn.LocalAddr().String()
}

// closedUDP is a UDP port nothing listens on any more.
func closedUDP(t *testing.T) string {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := conn.LocalAddr().String()
	_ = conn.Close()
	return address
}

// dnsAnswer answers a DNS query as a resolver would: its id, the response bit, its question, no records.
func dnsAnswer(query []byte) []byte {
	if len(query) < 12 {
		return nil
	}
	reply := append([]byte(nil), query...)
	reply[2] |= 0x80
	return reply
}

func only(t *testing.T, diagnosis probe.Diagnosis) probe.Outcome {
	t.Helper()
	if len(diagnosis.Results) != 1 {
		t.Fatalf("results %+v; want one", diagnosis.Results)
	}
	return diagnosis.Results[0]
}

func TestDiagnoseTLSIsAnsweredByAServerHelloOrAnAlert(t *testing.T) {
	sawSNI := make(chan string, 1)
	answering := tcpServer(t, func(conn net.Conn) {
		if _, sni, ok := clientHello(conn); ok {
			sawSNI <- sni
			_, _ = conn.Write(serverHello)
		}
	})
	got := only(t, probe.Diagnose([]probe.Check{{Probe: "tls", Address: answering, Name: "one.one.one.one"}}, short))
	if got.Outcome != "answered" || got.Proto != "tcp" || got.Probe != "tls" || got.Name != "one.one.one.one" || got.Bytes < 6 {
		t.Fatalf("a ServerHello came back, and the probe reported %+v; want answered over tcp, with its name and the bytes read", got)
	}
	if sni := <-sawSNI; sni != "one.one.one.one" {
		t.Fatalf("the ClientHello named %q; want the SNI one.one.one.one", sni)
	}

	alert := tcpServer(t, func(conn net.Conn) {
		if _, _, ok := clientHello(conn); ok {
			_, _ = conn.Write([]byte{0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28})
		}
	})
	got = only(t, probe.Diagnose([]probe.Check{{Probe: "tls", Address: alert, Name: "one.one.one.one"}}, short))
	if got.Outcome != "answered" || got.Bytes != 7 || !strings.Contains(got.Detail, "a TLS alert") {
		t.Fatalf("an alert came back, and the probe reported %+v; want answered, 7 bytes, a TLS alert: the far side spoke", got)
	}
}

// A real TLS server (Go's own, TLS 1.2 and 1.3) answers the probe's ClientHello with a ServerHello: the hello is one a
// server of today takes, not only one this file's parser reads.
func TestDiagnoseTLSIsAnsweredByARealTLSServer(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "one.one.one.one"}, DNSNames: []string{"one.one.one.one"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}})
	if err != nil {
		t.Fatal(err)
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
				_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
				_ = conn.(*tls.Conn).Handshake()
			}()
		}
	}()
	for _, name := range []string{"one.one.one.one", ""} {
		got := only(t, probe.Diagnose([]probe.Check{{Probe: "tls", Address: listener.Addr().String(), Name: name}}, short))
		if got.Outcome != "answered" {
			t.Fatalf("with the name %q, Go's TLS server gave %+v; want answered", name, got)
		}
	}
}

func TestDiagnoseWithNoNameSendsNoSNI(t *testing.T) {
	sawSNI := make(chan string, 1)
	answering := tcpServer(t, func(conn net.Conn) {
		if _, sni, ok := clientHello(conn); ok {
			sawSNI <- sni
			_, _ = conn.Write(serverHello)
		}
	})
	got := only(t, probe.Diagnose([]probe.Check{{Probe: "tls", Address: answering}}, short))
	if got.Outcome != "answered" {
		t.Fatalf("reported %+v; want answered", got)
	}
	if sni := <-sawSNI; sni != "" {
		t.Fatalf("the ClientHello named %q; want no SNI when the check names none", sni)
	}
}

func TestDiagnoseHTTPIsAnsweredByAStatusLineOrAnyOtherBytes(t *testing.T) {
	request := make(chan string, 1)
	answering := tcpServer(t, func(conn net.Conn) {
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		buffer := make([]byte, 512)
		n, _ := conn.Read(buffer)
		request <- string(buffer[:n])
		_, _ = conn.Write([]byte("HTTP/1.1 301 Moved Permanently\r\nLocation: https://example.com/\r\n\r\n"))
	})
	got := only(t, probe.Diagnose([]probe.Check{{Probe: "http", Address: answering, Name: "example.com"}}, short))
	if got.Outcome != "answered" || got.Proto != "tcp" {
		t.Fatalf("a status line came back, and the probe reported %+v; want answered", got)
	}
	if sent := <-request; sent != "HEAD / HTTP/1.0\r\nHost: example.com\r\n\r\n" {
		t.Fatalf("the probe sent %q; want HEAD / HTTP/1.0 with the Host header alone", sent)
	}

	noHost := make(chan string, 1)
	bare := tcpServer(t, func(conn net.Conn) {
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		buffer := make([]byte, 512)
		n, _ := conn.Read(buffer)
		noHost <- string(buffer[:n])
		_, _ = conn.Write([]byte("SSH-2.0-OpenSSH_9.6\r\n"))
	})
	got = only(t, probe.Diagnose([]probe.Check{{Probe: "http", Address: bare}}, short))
	if got.Outcome != "answered" || got.Bytes == 0 || !strings.Contains(got.Detail, "not an HTTP status line") {
		t.Fatalf("other bytes came back, and the probe reported %+v; want answered, as --connect counts them, the detail saying they are no status line", got)
	}
	if sent := <-noHost; sent != "HEAD / HTTP/1.0\r\n\r\n" {
		t.Fatalf("with no name the probe sent %q; want no Host header", sent)
	}
}

func TestDiagnoseATCPAcceptWithNoAnswerIsAccepted(t *testing.T) {
	quiet, hangsUp := silent(t), tcpServer(t, func(net.Conn) {})
	start := time.Now()
	diagnosis := probe.Diagnose([]probe.Check{{Probe: "tls", Address: quiet}, {Probe: "http", Address: hangsUp}}, short)
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("took %v; the read is bounded at %v", took, short.Read)
	}
	for _, got := range diagnosis.Results {
		if got.Outcome != "accepted" || got.Bytes != 0 {
			t.Errorf("reported %+v; want accepted with no bytes: the connection was accepted and nothing came back", got)
		}
	}
	if diagnosis.Verdict != "accepted-only" {
		t.Fatalf("verdict %q; want accepted-only when every check was accepted and none answered", diagnosis.Verdict)
	}
}

func TestDiagnoseAClosedPortIsRefused(t *testing.T) {
	diagnosis := probe.Diagnose([]probe.Check{{Probe: "tls", Address: closedTCP(t)}, {Probe: "http", Address: closedTCP(t)}, {Probe: "dns", Address: closedUDP(t)}}, short)
	for _, got := range diagnosis.Results {
		if got.Outcome != "refused" || got.Bytes != 0 || got.Detail == "" {
			t.Errorf("reported %+v; want refused, in words", got)
		}
	}
	if diagnosis.Verdict != "none" {
		t.Fatalf("verdict %q; want none when nothing was accepted or answered", diagnosis.Verdict)
	}
}

func TestDiagnoseDNSIsAnsweredByAnyReply(t *testing.T) {
	queries := make(chan []byte, 2)
	answering := udpServer(t, func(query []byte) []byte {
		queries <- query
		return dnsAnswer(query)
	})
	got := only(t, probe.Diagnose([]probe.Check{{Probe: "dns", Address: answering}}, short))
	if got.Outcome != "answered" || got.Proto != "udp" || got.Probe != "dns" {
		t.Fatalf("a DNS response came back, and the probe reported %+v; want answered over udp", got)
	}
	query := <-queries
	question := []byte("\x07example\x03com\x00\x00\x01\x00\x01")
	if len(query) != 12+len(question) || !bytes.Equal(query[12:], question) || binary.BigEndian.Uint16(query[4:6]) != 1 || query[2]&0x80 != 0 {
		t.Fatalf("the query was %x; want one question, example.com A IN", query)
	}

	wrongID := udpServer(t, func(query []byte) []byte {
		reply := dnsAnswer(query)
		reply[0] ^= 0xff
		return reply
	})
	got = only(t, probe.Diagnose([]probe.Check{{Probe: "dns", Address: wrongID}}, short))
	if got.Outcome != "answered" || got.Bytes == 0 || !strings.Contains(got.Detail, "not a DNS response with the query's id") {
		t.Fatalf("a response with another id came back, and the probe reported %+v; want answered (something on the path replied), the detail saying it is not the query's", got)
	}

	mute := udpServer(t, func([]byte) []byte { return nil })
	got = only(t, probe.Diagnose([]probe.Check{{Probe: "dns", Address: mute}}, short))
	if got.Outcome != "refused" || !strings.Contains(got.Detail, "no reply") {
		t.Fatalf("nothing came back, and the probe reported %+v; want refused: no reply", got)
	}
}

func TestDiagnoseIsAnsweredWhenAnyCheckIsAndKeepsTheOrderGiven(t *testing.T) {
	answering := tcpServer(t, func(conn net.Conn) {
		if _, _, ok := clientHello(conn); ok {
			_, _ = conn.Write(serverHello)
		}
	})
	checks := []probe.Check{{Probe: "tls", Address: closedTCP(t)}, {Probe: "http", Address: silent(t)}, {Probe: "tls", Address: answering}}
	diagnosis := probe.Diagnose(checks, short)
	outcomes := []string{}
	for i, got := range diagnosis.Results {
		host, port, _ := net.SplitHostPort(checks[i].Address)
		if number, _ := strconv.Atoi(port); got.Target != host || got.Port != number {
			t.Errorf("result %d is %s:%d; want %s, in the order given", i, got.Target, got.Port, checks[i].Address)
		}
		outcomes = append(outcomes, got.Outcome)
	}
	if !reflect.DeepEqual(outcomes, []string{"refused", "accepted", "answered"}) || diagnosis.Verdict != "egress" {
		t.Fatalf("outcomes %q, verdict %q; want refused, accepted, answered and the verdict egress", outcomes, diagnosis.Verdict)
	}
}

func TestDiagnoseIsBoundedAsAWhole(t *testing.T) {
	bounds := probe.Bounds{Connect: 5 * time.Second, Read: 5 * time.Second, Whole: 500 * time.Millisecond, MaxRead: 4096}
	start := time.Now()
	diagnosis := probe.Diagnose([]probe.Check{{Probe: "tls", Address: silent(t)}, {Probe: "dns", Address: udpServer(t, func([]byte) []byte { return nil })}}, bounds)
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("took %v; the whole diagnosis is bounded at %v", took, bounds.Whole)
	}
	if len(diagnosis.Results) != 2 || diagnosis.Results[0].Outcome != "accepted" || diagnosis.Results[1].Outcome != "refused" {
		t.Fatalf("results %+v; want accepted, then refused", diagnosis.Results)
	}
}

func TestDiagnoseReadsAtMostMaxRead(t *testing.T) {
	flood := tcpServer(t, func(conn net.Conn) {
		_, _ = conn.Write(bytes.Repeat([]byte{0x17}, 64*1024))
	})
	got := only(t, probe.Diagnose([]probe.Check{{Probe: "tls", Address: flood}}, probe.Bounds{Connect: time.Second, Read: time.Second, Whole: 5 * time.Second, MaxRead: 1024}))
	if got.Bytes == 0 || got.Bytes > 1024 || got.Outcome != "answered" {
		t.Fatalf("reported %+v; want answered, and at most 1024 bytes read", got)
	}
}

func TestDiagnoseReportsItsOwnUserAndTheKernelInOneJSONObject(t *testing.T) {
	encoded, err := json.Marshal(probe.Diagnose(nil, short))
	if err != nil {
		t.Fatal(err)
	}
	var report map[string]any
	if err := json.Unmarshal(encoded, &report); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"uid", "gid", "kernel", "verdict", "results"} {
		if _, ok := report[field]; !ok {
			t.Errorf("%s: no %q", encoded, field)
		}
	}
	if !strings.Contains(string(encoded), `"results":[]`) {
		t.Fatalf("%s: results must be [] when there is none, never null", encoded)
	}
}

// The diagnostic's own targets: three public resolvers and one CDN address that is no resolver, each on 443/tcp (TLS),
// 80/tcp (HTTP) and 53/udp (DNS), and nothing else.
func TestDiagnoseTargetsAreTheFourPublicAddressesOnThreePortsAlone(t *testing.T) {
	want := []probe.Check{}
	for _, target := range []struct{ address, name string }{
		{"1.1.1.1", "one.one.one.one"},
		{"8.8.8.8", "dns.google"},
		{"9.9.9.9", "dns.quad9.net"},
		{"151.101.1.57", "fastly.com"},
	} {
		want = append(want,
			probe.Check{Probe: "tls", Address: target.address + ":443", Name: target.name},
			probe.Check{Probe: "http", Address: target.address + ":80", Name: target.name},
			probe.Check{Probe: "dns", Address: target.address + ":53"},
		)
	}
	if got := probe.DiagnoseChecks(); !reflect.DeepEqual(got, want) {
		t.Fatalf("checks %+v;\nwant %+v", got, want)
	}
	if probe.DiagnoseBounds.Connect != 3*time.Second || probe.DiagnoseBounds.Read != 3*time.Second || probe.DiagnoseBounds.Whole > 20*time.Second || probe.DiagnoseBounds.MaxRead > 4096 {
		t.Fatalf("bounds %+v; want 3 s to connect, 3 s to read, at most 20 s in all and at most 4 KiB read", probe.DiagnoseBounds)
	}
}

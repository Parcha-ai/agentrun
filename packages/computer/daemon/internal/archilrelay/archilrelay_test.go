package archilrelay_test

import (
	"bytes"
	"errors"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/archilrelay"
)

// patience bounds every wait in these tests. The host may be loaded: it is never a claim about speed.
const patience = 30 * time.Second

func TestConfigOfTakesExactlyTheHelpersArguments(t *testing.T) {
	good := []string{"--gateway", "10.60.0.40", "--mount-lane", "18100", "--data-lane", "42050"}
	config, err := archilrelay.ConfigOf(good)
	if err != nil {
		t.Fatalf("ConfigOf(%q): %v", good, err)
	}
	if got := strings.Join(config.Args(), " "); got != strings.Join(good, " ") {
		t.Fatalf("Args() = %q, want %q", got, strings.Join(good, " "))
	}
	for name, args := range map[string][]string{
		"none":                {},
		"a hostname":          {"--gateway", "proxy.example", "--mount-lane", "18100", "--data-lane", "42050"},
		"IPv6":                {"--gateway", "::1", "--mount-lane", "18100", "--data-lane", "42050"},
		"a lane on 8100":      {"--gateway", "10.60.0.40", "--mount-lane", "8100", "--data-lane", "42050"},
		"a lane on 32050":     {"--gateway", "10.60.0.40", "--mount-lane", "18100", "--data-lane", "32050"},
		"the same lane twice": {"--gateway", "10.60.0.40", "--mount-lane", "18100", "--data-lane", "18100"},
		"port 0":              {"--gateway", "10.60.0.40", "--mount-lane", "0", "--data-lane", "42050"},
		"a leading zero":      {"--gateway", "10.60.0.40", "--mount-lane", "018100", "--data-lane", "42050"},
		"a flag twice":        {"--gateway", "10.60.0.40", "--gateway", "10.60.0.41", "--data-lane", "42050"},
		"an unknown flag":     {"--gateway", "10.60.0.40", "--mount-lane", "18100", "--other", "42050"},
	} {
		if _, err := archilrelay.ConfigOf(args); err == nil {
			t.Errorf("%s: ConfigOf(%q) accepted", name, args)
		}
	}
}

func TestHeaderIsTheProxyV2Layout(t *testing.T) {
	got := archilrelay.Header(netip.MustParseAddrPort("169.254.123.2:40000"), netip.MustParseAddrPort("35.238.187.214:32050"))
	// Written out from the spec's section 2.2, not from Header: signature, 0x21 (v2, PROXY), 0x11 (TCP4), length 12,
	// src 169.254.123.2, dst 35.238.187.214, sport 40000 (0x9c40), dport 32050 (0x7d32).
	want := []byte{0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a, 0x21, 0x11, 0x00, 0x0c,
		169, 254, 123, 2, 35, 238, 187, 214, 0x9c, 0x40, 0x7d, 0x32}
	if !bytes.Equal(got, want) {
		t.Fatalf("Header = % x\nwant     % x", got, want)
	}
}

// gateway listens on loopback and records, per connection, the header it was sent and what followed, then answers.
func gateway(t *testing.T) (net.Listener, chan []byte) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	got := make(chan []byte, 4)
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				all, _ := io.ReadAll(conn)
				got <- all
				_, _ = conn.Write([]byte("from-gateway"))
			}()
		}
	}()
	return l, got
}

// relay starts the relay on loopback with every connection's original destination given as dst.
// lockedBuffer is a log both the relay and the test touch.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.buf.String() }

func relay(t *testing.T, config archilrelay.Config, dst netip.AddrPort) (string, *lockedBuffer) {
	t.Helper()
	l, err := archilrelay.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	logs := &lockedBuffer{}
	go func() {
		_ = archilrelay.Serve(l, config, func(net.Conn) (netip.AddrPort, error) { return dst, nil }, log.New(logs, "", 0))
	}()
	return l.Addr().String(), logs
}

func port(t *testing.T, l net.Listener) uint16 {
	t.Helper()
	return netip.MustParseAddrPort(l.Addr().String()).Port()
}

func exchange(t *testing.T, address string, send string) (string, error) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", address, patience)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(patience))
	if _, err := conn.Write([]byte(send)); err != nil {
		return "", err
	}
	_ = conn.(*net.TCPConn).CloseWrite()
	back, err := io.ReadAll(conn)
	return string(back), err
}

func TestRelayCarriesEachArchilPortToItsLaneWithTheOriginalDestination(t *testing.T) {
	mount, mountGot := gateway(t)
	data, dataGot := gateway(t)
	config := archilrelay.Config{Gateway: netip.MustParseAddr("127.0.0.1"), MountLane: port(t, mount), DataLane: port(t, data)}
	for _, c := range []struct {
		dst string
		got chan []byte
	}{{"54.88.2.136:8100", mountGot}, {"35.238.187.214:32050", dataGot}} {
		dst := netip.MustParseAddrPort(c.dst)
		address, _ := relay(t, config, dst)
		back, err := exchange(t, address, "client-hello")
		if err != nil || back != "from-gateway" {
			t.Fatalf("%s: back %q, %v", c.dst, back, err)
		}
		sent := <-c.got
		if len(sent) < 28 || !bytes.Equal(sent[:12], []byte("\r\n\r\n\x00\r\nQUIT\n")) {
			t.Fatalf("%s: the gateway got no PROXY v2 header: % x", c.dst, sent)
		}
		claimed := netip.AddrPortFrom(netip.AddrFrom4([4]byte(sent[20:24])), uint16(sent[26])<<8|uint16(sent[27]))
		if claimed != dst || string(sent[28:]) != "client-hello" {
			t.Fatalf("%s: header names %s and carried %q", c.dst, claimed, sent[28:])
		}
	}
}

func TestRelayClosesWhatItCannotCarry(t *testing.T) {
	// A gateway that is not listening: the connection is closed, and nothing is reached.
	closed, _ := net.Listen("tcp", "127.0.0.1:0")
	down := port(t, closed)
	_ = closed.Close()
	config := archilrelay.Config{Gateway: netip.MustParseAddr("127.0.0.1"), MountLane: down, DataLane: down + 1}
	for name, dst := range map[string]string{
		"the gateway is down": "35.238.187.214:32050",
		"no Archil port":      "93.184.216.34:443",
	} {
		address, logs := relay(t, config, netip.MustParseAddrPort(dst))
		back, _ := exchange(t, address, "client-hello")
		if back != "" {
			t.Errorf("%s: the client got %q back", name, back)
		}
		deadline := time.Now().Add(patience)
		for !strings.Contains(logs.String(), "closed") && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if !strings.Contains(logs.String(), "closed") {
			t.Errorf("%s: no log line says the connection was closed: %q", name, logs.String())
		}
	}
}

func TestListenRefusesAPortAnotherProcessHolds(t *testing.T) {
	held, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	// In a test the holder is this process's own user: ErrServing only for root's own listener.
	_, err = archilrelay.Listen(held.Addr().String())
	if err == nil {
		t.Fatal("Listen on a held port succeeded")
	}
	if isRoot := errors.Is(err, archilrelay.ErrServing); isRoot != (uidIsRoot()) {
		t.Fatalf("Listen on a port this user holds: %v (root %v)", err, uidIsRoot())
	}
}

func uidIsRoot() bool { return os.Getuid() == 0 }

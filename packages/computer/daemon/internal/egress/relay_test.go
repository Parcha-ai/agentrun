package egress_test

import (
	"bytes"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/egress"
)

// patience bounds every wait in these tests. The host may be loaded: it is never a claim about speed.
const patience = 30 * time.Second

// socketPath is a path for a Unix socket in a fresh directory: not under t.TempDir(), whose name holds the test's,
// since a socket's path must fit in 108 bytes.
func socketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "egress-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "egress.sock")
}

// proxy listens on socket and answers each connection with "got:" and all it read, once the client's side ends.
func proxy(t *testing.T, socket string) net.Listener {
	t.Helper()
	listener, err := net.Listen("unix", socket)
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
				read, _ := io.ReadAll(conn)
				_, _ = conn.Write(append([]byte("got:"), read...))
			}()
		}
	}()
	return listener
}

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

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func relay(t *testing.T, socket string) (net.Listener, *lockedBuffer) {
	t.Helper()
	words := &lockedBuffer{}
	listener, err := egress.Relay("127.0.0.1:0", socket, log.New(words, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener, words
}

// roundTrip sends data through the relay, ends its side, and returns all that came back.
func roundTrip(t *testing.T, address string, data string) string {
	t.Helper()
	conn, err := net.DialTimeout("tcp", address, patience)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(patience))
	if _, err := conn.Write([]byte(data)); err != nil {
		t.Fatal(err)
	}
	if err := conn.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	back, err := io.ReadAll(conn)
	if err != nil {
		t.Fatalf("reading through the relay: %v", err)
	}
	return string(back)
}

func TestTheAddressIsTheComputersOwnLoopbackPort3128(t *testing.T) {
	if egress.Address != "127.0.0.1:3128" {
		t.Fatalf("egress.Address is %q; the provider's HTTP_PROXY names 127.0.0.1:3128", egress.Address)
	}
}

func TestTheRelayCarriesBytesBothWaysAndEachSidesEnd(t *testing.T) {
	socket := socketPath(t)
	proxy(t, socket)
	listener, _ := relay(t, socket)
	if got := roundTrip(t, listener.Addr().String(), "CONNECT pypi.org:443 HTTP/1.1\r\n\r\n"); got != "got:CONNECT pypi.org:443 HTTP/1.1\r\n\r\n" {
		t.Fatalf("through the relay: %q", got)
	}
	big := strings.Repeat("x", 1<<20)
	if got := roundTrip(t, listener.Addr().String(), big); got != "got:"+big {
		t.Fatalf("a megabyte through the relay came back as %d bytes", len(got))
	}
}

func TestAConnectionWhoseProxyIsGoneIsClosedAtOnceAndSaysWhy(t *testing.T) {
	socket := socketPath(t)
	listener, words := relay(t, socket)
	if got := roundTrip(t, listener.Addr().String(), "GET http://pypi.org/ HTTP/1.1\r\n\r\n"); got != "" {
		t.Fatalf("with no proxy at its socket the relay answered %q; want nothing, the connection closed", got)
	}
	deadline := time.Now().Add(patience)
	for !strings.Contains(words.String(), socket) {
		if time.Now().After(deadline) {
			t.Fatalf("the relay did not say why: %q", words.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(words.String(), "egress") {
		t.Fatalf("the relay's words do not name the egress proxy: %q", words.String())
	}
}

func TestEachConnectionDialsTheSocketByItsPathSoAProxyStartedAgainIsReached(t *testing.T) {
	socket := socketPath(t)
	first := proxy(t, socket)
	listener, _ := relay(t, socket)
	if got := roundTrip(t, listener.Addr().String(), "one"); got != "got:one" {
		t.Fatalf("first: %q", got)
	}
	_ = first.Close()
	_ = os.Remove(socket)
	proxy(t, socket)
	if got := roundTrip(t, listener.Addr().String(), "two"); got != "got:two" {
		t.Fatalf("after the proxy started again: %q", got)
	}
}

func TestTheRelayStopsWhenItsListenerCloses(t *testing.T) {
	socket := socketPath(t)
	proxy(t, socket)
	listener, _ := relay(t, socket)
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if conn, err := net.DialTimeout("tcp", address, time.Second); err == nil {
		_ = conn.Close()
		t.Fatalf("the relay still took a connection on %s after its listener closed", address)
	}
}

func TestARelayThatCannotListenFailsInWords(t *testing.T) {
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer taken.Close()
	_, err = egress.Relay(taken.Addr().String(), socketPath(t), log.New(io.Discard, "", 0))
	if err == nil || !strings.Contains(err.Error(), "egress relay") || !strings.Contains(err.Error(), taken.Addr().String()) {
		t.Fatalf("a relay on a taken address: %v; want an error naming the egress relay and the address", err)
	}
}

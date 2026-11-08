// Package egress is init's relay for a computer whose network is an allowlist. Such a computer has no network of its
// own, only its loopback; its one way out is its egress proxy's Unix socket, in a volume mounted into it. Init listens on
// its own loopback (Address, which the programs it starts are told is their HTTP and HTTPS proxy) and carries each
// connection to that socket and back. The proxy decides what is reached; the relay only carries bytes, so a relay that
// cannot reach the proxy closes the connection and the computer reaches nothing, never more.
package egress

import (
	"errors"
	"io"
	"log"
	"net"
	"time"
)

// Address is where init listens in the computer: its own loopback, port 3128, the proxy its programs are told of.
const Address = "127.0.0.1:3128" // key-gate: loopback-rule the loopback of the computer itself, where the egress relay of init listens

// NoProxy is what the programs are told to reach directly: the computer's own loopback.
const NoProxy = "localhost,127.0.0.1,::1" // key-gate: loopback-rule the loopback names of the computer itself, which its proxy leaves out

// dialFor bounds each connection to the proxy's socket.
const dialFor = 5 * time.Second

// acceptPause is how long the relay waits after an accept fails for another reason than its close (too many files).
const acceptPause = 50 * time.Millisecond

// Env is the proxy variables for a relay listening on address: what every program init starts is told.
func Env(address string) map[string]string {
	proxy := "http://" + address
	return map[string]string{
		"HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "http_proxy": proxy, "https_proxy": proxy,
		"NO_PROXY": NoProxy, "no_proxy": NoProxy,
	}
}

// Relay listens on address and carries each connection to a new connection to the Unix socket at socket, both ways,
// until each side has ended. Each connection dials the socket by its path, so a proxy started again is reached with no
// new relay. A connection whose socket cannot be dialled is closed at once, and logged. Closing the listener stops it.
func Relay(address, socket string, logger *log.Logger) (net.Listener, error) {
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return nil, errors.New("cannot listen on " + address + " for the egress relay: " + err.Error())
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if errors.Is(err, net.ErrClosed) {
				return
			}
			if err != nil {
				time.Sleep(acceptPause)
				continue
			}
			go carry(conn, socket, logger)
		}
	}()
	return listener, nil
}

// carry relays one connection to the proxy's socket and back. An end on either side is passed on as a half-close; a
// failure on either side ends both.
func carry(client net.Conn, socket string, logger *log.Logger) {
	defer client.Close()
	upstream, err := net.DialTimeout("unix", socket, dialFor)
	if err != nil {
		logger.Printf("egress: cannot reach the egress proxy at %s, so the connection is closed: %v", socket, err)
		return
	}
	defer upstream.Close()
	done := make(chan error, 2)
	pass := func(to, from net.Conn) {
		_, err := io.Copy(to, from)
		if half, ok := to.(interface{ CloseWrite() error }); ok && err == nil {
			_ = half.CloseWrite()
		}
		done <- err
	}
	go pass(upstream, client)
	go pass(client, upstream)
	if err := <-done; err != nil {
		// One side failed: the other's copy ends when both are closed.
		_ = client.Close()
		_ = upstream.Close()
	}
	<-done
}

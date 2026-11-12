// Package archilrelay is the archil client's way out of a computer whose Archil traffic goes through an egress gateway:
// `computerd archil-relay`, which the root helper's mount starts before the client when the provider names a gateway.
//
// The helper redirects root's TCP to Archil's two ports (8100, the mount endpoint; 32050, the file servers, at the raw
// addresses the mount endpoint returns) to this relay on the computer's own loopback. For each connection the relay
// reads the destination the client dialled (SO_ORIGINAL_DST), opens a connection to the gateway's lane for that port,
// sends a PROXY protocol v2 header naming that destination, and carries the bytes both ways. The gateway decides what
// is reached (it admits only a destination that proves, by certificate, the Archil name the client asked for); the
// relay only carries bytes, so a relay that cannot reach the gateway closes the connection and the client reaches
// nothing, never more. It holds no token.
package archilrelay

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Address is where the relay listens: the computer's own loopback, where the helper's redirect sends root's Archil
// connections.
const Address = "127.0.0.1:3129" // key-gate: loopback-rule the loopback of the computer itself, where the archil relay of the root helper listens

// MountPort and DataPort are Archil's two ports: the mount endpoint and the file servers (docs.archil.com/mounting/linux).
const (
	MountPort = 8100
	DataPort  = 32050
)

// LogPath is the relay's log, root's alone (0600): what it closed and why.
const LogPath = "/var/log/agentrun-archil-relay.log"

// dialFor bounds each connection to the gateway.
const dialFor = 5 * time.Second

// acceptPause is how long the relay waits after an accept fails for another reason than its close (too many files).
const acceptPause = 50 * time.Millisecond

// ErrServing is a Listen where root's relay already listens on Address (a computer found again).
var ErrServing = errors.New("an archil relay already listens on " + Address)

// Config is what archil-relay is given, by the helper alone.
type Config struct {
	// Gateway is the egress gateway's IPv4 address.
	Gateway netip.Addr
	// MountLane and DataLane are the gateway's ports for connections the client made to MountPort and DataPort.
	MountLane, DataLane uint16
}

const configWords = "archil-relay takes --gateway <IPv4 address> --mount-lane <port> --data-lane <port>, each once; the two ports differ and neither is 8100 or 32050, which the computer redirects to the relay"

// ConfigOf reads archil-relay's arguments: exactly the helper's three, each once.
func ConfigOf(args []string) (Config, error) {
	var config Config
	if len(args) != 6 {
		return Config{}, errors.New(configWords)
	}
	seen := map[string]bool{}
	for i := 0; i < len(args); i += 2 {
		name, value := args[i], args[i+1]
		if seen[name] {
			return Config{}, errors.New(configWords)
		}
		seen[name] = true
		switch name {
		case "--gateway":
			addr, err := netip.ParseAddr(value)
			if err != nil || !addr.Is4() || addr.String() != value {
				return Config{}, errors.New(configWords)
			}
			config.Gateway = addr
		case "--mount-lane", "--data-lane":
			port, err := strconv.ParseUint(value, 10, 16)
			if err != nil || port == 0 || port == MountPort || port == DataPort || strconv.FormatUint(port, 10) != value {
				return Config{}, errors.New(configWords)
			}
			if name == "--mount-lane" {
				config.MountLane = uint16(port)
			} else {
				config.DataLane = uint16(port)
			}
		default:
			return Config{}, errors.New(configWords)
		}
	}
	if config.MountLane == config.DataLane {
		return Config{}, errors.New(configWords)
	}
	return config, nil
}

// Args is the argument list ConfigOf reads back as config.
func (config Config) Args() []string {
	return []string{"--gateway", config.Gateway.String(), "--mount-lane", strconv.Itoa(int(config.MountLane)), "--data-lane", strconv.Itoa(int(config.DataLane))}
}

// lane is the gateway's port for a connection the client made to port, or false for any other port.
func (config Config) lane(port uint16) (uint16, bool) {
	switch port {
	case MountPort:
		return config.MountLane, true
	case DataPort:
		return config.DataLane, true
	}
	return 0, false
}

// Listen listens on address. Where root's relay listens there already, it is ErrServing; another user's listener there
// is an error, so nothing but root's relay is ever handed root's Archil connections.
func Listen(address string) (net.Listener, error) {
	l, err := net.Listen("tcp", address)
	if err == nil {
		return l, nil
	}
	if errors.Is(err, syscall.EADDRINUSE) {
		if uid, found := listenerUID(address); found && uid == 0 {
			return nil, ErrServing
		}
		return nil, fmt.Errorf("another user's listener holds %s, where the archil relay listens", address)
	}
	return nil, fmt.Errorf("cannot listen on %s for the archil relay: %w", address, err)
}

// listenerUID is the uid of the TCP listener on address, from /proc/net/tcp.
func listenerUID(address string) (int, bool) {
	want, err := netip.ParseAddrPort(address)
	if err != nil || !want.Addr().Is4() {
		return 0, false
	}
	data, err := os.ReadFile("/proc/net/tcp")
	if err != nil {
		return 0, false
	}
	ip := want.Addr().As4()
	local := fmt.Sprintf("%08X:%04X", binary.LittleEndian.Uint32(ip[:]), want.Port())
	for _, line := range strings.Split(string(data), "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) >= 8 && fields[1] == local && fields[3] == "0A" { // 0A: LISTEN
			uid, err := strconv.Atoi(fields[7])
			return uid, err == nil
		}
	}
	return 0, false
}

// Original is how the relay learns a connection's original destination; OriginalDestination in a computer.
type Original func(net.Conn) (netip.AddrPort, error)

// Serve accepts on l until it is closed, carrying each connection to the gateway's lane for its original port.
func Serve(l net.Listener, config Config, original Original, logger *log.Logger) error {
	for {
		conn, err := l.Accept()
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		if err != nil {
			time.Sleep(acceptPause)
			continue
		}
		go carry(conn, config, original, logger)
	}
}

func carry(conn net.Conn, config Config, original Original, logger *log.Logger) {
	defer conn.Close()
	dst, err := original(conn)
	if err != nil {
		logger.Printf("archil-relay: a connection's original destination is unknown (%v), so it is closed", err)
		return
	}
	lane, ok := config.lane(dst.Port())
	if !ok {
		logger.Printf("archil-relay: a connection to %s is on no Archil port, so it is closed", dst)
		return
	}
	src, err := netip.ParseAddrPort(conn.RemoteAddr().String())
	if err != nil || !src.Addr().Unmap().Is4() || !dst.Addr().Unmap().Is4() {
		logger.Printf("archil-relay: a connection from %s to %s is not IPv4, so it is closed", conn.RemoteAddr(), dst)
		return
	}
	gateway := netip.AddrPortFrom(config.Gateway, lane)
	up, err := net.DialTimeout("tcp", gateway.String(), dialFor)
	if err != nil {
		logger.Printf("archil-relay: the gateway at %s cannot be reached (%v), so the connection to %s is closed", gateway, err, dst)
		return
	}
	defer up.Close()
	if _, err := up.Write(Header(netip.AddrPortFrom(src.Addr().Unmap(), src.Port()), netip.AddrPortFrom(dst.Addr().Unmap(), dst.Port()))); err != nil {
		logger.Printf("archil-relay: the gateway at %s took no header (%v), so the connection to %s is closed", gateway, err, dst)
		return
	}
	// An end on either side is passed on as a half-close; a failure on either side ends both, as the egress relay does.
	done := make(chan error, 2)
	pass := func(to, from net.Conn) {
		_, err := io.Copy(to, from)
		if half, ok := to.(interface{ CloseWrite() error }); ok && err == nil {
			_ = half.CloseWrite()
		}
		done <- err
	}
	go pass(up, conn)
	go pass(conn, up)
	if err := <-done; err != nil {
		_ = conn.Close()
		_ = up.Close()
	}
	<-done
}

// Header is the PROXY protocol v2 header for a TCP over IPv4 connection from src to dst
// (haproxy.org/download/2.6/doc/proxy-protocol.txt, section 2.2): the signature, version 2 and command PROXY, AF_INET
// over SOCK_STREAM, a 12-byte address block, no TLVs.
func Header(src, dst netip.AddrPort) []byte {
	header := []byte("\r\n\r\n\x00\r\nQUIT\n\x21\x11\x00\x0c")
	s, d := src.Addr().As4(), dst.Addr().As4()
	header = append(header, s[:]...)
	header = append(header, d[:]...)
	header = binary.BigEndian.AppendUint16(header, src.Port())
	return binary.BigEndian.AppendUint16(header, dst.Port())
}

// soOriginalDst is SO_ORIGINAL_DST (linux/netfilter_ipv4.h): the destination a connection had before the redirect.
const soOriginalDst = 80

// OriginalDestination reads SO_ORIGINAL_DST from conn, the address its client dialled before the computer's redirect.
func OriginalDestination(conn net.Conn) (netip.AddrPort, error) {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return netip.AddrPort{}, errors.New("not a TCP connection")
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return netip.AddrPort{}, err
	}
	var addr *syscall.IPv6Mreq
	var sockErr error
	if err := raw.Control(func(fd uintptr) {
		// struct sockaddr_in is 16 bytes, the size of an ipv6_mreq: the usual way to read it with the syscall package.
		addr, sockErr = syscall.GetsockoptIPv6Mreq(int(fd), syscall.IPPROTO_IP, soOriginalDst)
	}); err != nil {
		return netip.AddrPort{}, err
	}
	if sockErr != nil {
		return netip.AddrPort{}, fmt.Errorf("SO_ORIGINAL_DST: %w", sockErr)
	}
	b := addr.Multiaddr
	return netip.AddrPortFrom(netip.AddrFrom4([4]byte(b[4:8])), binary.BigEndian.Uint16(b[2:4])), nil
}

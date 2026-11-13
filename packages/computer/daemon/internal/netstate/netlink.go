package netstate

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"syscall"
	"time"
	"unsafe"
)

// rtScopeHost is RT_SCOPE_HOST: an address valid on this host alone, as the loopback's.
const rtScopeHost = 254

// loopback4 is the loopback's IPv4 address, which Linux gives lo when it comes up and gVisor's netstack may not.
var loopback4 = [4]byte{127, 0, 0, 1}

// LoopbackUp brings the loopback (lo) of the calling thread's network namespace up over rtnetlink, as `ip link set lo
// up` does, gives it 127.0.0.1/8 where the kernel did not, and reads it back: lo up and running, 127.0.0.1 on it, and a
// connection to a listener there accepted. rtnetlink is the one path: gVisor's netstack takes no SIOCSIFFLAGS ioctl in
// a new network namespace (ENOTTY, live on Modal's gVisor, 11-11), and Linux takes both. Each failure is an error in
// words.
func LoopbackUp() error {
	lo, err := net.InterfaceByName("lo")
	if err != nil {
		return fmt.Errorf("cannot find the network namespace's loopback (lo): %w", err)
	}
	if err := setLinkUp(lo.Index, true); err != nil {
		return fmt.Errorf("cannot bring the network namespace's loopback up over rtnetlink: %w; init needs CAP_NET_ADMIN over the namespace", err)
	}
	has, err := hasAddress(lo, loopback4[:])
	if err != nil {
		return err
	}
	if !has {
		if err := addAddress4(lo.Index, loopback4, 8); err != nil {
			return fmt.Errorf("cannot give the network namespace's loopback 127.0.0.1/8 over rtnetlink: %w", err)
		}
	}
	return checkLoopback()
}

// checkLoopback reads lo back: up and running, 127.0.0.1 on it, and a connection to a listener there accepted.
func checkLoopback() error {
	lo, err := net.InterfaceByName("lo")
	if err != nil {
		return fmt.Errorf("cannot read the network namespace's loopback back: %w", err)
	}
	if lo.Flags&net.FlagUp == 0 || lo.Flags&net.FlagRunning == 0 {
		return fmt.Errorf("the network namespace's loopback reads back %s, not up and running", lo.Flags)
	}
	if has, err := hasAddress(lo, loopback4[:]); err != nil {
		return err
	} else if !has {
		return fmt.Errorf("the network namespace's loopback reads back without 127.0.0.1")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0") // key-gate: loopback-rule init's own namespace's loopback, read back
	if err != nil {
		return fmt.Errorf("cannot listen on the network namespace's loopback: %w", err)
	}
	defer listener.Close()
	conn, err := net.DialTimeout("tcp4", listener.Addr().String(), 2*time.Second)
	if err != nil {
		return fmt.Errorf("cannot reach a listener on the network namespace's loopback: %w", err)
	}
	return conn.Close()
}

// hasAddress says whether iface holds ip.
func hasAddress(iface *net.Interface, ip net.IP) (bool, error) {
	addrs, err := iface.Addrs()
	if err != nil {
		return false, fmt.Errorf("cannot list the addresses of %s: %w", iface.Name, err)
	}
	for _, addr := range addrs {
		if prefix, ok := addr.(*net.IPNet); ok && prefix.IP.Equal(ip) {
			return true, nil
		}
	}
	return false, nil
}

// setLinkUp sets (or clears) IFF_UP on the interface index: RTM_NEWLINK with ifi_change IFF_UP.
func setLinkUp(index int, up bool) error {
	info := syscall.IfInfomsg{Family: syscall.AF_UNSPEC, Index: int32(index), Change: syscall.IFF_UP}
	if up {
		info.Flags = syscall.IFF_UP
	}
	body := unsafe.Slice((*byte)(unsafe.Pointer(&info)), syscall.SizeofIfInfomsg)
	return request(syscall.RTM_NEWLINK, 0, body)
}

// addAddress4 gives the interface index the IPv4 address ip/prefix, host scope: RTM_NEWADDR with IFA_LOCAL and
// IFA_ADDRESS.
func addAddress4(index int, ip [4]byte, prefix uint8) error {
	msg := syscall.IfAddrmsg{Family: syscall.AF_INET, Prefixlen: prefix, Scope: rtScopeHost, Index: uint32(index)}
	body := append([]byte{}, unsafe.Slice((*byte)(unsafe.Pointer(&msg)), syscall.SizeofIfAddrmsg)...)
	for _, kind := range []uint16{syscall.IFA_LOCAL, syscall.IFA_ADDRESS} {
		attr := make([]byte, syscall.SizeofRtAttr+4)
		binary.NativeEndian.PutUint16(attr[0:2], uint16(len(attr)))
		binary.NativeEndian.PutUint16(attr[2:4], kind)
		copy(attr[syscall.SizeofRtAttr:], ip[:])
		body = append(body, attr...)
	}
	return request(syscall.RTM_NEWADDR, syscall.NLM_F_CREATE|syscall.NLM_F_EXCL, body)
}

// request sends one rtnetlink request with body and waits for the kernel's acknowledgement: nil, or its error.
func request(kind uint16, flags uint16, body []byte) error {
	fd, err := syscall.Socket(syscall.AF_NETLINK, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, syscall.NETLINK_ROUTE)
	if err != nil {
		return fmt.Errorf("cannot open a NETLINK_ROUTE socket: %w", err)
	}
	defer syscall.Close(fd)
	kernel := &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}
	if err := syscall.Bind(fd, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}); err != nil {
		return fmt.Errorf("cannot bind a NETLINK_ROUTE socket: %w", err)
	}
	const seq = 1
	message := make([]byte, syscall.NLMSG_HDRLEN+len(body))
	binary.NativeEndian.PutUint32(message[0:4], uint32(len(message)))
	binary.NativeEndian.PutUint16(message[4:6], kind)
	binary.NativeEndian.PutUint16(message[6:8], syscall.NLM_F_REQUEST|syscall.NLM_F_ACK|flags)
	binary.NativeEndian.PutUint32(message[8:12], seq)
	copy(message[syscall.NLMSG_HDRLEN:], body)
	if err := syscall.Sendto(fd, message, 0, kernel); err != nil {
		return fmt.Errorf("cannot send the request: %w", err)
	}
	reply := make([]byte, 8192)
	for {
		n, _, err := syscall.Recvfrom(fd, reply, 0)
		if err != nil {
			return fmt.Errorf("cannot read the kernel's answer: %w", err)
		}
		messages, err := syscall.ParseNetlinkMessage(reply[:n])
		if err != nil {
			return fmt.Errorf("cannot read the kernel's answer: %w", err)
		}
		for _, answer := range messages {
			if answer.Header.Seq != seq || answer.Header.Type != syscall.NLMSG_ERROR {
				continue
			}
			if len(answer.Data) < 4 {
				return errors.New("the kernel's acknowledgement is short")
			}
			if code := int32(binary.NativeEndian.Uint32(answer.Data[0:4])); code != 0 {
				return syscall.Errno(-code)
			}
			return nil
		}
	}
}

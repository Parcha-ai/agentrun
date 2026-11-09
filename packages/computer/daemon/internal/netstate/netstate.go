// Package netstate reads the network interfaces of the calling thread's network namespace, each with whether it is up
// and how many addresses it holds, and states the own-network invariant init keeps for its programs: the loopback alone
// is up or addressed; every other interface (a kernel with the tunnel modules loaded gives each new namespace its
// fallback tunnels, tunl0, gre0, sit0 and the rest) is down with no address, which a program with no CAP_NET_ADMIN
// cannot change.
package netstate

import (
	"fmt"
	"net"
	"strings"
	"syscall"
	"unsafe"
)

const (
	siocgifflags = 0x8913
	siocsifflags = 0x8914
	ifNameSize   = 16
)

// Iface is one interface as read: its name, whether it is up, whether it is a loopback, and how many addresses it holds.
type Iface struct {
	Name     string
	Up       bool
	Loopback bool
	Addrs    int
}

// Read lists this namespace's interfaces in the kernel's order, each with its state and its count of addresses.
func Read() ([]Iface, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("cannot list the network namespace's interfaces: %w", err)
	}
	out := make([]Iface, 0, len(ifaces))
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			return nil, fmt.Errorf("cannot list the addresses of %s: %w", iface.Name, err)
		}
		out = append(out, Iface{Name: iface.Name, Up: iface.Flags&net.FlagUp != 0, Loopback: iface.Flags&net.FlagLoopback != 0, Addrs: len(addrs)})
	}
	return out, nil
}

// Live names the interfaces that are up or hold an address: the ones a program could send through.
func Live(ifaces []Iface) []string {
	names := []string{}
	for _, iface := range ifaces {
		if iface.Up || iface.Addrs > 0 {
			names = append(names, iface.Name)
		}
	}
	return names
}

// Quiet names the interfaces that are down with no address.
func Quiet(ifaces []Iface) []string {
	names := []string{}
	for _, iface := range ifaces {
		if !iface.Up && iface.Addrs == 0 {
			names = append(names, iface.Name)
		}
	}
	return names
}

// OwnProblem says, in words, how ifaces break the own-network invariant: a loopback, up, and no other interface up or
// addressed. "" when they keep it.
func OwnProblem(ifaces []Iface) string {
	loopbackUp := false
	others := []string{}
	for _, iface := range ifaces {
		switch {
		case iface.Loopback && iface.Name == "lo":
			loopbackUp = iface.Up
		case iface.Up || iface.Addrs > 0:
			others = append(others, describe(iface))
		}
	}
	if !loopbackUp {
		problem := "the network namespace has no loopback (lo) up"
		if len(others) > 0 {
			problem += ", and holds " + strings.Join(others, ", ")
		}
		return problem
	}
	if len(others) > 0 {
		return fmt.Sprintf("the network namespace holds more than its loopback up or addressed: %s", strings.Join(others, ", "))
	}
	return ""
}

func describe(iface Iface) string {
	state := "down"
	if iface.Up {
		state = "up"
	}
	return fmt.Sprintf("%s (%s, %d addresses)", iface.Name, state, iface.Addrs)
}

// Raise tries to bring the interface name up, as the calling thread's credentials allow. When it can, it puts it back
// down and answers true: a program that can is not cut off. A program with no CAP_NET_ADMIN is refused (false, the
// kernel's error).
func Raise(name string) (bool, error) {
	if len(name) >= ifNameSize {
		return false, fmt.Errorf("%q is longer than an interface name", name)
	}
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return false, fmt.Errorf("cannot open a socket to try %s's flags: %w", name, err)
	}
	defer syscall.Close(fd)
	// struct ifreq: the name, then a union whose first member here is the flags, a short.
	var req [40]byte
	copy(req[:ifNameSize-1], name)
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), siocgifflags, uintptr(unsafe.Pointer(&req[0]))); errno != 0 {
		return false, fmt.Errorf("cannot read %s's flags: %w", name, errno)
	}
	flags := (*uint16)(unsafe.Pointer(&req[ifNameSize]))
	was := *flags
	*flags = was | syscall.IFF_UP
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), siocsifflags, uintptr(unsafe.Pointer(&req[0]))); errno != 0 {
		return false, fmt.Errorf("cannot bring %s up: %w", name, errno)
	}
	*flags = was
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), siocsifflags, uintptr(unsafe.Pointer(&req[0]))); errno != 0 {
		return true, fmt.Errorf("brought %s up, and could not put it back: %w", name, errno)
	}
	return true, nil
}

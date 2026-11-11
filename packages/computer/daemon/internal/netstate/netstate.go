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

// Raise tries to bring the interface name up over rtnetlink, as the calling thread's credentials allow: the one path
// LoopbackUp takes too, so a probe asks what init itself would use. When it can, it puts it back down and answers true:
// a program that can is not cut off. A program with no CAP_NET_ADMIN is refused (false, the kernel's error).
func Raise(name string) (bool, error) {
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return false, fmt.Errorf("cannot find %s: %w", name, err)
	}
	if err := setLinkUp(iface.Index, true); err != nil {
		return false, fmt.Errorf("cannot bring %s up: %w", name, err)
	}
	if iface.Flags&net.FlagUp != 0 {
		return true, nil
	}
	if err := setLinkUp(iface.Index, false); err != nil {
		return true, fmt.Errorf("brought %s up, and could not put it back: %w", name, err)
	}
	return true, nil
}

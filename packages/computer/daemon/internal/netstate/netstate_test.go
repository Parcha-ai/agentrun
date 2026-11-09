package netstate_test

import (
	"os"
	"strings"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/netstate"
)

// The Modal live run: a kernel with the tunnel modules loaded gives every new network namespace its fallback tunnel
// devices, down and with no address, and init refused to start because its namespace held more than the loopback. The
// invariant is the loopback alone up or addressed; every other interface down with no address, which a program with no
// CAP_NET_ADMIN cannot raise.
func TestOwnProblemTakesTheLoopbackAloneUpOrAddressedAndRefusesAnyOtherThatIs(t *testing.T) {
	lo := netstate.Iface{Name: "lo", Up: true, Loopback: true, Addrs: 2}
	tunnels := []netstate.Iface{{Name: "tunl0"}, {Name: "gre0"}, {Name: "sit0"}, {Name: "ip6tnl0"}}
	for _, ifaces := range [][]netstate.Iface{{lo}, append([]netstate.Iface{lo}, tunnels...)} {
		if problem := netstate.OwnProblem(ifaces); problem != "" {
			t.Fatalf("OwnProblem(%v) = %q; want none", ifaces, problem)
		}
	}
	for _, c := range []struct {
		what   string
		ifaces []netstate.Iface
		names  string
	}{
		{"a tunnel up", []netstate.Iface{lo, {Name: "tunl0", Up: true}}, "tunl0"},
		{"an address on a down tunnel", []netstate.Iface{lo, {Name: "gre0", Addrs: 1}}, "gre0"},
		{"another interface up with an address", []netstate.Iface{lo, {Name: "eth0", Up: true, Addrs: 1}}, "eth0"},
		{"the loopback down", []netstate.Iface{{Name: "lo", Loopback: true}}, "lo"},
		{"no loopback", []netstate.Iface{{Name: "tunl0"}}, "loopback"},
		{"nothing", nil, "loopback"},
	} {
		problem := netstate.OwnProblem(c.ifaces)
		if problem == "" || !strings.Contains(problem, c.names) {
			t.Fatalf("%s: OwnProblem = %q; want words naming %s", c.what, problem, c.names)
		}
	}
}

func TestLiveAndQuietSplitTheInterfacesByWhetherTheyAreUpOrAddressed(t *testing.T) {
	ifaces := []netstate.Iface{{Name: "lo", Up: true, Loopback: true, Addrs: 2}, {Name: "tunl0"}, {Name: "gre0", Addrs: 1}, {Name: "sit0", Up: true}}
	if got := strings.Join(netstate.Live(ifaces), ","); got != "lo,gre0,sit0" {
		t.Fatalf("Live = %s; want lo,gre0,sit0", got)
	}
	if got := strings.Join(netstate.Quiet(ifaces), ","); got != "tunl0" {
		t.Fatalf("Quiet = %s; want tunl0", got)
	}
}

func TestReadListsThisNamespacesInterfacesWithTheirStateAndAddresses(t *testing.T) {
	ifaces, err := netstate.Read()
	if err != nil {
		t.Fatal(err)
	}
	for _, iface := range ifaces {
		if iface.Name == "lo" && iface.Loopback && iface.Up && iface.Addrs > 0 {
			return
		}
	}
	t.Fatalf("Read = %+v; want the loopback among them, up and addressed", ifaces)
}

// A program of the computer's user holds no CAP_NET_ADMIN, so it can raise no interface of its namespace. As this test's
// own user (not root), Raise of the loopback is refused, and says so.
func TestRaiseIsRefusedToAUserWithoutCapNetAdmin(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("as root, Raise would succeed: the refusal is a non-root user's")
	}
	raised, err := netstate.Raise("lo")
	if raised || err == nil {
		t.Fatalf("Raise(lo) as uid %d = %v, %v; want refused", os.Geteuid(), raised, err)
	}
}

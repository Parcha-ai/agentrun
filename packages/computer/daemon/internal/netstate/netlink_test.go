package netstate_test

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/netstate"
)

// loopbackChildArg runs this test binary as loopbackChild (TestMain).
const loopbackChildArg = "loopback-up-child"

func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == loopbackChildArg {
		os.Exit(loopbackChild())
	}
	os.Exit(m.Run())
}

// loopbackChild, in a network namespace of its own: lo as it starts, LoopbackUp, then lo as it reads back. Prints
// "before <flags>", then "refused <why>" (exit 3) or "after <flags> <addresses>".
func loopbackChild() int {
	lo, err := net.InterfaceByName("lo")
	if err != nil {
		fmt.Println("refused", err)
		return 3
	}
	fmt.Println("before", lo.Flags)
	if err := netstate.LoopbackUp(); err != nil {
		fmt.Println("refused", err)
		return 3
	}
	// The RTM_NEWADDR LoopbackUp sends where the kernel gave lo no 127.0.0.1 (Linux always gives it): another loopback
	// address, added the same way.
	if err := netstate.AddAddress4(lo.Index, [4]byte{127, 0, 0, 2}, 8); err != nil {
		fmt.Println("refused adding 127.0.0.2/8:", err)
		return 3
	}
	lo, _ = net.InterfaceByName("lo")
	addrs, _ := lo.Addrs()
	shown := []string{}
	for _, addr := range addrs {
		shown = append(shown, addr.String())
	}
	fmt.Println("after", lo.Flags, strings.Join(shown, ","))
	return 0
}

// LoopbackUp brings a fresh network namespace's loopback up over rtnetlink, alone of the ways (gVisor's netstack takes
// no SIOCSIFFLAGS ioctl in a new namespace: ENOTTY, live on Modal's gVisor), as root of an unprivileged user namespace
// that owns the namespace, as init does there. It starts down; after, it is up and running with 127.0.0.1 on it, and
// LoopbackUp has read a listener there back. A host that gives this user no user namespace with a network namespace
// (Ubuntu's AppArmor userns restriction) skips it.
func TestLoopbackUpOverRtnetlinkInAFreshNetworkNamespace(t *testing.T) {
	cmd := exec.Command(os.Args[0], loopbackChildArg)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags:  syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET,
		UidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
		GidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}},
	}
	out, err := cmd.Output()
	text := string(out)
	if err != nil && (!strings.Contains(text, "before") || strings.Contains(text, "operation not permitted")) {
		t.Skipf("this host gives this user no user namespace with a network namespace whose root may bring its loopback up (%v: %s)", err, strings.TrimSpace(text))
	}
	if err != nil {
		t.Fatalf("LoopbackUp in a fresh network namespace: %v, %q", err, text)
	}
	before, after, _ := strings.Cut(strings.TrimSpace(text), "\n")
	if strings.Contains(before, "up") {
		t.Fatalf("lo started %q; want a fresh namespace's loopback down", before)
	}
	if !strings.Contains(after, "up") || !strings.Contains(after, "running") || !strings.Contains(after, "127.0.0.1/8") || !strings.Contains(after, "127.0.0.2/8") {
		t.Fatalf("lo after LoopbackUp and an added address: %q; want up, running, with 127.0.0.1/8 and 127.0.0.2/8", after)
	}
}

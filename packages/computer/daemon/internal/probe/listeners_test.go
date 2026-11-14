package probe_test

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/probe"
)

// find is the listener of protocol on port, if listed.
func find(search probe.ListenerSearch, protocol string, port int) (probe.Listener, bool) {
	for _, one := range search.Listeners {
		if one.Protocol == protocol && one.Port == port {
			return one, true
		}
	}
	return probe.Listener{}, false
}

// The isolation fence's listener listing, read from this process's own /proc: a TCP socket in LISTEN and a UDP socket
// bound with no peer are listed, by address and port, each tied to this process, which runs the probe's own program; a
// TCP connection and a UDP socket connected to a peer listen for no one and are not.
func TestListenersListsTheNamespacesListeningSocketsTiedToTheirProcess(t *testing.T) {
	tcp, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcp.Close()
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	client, err := net.Dial("tcp4", tcp.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	peered, err := net.Dial("udp4", udp.LocalAddr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer peered.Close()

	search := probe.Listeners("/proc")
	if len(search.Incomplete) != 0 {
		t.Fatalf("incomplete: %v", search.Incomplete)
	}
	command, _ := os.ReadFile("/proc/self/comm")
	self := fmt.Sprintf("pid %d (%s)", os.Getpid(), strings.TrimSpace(string(command)))
	for _, want := range []struct {
		protocol string
		port     int
	}{{"tcp", tcp.Addr().(*net.TCPAddr).Port}, {"udp", udp.LocalAddr().(*net.UDPAddr).Port}} {
		got, ok := find(search, want.protocol, want.port)
		if !ok {
			t.Fatalf("%s port %d is not listed: %+v", want.protocol, want.port, search.Listeners)
		}
		if got.Address != "127.0.0.1" || got.UID != os.Getuid() || got.Owner != self || !got.Computerd {
			t.Errorf("%s port %d: %+v, want 127.0.0.1, uid %d, owner %q, computerd", want.protocol, want.port, got, os.Getuid(), self)
		}
	}
	if got, ok := find(search, "tcp", client.LocalAddr().(*net.TCPAddr).Port); ok {
		t.Errorf("a TCP connection is listed as a listener: %+v", got)
	}
	if got, ok := find(search, "udp", peered.LocalAddr().(*net.UDPAddr).Port); ok {
		t.Errorf("a UDP socket connected to a peer is listed as a listener: %+v", got)
	}
}

// An IPv6 listener is read from tcp6, its address as the kernel holds it.
func TestListenersReadsIPv6(t *testing.T) {
	l, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skipf("no IPv6 loopback here: %v", err)
	}
	defer l.Close()
	got, ok := find(probe.Listeners("/proc"), "tcp6", l.Addr().(*net.TCPAddr).Port)
	if !ok || got.Address != "::1" || !got.Computerd {
		t.Fatalf("tcp6 [::1]:%d: %+v (listed: %v)", l.Addr().(*net.TCPAddr).Port, got, ok)
	}
}

// write makes path, and its folders, holding text.
func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// link makes path, and its folders, a symbolic link to target.
func link(t *testing.T, target, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
}

const tableHead = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"

// A /proc laid out by hand: a listener whose holder runs the probe's own program is computerd's; one held by another
// program is named with its pid and command and is not; one whose holder the probe cannot read has no owner. A table the
// kernel lacks holds nothing; one it cannot read is named, so a search with it proves nothing.
func TestListenersTiesEachListenerToItsHolderByInode(t *testing.T) {
	proc := t.TempDir()
	write(t, filepath.Join(proc, "computerd"), "the probe's program")
	write(t, filepath.Join(proc, "python3"), "another program")
	link(t, filepath.Join(proc, "computerd"), filepath.Join(proc, "self", "exe"))
	write(t, filepath.Join(proc, "net", "tcp"), tableHead+
		"   0: 00000000:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 100 0 0 10 0\n"+
		"   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 333 1 0 100 0 0 10 0\n"+
		"   2: 00000000:9C40 00000000:0CEA 01 00000000:00000000 00:00000000 00000000  1000        0 444 1 0 100 0 0 10 0\n")
	write(t, filepath.Join(proc, "net", "udp"), tableHead+
		"   0: 00000000:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 222 2 0 0 0\n"+
		"   1: 00000000:A000 00000000:0035 01 00000000:00000000 00:00000000 00000000  1000        0 555 2 0 0 0\n")
	if err := os.MkdirAll(filepath.Join(proc, "net", "udp6"), 0o755); err != nil {
		t.Fatal(err)
	}
	link(t, "socket:[111]", filepath.Join(proc, "42", "fd", "3"))
	link(t, filepath.Join(proc, "computerd"), filepath.Join(proc, "42", "exe"))
	write(t, filepath.Join(proc, "42", "comm"), "computerd\n")
	link(t, "pipe:[999]", filepath.Join(proc, "43", "fd", "0"))
	link(t, "socket:[222]", filepath.Join(proc, "43", "fd", "5"))
	link(t, filepath.Join(proc, "python3"), filepath.Join(proc, "43", "exe"))
	write(t, filepath.Join(proc, "43", "comm"), "python3\n")

	search := probe.Listeners(proc)
	want := []probe.Listener{
		{Protocol: "tcp", Address: "0.0.0.0", Port: 3306, UID: 1000, Owner: "pid 42 (computerd)", Computerd: true},
		{Protocol: "tcp", Address: "0.0.0.0", Port: 8080, UID: 0},
		{Protocol: "udp", Address: "0.0.0.0", Port: 53, UID: 1000, Owner: "pid 43 (python3)"},
	}
	if fmt.Sprint(search.Listeners) != fmt.Sprint(want) {
		t.Errorf("listeners:\n got %+v\nwant %+v", search.Listeners, want)
	}
	if len(search.Incomplete) != 1 || !strings.Contains(search.Incomplete[0], filepath.Join(proc, "net", "udp6")) {
		t.Errorf("incomplete: %v, want the unreadable udp6 alone (tcp6 is absent: no listener)", search.Incomplete)
	}
}

package probe_test

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/probe"
)

// shortDir is a folder whose paths fit a unix socket's 107 bytes (t.TempDir's carry the test's long name).
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "pso-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

func listed(search probe.SocketSearch) string {
	parts := []string{}
	for _, socket := range search.Sockets {
		parts = append(parts, socket.Type+" "+socket.Path)
	}
	return strings.Join(parts, ",")
}

// The isolation fence's listing, in computerd so no image lacks it: every unix socket with a path a program can connect
// to, under the roots walked and among /proc/net/unix's paths, by its real path and the type that connected.
func TestConnectableSocketsListsThoseThatAcceptByTheirRealPathAndTypeAndNoOther(t *testing.T) {
	dir := shortDir(t)
	stream := filepath.Join(dir, "stream.sock")
	l, err := net.Listen("unix", stream)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	// Review (#1994, PRRT_kwDOUmdVMs61HER9): a datagram or seqpacket socket is reachable too, and only a stream dial was
	// tried.
	dgram := filepath.Join(dir, "dgram.sock")
	d, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: dgram, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	seqpacket := filepath.Join(dir, "seqpacket.sock")
	p, err := net.Listen("unixpacket", seqpacket)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	// A socket file no one listens on any more: refused on every type.
	dead := filepath.Join(dir, "dead.sock")
	gone, err := net.Listen("unix", dead)
	if err != nil {
		t.Fatal(err)
	}
	gone.(*net.UnixListener).SetUnlinkOnClose(false)
	gone.Close()
	if err := os.WriteFile(filepath.Join(dir, "file"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(stream, filepath.Join(dir, "link.sock")); err != nil {
		t.Fatal(err)
	}
	// A socket elsewhere, named only by /proc/net/unix's text, as one bound outside the walked roots.
	named := filepath.Join(shortDir(t), "named.sock")
	l2, err := net.Listen("unix", named)
	if err != nil {
		t.Fatal(err)
	}
	defer l2.Close()
	netUnix := "Num       RefCount Protocol Flags    Type St Inode Path\n" +
		"0000000000000000: 00000002 00000000 00010000 0001 01 12345 " + named + "\n" +
		"0000000000000000: 00000002 00000000 00010000 0001 01 12346 @abstract-name\n"

	search := probe.ConnectableSockets([]string{dir}, netUnix, probe.SocketBounds{Entries: 1000, Depth: 8}, 2*time.Second)
	want := fmt.Sprintf("dgram %s,seqpacket %s,stream %s,stream %s", dgram, seqpacket, stream, named)
	if got := listed(search); got != want {
		t.Fatalf("ConnectableSockets = %s; want %s (not the dead socket, the file, the link again or the abstract name)", got, want)
	}
	if len(search.Incomplete) != 0 {
		t.Fatalf("a search within its bounds reports itself incomplete: %v", search.Incomplete)
	}
}

// Review (#1994, PRRT_kwDOUmdVMs61HBO1): a search that stopped at a bound returned a partial list as if whole, and one
// shared count let a large root leave the next unsearched. Each root has its own budget, and a bound reached is said.
func TestConnectableSocketsSaysWhichRootItCouldNotSearchWholeAndGivesEachRootItsOwnBudget(t *testing.T) {
	big := shortDir(t)
	for i := 0; i < 20; i++ {
		if err := os.WriteFile(filepath.Join(big, fmt.Sprintf("f%02d", i)), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	deep := shortDir(t)
	if err := os.MkdirAll(filepath.Join(deep, "a", "b", "c"), 0o755); err != nil {
		t.Fatal(err)
	}
	small := shortDir(t)
	socket := filepath.Join(small, "s.sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	search := probe.ConnectableSockets([]string{big, deep, small}, "", probe.SocketBounds{Entries: 10, Depth: 2}, 2*time.Second)
	if got := listed(search); got != "stream "+socket {
		t.Fatalf("ConnectableSockets = %s; want the socket in the root after the large one, searched with its own budget", got)
	}
	words := strings.Join(search.Incomplete, "; ")
	if len(search.Incomplete) != 2 || !strings.Contains(words, big) || !strings.Contains(words, "10 entries") || !strings.Contains(words, deep) || !strings.Contains(words, "deeper than 2") {
		t.Fatalf("Incomplete = %q; want the large root (its entry budget) and the deep one (its depth), each named", search.Incomplete)
	}
}

package probe_test

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/probe"
)

// The isolation fence's listing, in computerd so no image lacks it (it ran through python3): every unix socket with a
// path a program can connect to, under the roots walked and among /proc/net/unix's paths, by its real path.
func TestConnectableSocketsListsThoseThatAcceptByTheirRealPathAndNoOther(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	live := filepath.Join(dir, "live.sock")
	listener, err := net.Listen("unix", live)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	// A socket file no one listens on any more: connect is refused.
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
	// A link to the live socket is the same socket: listed once, by its real path.
	if err := os.Symlink(live, filepath.Join(dir, "link.sock")); err != nil {
		t.Fatal(err)
	}
	// A socket elsewhere, named only by /proc/net/unix's text, as one bound outside the walked roots.
	other, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	named := filepath.Join(other, "named.sock")
	listener2, err := net.Listen("unix", named)
	if err != nil {
		t.Fatal(err)
	}
	defer listener2.Close()
	netUnix := "Num       RefCount Protocol Flags    Type St Inode Path\n" +
		"0000000000000000: 00000002 00000000 00010000 0001 01 12345 " + named + "\n" +
		"0000000000000000: 00000002 00000000 00010000 0001 01 12346 @abstract-name\n"

	got := probe.ConnectableSockets([]string{dir}, netUnix, 2*time.Second)
	want := []string{live, named}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("ConnectableSockets = %v; want %v (not the dead socket, the file, the link again or the abstract name)", got, want)
	}
}

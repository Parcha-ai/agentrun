package probe_test

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
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

// listed is the search's sockets as "type path", sorted, so a comparison holds whatever order the temp folders' random
// names sort in (CI run 42553902900: the named socket's folder sorted before the walked one's).
func listed(search probe.SocketSearch) string {
	parts := []string{}
	for _, socket := range search.Sockets {
		parts = append(parts, socket.Type+" "+socket.Path)
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// table writes text as a /proc/net/unix for ConnectableSockets to read, and gives its path.
func table(t *testing.T, text string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "unix")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// Review (#2787, PRRT_kwDOUmdVMs63e4QV): /proc/net/unix that could not be read was taken for an empty one, and the
// search said nothing of the abstract names it never tried.
func TestConnectableSocketsSaysWhenItCouldNotReadTheTableOfAbstractNames(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "unix")
	search := probe.ConnectableSockets(nil, missing, probe.DefaultSocketBounds, 2*time.Second)
	if len(search.Incomplete) != 1 || !strings.Contains(search.Incomplete[0], missing) || !strings.Contains(search.Incomplete[0], "no abstract name was tried") {
		t.Fatalf("Incomplete = %q; want the table named, and that no abstract name was tried", search.Incomplete)
	}
}

// set is the same for the sockets a test expects.
func set(entries ...string) string {
	sort.Strings(entries)
	return strings.Join(entries, ",")
}

// The isolation fence's listing, in computerd so no image lacks it: every unix socket a program can connect to, under
// the roots walked and among /proc/net/unix's paths and abstract names, by its real path or its name and the type that
// connected.
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
	// An abstract name, which no folder holds: a session bus on E2B (dbus 1.12's unix:tmpdir) is one. The network
	// namespace holds it, and a program in the namespace reaches it. An abstract name no one listens on is refused.
	abstract := fmt.Sprintf("@pso-%d", time.Now().UnixNano())
	l3, err := net.Listen("unix", abstract)
	if err != nil {
		t.Fatal(err)
	}
	defer l3.Close()
	// Review (#2787, PRRT_kwDOUmdVMs63e4QR): a name with spaces was split into fields, and its first word, which no one
	// listens on, was tried instead. The kernel pads the inode on the left.
	spaced := fmt.Sprintf("@pso %d bus", time.Now().UnixNano())
	l4, err := net.Listen("unix", spaced)
	if err != nil {
		t.Fatal(err)
	}
	defer l4.Close()
	netUnix := table(t, "Num       RefCount Protocol Flags    Type St Inode Path\n"+
		"0000000000000000: 00000002 00000000 00010000 0001 01 12345 "+named+"\n"+
		"0000000000000000: 00000002 00000000 00010000 0001 01 12346 "+abstract+"\n"+
		"0000000000000000: 00000002 00000000 00010000 0001 01   347 "+spaced+"\n"+
		"0000000000000000: 00000002 00000000 00000000 0002 01 12348\n"+
		"0000000000000000: 00000002 00000000 00010000 0001 01 12349 @pso-no-one-listens\n")

	search := probe.ConnectableSockets([]string{dir}, netUnix, probe.SocketBounds{Entries: 1000, Depth: 8}, 2*time.Second)
	want := set("dgram "+dgram, "seqpacket "+seqpacket, "stream "+stream, "stream "+named, "stream "+abstract, "stream "+spaced)
	if got := listed(search); got != want {
		t.Fatalf("ConnectableSockets = %s; want %s (not the dead socket, the file, the link again or the abstract name no one listens on)", got, want)
	}
	if len(search.Incomplete) != 0 {
		t.Fatalf("a search within its bounds reports itself incomplete: %v", search.Incomplete)
	}
}

// Review (#1994, PRRT_kwDOUmdVMs61HBO1): a search that stopped at a bound returned a partial list as if whole, and one
// shared count let a large root leave the next unsearched. Each root has its own budget, and a bound reached is said.
func TestConnectableSocketsSaysWhichRootItCouldNotSearchWholeAndGivesEachRootItsOwnBudget(t *testing.T) {
	big := shortDir(t)
	many := filepath.Join(big, "many")
	if err := os.Mkdir(many, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		if err := os.WriteFile(filepath.Join(many, fmt.Sprintf("f%02d", i)), nil, 0o600); err != nil {
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

	search := probe.ConnectableSockets([]string{big, deep, small}, table(t, ""), probe.SocketBounds{Entries: 10, Depth: 2}, 2*time.Second)
	if got := listed(search); got != "stream "+socket {
		t.Fatalf("ConnectableSockets = %s; want the socket in the root after the large one, searched with its own budget", got)
	}
	words := strings.Join(search.Incomplete, "; ")
	if len(search.Incomplete) != 2 || !strings.Contains(words, big) || !strings.Contains(words, "10 entries") || !strings.Contains(words, deep) || !strings.Contains(words, "deeper than 2") {
		t.Fatalf("Incomplete = %q; want the large root (its entry budget) and the deep one (its depth), each named", search.Incomplete)
	}
	// The root itself, then many and 8 of its files fill the 10: the words name the folder that filled the budget.
	if !strings.Contains(words, "(most under "+many+" 9)") {
		t.Fatalf("Incomplete = %q; want the stopped walk to name %s, which filled its budget, with its 9 entries", search.Incomplete, many)
	}
}

func TestConnectableSocketsNamesTheThreeHeaviestFoldersOfAStoppedWalkMostFirst(t *testing.T) {
	// a, b, c and d hold 1, 4, 3 and 2 files, so with each folder they are 2, 5, 4 and 3 entries. With the root that is
	// 15, the budget, and z, walked last, stops the walk.
	root := shortDir(t)
	for folder, files := range map[string]int{"a": 1, "b": 4, "c": 3, "d": 2} {
		if err := os.Mkdir(filepath.Join(root, folder), 0o755); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < files; i++ {
			if err := os.WriteFile(filepath.Join(root, folder, fmt.Sprintf("f%d", i)), nil, 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.WriteFile(filepath.Join(root, "z"), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	search := probe.ConnectableSockets([]string{root}, table(t, ""), probe.SocketBounds{Entries: 15, Depth: 8}, 2*time.Second)
	want := fmt.Sprintf("(most under %s 5, %s 4, %s 3)", filepath.Join(root, "b"), filepath.Join(root, "c"), filepath.Join(root, "d"))
	if len(search.Incomplete) != 1 || !strings.HasSuffix(search.Incomplete[0], want) {
		t.Fatalf("Incomplete = %q; want the stopped walk to end %q: the three heaviest, most first, and not a (2 entries)", search.Incomplete, want)
	}
}

// cloudflare-dial-live-10 (11-17): Cloudflare's runtime mounts proc and sysfs at /run/cloudchamber, about 58,000 entries,
// and the walk of /run stopped at its 50,000 budget, so isolation.vendor-agent failed on a search with no socket left in
// it. A test cannot mount proc in a temp folder, but a Linux box has /proc and /sys: walked as roots with a budget of 10
// entries, each is skipped at once, named with its filesystem, and the search is whole.
func TestConnectableSocketsDoesNotGoIntoProcOrSysfsAndSaysSo(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("proc and sysfs are Linux's")
	}
	for _, fs := range []struct {
		root, name string
		magic      int64
	}{{"/proc", "proc", 0x9fa0}, {"/sys", "sysfs", 0x62656572}} {
		var st syscall.Statfs_t
		if err := syscall.Statfs(fs.root, &st); err != nil || int64(st.Type) != fs.magic {
			if fs.name == "proc" {
				t.Fatalf("/proc is not proc here (statfs: %v, type %#x)", err, st.Type)
			}
			t.Logf("%s is not %s here; not tried", fs.root, fs.name)
			continue
		}
		search := probe.ConnectableSockets([]string{fs.root}, table(t, ""), probe.SocketBounds{Entries: 10, Depth: 8}, 2*time.Second)
		want := fs.root + " (" + fs.name + ")"
		if len(search.Skipped) != 1 || search.Skipped[0] != want {
			t.Fatalf("Skipped = %q; want [%q]", search.Skipped, want)
		}
		if len(search.Incomplete) != 0 {
			t.Fatalf("Incomplete = %q; want none: a skipped %s costs the budget nothing", search.Incomplete, fs.name)
		}
	}
}

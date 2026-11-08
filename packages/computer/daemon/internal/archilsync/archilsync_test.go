package archilsync_test

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/archilsync"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// box is a scratch computer: a mount table with the archil mount at its mountpoint, and the socket's place.
type box struct {
	dir, socket, mountpoint, mounts string
}

func newBox(t *testing.T) box {
	t.Helper()
	dir := t.TempDir()
	b := box{dir: dir, socket: filepath.Join(dir, "run", "archil.sock"), mountpoint: filepath.Join(dir, "workspace"), mounts: filepath.Join(dir, "mounts")}
	b.mount(t, true)
	return b
}

func (b box) mount(t *testing.T, mounted bool) {
	t.Helper()
	table := "proc /proc proc rw,hidepid=invisible 0 0\n"
	if mounted {
		table += "dsk-00000000000baf76:/agents/a/runs/r/work[aws-us-east-1] " + b.mountpoint + " fuse.archil rw 0 0\n"
	}
	if err := os.WriteFile(b.mounts, []byte(table), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (b box) config() archilsync.Config {
	return archilsync.Config{Socket: b.socket, Mountpoint: b.mountpoint, Mounts: b.mounts, GID: os.Getegid(), Poll: 20 * time.Millisecond}
}

// serve prepares the socket and serves it with sync, until the test ends or the server exits on its own.
func (b box) serve(t *testing.T, sync func(context.Context) int) <-chan error {
	t.Helper()
	l, err := archilsync.Listen(b.config())
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- archilsync.Serve(ctx, l, b.config(), sync) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Error("the server did not stop")
		}
	})
	return done
}

// raw sends bytes on a fresh connection, half-closes it, and reads what comes back.
func raw(t *testing.T, socket string, send []byte) []byte {
	t.Helper()
	conn, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if len(send) > 0 {
		if _, err := conn.Write(send); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	_ = conn.(*net.UnixConn).CloseWrite()
	got := make([]byte, 8)
	n, _ := conn.Read(got)
	return got[:n]
}

func TestOneRequestByteRunsOneSyncAndAnswersItsExitCode(t *testing.T) {
	b := newBox(t)
	var runs atomic.Int32
	b.serve(t, func(context.Context) int { runs.Add(1); return 7 })
	code, err := archilsync.Ask(context.Background(), b.socket)
	if err != nil || code != 7 {
		t.Fatalf("Ask = %d, %v; want 7", code, err)
	}
	if runs.Load() != 1 {
		t.Fatalf("syncs = %d, want 1", runs.Load())
	}
}

func TestAnyOtherInputIsRefusedAndNothingRuns(t *testing.T) {
	b := newBox(t)
	var runs atomic.Int32
	b.serve(t, func(context.Context) int { runs.Add(1); return 0 })
	for _, send := range [][]byte{nil, []byte("x"), []byte("ss"), []byte("s\n"), []byte("sync"), {0}} {
		if got := raw(t, b.socket, send); len(got) != 0 {
			t.Errorf("%q answered %q, want nothing", send, got)
		}
	}
	if runs.Load() != 0 {
		t.Fatalf("syncs = %d, want 0", runs.Load())
	}
	// And the server still answers the one request after.
	if got := raw(t, b.socket, []byte{archilsync.Request}); len(got) != 1 || got[0] != 0 {
		t.Fatalf("after the refusals, a request answered %q", got)
	}
}

func TestCoalescedTheRequestsDuringASyncShareOneMore(t *testing.T) {
	b := newBox(t)
	var runs atomic.Int32
	release := make(chan struct{})
	started := make(chan struct{}, 4)
	b.serve(t, func(context.Context) int {
		n := runs.Add(1)
		started <- struct{}{}
		if n == 1 {
			<-release
		}
		return int(n)
	})
	var wg sync.WaitGroup
	codes := make([]int, 4)
	ask := func(i int) {
		defer wg.Done()
		code, err := archilsync.Ask(context.Background(), b.socket)
		if err != nil {
			t.Errorf("Ask %d: %v", i, err)
		}
		codes[i] = code
	}
	wg.Add(1)
	go ask(0)
	<-started
	for i := 1; i < 4; i++ {
		wg.Add(1)
		go ask(i)
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	wg.Wait()
	if runs.Load() != 2 {
		t.Fatalf("syncs = %d, want 2: the one in flight, then one shared", runs.Load())
	}
	if codes[0] != 1 || codes[1] != 2 || codes[2] != 2 || codes[3] != 2 {
		t.Fatalf("codes = %v, want [1 2 2 2]", codes)
	}
}

func TestTheServerExitsWhenTheMountGoes(t *testing.T) {
	b := newBox(t)
	done := b.serve(t, func(context.Context) int { return 0 })
	b.mount(t, false)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the server did not exit when the mount went")
	}
	if _, err := os.Lstat(b.socket); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the socket is left: %v", err)
	}
}

func TestTheServerExitsWhenItsSocketIsTakenAwayAndLeavesANewOneAlone(t *testing.T) {
	b := newBox(t)
	done := b.serve(t, func(context.Context) int { return 0 })
	if err := os.Remove(b.socket); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b.socket, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the server did not exit when its socket was taken away")
	}
	if info, err := os.Lstat(b.socket); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("the file put in its place is gone or changed: %v", err)
	}
}

func TestListenMakesTheFolderAndSocketTheGroupsAndRefusesWhatIsNotItsOwn(t *testing.T) {
	b := newBox(t)
	l, err := archilsync.Listen(b.config())
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	for path, want := range map[string]os.FileMode{filepath.Dir(b.socket): os.ModeDir | 0o750, b.socket: os.ModeSocket | 0o660} {
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode() != want {
			t.Errorf("%s mode %v, want %v", path, info.Mode(), want)
		}
		st := info.Sys().(*syscall.Stat_t)
		if int(st.Uid) != os.Geteuid() || int(st.Gid) != os.Getegid() {
			t.Errorf("%s is %d:%d, want %d:%d", path, st.Uid, st.Gid, os.Geteuid(), os.Getegid())
		}
	}

	// A folder that is a link is refused.
	linked := newBox(t)
	if err := os.Symlink(t.TempDir(), filepath.Dir(linked.socket)); err != nil {
		t.Fatal(err)
	}
	if _, err := archilsync.Listen(linked.config()); err == nil {
		t.Error("Listen took a folder that is a link")
	}
	// Nothing mounted: refused, as the helper's exit 3.
	bare := newBox(t)
	bare.mount(t, false)
	if _, err := archilsync.Listen(bare.config()); !errors.Is(err, archilsync.ErrNotMounted) {
		t.Errorf("Listen with nothing mounted = %v, want ErrNotMounted", err)
	}
}

func TestListenReplacesAStaleSocketAndFindsALiveOne(t *testing.T) {
	b := newBox(t)
	if err := os.MkdirAll(filepath.Dir(b.socket), 0o750); err != nil {
		t.Fatal(err)
	}
	stale, err := net.Listen("unix", b.socket)
	if err != nil {
		t.Fatal(err)
	}
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = stale.Close()
	l, err := archilsync.Listen(b.config())
	if err != nil {
		t.Fatalf("Listen over a stale socket: %v", err)
	}
	if _, err := archilsync.Listen(b.config()); !errors.Is(err, archilsync.ErrServing) {
		t.Errorf("Listen while one serves = %v, want ErrServing", err)
	}
	_ = l.Close()
}

func TestAskWithNoServerIsNotFoundInWords(t *testing.T) {
	_, err := archilsync.Ask(context.Background(), filepath.Join(t.TempDir(), "archil.sock"))
	var e *rpc.Error
	if !errors.As(err, &e) || e.Kind != rpc.KindNotFound {
		t.Fatalf("Ask = %v, want not_found", err)
	}
}

// sync-serve takes exactly the helper's fixed arguments, each once, every path absolute.
func TestConfigOfTakesTheHelpersFixedArgumentsAlone(t *testing.T) {
	good := []string{"--socket", "/run/agentrun-archil/archil.sock", "--mountpoint", "/workspace", "--mounts", "/proc/self/mounts", "--archil", "/usr/bin/archil", "--gid", "2510"}
	config, err := archilsync.ConfigOf(good)
	if err != nil {
		t.Fatal(err)
	}
	if config.Socket != "/run/agentrun-archil/archil.sock" || config.Mountpoint != "/workspace" || config.Mounts != "/proc/self/mounts" || config.Archil != "/usr/bin/archil" || config.GID != 2510 {
		t.Fatalf("ConfigOf = %+v", config)
	}
	bad := [][]string{
		nil,
		good[:8],
		append(append([]string{}, good...), "--gid", "2510"),
		append(append([]string{}, good...), "--token", "x"),
		{"--socket", "run/archil.sock", "--mountpoint", "/workspace", "--mounts", "/proc/self/mounts", "--archil", "/usr/bin/archil", "--gid", "2510"},
		{"--socket", "/run/agentrun-archil/archil.sock", "--mountpoint", "/workspace", "--mounts", "/proc/self/mounts", "--archil", "/usr/bin/archil", "--gid", "0"},
		{"--socket", "/run/agentrun-archil/archil.sock", "--mountpoint", "/workspace", "--mounts", "/proc/self/mounts", "--archil", "/usr/bin/archil", "--gid", "x"},
	}
	for _, args := range bad {
		if _, err := archilsync.ConfigOf(args); err == nil {
			t.Errorf("ConfigOf(%q) took it", args)
		}
	}
}

func TestRunSyncAnswersTheClientsExitCode(t *testing.T) {
	dir := t.TempDir()
	archil := filepath.Join(dir, "archil")
	if err := os.WriteFile(archil, []byte("#!/bin/sh\n[ \"$1 $2\" = \"sync "+dir+"\" ] || exit 9\nexit 5\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if code := archilsync.RunSync(archil, dir, time.Second)(context.Background()); code != 5 {
		t.Fatalf("RunSync = %d, want 5", code)
	}
	if code := archilsync.RunSync(filepath.Join(dir, "missing"), dir, time.Second)(context.Background()); code != 127 {
		t.Fatalf("RunSync of a missing client = %d, want 127", code)
	}
	slow := filepath.Join(dir, "slow")
	if err := os.WriteFile(slow, []byte("#!/bin/sh\nexec sleep 5\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if code := archilsync.RunSync(slow, dir, 100*time.Millisecond)(context.Background()); code != 124 {
		t.Fatalf("RunSync past its bound = %d, want 124", code)
	}
}

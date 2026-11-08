package process_test

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// running says whether pid runs (a zombie has ended).
func running(pid int) bool {
	state, ok := stateOf(pid)
	return ok && state != "Z"
}

// still fails unless id still runs: a wait of ms answers running.
func still(t *testing.T, tbl *process.Table, id string, d time.Duration) {
	t.Helper()
	res, err := tbl.Wait(context.Background(), process.WaitParams{ID: id, TimeoutMs: ms(d)})
	if err != nil || !res.Running {
		t.Fatalf("%s after %v: %+v %v", id, d, res, err)
	}
}

// A log is a file computerd makes and writes the first LogBytes of the output to, stdout and stderr as they come; the
// "log" stream reads it from computerd's own open file, by offset, and says when later output was dropped.
func TestLogKeepsTheFirstBytes(t *testing.T) {
	tbl := table(t, process.Options{LogBytes: 10})
	path := filepath.Join(t.TempDir(), "background", "1", "output.log")
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "printf 0123456789abcdef; printf XY >&2"}, Log: path})
	wait(t, tbl, p.ID)
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "0123456789" {
		t.Fatalf("the file: %q %v", data, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("its mode: %v %v", info.Mode(), err)
	}
	if got := readAll(t, tbl, p.ID, "log"); got != "0123456789" {
		t.Fatalf("the log stream %q", got)
	}
	three := 3
	res, err := tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "log", Offset: off(4), MaxBytes: &three})
	if err != nil || string(res.Data) != "456" || res.NextOffset != 7 || res.Size != 10 || !res.Capped || res.Exited {
		t.Fatalf("read at 4, 3 bytes: %+v %v", res, err)
	}
	if _, err := tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "log", Offset: off(11)}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("a read past the log's end: %v", err)
	}
	// The stream is read from computerd's own open file: a rename under it changes nothing.
	if err := os.Rename(path, path+".moved"); err != nil {
		t.Fatal(err)
	}
	if got := readAll(t, tbl, p.ID, "log"); got != "0123456789" {
		t.Fatalf("the log stream after a rename %q", got)
	}
	short := start(t, tbl, process.StartParams{Argv: []string{"printf", "hi"}, Log: filepath.Join(filepath.Dir(path), "short.log")})
	wait(t, tbl, short.ID)
	res, err = tbl.Read(context.Background(), process.ReadParams{ID: short.ID, Stream: "log", Offset: off(0)})
	if err != nil || string(res.Data) != "hi" || res.Size != 2 || res.Capped || !res.Exited {
		t.Fatalf("a log under its cap: %+v %v", res, err)
	}
	if _, err := tbl.Read(context.Background(), process.ReadParams{ID: short.ID, Stream: "log", Offset: off(0)}); err != nil {
		t.Fatal(err)
	}
	plain := start(t, tbl, process.StartParams{Argv: []string{"true"}})
	if _, err := tbl.Read(context.Background(), process.ReadParams{ID: plain.ID, Stream: "log", Offset: off(0)}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("the log of a process with none: %v", err)
	}
}

// The run's folder is writable by the program's user, so a link planted at the log's path or at any directory on its
// way is refused, the program never starts, and nothing is written where the link points.
func TestLogRefusesLinks(t *testing.T) {
	tbl := table(t, process.Options{})
	dir := t.TempDir()
	outside := filepath.Join(dir, "outside")
	if err := os.Mkdir(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "target.log"), filepath.Join(dir, "a", "output.log")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "background")); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{
		"a link at the log's path": filepath.Join(dir, "a", "output.log"),
		"a link at a parent":       filepath.Join(dir, "background", "1", "output.log"),
	} {
		_, err := tbl.Start(context.Background(), process.StartParams{Argv: []string{"sh", "-c", "echo ran > " + filepath.Join(dir, "ran")}, Log: path})
		if err == nil || kindOf(t, err) != rpc.KindDenied {
			t.Fatalf("%s: %v", name, err)
		}
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("written through a link: %v %v", entries, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "ran")); !os.IsNotExist(err) {
		t.Fatalf("the program ran: %v", err)
	}
	if got := listAll(t, tbl); len(got) != 0 {
		t.Fatalf("a refused start is in the table: %+v", got)
	}
	existing := filepath.Join(dir, "a", "existing.log")
	if err := os.WriteFile(existing, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := tbl.Start(context.Background(), process.StartParams{Argv: []string{"true"}, Log: existing}); err == nil || kindOf(t, err) != rpc.KindExists {
		t.Fatalf("a file at the log's path: %v", err)
	}
	if data, _ := os.ReadFile(existing); string(data) != "before" {
		t.Fatalf("the file there was written: %q", data)
	}
	if _, err := tbl.Start(context.Background(), process.StartParams{Argv: []string{"true"}, Log: "relative/output.log"}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("a relative path: %v", err)
	}
	// A start that fails after its log is made leaves no log behind.
	failed := filepath.Join(dir, "a", "failed.log")
	if _, err := tbl.Start(context.Background(), process.StartParams{Argv: []string{"no-such-program-here"}, Log: failed}); err == nil {
		t.Fatal("a missing program started")
	}
	if _, err := os.Lstat(failed); !os.IsNotExist(err) {
		t.Fatalf("a failed start's log is left: %v", err)
	}
}

// With waitGroup, a process runs until its program and every process left in its group have ended, and reports the
// program's own exit: a job started with & keeps it running, and a signal reaches that job after the shell is gone.
func TestWaitGroupRunsUntilTheGroupIsEmpty(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "sleep 1 & echo started"}, WaitGroup: true})
	still(t, tbl, p.ID, 300*time.Millisecond)
	if res := wait(t, tbl, p.ID); res.ExitCode == nil || *res.ExitCode != 0 || res.Signal != nil {
		t.Fatalf("its end: %+v", res)
	}
	job := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "sleep 300 >/dev/null 2>&1 & echo $!; exit 3"}, WaitGroup: true})
	var offset int64
	pids := pidsIn(t, readUntil(t, tbl, job.ID, "stdout", &offset, "\n"))
	still(t, tbl, job.ID, 300*time.Millisecond)
	if _, err := tbl.Signal(process.SignalParams{ID: job.ID, Signal: "TERM"}); err != nil {
		t.Fatal(err)
	}
	if res := wait(t, tbl, job.ID); res.ExitCode == nil || *res.ExitCode != 3 || res.Signal != nil {
		t.Fatalf("the program's own exit, once TERM ended its job: %+v", res)
	}
	gone(t, pids[0])
	tty := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "sleep 1 & echo started"}, WaitGroup: true, Pty: &process.Size{Cols: 80, Rows: 24}})
	still(t, tbl, tty.ID, 300*time.Millisecond)
	if res := wait(t, tbl, tty.ID); res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("on a terminal: %+v", res)
	}
}

// With orphans "keep", a process that left the program's group (its own session, a daemon) runs on after the process
// ends, to the computer's end; without it, it is ended with the process (TestWhenTheProgramEndsItsWholeTreeEnds).
func TestOrphansKeptRunOn(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "setsid sleep 301 >/dev/null 2>&1 < /dev/null & echo $!"}, WaitGroup: true, Orphans: "keep"})
	if res := wait(t, tbl, p.ID); res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("its end: %+v", res)
	}
	pid := pidsIn(t, readAll(t, tbl, p.ID, "stdout"))[0]
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	time.Sleep(500 * time.Millisecond)
	if !running(pid) {
		t.Fatalf("the daemon %d was ended with the process", pid)
	}
	if _, err := tbl.Signal(process.SignalParams{ID: p.ID, Signal: "KILL"}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if !running(pid) {
		t.Fatalf("a signal to the ended process reached the daemon %d", pid)
	}
	if _, err := tbl.Start(context.Background(), process.StartParams{Argv: []string{"true"}, Orphans: "end"}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("orphans other than keep: %v", err)
	}
}

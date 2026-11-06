package process_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// TestMain runs the guard when a start runs this test binary as one, as computerd does.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == execrun.GuardCommand {
		os.Exit(execrun.Guard())
	}
	os.Exit(m.Run())
}

// patience bounds every wait on a program in these tests. The host may be loaded: it is never a claim about speed.
const patience = 30 * time.Second

func table(t *testing.T, opts process.Options) *process.Table {
	t.Helper()
	tbl := process.NewTable(opts)
	t.Cleanup(func() {
		for _, p := range listAll(t, tbl) {
			if p.Running {
				_, _ = tbl.Signal(process.SignalParams{ID: p.ID, Signal: "KILL"})
				_, _ = tbl.Wait(context.Background(), process.WaitParams{ID: p.ID, TimeoutMs: ms(patience)})
			}
		}
	})
	return tbl
}

// listAll pages a listing from its start until a page is not truncated.
func listAll(t *testing.T, tbl *process.Table) []process.Info {
	t.Helper()
	var all []process.Info
	params := process.ListParams{}
	for range 1000 {
		page, err := tbl.List(params)
		if err != nil {
			t.Fatalf("list from %v: %v", params.From, err)
		}
		all = append(all, page.Processes...)
		if !page.Truncated {
			return all
		}
		next := page.Next
		params.From = &next
	}
	t.Fatal("a listing that never ends")
	return nil
}

func ms(d time.Duration) *int64 {
	v := d.Milliseconds()
	return &v
}

func off(v int64) *int64 { return &v }

func start(t *testing.T, tbl *process.Table, params process.StartParams) process.StartResult {
	t.Helper()
	res, err := tbl.Start(params)
	if err != nil {
		t.Fatalf("start %q: %v", params.Argv, err)
	}
	if res.ID == "" || res.Pid <= 0 {
		t.Fatalf("start %q: %+v", params.Argv, res)
	}
	return res
}

func kindOf(t *testing.T, err error) rpc.Kind {
	t.Helper()
	var e *rpc.Error
	if !errors.As(err, &e) {
		t.Fatalf("want an *rpc.Error, got %v", err)
	}
	return e.Kind
}

func wait(t *testing.T, tbl *process.Table, id string) process.WaitResult {
	t.Helper()
	res, err := tbl.Wait(context.Background(), process.WaitParams{ID: id, TimeoutMs: ms(patience)})
	if err != nil {
		t.Fatalf("wait %s: %v", id, err)
	}
	if res.Running {
		t.Fatalf("%s still runs after %v", id, patience)
	}
	return res
}

// readAll reads a stream from offset 0 until the process has ended and every byte is read.
func readAll(t *testing.T, tbl *process.Table, id, stream string) string {
	t.Helper()
	var out bytes.Buffer
	offset := int64(0)
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		res, err := tbl.Read(context.Background(), process.ReadParams{ID: id, Stream: stream, Offset: off(offset), WaitMs: 1000})
		if err != nil {
			t.Fatalf("read %s %s at %d: %v", id, stream, offset, err)
		}
		out.Write(res.Data)
		offset = res.NextOffset
		if res.Exited {
			return out.String()
		}
	}
	t.Fatalf("%s %s did not end within %v; read %q", id, stream, patience, out.String())
	return ""
}

// readUntil reads a stream from *offset until what was read holds want.
func readUntil(t *testing.T, tbl *process.Table, id, stream string, offset *int64, want string) string {
	t.Helper()
	var out bytes.Buffer
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		res, err := tbl.Read(context.Background(), process.ReadParams{ID: id, Stream: stream, Offset: off(*offset), WaitMs: 1000})
		if err != nil {
			t.Fatalf("read %s %s at %d: %v", id, stream, *offset, err)
		}
		out.Write(res.Data)
		*offset = res.NextOffset
		if strings.Contains(out.String(), want) {
			return out.String()
		}
		if res.Exited {
			break
		}
	}
	t.Fatalf("%s %s never showed %q; read %q", id, stream, want, out.String())
	return ""
}

// gone waits until pid is no process or a zombie.
func gone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		state, ok := stateOf(pid)
		if !ok || state == "Z" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d is still running", pid)
}

func stateOf(pid int) (string, bool) {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", false
	}
	fields := strings.Fields(string(stat[bytes.LastIndexByte(stat, ')')+1:]))
	return fields[0], true
}

// childNamed waits for a child of parent whose command is name, and returns its pid.
func childNamed(t *testing.T, parent int, name string) int {
	t.Helper()
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir("/proc")
		for _, e := range entries {
			pid, err := strconv.Atoi(e.Name())
			if err != nil {
				continue
			}
			stat, err := os.ReadFile("/proc/" + e.Name() + "/stat")
			if err != nil {
				continue
			}
			open, close := bytes.IndexByte(stat, '('), bytes.LastIndexByte(stat, ')')
			fields := strings.Fields(string(stat[close+1:]))
			if string(stat[open+1:close]) == name && len(fields) > 1 && fields[1] == strconv.Itoa(parent) {
				return pid
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no child %s of %d", name, parent)
	return 0
}

func pidsIn(t *testing.T, text string) []int {
	t.Helper()
	var pids []int
	for _, field := range strings.Fields(text) {
		pid, err := strconv.Atoi(field)
		if err != nil {
			t.Fatalf("not a pid: %q in %q", field, text)
		}
		pids = append(pids, pid)
	}
	return pids
}

func TestReadByOffset(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "printf hello; printf oops >&2; exit 3"}})
	if res := wait(t, tbl, p.ID); res.ExitCode == nil || *res.ExitCode != 3 || res.Signal != nil {
		t.Fatalf("wait %+v", res)
	}
	if got := readAll(t, tbl, p.ID, "stdout"); got != "hello" {
		t.Fatalf("stdout %q", got)
	}
	if got := readAll(t, tbl, p.ID, "stderr"); got != "oops" {
		t.Fatalf("stderr %q", got)
	}
	two := 2
	res, err := tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(1), MaxBytes: &two})
	if err != nil || string(res.Data) != "el" || res.NextOffset != 3 || res.Dropped != 0 || res.Exited {
		t.Fatalf("read at 1, 2 bytes: %+v %v", res, err)
	}
	res, err = tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(3)})
	if err != nil || string(res.Data) != "lo" || res.NextOffset != 5 || !res.Exited {
		t.Fatalf("read at 3: %+v %v", res, err)
	}
	res, err = tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(5)})
	if err != nil || len(res.Data) != 0 || res.Data == nil || res.NextOffset != 5 || !res.Exited {
		t.Fatalf("read at the end: %+v %v", res, err)
	}
}

func TestReadRefusals(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"printf", "abc"}})
	wait(t, tbl, p.ID)
	big := process.MaxRead + 1
	zero := 0
	for name, c := range map[string]struct {
		params process.ReadParams
		kind   rpc.Kind
	}{
		"no such process":  {process.ReadParams{ID: "p999999", Stream: "stdout", Offset: off(0)}, rpc.KindNotFound},
		"no offset":        {process.ReadParams{ID: p.ID, Stream: "stdout"}, rpc.KindInvalid},
		"negative offset":  {process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(-1)}, rpc.KindInvalid},
		"past the end":     {process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(4)}, rpc.KindInvalid},
		"pty of a pipe":    {process.ReadParams{ID: p.ID, Stream: "pty", Offset: off(0)}, rpc.KindInvalid},
		"no such stream":   {process.ReadParams{ID: p.ID, Stream: "stdin", Offset: off(0)}, rpc.KindInvalid},
		"maxBytes too big": {process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(0), MaxBytes: &big}, rpc.KindLimit},
		"maxBytes zero":    {process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(0), MaxBytes: &zero}, rpc.KindInvalid},
		"wait too long":    {process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(0), WaitMs: process.MaxWaitMs + 1}, rpc.KindInvalid},
	} {
		if _, err := tbl.Read(context.Background(), c.params); err == nil || kindOf(t, err) != c.kind {
			t.Errorf("%s: want %s, got %v", name, c.kind, err)
		}
	}
}

func TestTheRingKeepsTheLastBytesAndCountsWhatItDropped(t *testing.T) {
	tbl := table(t, process.Options{RingBytes: 16})
	p := start(t, tbl, process.StartParams{Argv: []string{"printf", "0123456789abcdefghij"}})
	wait(t, tbl, p.ID)
	res, err := tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(0)})
	if err != nil || string(res.Data) != "456789abcdefghij" || res.Dropped != 4 || res.NextOffset != 20 || !res.Exited {
		t.Fatalf("read below the ring: %+v %v", res, err)
	}
	res, err = tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(10)})
	if err != nil || string(res.Data) != "abcdefghij" || res.Dropped != 0 || res.NextOffset != 20 {
		t.Fatalf("read inside the ring: %+v %v", res, err)
	}
	// A read that wraps the ring's end comes back whole.
	three := 3
	res, err = tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(15), MaxBytes: &three})
	if err != nil || string(res.Data) != "fgh" || res.NextOffset != 18 {
		t.Fatalf("read across the wrap: %+v %v", res, err)
	}
}

func TestALargeOutputIsReadInPagesWithNothingLost(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"head", "-c", "3000000", "/dev/zero"}})
	wait(t, tbl, p.ID)
	if got := readAll(t, tbl, p.ID, "stdout"); len(got) != 3000000 || strings.Trim(got, "\x00") != "" {
		t.Fatalf("read %d bytes", len(got))
	}
}

func TestStdinWriteAndClose(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"cat"}, Stdin: true})
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("one\n")}); err != nil {
		t.Fatal(err)
	}
	offset := int64(0)
	readUntil(t, tbl, p.ID, "stdout", &offset, "one\n")
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("two\n"), Close: true}); err != nil {
		t.Fatal(err)
	}
	if res := wait(t, tbl, p.ID); res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("cat after close: %+v", res)
	}
	if got := readAll(t, tbl, p.ID, "stdout"); got != "one\ntwo\n" {
		t.Fatalf("stdout %q", got)
	}
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("late")}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("a write after the end: %v", err)
	}
}

func TestWithoutStdinTheProgramReadsNothingAndAWriteIsRefused(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "cat; echo end"}})
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("x")}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("a write with no stdin: %v", err)
	}
	wait(t, tbl, p.ID)
	if got := readAll(t, tbl, p.ID, "stdout"); got != "end\n" {
		t.Fatalf("stdout %q", got)
	}
}

func TestALongPollReturnsWhenBytesCome(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"cat"}, Stdin: true})
	got := make(chan process.ReadResult, 1)
	failed := make(chan error, 1)
	go func() {
		res, err := tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(0), WaitMs: process.MaxWaitMs})
		if err != nil {
			failed <- err
			return
		}
		got <- res
	}()
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("ping\n")}); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-got:
		if !strings.HasPrefix("ping\n", string(res.Data)) || len(res.Data) == 0 || res.Exited {
			t.Fatalf("long poll %+v", res)
		}
	case err := <-failed:
		t.Fatal(err)
	case <-time.After(patience + time.Duration(process.MaxWaitMs)*time.Millisecond):
		t.Fatal("the long poll never returned")
	}
}

func TestEachSignalReachesTheProgramsGroup(t *testing.T) {
	tbl := table(t, process.Options{})
	for _, c := range []struct {
		signal string
		code   int
	}{{"TERM", 143}, {"INT", 130}, {"HUP", 129}} {
		// The shell traps the signal; its child sleep does not, so only a signal to the group ends the sleep.
		p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", `trap "echo trapped" TERM INT HUP; sleep 300; echo "child=$?"`}})
		sleep := childNamed(t, p.Pid, "sleep")
		if _, err := tbl.Signal(process.SignalParams{ID: p.ID, Signal: c.signal}); err != nil {
			t.Fatal(err)
		}
		res := wait(t, tbl, p.ID)
		if res.ExitCode == nil || *res.ExitCode != 0 || res.Signal != nil {
			t.Fatalf("%s: %+v", c.signal, res)
		}
		if got, want := readAll(t, tbl, p.ID, "stdout"), "trapped\nchild="+strconv.Itoa(c.code)+"\n"; got != want {
			t.Fatalf("%s: stdout %q, want %q", c.signal, got, want)
		}
		gone(t, sleep)
	}
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "sleep 300; echo after"}})
	sleep := childNamed(t, p.Pid, "sleep")
	if _, err := tbl.Signal(process.SignalParams{ID: p.ID, Signal: "KILL"}); err != nil {
		t.Fatal(err)
	}
	if res := wait(t, tbl, p.ID); res.ExitCode != nil || res.Signal == nil || *res.Signal != "KILL" {
		t.Fatalf("KILL: %+v", res)
	}
	gone(t, sleep)
	if _, err := tbl.Signal(process.SignalParams{ID: p.ID, Signal: "TERM"}); err != nil {
		t.Fatalf("a signal to an ended process does nothing: %v", err)
	}
	if _, err := tbl.Signal(process.SignalParams{ID: p.ID, Signal: "USR1"}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("USR1: %v", err)
	}
}

func TestWhenTheProgramEndsItsWholeTreeEnds(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "setsid sleep 301 >/dev/null 2>&1 & echo $!"}})
	wait(t, tbl, p.ID)
	for _, pid := range pidsIn(t, readAll(t, tbl, p.ID, "stdout")) {
		gone(t, pid)
	}
}

func TestAPtyProgramHasAControllingTerminal(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{
		Argv: []string{"sh", "-c", `test -t 0 && test -t 1 && test -t 2 && tty && : </dev/tty && echo controlling`},
		Pty:  &process.Size{Cols: 80, Rows: 24},
	})
	if res := wait(t, tbl, p.ID); res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("wait %+v; pty %q", res, readAll(t, tbl, p.ID, "pty"))
	}
	got := readAll(t, tbl, p.ID, "pty")
	if !strings.Contains(got, "/dev/pts/") || !strings.Contains(got, "controlling") {
		t.Fatalf("pty %q", got)
	}
	if _, err := tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(0)}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("stdout of a pty process: %v", err)
	}
}

func TestAPtyShellEchoesAndSeesAResize(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sh"}, Pty: &process.Size{Cols: 80, Rows: 24}})
	offset := int64(0)
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("echo one$((1+1))\n")}); err != nil {
		t.Fatal(err)
	}
	// The terminal echoes what was typed, and the shell prints what it ran.
	readUntil(t, tbl, p.ID, "pty", &offset, "one2")
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("stty size\n")}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, tbl, p.ID, "pty", &offset, "24 80")
	if _, err := tbl.Resize(process.ResizeParams{ID: p.ID, Cols: 120, Rows: 40}); err != nil {
		t.Fatal(err)
	}
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("stty size\n")}); err != nil {
		t.Fatal(err)
	}
	readUntil(t, tbl, p.ID, "pty", &offset, "40 120")
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("x"), Close: true}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("close on a pty: %v", err)
	}
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("exit 7\n")}); err != nil {
		t.Fatal(err)
	}
	if res := wait(t, tbl, p.ID); res.ExitCode == nil || *res.ExitCode != 7 {
		t.Fatalf("wait %+v", res)
	}
	if _, err := tbl.Resize(process.ResizeParams{ID: p.ID, Cols: 80, Rows: 24}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("resize after the end: %v", err)
	}
}

func TestResizeRefusals(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sleep", "300"}})
	if _, err := tbl.Resize(process.ResizeParams{ID: p.ID, Cols: 80, Rows: 24}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("resize without a pty: %v", err)
	}
	for _, size := range []*process.Size{{Cols: 0, Rows: 24}, {Cols: 80, Rows: 70000}} {
		if _, err := tbl.Start(process.StartParams{Argv: []string{"true"}, Pty: size}); err == nil || kindOf(t, err) != rpc.KindInvalid {
			t.Fatalf("pty %+v: %v", size, err)
		}
	}
}

func TestListAndWait(t *testing.T) {
	tbl := table(t, process.Options{})
	before := time.Now().UnixMilli()
	p := start(t, tbl, process.StartParams{Argv: []string{"sleep", "300"}})
	res, err := tbl.Wait(context.Background(), process.WaitParams{ID: p.ID, TimeoutMs: ms(100 * time.Millisecond)})
	if err != nil || !res.Running || res.ExitCode != nil || res.Signal != nil {
		t.Fatalf("wait on a running process: %+v %v", res, err)
	}
	list, err := tbl.List(process.ListParams{})
	if err != nil || len(list.Processes) != 1 || list.Truncated {
		t.Fatalf("list %+v %v", list, err)
	}
	if got := list.Processes[0]; got.ArgvClipped || got.ID != p.ID || got.Pid != p.Pid || strings.Join(got.Argv, " ") != "sleep 300" || got.Pty || !got.Running || got.StartedAt < before || got.EndedAt != nil {
		t.Fatalf("list entry %+v", got)
	}
	if _, err := tbl.Signal(process.SignalParams{ID: p.ID, Signal: "KILL"}); err != nil {
		t.Fatal(err)
	}
	wait(t, tbl, p.ID)
	list, _ = tbl.List(process.ListParams{})
	if got := list.Processes[0]; got.Running || got.Signal == nil || *got.Signal != "KILL" || got.EndedAt == nil || *got.EndedAt < got.StartedAt {
		t.Fatalf("list entry after the end %+v", got)
	}
	if _, err := tbl.Wait(context.Background(), process.WaitParams{ID: p.ID}); err == nil || kindOf(t, err) != rpc.KindInvalid {
		t.Fatalf("wait without timeoutMs: %v", err)
	}
	if _, err := tbl.Wait(context.Background(), process.WaitParams{ID: "nope", TimeoutMs: ms(0)}); err == nil || kindOf(t, err) != rpc.KindNotFound {
		t.Fatalf("wait on no process: %v", err)
	}
}

func TestAWaitIsCancelled(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sleep", "300"}})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := tbl.Wait(ctx, process.WaitParams{ID: p.ID, TimeoutMs: ms(patience)}); err == nil || kindOf(t, err) != rpc.KindAborted {
		t.Fatalf("a cancelled wait: %v", err)
	}
}

func TestTheTableIsBounded(t *testing.T) {
	tbl := table(t, process.Options{MaxEntries: 2})
	first := start(t, tbl, process.StartParams{Argv: []string{"true"}})
	second := start(t, tbl, process.StartParams{Argv: []string{"true"}})
	wait(t, tbl, first.ID)
	wait(t, tbl, second.ID)
	third := start(t, tbl, process.StartParams{Argv: []string{"sleep", "300"}})
	if _, err := tbl.Read(context.Background(), process.ReadParams{ID: first.ID, Stream: "stdout", Offset: off(0)}); err == nil || kindOf(t, err) != rpc.KindNotFound {
		t.Fatalf("the oldest ended process should be evicted: %v", err)
	}
	fourth := start(t, tbl, process.StartParams{Argv: []string{"sleep", "300"}})
	if _, err := tbl.Start(process.StartParams{Argv: []string{"true"}}); err == nil || kindOf(t, err) != rpc.KindLimit {
		t.Fatalf("a start past the bound with every process running: %v", err)
	}
	list, _ := tbl.List(process.ListParams{})
	if len(list.Processes) != 2 || list.Processes[0].ID != third.ID || list.Processes[1].ID != fourth.ID {
		t.Fatalf("list %+v", list)
	}
}

func TestStartRefusals(t *testing.T) {
	tbl := table(t, process.Options{})
	for name, c := range map[string]struct {
		params process.StartParams
		kind   rpc.Kind
	}{
		"no argv":    {process.StartParams{}, rpc.KindInvalid},
		"no program": {process.StartParams{Argv: []string{"no-such-program-here"}}, rpc.KindNotFound},
		"no cwd":     {process.StartParams{Argv: []string{"true"}, Cwd: "/no/such/dir"}, rpc.KindNotFound},
	} {
		if _, err := tbl.Start(c.params); err == nil || kindOf(t, err) != c.kind {
			t.Errorf("%s: want %s, got %v", name, c.kind, err)
		}
	}
	if list, _ := tbl.List(process.ListParams{}); len(list.Processes) != 0 {
		t.Fatalf("a refused start left %+v", list)
	}
}

func TestEnvAndCwd(t *testing.T) {
	tbl := table(t, process.Options{})
	dir := t.TempDir()
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", `printf "%s %s" "$PWD" "$GREETING"`}, Cwd: dir, Env: map[string]string{"GREETING": "hola"}})
	wait(t, tbl, p.ID)
	if got := readAll(t, tbl, p.ID, "stdout"); got != dir+" hola" {
		t.Fatalf("stdout %q", got)
	}
}

// A start that is refused, whatever the reason, leaves a full table as it was: no ended process is dropped for it.
func TestARefusedStartIntoAFullTableKeepsEveryEntryAndItsOutput(t *testing.T) {
	tbl := table(t, process.Options{MaxEntries: 2})
	first := start(t, tbl, process.StartParams{Argv: []string{"printf", "first"}})
	wait(t, tbl, first.ID)
	second := start(t, tbl, process.StartParams{Argv: []string{"printf", "second"}})
	wait(t, tbl, second.ID)
	for name, params := range map[string]process.StartParams{
		"no argv":    {Argv: []string{}},
		"no program": {Argv: []string{"no-such-program-here"}},
		"no cwd":     {Argv: []string{"true"}, Cwd: "/no/such/dir"},
		"no user":    {Argv: []string{"true"}, User: "no-such-user-here"},
		"bad pty":    {Argv: []string{"true"}, Pty: &process.Size{Cols: 0, Rows: 24}},
	} {
		if _, err := tbl.Start(params); err == nil {
			t.Fatalf("%s: started", name)
		}
		if got := readAll(t, tbl, first.ID, "stdout"); got != "first" {
			t.Fatalf("after a refused start (%s), the first process's stdout is %q", name, got)
		}
		if got := readAll(t, tbl, second.ID, "stdout"); got != "second" {
			t.Fatalf("after a refused start (%s), the second process's stdout is %q", name, got)
		}
	}
	third := start(t, tbl, process.StartParams{Argv: []string{"true"}})
	if _, err := tbl.Read(context.Background(), process.ReadParams{ID: first.ID, Stream: "stdout", Offset: off(0)}); err == nil || kindOf(t, err) != rpc.KindNotFound {
		t.Fatalf("a start that runs drops the process that ended first: %v", err)
	}
	if list := listAll(t, tbl); len(list) != 2 || list[0].ID != second.ID || list[1].ID != third.ID {
		t.Fatalf("list %+v", list)
	}
}

// filler makes a listing entry about 40 KiB, so a few dozen processes take more than one page.
var filler = strings.Repeat("x", 40<<10)

// startShort starts a program that ends at once, with an argv as large as a long-running one's, and waits for its end.
func startShort(t *testing.T, tbl *process.Table) string {
	t.Helper()
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "exit 0", "sh", filler}})
	wait(t, tbl, p.ID)
	return p.ID
}

// missing is every id in want that list does not hold.
func missing(want []string, list []process.Info) []string {
	listed := map[string]bool{}
	for _, p := range list {
		listed[p.ID] = true
	}
	var gone []string
	for _, id := range want {
		if !listed[id] {
			gone = append(gone, id)
		}
	}
	return gone
}

// A listing pages by when a process started, not by where it sits in the table: entries dropped between two pages never
// make the next page skip a process that runs.
func TestPagingNeverSkipsARunningProcessWhenEntriesAreDroppedBetweenPages(t *testing.T) {
	tbl := table(t, process.Options{MaxEntries: 40})
	var running []string
	for range 20 {
		startShort(t, tbl)
		running = append(running, start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "sleep 300", "sh", filler}}).ID)
	}
	var seen []process.Info
	params := process.ListParams{}
	pages := 0
	for {
		page, err := tbl.List(params)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		seen = append(seen, page.Processes...)
		if !page.Truncated {
			break
		}
		// Two starts into the full table drop the two processes that ended first, both listed already.
		startShort(t, tbl)
		startShort(t, tbl)
		next := page.Next
		params.From = &next
	}
	if pages < 2 {
		t.Fatalf("one page: the test needs more")
	}
	if gone := missing(running, seen); len(gone) > 0 {
		t.Fatalf("the listing skipped running processes %v", gone)
	}
	for i := 1; i < len(seen); i++ {
		a, _ := strconv.Atoi(strings.TrimPrefix(seen[i-1].ID, "p"))
		b, _ := strconv.Atoi(strings.TrimPrefix(seen[i].ID, "p"))
		if a >= b {
			t.Fatalf("the listing is not in start order, or lists one twice: %s then %s", seen[i-1].ID, seen[i].ID)
		}
	}
}

// The same while another goroutine starts processes into the full table and so drops ended ones, as it pleases.
func TestPagingWhileAnotherGoroutineStartsNeverSkipsARunningProcess(t *testing.T) {
	tbl := table(t, process.Options{MaxEntries: 40})
	var running []string
	for range 20 {
		startShort(t, tbl)
		running = append(running, start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "sleep 300", "sh", filler}}).ID)
	}
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(done)
		for range 30 {
			p, err := tbl.Start(process.StartParams{Argv: []string{"sh", "-c", "exit 0", "sh", filler}})
			if err != nil {
				t.Errorf("start: %v", err)
				return
			}
			if _, err := tbl.Wait(context.Background(), process.WaitParams{ID: p.ID, TimeoutMs: ms(patience)}); err != nil {
				t.Errorf("wait: %v", err)
				return
			}
		}
	}()
	listings := 0
	for {
		select {
		case <-done:
		default:
			listings++
			if gone := missing(running, listAll(t, tbl)); len(gone) > 0 {
				<-done
				t.Fatalf("listing %d skipped running processes %v", listings, gone)
			}
			continue
		}
		break
	}
	wg.Wait()
	if gone := missing(running, listAll(t, tbl)); len(gone) > 0 {
		t.Fatalf("the last listing skipped running processes %v", gone)
	}
}

// writeTimeout is process.write's bound, as the README gives it.
const writeTimeout = 10 * time.Second

// buffered is how many bytes wait in the pipe that is pid's stdin: through a second reader of it that reads nothing.
func buffered(t *testing.T, pid int) int {
	t.Helper()
	f, err := os.OpenFile("/proc/"+strconv.Itoa(pid)+"/fd/0", os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		t.Fatalf("open the stdin of %d: %v", pid, err)
	}
	defer f.Close()
	var n int32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), syscall.TIOCINQ, uintptr(unsafe.Pointer(&n))); errno != 0 {
		t.Fatalf("FIONREAD on the stdin of %d: %v", pid, errno)
	}
	return int(n)
}

type writeDone struct {
	err  error
	took time.Duration
}

func writeIn(tbl *process.Table, ctx context.Context, id string, data []byte) <-chan writeDone {
	done := make(chan writeDone, 1)
	go func() {
		began := time.Now()
		_, err := tbl.Write(ctx, process.WriteParams{ID: id, Data: data})
		done <- writeDone{err, time.Since(began)}
	}()
	return done
}

// A write queued behind one blocked on a program that does not read is cancelled while it waits its turn, and its wait
// for the turn counts toward its own bound.
func TestAQueuedWriteIsCancelledAndBoundedWhileAnotherBlocks(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sleep", "300"}, Stdin: true})
	big := make([]byte, 4<<20)
	first := writeIn(tbl, context.Background(), p.ID, big)
	deadline := time.Now().Add(patience)
	for buffered(t, p.Pid) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the first write never began")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// The first write holds the input now, and cannot end before its bound: the pipe is full and nothing reads it.
	queued := writeIn(tbl, context.Background(), p.ID, []byte("queued"))
	ctx, cancel := context.WithCancel(context.Background())
	cancelled := writeIn(tbl, ctx, p.ID, []byte("cancelled"))
	cancel()
	res := <-cancelled
	if res.err == nil || kindOf(t, res.err) != rpc.KindAborted {
		t.Fatalf("a queued write that is cancelled: %v", res.err)
	}
	select {
	case r := <-first:
		t.Fatalf("the cancelled write returned only once the first had (%v after %v)", r.err, r.took)
	default:
	}
	if r := <-first; r.err == nil || kindOf(t, r.err) != rpc.KindTimeout {
		t.Fatalf("the first write: %v", r.err)
	}
	// Without the wait for its turn counted, the queued write would take its whole bound after the first's.
	if r := <-queued; r.err == nil || kindOf(t, r.err) != rpc.KindTimeout || r.took >= 2*writeTimeout {
		t.Fatalf("the queued write: %v after %v", r.err, r.took)
	}
}

// A cancel that comes as a write completes never sets the deadline of the write after it.
func TestACancelRacingAWriteNeverBreaksTheNextWrite(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "cat >/dev/null"}, Stdin: true})
	for i := range 2000 {
		ctx, cancel := context.WithCancel(context.Background())
		go cancel()
		if _, err := tbl.Write(ctx, process.WriteParams{ID: p.ID, Data: []byte("x")}); err != nil && kindOf(t, err) != rpc.KindAborted {
			t.Fatalf("round %d, the raced write: %v", i, err)
		}
		if _, err := tbl.Write(context.Background(), process.WriteParams{ID: p.ID, Data: []byte("y")}); err != nil {
			t.Fatalf("round %d, the write after a cancelled one: %v", i, err)
		}
	}
}

package execrun_test

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// patience bounds every wait on a program here. The host may be loaded: it is never a claim about speed.
const patience = 30 * time.Second

// appears waits until path exists.
func appears(path string) bool {
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

type startOutcome struct {
	g   *execrun.Guarded
	err error
}

// A start already in flight when EndAll begins runs its program, and that program gets SIGTERM (its trap leaves a mark)
// before any SIGKILL; a start once EndAll has begun is refused.
func TestEndAllTermsAStartInFlightAndRefusesALaterOne(t *testing.T) {
	dir := t.TempDir()
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()
	// $0 names the program's marks: $0.ready once its trap is set, $0.termed once SIGTERM came.
	program := func(name string) execrun.Program {
		return execrun.Program{Argv: []string{"sh", "-c", `trap 'echo > "$0.termed"; exit 0' TERM; echo > "$0.ready"; sleep 300 & wait`, filepath.Join(dir, name)}}
	}
	first, later := program("first"), program("later")
	isFirst := func(p execrun.Program) bool { return len(p.Argv) == 4 && p.Argv[3] == first.Argv[3] }
	held, release := make(chan struct{}), make(chan struct{})
	execrun.SetStartHooks(t, func(p execrun.Program) {
		if isFirst(p) {
			close(held)
			<-release
		}
	}, func(p execrun.Program) {
		if isFirst(p) {
			// Its trap is set before anyone can send it SIGTERM.
			appears(first.Argv[3] + ".ready")
		}
	})
	stop := func(g *execrun.Guarded) {
		t.Cleanup(func() {
			g.Stop()
			select {
			case <-g.Done():
			case <-time.After(patience):
			}
			g.Close()
		})
	}

	firstDone := make(chan startOutcome, 1)
	go func() {
		g, err := execrun.Start(first, nil, null, null)
		firstDone <- startOutcome{g, err}
	}()
	select {
	case <-held:
	case <-time.After(patience):
		t.Fatal("the first start never reached its hook")
	}
	var after startOutcome
	execrun.SetEndHooks(t, func() { close(release) }, func() {
		g, err := execrun.Start(later, nil, null, null)
		after = startOutcome{g, err}
	})
	ended := make(chan struct{})
	go func() {
		execrun.EndAll(time.Second)
		close(ended)
	}()
	select {
	case <-ended:
	case <-time.After(2 * patience):
		t.Fatal("EndAll never returned")
	}

	if after.err == nil {
		stop(after.g)
		t.Errorf("a start once EndAll had begun was let in")
		if !exists(later.Argv[3] + ".termed") {
			t.Errorf("and its program never got SIGTERM: only a SIGKILL could end it")
		}
	} else if kindOf(t, after.err) != rpc.KindUnsupported || !strings.Contains(after.err.Error(), "shutting down") {
		t.Errorf("a start once EndAll had begun: %v", after.err)
	}

	var r startOutcome
	select {
	case r = <-firstDone:
	case <-time.After(patience):
		t.Fatal("the start in flight never returned")
	}
	if r.err != nil {
		t.Fatalf("the start in flight: %v", r.err)
	}
	stop(r.g)
	select {
	case <-r.g.Done():
	case <-time.After(patience):
		t.Fatalf("the program started in flight still runs after EndAll: it never got SIGTERM")
	}
	code, signal, reported := r.g.Exit()
	if !exists(first.Argv[3]+".termed") || code == nil || *code != 0 || !reported {
		t.Fatalf("the program started in flight did not end by its SIGTERM trap: exit code %v, signal %q, reported %v", code, signal, reported)
	}
}

// discard is /dev/null for a program's output.
func discard(t *testing.T) *os.File {
	t.Helper()
	null, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = null.Close() })
	return null
}

// init's shutdown reaps every child with Wait4(-1) once EndAll's wait runs out, so it may reap a guard before follow's
// Wait does. Its program's end is then KILL, unreported, and nothing panics.
func TestAGuardReapedElsewhereEndsAsKill(t *testing.T) {
	null := discard(t)
	execrun.SetGuardHooks(t, nil, func(guard int) {
		var ws syscall.WaitStatus
		_, _ = syscall.Wait4(guard, &ws, 0, nil)
	})
	g, err := execrun.Start(execrun.Program{Argv: []string{"sleep", "301"}}, nil, null, null)
	if err != nil {
		t.Fatal(err)
	}
	program := g.Pid
	t.Cleanup(func() { _ = syscall.Kill(-program, syscall.SIGKILL) })
	_ = syscall.Kill(execrun.GuardPid(g), syscall.SIGKILL)
	select {
	case <-g.Done():
	case <-time.After(patience):
		t.Fatal("the killed guard was never reaped")
	}
	g.Close()
	var code *int
	var signal string
	var reported bool
	var crash any
	func() {
		defer func() { crash = recover() }()
		code, signal, reported = g.Exit()
	}()
	if crash != nil {
		t.Fatalf("Exit panicked for a guard reaped elsewhere: %v", crash)
	}
	if code != nil || signal != "KILL" || reported {
		t.Fatalf("a guard reaped elsewhere: exit code %v, signal %q, reported %v; want KILL, unreported", code, signal, reported)
	}
}

// A sweep that begins between a guard's fork and its record waits for the record, so it never takes the guard for an
// orphan.
func TestASweepDuringAGuardsForkSeesAGuard(t *testing.T) {
	null := discard(t)
	seen := make(chan bool, 1)
	execrun.SetGuardHooks(t, func(guard int) {
		go execrun.WithGuards(func(isGuard func(int) bool) { seen <- isGuard(guard) })
	}, nil)
	g, err := execrun.Start(execrun.Program{Argv: []string{"sleep", "302"}}, nil, null, null)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		g.Stop()
		select {
		case <-g.Done():
		case <-time.After(patience):
		}
		g.Close()
	})
	select {
	case isGuard := <-seen:
		if !isGuard {
			t.Fatal("a sweep begun between the guard's fork and its record took the guard for an orphan")
		}
	case <-time.After(patience):
		t.Fatal("the sweep never ran")
	}
}

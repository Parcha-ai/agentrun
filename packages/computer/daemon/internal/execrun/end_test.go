package execrun_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
		g, err := execrun.Start(context.Background(), first, nil, null, null)
		firstDone <- startOutcome{g, err}
	}()
	select {
	case <-held:
	case <-time.After(patience):
		t.Fatal("the first start never reached its hook")
	}
	var after startOutcome
	execrun.SetEndHooks(t, func() { close(release) }, func() {
		g, err := execrun.Start(context.Background(), later, nil, null, null)
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

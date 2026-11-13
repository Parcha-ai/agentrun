package execrun

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// SignalGroup waits for the guard's answer, bounded: a guard that does not answer is an error that says the signal may
// or may not have been sent, an answer that comes too late is not taken for the next signal's, and a guard that ends
// before it answers sent nothing. A sleep stands in for the guard process; the test speaks the guard's side of the wire.
func TestSignalGroupWaitsForItsOwnAnswerBounded(t *testing.T) {
	controlReader, control, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	statusReader, status, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stand := exec.Command("/bin/sleep", "300")
	if err := stand.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = stand.Process.Kill()
		_ = control.Close()
		_ = controlReader.Close()
	})
	g := &Guarded{guard: stand, control: control, done: make(chan struct{})}
	started := make(chan struct{})
	go g.follow(statusReader, started)
	say := func(line string) {
		if _, err := status.WriteString(line + "\n"); err != nil {
			t.Errorf("cannot write a status line: %v", err)
		}
	}
	say(`{"pid":4242}`)
	<-started
	commands := make(chan guardCommand, 8)
	go func() {
		lines := bufio.NewScanner(controlReader)
		for lines.Scan() {
			var c guardCommand
			if json.Unmarshal(lines.Bytes(), &c) == nil {
				commands <- c
			}
		}
	}()
	t.Cleanup(func() { groupAnswerTimeout = 2 * time.Second })

	groupAnswerTimeout = 100 * time.Millisecond
	_, _, err = g.SignalGroup(syscall.SIGINT, 77)
	var e *rpc.Error
	if !errors.As(err, &e) || e.Kind != rpc.KindTimeout || !strings.Contains(err.Error(), "may or may not") {
		t.Fatalf("a guard that never answers: want a timeout that says so, got %v", err)
	}
	if c := <-commands; c.Group != 77 || c.Seq != 1 || c.Signal != int(syscall.SIGINT) {
		t.Fatalf("the first command on the wire: %+v", c)
	}

	groupAnswerTimeout = patienceInternal
	go func() {
		c := <-commands
		say(`{"signalled":{"seq":1,"group":77,"sent":true}}`)
		data, _ := json.Marshal(guardStatus{Signalled: &groupSignalled{Seq: c.Seq, Group: c.Group, Reason: "not this time"}})
		say(string(data))
	}()
	if sent, why, err := g.SignalGroup(syscall.SIGINT, 77); err != nil || sent || why != "not this time" {
		t.Fatalf("after a late answer to the first signal, the second got sent=%v why=%q err=%v, not its own answer", sent, why, err)
	}

	type outcome struct {
		sent bool
		why  string
		err  error
	}
	got := make(chan outcome, 1)
	go func() {
		sent, why, err := g.SignalGroup(syscall.SIGINT, 77)
		got <- outcome{sent, why, err}
	}()
	<-commands
	_ = stand.Process.Kill()
	_ = status.Close()
	o := <-got
	if o.err != nil || o.sent || !strings.Contains(o.why, "the program ended") {
		t.Fatalf("a guard that ended before it answered: sent=%v why=%q err=%v", o.sent, o.why, o.err)
	}
	<-g.done
}

// patienceInternal bounds a wait that only a stuck test reaches.
const patienceInternal = 30 * time.Second

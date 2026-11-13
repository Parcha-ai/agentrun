package process_test

import (
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
)

// countSignalsCommand runs this test binary as a program that writes a line to its file for each TERM or INT it
// receives, and, given a second file, first starts itself as a job in a process group of its own (in the same session)
// counting into that one. Each writes <file>.ready once it counts.
const countSignalsCommand = "count-signals"

func countSignals(args []string) int {
	got := make(chan os.Signal, 64)
	signal.Notify(got, syscall.SIGTERM, syscall.SIGINT)
	signal.Ignore(syscall.SIGHUP)
	if len(args) > 1 {
		job := exec.Command("/proc/self/exe", countSignalsCommand, args[1])
		job.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := job.Start(); err != nil {
			return 1
		}
	}
	if err := os.WriteFile(args[0]+".ready", []byte("ready\n"), 0o644); err != nil {
		return 1
	}
	for s := range got {
		f, err := os.OpenFile(args[0], os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return 1
		}
		_, _ = f.WriteString(s.String() + "\n")
		_ = f.Close()
	}
	return 0
}

// ready waits until each file's counter is counting.
func ready(t *testing.T, files ...string) {
	t.Helper()
	deadline := time.Now().Add(patience)
	for _, file := range files {
		for {
			if _, err := os.Stat(file + ".ready"); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s never counted", file)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// deliveries is how many signals file's counter wrote down.
func deliveries(file string) int {
	data, _ := os.ReadFile(file)
	return len(strings.Fields(string(data)))
}

// A waitGroup process gets each signal once: its program's group is signalled once while the program runs, and every
// other group of a terminal's session once too, never a second time by pid.
func TestWaitGroupSignalsEachGroupOnce(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name string
		pty  *process.Size
		job  bool
	}{
		{"plain", nil, false},
		{"a terminal's session, with a job in a group of its own", &process.Size{Cols: 80, Rows: 24}, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			tbl := table(t, process.Options{})
			dir := t.TempDir()
			leader, job := filepath.Join(dir, "leader"), filepath.Join(dir, "job")
			argv := []string{self, countSignalsCommand, leader}
			files := []string{leader}
			if c.job {
				argv = append(argv, job)
				files = append(files, job)
			}
			p := start(t, tbl, process.StartParams{Argv: argv, WaitGroup: true, Pty: c.pty})
			ready(t, files...)
			for range 2 {
				if _, err := tbl.Signal(process.SignalParams{ID: p.ID, Signal: "TERM"}); err != nil {
					t.Fatal(err)
				}
				// Long enough for a second delivery, were there one, to land apart from the first.
				time.Sleep(500 * time.Millisecond)
			}
			for _, file := range files {
				if got := deliveries(file); got != 2 {
					t.Fatalf("%s got %d TERMs for 2 signals", filepath.Base(file), got)
				}
			}
		})
	}
}

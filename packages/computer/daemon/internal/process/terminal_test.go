package process_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// dropTerminalCommand runs this test binary as a program that lets go of its controlling terminal (TIOCNOTTY) and,
// given "give", hands it to a sleep in a session of its own. It says what it did, then sleeps until a signal ends it.
const dropTerminalCommand = "drop-terminal"

func dropTerminal(args []string) int {
	// A session leader that lets go of its terminal sends SIGHUP to the foreground group, which is its own.
	signal.Ignore(syscall.SIGHUP)
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, 0, syscall.TIOCNOTTY, 0); errno != 0 {
		fmt.Println("TIOCNOTTY:", errno)
		return 1
	}
	if len(args) == 1 && args[0] == "give" {
		sleep := exec.Command("sleep", "302")
		sleep.Stdin = os.Stdin
		sleep.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
		if err := sleep.Start(); err != nil {
			fmt.Println("cannot give the terminal away:", err)
			return 1
		}
		fmt.Printf("gave=%d\n", sleep.Process.Pid)
	} else {
		fmt.Println("dropped")
	}
	time.Sleep(time.Hour)
	return 0
}

// staleForegroundCommand runs this test binary as a program that hands its terminal to a child in a group of its own,
// then reaps that child. The terminal keeps naming the child's group as its foreground group, a group no process is in
// now, whose id the kernel may hand to a process in another session. It says the group, then sleeps until a signal ends
// it.
const staleForegroundCommand = "stale-foreground"

func staleForeground() int {
	child := exec.Command("/bin/true")
	child.Stdin = os.Stdin
	child.SysProcAttr = &syscall.SysProcAttr{Foreground: true, Ctty: 0}
	if err := child.Run(); err != nil {
		fmt.Println("cannot run a job in the foreground:", err)
		return 1
	}
	fmt.Printf("stale=%d\n", child.Process.Pid)
	time.Sleep(time.Hour)
	return 0
}

func typeLine(t *testing.T, tbl *process.Table, id, line string) {
	t.Helper()
	if _, err := tbl.Write(context.Background(), process.WriteParams{ID: id, Data: []byte(line)}); err != nil {
		t.Fatalf("write %q: %v", line, err)
	}
}

// pidAfter reads the pty from *offset until it shows name=<pid>, and returns the pid. What the terminal echoes of a
// typed line holds name=$..., never digits, so only the program's output matches.
func pidAfter(t *testing.T, tbl *process.Table, id string, offset *int64, name string) int {
	t.Helper()
	re := regexp.MustCompile(name + `=(\d+)\r?\n`)
	var out strings.Builder
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		res, err := tbl.Read(context.Background(), process.ReadParams{ID: id, Stream: "pty", Offset: off(*offset), WaitMs: 1000})
		if err != nil {
			t.Fatalf("read %s at %d: %v", id, *offset, err)
		}
		out.Write(res.Data)
		*offset = res.NextOffset
		if m := re.FindStringSubmatch(out.String()); m != nil {
			pid, _ := strconv.Atoi(m[1])
			return pid
		}
		if res.Exited {
			break
		}
	}
	t.Fatalf("%s never showed %s=<pid>; read %q", id, name, out.String())
	return 0
}

// foregroundGroup waits until pid's group is its terminal's foreground group, as /proc/<pid>/stat's pgrp and tpgid
// say, and returns the group.
func foregroundGroup(t *testing.T, pid int) int {
	t.Helper()
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if err != nil {
			t.Fatalf("process %d: %v", pid, err)
		}
		fields := strings.Fields(string(stat[strings.LastIndexByte(string(stat), ')')+1:]))
		if fields[2] == fields[5] {
			group, _ := strconv.Atoi(fields[2])
			return group
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d's group never became its terminal's foreground group", pid)
	return 0
}

// reaped waits until pid is no process at all, not even a zombie.
func reaped(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(patience)
	for time.Now().Before(deadline) {
		if _, ok := stateOf(pid); !ok {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d was never reaped", pid)
}

// interrupt sends INT to a pty shell running a foreground job, which must end it with an empty reply; the shell must
// then report status 130 and read on.
func interrupt(t *testing.T, tbl *process.Table, id string, offset *int64, job int) {
	t.Helper()
	res, err := tbl.Signal(process.SignalParams{ID: id, Signal: "INT"})
	if err != nil {
		t.Fatal(err)
	}
	if got := reply(t, res); len(got) != 0 {
		t.Fatalf("the reply to INT with a foreground job: %v", got)
	}
	gone(t, job)
	typeLine(t, tbl, id, "echo status=$?\n")
	readUntil(t, tbl, id, "pty", offset, "status=130")
	typeLine(t, tbl, id, "echo al''ive\n")
	readUntil(t, tbl, id, "pty", offset, "alive")
}

// reply is a result as the daemon sends it, in JSON.
func reply(t *testing.T, res any) map[string]any {
	t.Helper()
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	return got
}

// INT on a terminal is ^C: it goes to the terminal's foreground job, and the shell that started the job reads on.
func TestINTOnATerminalEndsItsForegroundJobAndNotTheShell(t *testing.T) {
	tbl := table(t, process.Options{})
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-i"}, Pty: &process.Size{Cols: 80, Rows: 24}})
	offset := int64(0)
	typeLine(t, tbl, p.ID, "sleep 300 & echo bg=$!\n")
	bg := pidAfter(t, tbl, p.ID, &offset, "bg")
	typeLine(t, tbl, p.ID, "sh -c 'echo fg=$$; exec sleep 301'\n")
	fg := pidAfter(t, tbl, p.ID, &offset, "fg")
	if group := foregroundGroup(t, fg); group != fg {
		t.Fatalf("the foreground group is %d, not the job's, %d", group, fg)
	}
	interrupt(t, tbl, p.ID, &offset, fg)

	// A pipeline's group is named for its first process; once that has ended and been reaped, INT still reaches the rest.
	typeLine(t, tbl, p.ID, "true | sh -c 'echo last=$$; exec sleep 302'\n")
	last := pidAfter(t, tbl, p.ID, &offset, "last")
	reaped(t, foregroundGroup(t, last))
	interrupt(t, tbl, p.ID, &offset, last)
	if state, ok := stateOf(bg); !ok || state == "Z" {
		t.Fatalf("the background job %d was signalled: state %q", bg, state)
	}
	if res, err := tbl.Wait(context.Background(), process.WaitParams{ID: p.ID, TimeoutMs: ms(0)}); err != nil || !res.Running {
		t.Fatalf("the shell after INT: %+v, %v", res, err)
	}
}

// A program that let go of its terminal has no foreground group to read: INT goes to its own group, and the reply says so.
func TestINTOnATerminalWithNoForegroundGroupGoesToTheProgramsGroupAndSaysSo(t *testing.T) {
	tbl := table(t, process.Options{})
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	p := start(t, tbl, process.StartParams{Argv: []string{self, dropTerminalCommand}, Pty: &process.Size{Cols: 80, Rows: 24}})
	offset := int64(0)
	readUntil(t, tbl, p.ID, "pty", &offset, "dropped")
	res, err := tbl.Signal(process.SignalParams{ID: p.ID, Signal: "INT"})
	if err != nil {
		t.Fatal(err)
	}
	if note, _ := reply(t, res)["note"].(string); !strings.Contains(note, "program's own group") {
		t.Fatalf("the reply to INT with no foreground group: %v", reply(t, res))
	}
	if res := wait(t, tbl, p.ID); res.Signal == nil || *res.Signal != "INT" {
		t.Fatalf("wait %+v", res)
	}
}

// A terminal handed to another session has a foreground group outside the program's session: INT is refused.
func TestINTIsRefusedWhenTheTerminalsForegroundGroupIsInAnotherSession(t *testing.T) {
	tbl := table(t, process.Options{})
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	p := start(t, tbl, process.StartParams{Argv: []string{self, dropTerminalCommand, "give"}, Pty: &process.Size{Cols: 80, Rows: 24}})
	offset := int64(0)
	sleep := pidAfter(t, tbl, p.ID, &offset, "gave")
	_, err = tbl.Signal(process.SignalParams{ID: p.ID, Signal: "INT"})
	if err == nil || kindOf(t, err) != rpc.KindDenied || !strings.Contains(err.Error(), "another session") {
		t.Fatalf("INT to a terminal another session holds: %v", err)
	}
	if res, err := tbl.Wait(context.Background(), process.WaitParams{ID: p.ID, TimeoutMs: ms(0)}); err != nil || !res.Running {
		t.Fatalf("the program after a refused INT: %+v, %v", res, err)
	}
	if state, ok := stateOf(sleep); !ok || state == "Z" {
		t.Fatalf("the other session's sleep %d was signalled: state %q", sleep, state)
	}
}

// The terminal's foreground group can end between the daemon's check that it is in the program's session and the
// guard's signal, and its id go to a group in another session. The guard checks again: a group with no process in the
// program's session is not signalled, and the reply says INT was not sent. Here the group has no process left at all,
// so its id is free for any session to take.
func TestINTIsNotSentWhenTheForegroundGroupHasNoProcessLeftInTheProgramsSession(t *testing.T) {
	tbl := table(t, process.Options{})
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	p := start(t, tbl, process.StartParams{Argv: []string{self, staleForegroundCommand}, Pty: &process.Size{Cols: 80, Rows: 24}})
	offset := int64(0)
	group := pidAfter(t, tbl, p.ID, &offset, "stale")
	reaped(t, group)
	res, err := tbl.Signal(process.SignalParams{ID: p.ID, Signal: "INT"})
	if err != nil {
		t.Fatalf("INT with a foreground group that has ended: %v", err)
	}
	note, _ := reply(t, res)["note"].(string)
	if !strings.Contains(note, strconv.Itoa(group)) || !strings.Contains(note, "INT was not sent") {
		t.Fatalf("the reply to INT with a foreground group that has ended: %v", reply(t, res))
	}
	if res, err := tbl.Wait(context.Background(), process.WaitParams{ID: p.ID, TimeoutMs: ms(0)}); err != nil || !res.Running {
		t.Fatalf("the program after an INT that was not sent: %+v, %v", res, err)
	}
}

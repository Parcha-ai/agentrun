package execrun_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/proctree"
)

// groupJobArg starts the test binary as a program that runs a sleep in a process group of its own, as a shell runs a
// job, and waits for it.
const groupJobArg = "group-job"

func groupJob() int {
	job := exec.Command("/bin/sleep", "300")
	job.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if job.Run() != nil {
		return 1
	}
	return 0
}

// wireGuard is a guard this test started and speaks to on its wire: the spec, then commands, as JSON lines on fd 3;
// status lines back on fd 4.
type wireGuard struct {
	cmd     *exec.Cmd
	control *os.File
	status  chan map[string]json.RawMessage
	pid     int
}

// startWireGuard starts a guard for the test binary as a groupJob, in a session of its own with a fresh terminal as its
// controlling terminal, as process.start with a pty runs a program, and waits for the program's pid.
func startWireGuard(t *testing.T) *wireGuard {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	master, slave := openTerminal(t)
	specReader, control, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	statusReader, statusWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd := &exec.Cmd{
		Path:        self,
		Args:        []string{self, execrun.GuardCommand},
		Env:         []string{},
		Stdin:       slave,
		Stdout:      slave,
		Stderr:      slave,
		ExtraFiles:  []*os.File{specReader, statusWriter},
		SysProcAttr: &syscall.SysProcAttr{Setpgid: true},
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = specReader.Close()
	_ = statusWriter.Close()
	_ = slave.Close()
	g := &wireGuard{cmd: cmd, control: control, status: make(chan map[string]json.RawMessage, 16)}
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		dec := json.NewDecoder(statusReader)
		for {
			var line map[string]json.RawMessage
			if dec.Decode(&line) != nil {
				close(g.status)
				return
			}
			g.status <- line
		}
	}()
	// Letting go of the control pipe ends the program; the guard is reaped, bounded, before the terminal is closed.
	t.Cleanup(func() {
		_ = control.Close()
		reaped := make(chan struct{})
		go func() {
			_ = cmd.Wait()
			close(reaped)
		}()
		select {
		case <-reaped:
		case <-time.After(patience):
			_ = cmd.Process.Kill()
			<-reaped
		}
		<-ended
		_ = statusReader.Close()
		_ = master.Close()
	})
	spec := map[string]any{"path": self, "argv": []string{self, groupJobArg}, "env": []string{}, "dir": "/", "terminal": true}
	g.send(t, spec)
	select {
	case line, ok := <-g.status:
		if !ok || json.Unmarshal(line["pid"], &g.pid) != nil || g.pid == 0 {
			t.Fatalf("the guard's first status line is %v, not the program's pid", line)
		}
	case <-time.After(patience):
		t.Fatal("the guard never reported the program's pid")
	}
	return g
}

func (g *wireGuard) send(t *testing.T, line any) {
	t.Helper()
	data, err := json.Marshal(line)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.control.Write(append(data, '\n')); err != nil {
		t.Fatalf("cannot write to the guard's control pipe: %v", err)
	}
}

// groupAck is what the guard says of a signal to a named group: whether it was sent and, when not, why.
type groupAck struct {
	Seq    uint64 `json:"seq"`
	Group  int    `json:"group"`
	Sent   bool   `json:"sent"`
	Reason string `json:"reason"`
}

// ack waits for the guard's answer to the group signal numbered seq, the next status line; ok is false, and the test
// failed, when no answer came.
func (g *wireGuard) ack(t *testing.T, seq uint64) (a groupAck, ok bool) {
	t.Helper()
	select {
	case line, open := <-g.status:
		if !open || line["signalled"] == nil || json.Unmarshal(line["signalled"], &a) != nil {
			t.Errorf("the guard's status line after a group signal is %v, not its answer", line)
			return a, false
		}
		if a.Seq != seq {
			t.Errorf("the guard answered signal %d, not %d: %+v", a.Seq, seq, a)
			return a, false
		}
		return a, true
	case <-time.After(2 * time.Second):
		t.Error("the guard did not say within 2 s whether it signalled the group")
	}
	return a, false
}

// job waits for the groupJob's sleep, a process under the guard that leads a group of its own.
func (g *wireGuard) job(t *testing.T) int {
	t.Helper()
	for deadline := time.Now().Add(patience); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		for _, d := range proctree.Descendants(g.cmd.Process.Pid) {
			if pgid, err := syscall.Getpgid(d); err == nil && d != g.pid && pgid == d {
				return d
			}
		}
	}
	t.Fatalf("program %d never started a job in a group of its own", g.pid)
	return 0
}

// openTerminal opens a pty: its master, which the test keeps open while the guard runs, and its slave. See pty(7).
func openTerminal(t *testing.T) (master, slave *os.File) {
	t.Helper()
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Fatal(err)
	}
	var unlock int32
	var n uint32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); errno != 0 {
		t.Fatalf("cannot unlock a terminal: %v", errno)
	}
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, master.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n))); errno != 0 {
		t.Fatalf("cannot name a terminal: %v", errno)
	}
	slave, err = os.OpenFile("/dev/pts/"+strconv.FormatUint(uint64(n), 10), os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		t.Fatal(err)
	}
	return master, slave
}

// A group the guard is asked to signal is one the daemon found in the program's session; by the time the guard acts, it
// may have ended and its id been taken by a group in another session. The guard checks again and does not signal a
// group outside the program's session; it says so. Here a sleep in a session of its own stands in for that group.
func TestTheGuardDoesNotSignalAGroupOutsideTheProgramsSession(t *testing.T) {
	g := startWireGuard(t)
	other := exec.Command("/bin/sleep", "60")
	other.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	bystander := openPidfd(t, other.Process.Pid)
	go func() { _ = other.Wait() }()
	g.send(t, map[string]any{"signal": int(syscall.SIGTERM), "group": other.Process.Pid, "seq": 1})
	if a, ok := g.ack(t, 1); ok && (a.Sent || a.Group != other.Process.Pid || a.Reason == "") {
		t.Errorf("the guard's answer for a group in another session: %+v", a)
	}
	// Had the guard signalled it, it did so before it answered: SIGTERM ends a sleep at once.
	if bystander.ended(500 * time.Millisecond) {
		t.Fatalf("the guard signalled group %d, which is in another session", other.Process.Pid)
	}
}

// A group in the program's session, as a shell's foreground job is, is signalled, and the guard says it was.
func TestTheGuardSignalsAGroupInTheProgramsSessionAndSaysSo(t *testing.T) {
	g := startWireGuard(t)
	job := g.job(t)
	fd := openPidfd(t, job)
	g.send(t, map[string]any{"signal": int(syscall.SIGTERM), "group": job, "seq": 1})
	if a, ok := g.ack(t, 1); ok && (!a.Sent || a.Group != job) {
		t.Errorf("the guard's answer for a group in the program's session: %+v", a)
	}
	if !fd.ended(patience) {
		t.Fatalf("the job's group, %d, was not signalled", job)
	}
}

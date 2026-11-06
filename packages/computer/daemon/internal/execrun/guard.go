package execrun

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The guard is the one process between the daemon and a run's program. It makes itself a child subreaper, so every
// process the program starts stays its descendant, even one that calls setsid, double-forks and is orphaned: the kernel
// hands an orphan to its nearest subreaper ancestor, not to PID 1. When the program ends, the guard SIGKILLs every
// descendant left and reaps it, until it has no child at all, then reports the program's status and exits. So nothing
// a run starts outlives its guard.
//
// The daemon starts it as `computerd guard` from /proc/self/exe, in a process group of its own, with an empty
// environment, /dev/null as stdin and the run's two output pipes as stdout and stderr, which the program inherits. The
// spec comes as one JSON object on fd 3; the status leaves as one JSON line on fd 4, written after the last descendant
// is reaped. Both fds are closed on exec, so the program never holds them. SIGTERM or SIGINT asks the guard to end the
// run: it sends SIGTERM to the program's group and to every descendant, and SIGKILLs whatever is left KillGrace later.

// GuardCommand is the daemon's hidden subcommand that runs a guard. A program that hosts execrun (computerd, or a test
// binary) must call Guard when it is started with this one argument.
const GuardCommand = "guard"

const (
	guardSpecFD         = 3
	guardStatusFD       = 4
	prSetChildSubreaper = 36
)

// guardSpec is what the daemon resolved: the program runs as given, with no lookup left to do.
type guardSpec struct {
	Path       string              `json:"path"`
	Argv       []string            `json:"argv"`
	Env        []string            `json:"env"`
	Dir        string              `json:"dir"`
	Credential *syscall.Credential `json:"credential,omitempty"`
}

// guardStatus is how the program ended: an exit code, a signal number, or the errno of a start that failed.
type guardStatus struct {
	ExitCode   *int   `json:"exitCode,omitempty"`
	Signal     int    `json:"signal,omitempty"`
	StartErrno int    `json:"startErrno,omitempty"`
	StartError string `json:"startError,omitempty"`
}

// Guard runs one guard and returns its exit code: the program's, 128 plus its signal, or 125 when the guard itself
// failed before the program started.
func Guard() int {
	signals := make(chan os.Signal, 64)
	signal.Notify(signals, syscall.SIGCHLD, syscall.SIGTERM, syscall.SIGINT)
	syscall.CloseOnExec(guardSpecFD)
	syscall.CloseOnExec(guardStatusFD)
	statusFile := os.NewFile(guardStatusFD, "status")
	report := func(s guardStatus) {
		data, _ := json.Marshal(s)
		_, _ = statusFile.Write(append(data, '\n'))
	}
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0); errno != 0 {
		report(guardStatus{StartError: "the guard cannot become a child subreaper: " + errno.Error()})
		return 125
	}
	var spec guardSpec
	specFile := os.NewFile(guardSpecFD, "spec")
	err := json.NewDecoder(specFile).Decode(&spec)
	_ = specFile.Close()
	if err != nil {
		report(guardStatus{StartError: "the guard cannot read its spec: " + err.Error()})
		return 125
	}
	devNull, err := os.Open(os.DevNull)
	if err != nil {
		report(guardStatus{StartError: "the guard cannot open " + os.DevNull + ": " + err.Error()})
		return 125
	}
	pid, err := syscall.ForkExec(spec.Path, spec.Argv, &syscall.ProcAttr{
		Dir:   spec.Dir,
		Env:   spec.Env,
		Files: []uintptr{devNull.Fd(), 1, 2},
		Sys:   &syscall.SysProcAttr{Setpgid: true, Credential: spec.Credential},
	})
	_ = devNull.Close()
	if err != nil {
		var errno syscall.Errno
		errors.As(err, &errno)
		report(guardStatus{StartErrno: int(errno), StartError: err.Error()})
		return 127
	}
	ws := supervise(pid, signals)
	if ws.Signaled() {
		report(guardStatus{Signal: int(ws.Signal())})
		return 128 + int(ws.Signal())
	}
	code := ws.ExitStatus()
	report(guardStatus{ExitCode: &code})
	return code
}

// supervise reaps every child of the guard until none is left, and returns the program's own wait status. The program
// ending, or the grace after a SIGTERM running out, sends SIGKILL to every descendant, again on each pass, so one that
// forks while it is being killed is caught on the next.
func supervise(pid int, signals <-chan os.Signal) syscall.WaitStatus {
	var status syscall.WaitStatus
	exited, ending, graceOver := false, false, false
	var grace <-chan time.Time
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		remaining := true
		for {
			var ws syscall.WaitStatus
			got, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			if errors.Is(err, syscall.ECHILD) {
				remaining = false
			}
			if err != nil || got <= 0 {
				break
			}
			if got == pid {
				status, exited = ws, true
			}
		}
		if exited && !remaining {
			return status
		}
		if (exited && !ending) || graceOver {
			signalRun(pid, exited, syscall.SIGKILL)
		}
		select {
		case sig := <-signals:
			if sig != syscall.SIGCHLD && !ending {
				ending = true
				signalRun(pid, exited, syscall.SIGTERM)
				grace = time.After(KillGrace)
			}
		case <-grace:
			graceOver, grace = true, nil
		case <-tick.C:
		}
	}
}

// signalRun signals the program's group while its leader is unreaped (so the group id is still its), then every
// descendant of this process.
func signalRun(pid int, leaderReaped bool, sig syscall.Signal) {
	if !leaderReaped {
		_ = syscall.Kill(-pid, sig)
	}
	for _, d := range descendants(os.Getpid()) {
		_ = syscall.Kill(d, sig)
	}
}

// descendants lists every process under root, from one pass over /proc/*/stat. It needs no CONFIG_PROC_CHILDREN, and
// a process that forks during the pass is found by the next one.
func descendants(root int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if ppid, ok := parentOf(pid); ok {
			children[ppid] = append(children[ppid], pid)
		}
	}
	var found []int
	for queue := []int{root}; len(queue) > 0; queue = queue[1:] {
		for _, child := range children[queue[0]] {
			found = append(found, child)
			queue = append(queue, child)
		}
	}
	return found
}

// parentOf reads the ppid from /proc/<pid>/stat: the second field after the command name, which may hold spaces and
// parentheses, so it is cut at the last ')'.
func parentOf(pid int) (int, bool) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, false
	}
	end := bytes.LastIndexByte(data, ')')
	if end < 0 {
		return 0, false
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 2 {
		return 0, false
	}
	ppid, err := strconv.Atoi(fields[1])
	return ppid, err == nil
}

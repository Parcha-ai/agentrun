package execrun

import (
	"encoding/json"
	"errors"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/proctree"
)

// The guard is the one process between the daemon and a program. It makes itself a child subreaper, so every process
// the program starts stays its descendant, even one that calls setsid, double-forks and is orphaned: the kernel hands an
// orphan to its nearest subreaper ancestor, not to PID 1. When the program ends, the guard SIGKILLs every descendant
// left and reaps it, until it has no child at all, then reports the program's status and exits. So nothing a program
// starts outlives its guard.
//
// The daemon starts it as `computerd guard` from /proc/self/exe, in a process group of its own, with an empty
// environment, and stdin, stdout and stderr that the program inherits: /dev/null or a pipe and two output pipes, or one
// terminal. The spec comes as one JSON line on fd 3, the control pipe; later lines there ask for a signal to the
// program's group, and its end (the daemon let go, or died) ends the program. Status leaves on fd 4 as JSON lines: the
// program's pid once it has started, then how it ended, after the last descendant is reaped. Both fds are closed on
// exec, so the program never holds them. SIGTERM or SIGINT asks the guard to end the program: it sends SIGTERM to the
// program's group and to every descendant, and SIGKILLs whatever is left KillGrace later.

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
	// Terminal: fds 0 to 2 are a terminal, made the controlling terminal of the program's own session.
	Terminal bool `json:"terminal,omitempty"`
}

// guardCommand is a control line after the spec.
type guardCommand struct {
	Signal int `json:"signal"`
}

// guardStatus is the program's pid once it started, then how it ended: an exit code, a signal number, or the errno of
// a start that failed.
type guardStatus struct {
	Pid        int    `json:"pid,omitempty"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	Signal     int    `json:"signal,omitempty"`
	StartErrno int    `json:"startErrno,omitempty"`
	StartError string `json:"startError,omitempty"`
}

// Guard runs one guard and returns its exit code: the program's, 128 plus its signal, or 125 when the guard itself
// failed before the program started.
func Guard() int {
	// Apart, so a burst of SIGCHLD (dropped when the buffer is full, and only a hint to reap) never drops a SIGTERM.
	childEnded, stop := make(chan os.Signal, 1), make(chan os.Signal, 2)
	signal.Notify(childEnded, syscall.SIGCHLD)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
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
	control := json.NewDecoder(os.NewFile(guardSpecFD, "control"))
	if err := control.Decode(&spec); err != nil {
		report(guardStatus{StartError: "the guard cannot read its spec: " + err.Error()})
		return 125
	}
	attr := &syscall.SysProcAttr{Setpgid: true, Credential: spec.Credential}
	if spec.Terminal {
		attr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0, Credential: spec.Credential}
	}
	pid, err := syscall.ForkExec(spec.Path, spec.Argv, &syscall.ProcAttr{Dir: spec.Dir, Env: spec.Env, Files: []uintptr{0, 1, 2}, Sys: attr})
	if err != nil {
		var errno syscall.Errno
		errors.As(err, &errno)
		report(guardStatus{StartErrno: int(errno), StartError: err.Error()})
		return 127
	}
	report(guardStatus{Pid: pid})
	commands := make(chan syscall.Signal, 8)
	go func() {
		for {
			var c guardCommand
			if control.Decode(&c) != nil {
				stop <- syscall.SIGTERM
				return
			}
			commands <- syscall.Signal(c.Signal)
		}
	}()
	ws := supervise(pid, childEnded, stop, commands)
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
// forks while it is being killed is caught on the next. A command's signal goes to the program's group while it runs.
func supervise(pid int, childEnded, stop <-chan os.Signal, commands <-chan syscall.Signal) syscall.WaitStatus {
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
		case <-childEnded:
		case <-stop:
			if !ending {
				ending = true
				signalRun(pid, exited, syscall.SIGTERM)
				grace = time.After(KillGrace)
			}
		case sig := <-commands:
			if !exited {
				_ = syscall.Kill(-pid, sig)
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
	for _, d := range proctree.Descendants(os.Getpid()) {
		_ = syscall.Kill(d, sig)
	}
}

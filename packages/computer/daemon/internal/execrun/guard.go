package execrun

import (
	"encoding/json"
	"errors"
	"fmt"
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
// terminal. Once the program runs, the guard lets go of its copies of the pipes; a terminal it keeps. The spec comes as
// one JSON line on fd 3, the control pipe; later lines there ask for a signal to the program's group, or to another group
// the daemon named (a terminal's foreground job, which it checked is in the program's session), and its end (the
// daemon let go, or died) ends the program. The guard checks a named group again right before it signals it, since the
// group may have ended since the daemon's check and its id gone to a group in another session, and answers each such
// line with whether it sent the signal. Status leaves on fd 4 as JSON lines: the program's pid once it has started, an
// answer for each signal to a named group, then how the program ended, after the last descendant is reaped. Both fds
// are closed on exec, so the program never holds them. SIGTERM or SIGINT asks the guard to end the program: it sends
// SIGTERM to the program's group and to every descendant, and SIGKILLs whatever is left KillGrace later.

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
	// WaitGroup and KeepOrphans are Program's.
	WaitGroup   bool `json:"waitGroup,omitempty"`
	KeepOrphans bool `json:"keepOrphans,omitempty"`
}

// guardCommand is a control line after the spec: a signal, to the program's group or, when Group is set, to that group,
// which the guard answers, quoting Seq.
type guardCommand struct {
	Signal int    `json:"signal"`
	Group  int    `json:"group,omitempty"`
	Seq    uint64 `json:"seq,omitempty"`
}

// groupSignalled answers a command that named a group: whether its signal was sent and, when not, why.
type groupSignalled struct {
	Seq    uint64 `json:"seq"`
	Group  int    `json:"group"`
	Sent   bool   `json:"sent"`
	Reason string `json:"reason,omitempty"`
}

// guardStatus is the program's pid once it started, an answer for each signal to a named group, then how the program
// ended: an exit code, a signal number, or the errno of a start that failed.
type guardStatus struct {
	Pid        int             `json:"pid,omitempty"`
	Signalled  *groupSignalled `json:"signalled,omitempty"`
	ExitCode   *int            `json:"exitCode,omitempty"`
	Signal     int             `json:"signal,omitempty"`
	StartErrno int             `json:"startErrno,omitempty"`
	StartError string          `json:"startError,omitempty"`
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
	if !spec.Terminal {
		releaseStdio()
	}
	report(guardStatus{Pid: pid})
	commands := make(chan guardCommand, 8)
	go func() {
		for {
			var c guardCommand
			if control.Decode(&c) != nil {
				stop <- syscall.SIGTERM
				return
			}
			commands <- c
		}
	}()
	answer := func(a groupSignalled) { report(guardStatus{Signalled: &a}) }
	run := run{pid: pid, terminal: spec.Terminal, waitGroup: spec.WaitGroup, keep: spec.KeepOrphans}
	ws, linger := run.supervise(childEnded, stop, commands, answer)
	code := ws.ExitStatus()
	if ws.Signaled() {
		code = 128 + int(ws.Signal())
		report(guardStatus{Signal: int(ws.Signal())})
	} else {
		report(guardStatus{ExitCode: &code})
	}
	if linger {
		run.linger(childEnded, stop, commands, answer)
	}
	return code
}

// run is what a guard supervises: the program, by pid, and how its end is told.
type run struct {
	pid      int
	terminal bool
	// waitGroup: the run ends once the program and every live process of its group (on a terminal, its session) have
	// ended. keep: when it ends, whatever else is left runs on (linger) instead of being killed.
	waitGroup, keep bool
}

// members is every live descendant of the guard in the program's group, or on a terminal in its session too.
func (r run) members() []int {
	var in []int
	for _, d := range proctree.Descendants(os.Getpid()) {
		if proctree.Zombie(d) {
			continue
		}
		if pgid, err := syscall.Getpgid(d); err == nil && pgid == r.pid {
			in = append(in, d)
			continue
		}
		if sid, err := getsid(d); r.terminal && err == nil && sid == r.pid {
			in = append(in, d)
		}
	}
	return in
}

// signal sends a command's signal to the run: the program's group while its leader is unreaped (so the group id is
// still the program's), and with waitGroup every member by pid too (the group's id may be gone with its leader, and on
// a terminal the session's other groups are the run's).
func (r run) signal(exited bool, sig syscall.Signal) {
	if !exited {
		_ = syscall.Kill(-r.pid, sig)
	}
	if r.waitGroup {
		for _, m := range r.members() {
			_ = syscall.Kill(m, sig)
		}
	}
}

// supervise reaps every child of the guard until the run has ended, and returns the program's own wait status, and
// whether the guard lingers for what the run left (keep). The run ends when the program does, or with waitGroup once
// no member is left either. Then every descendant is sent SIGKILL, again on each pass, so one that forks while it is
// being killed is caught on the next, unless keep has it run on. The grace after a SIGTERM running out kills all. A
// command's signal goes to the run as signal says; one that names a group goes as signalGroup says, and is answered.
func (r run) supervise(childEnded, stop <-chan os.Signal, commands <-chan guardCommand, answer func(groupSignalled)) (syscall.WaitStatus, bool) {
	pid := r.pid
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
			return status, false
		}
		over := exited && (!r.waitGroup || len(r.members()) == 0)
		if over && r.keep && !ending {
			return status, true
		}
		if (over && !ending) || graceOver {
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
		case c := <-commands:
			switch {
			case c.Group != 0:
				answer(signalGroup(pid, over, c))
			case !over:
				r.signal(exited, syscall.Signal(c.Signal))
			}
		case <-grace:
			graceOver, grace = true, nil
		case <-tick.C:
		}
	}
}

// linger reaps what a run with keep left running, once its end is reported, until none is left or the guard is told to
// end (the computer's end, or the daemon letting go): then SIGTERM to all of it, and SIGKILL KillGrace later. A
// command's signal reaches none of it: the run has ended.
func (r run) linger(childEnded, stop <-chan os.Signal, commands <-chan guardCommand, answer func(groupSignalled)) {
	ending, graceOver := false, false
	var grace <-chan time.Time
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		for {
			got, err := syscall.Wait4(-1, nil, syscall.WNOHANG, nil)
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			if errors.Is(err, syscall.ECHILD) {
				return
			}
			if err != nil || got <= 0 {
				break
			}
		}
		if graceOver {
			signalRun(r.pid, true, syscall.SIGKILL)
		}
		select {
		case <-childEnded:
		case <-stop:
			if !ending {
				ending = true
				signalRun(r.pid, true, syscall.SIGTERM)
				grace = time.After(KillGrace)
			}
		case c := <-commands:
			if c.Group != 0 {
				answer(groupSignalled{Seq: c.Seq, Group: c.Group, Reason: programEnded(syscall.Signal(c.Signal), c.Group)})
			}
		case <-grace:
			graceOver, grace = true, nil
		case <-tick.C:
		}
	}
}

// signalGroup sends c's signal to the group it names while the program runs, and only when that group is the program's
// or has a process in the program's session. The daemon checked that before it asked, but the group may have ended
// since, and its id gone to a group in another session: kill(2) on a group id names whatever group holds it when the
// call is made. The check here narrows that window to the two system calls below; the program leads its session (it
// was started with setsid), so the program's session is its pid.
func signalGroup(pid int, exited bool, c guardCommand) groupSignalled {
	a := groupSignalled{Seq: c.Seq, Group: c.Group}
	sig := syscall.Signal(c.Signal)
	switch {
	case exited:
		a.Reason = programEnded(sig, c.Group)
	case c.Group != pid && !inSession(c.Group, pid):
		a.Reason = fmt.Sprintf("group %d has no process left in the program's session (it ended, and its id may now name a group in another session)", c.Group)
	default:
		err := syscall.Kill(-c.Group, sig)
		switch {
		case err == nil:
			a.Sent = true
		case errors.Is(err, syscall.ESRCH):
			a.Reason = fmt.Sprintf("group %d ended before %s reached it", c.Group, signalName(sig))
		default:
			a.Reason = fmt.Sprintf("the guard cannot signal group %d: %v", c.Group, err)
		}
	}
	return a
}

// programEnded is why a signal to a named group was not sent once the program had ended: what is left of it is being
// killed.
func programEnded(sig syscall.Signal, group int) string {
	return fmt.Sprintf("the program ended before %s reached group %d", signalName(sig), group)
}

// inSession says whether group has a process in session. Its leader, while it is a process (a zombie too), says; once
// it has been reaped, the group's id stays the group's while any process is in it, and every process in the program's
// session descends from the program, so is under this guard, a subreaper: one of them in the group says.
func inSession(group, session int) bool {
	if sid, err := getsid(group); err == nil {
		return sid == session
	}
	return inSessionAmong(group, session, proctree.Descendants(os.Getpid()), syscall.Getpgid, getsid)
}

// inSessionAmong is inSession's search once the group's leader is gone: a member of group among members, asked its
// session.
func inSessionAmong(group, session int, members []int, pgidOf, sidOf func(int) (int, error)) bool {
	for _, d := range members {
		if pgid, err := pgidOf(d); err == nil && pgid == group {
			sid, err := sidOf(d)
			if err != nil {
				continue // It ended between the two calls; another member may still run.
			}
			return sid == session
		}
	}
	return false
}

// getsid is getsid(2), which package syscall leaves out on Linux.
func getsid(pid int) (int, error) {
	sid, _, errno := syscall.RawSyscall(syscall.SYS_GETSID, uintptr(pid), 0, 0)
	if errno != 0 {
		return 0, errno
	}
	return int(sid), nil
}

// releaseStdio points fds 0 to 2 at /dev/null, so the guard holds no copy of the program's pipes: once the program has
// closed its stdin, a write to it finds no reader and fails at once.
func releaseStdio() {
	null, err := syscall.Open(os.DevNull, syscall.O_RDWR|syscall.O_CLOEXEC, 0)
	for fd := 0; fd <= 2; fd++ {
		if err == nil {
			_ = syscall.Dup3(null, fd, 0)
		} else {
			_ = syscall.Close(fd)
		}
	}
	if err == nil {
		_ = syscall.Close(null)
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

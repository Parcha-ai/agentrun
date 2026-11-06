package execrun

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// Program is what a guard runs, before the daemon resolves its user, directory, environment and path.
type Program struct {
	Argv []string
	Cwd  string
	Env  map[string]string
	User string
	// Terminal says stdin, stdout and stderr are one terminal, which becomes the program's controlling terminal in a
	// session of its own.
	Terminal bool
}

// Guarded is a program running under its guard.
type Guarded struct {
	// Pid is the program's, not the guard's.
	Pid       int
	guard     *exec.Cmd
	controlMu sync.Mutex
	control   *os.File
	done      chan struct{}
	final     guardStatus
	reported  bool
}

// guards is every guard this process started and has not yet reaped, so init's sweep can tell a guard from an orphan.
// Start holds the lock from the fork until the guard is recorded.
var guards = struct {
	sync.Mutex
	pids map[int]bool
}{pids: map[int]bool{}}

// WithGuards calls fn while no guard starts or is forgotten; isGuard says whether a pid is one of this process's guards.
func WithGuards(fn func(isGuard func(pid int) bool)) {
	guards.Lock()
	defer guards.Unlock()
	fn(func(pid int) bool { return guards.pids[pid] })
}

// Guards is the pid of every guard not yet reaped.
func Guards() []int {
	guards.Lock()
	defer guards.Unlock()
	pids := make([]int, 0, len(guards.pids))
	for pid := range guards.pids {
		pids = append(pids, pid)
	}
	return pids
}

// afterAdmit and afterStarted are nil outside tests: they run in Start once it is let in, and once its program runs.
var afterAdmit, afterStarted func(p Program)

// guardArgs is nil outside tests: what it returns for p follows GuardCommand in the guard's argv, so a test can start a
// guard of its own making in the guard's place.
var guardArgs func(p Program) []string

// endingBegan and guardsTermed are nil outside tests: they run in EndAll once it refuses new starts, and once every
// guard has been sent SIGTERM.
var endingBegan, guardsTermed func()

// admission lets starts in until EndAll begins, and counts those in flight.
var admission struct {
	sync.Mutex
	closed   bool
	inFlight sync.WaitGroup
}

func admit() bool {
	admission.Lock()
	defer admission.Unlock()
	if admission.closed {
		return false
	}
	admission.inFlight.Add(1)
	return true
}

// EndAll ends every program, as the computer shuts down. It refuses every start from then on, waits up to slack for the
// starts in flight to start their program (or fail), then sends every guard SIGTERM (each sends SIGKILL to what is left
// of its program KillGrace later), and waits up to KillGrace plus slack for every guard to end. So every program that
// started gets SIGTERM before any SIGKILL.
func EndAll(slack time.Duration) {
	admission.Lock()
	admission.closed = true
	admission.Unlock()
	if endingBegan != nil {
		endingBegan()
	}
	started := make(chan struct{})
	go func() {
		admission.inFlight.Wait()
		close(started)
	}()
	select {
	case <-started:
	case <-time.After(slack):
	}
	for _, guard := range Guards() {
		_ = syscall.Kill(guard, syscall.SIGTERM)
	}
	if guardsTermed != nil {
		guardsTermed()
	}
	deadline := time.Now().Add(KillGrace + slack)
	for len(Guards()) > 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
}

// Start starts p under a guard of its own (guard.go), with stdin (nil is /dev/null), stdout and stderr, and returns once
// the program has started. The caller closes its own copies of the three files. A program that cannot start is an
// error of the protocol's kinds; once EndAll has begun, every start is refused as unsupported.
func Start(ctx context.Context, p Program, stdin, stdout, stderr *os.File) (*Guarded, error) {
	if !admit() {
		return nil, rpc.Errorf(rpc.KindUnsupported, "the computer is shutting down: it starts no program now")
	}
	defer admission.inFlight.Done()
	if afterAdmit != nil {
		afterAdmit(p)
	}
	if len(p.Argv) == 0 || p.Argv[0] == "" {
		return nil, rpc.Errorf(rpc.KindInvalid, "argv needs at least a program")
	}
	acct, err := resolveUser(p.User)
	if err != nil {
		return nil, err
	}
	cred, err := credential(acct)
	if err != nil {
		return nil, err
	}
	dir, err := resolveCwd(p.Cwd, acct)
	if err != nil {
		return nil, err
	}
	env := environment(acct, p.Env)
	path, err := lookPath(p.Argv[0], env, dir)
	if err != nil {
		return nil, err
	}
	specReader, specWriter, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("cannot make a pipe: %w", err)
	}
	statusReader, statusWriter, err := os.Pipe()
	if err != nil {
		closeAll(specReader, specWriter)
		return nil, fmt.Errorf("cannot make a pipe: %w", err)
	}
	args := []string{"computerd", GuardCommand}
	if guardArgs != nil {
		args = append(args, guardArgs(p)...)
	}
	cmd := &exec.Cmd{
		Path:        "/proc/self/exe",
		Args:        args,
		Env:         []string{},
		Stdout:      stdout,
		Stderr:      stderr,
		ExtraFiles:  []*os.File{specReader, statusWriter},
		SysProcAttr: &syscall.SysProcAttr{Setpgid: true},
	}
	if stdin != nil {
		cmd.Stdin = stdin
	}
	guards.Lock()
	err = cmd.Start()
	if err == nil {
		guards.pids[cmd.Process.Pid] = true
	}
	guards.Unlock()
	closeAll(specReader, statusWriter)
	if err != nil {
		closeAll(specWriter, statusReader)
		return nil, fmt.Errorf("cannot start the guard for %s: %w", p.Argv[0], err)
	}
	g := &Guarded{guard: cmd, control: specWriter, done: make(chan struct{})}
	started := make(chan struct{})
	go g.follow(statusReader, started)
	if err := json.NewEncoder(specWriter).Encode(guardSpec{Path: path, Argv: p.Argv, Env: env, Dir: dir, Credential: cred, Terminal: p.Terminal}); err != nil {
		_ = syscall.Kill(cmd.Process.Pid, syscall.SIGKILL)
		<-g.done
		g.Close()
		return nil, fmt.Errorf("cannot hand %s to its guard: %w", p.Argv[0], err)
	}
	select {
	case <-started:
		if afterStarted != nil {
			afterStarted(p)
		}
		return g, nil
	case <-g.done:
	}
	g.Close()
	if g.Pid != 0 {
		return g, nil
	}
	if g.final.StartError != "" {
		return nil, startError(p.Argv[0], g.final.StartErrno, g.final.StartError)
	}
	code, signal := exitStatus(cmd.ProcessState)
	return nil, fmt.Errorf("the guard for %s ended before it started the program (exit code %v, signal %q)", p.Argv[0], code, signal)
}

// follow reads the guard's status lines, the program's pid and then how it ended, then reaps the guard.
func (g *Guarded) follow(status *os.File, started chan<- struct{}) {
	dec := json.NewDecoder(io.LimitReader(status, 64<<10))
	for {
		var s guardStatus
		if dec.Decode(&s) != nil {
			break
		}
		if s.Pid != 0 && g.Pid == 0 {
			g.Pid = s.Pid
			close(started)
			continue
		}
		g.final, g.reported = s, true
	}
	_ = status.Close()
	_ = g.guard.Wait()
	guards.Lock()
	delete(guards.pids, g.guard.Process.Pid)
	guards.Unlock()
	close(g.done)
}

// Done is closed once the program and everything under it have ended and the guard is reaped.
func (g *Guarded) Done() <-chan struct{} { return g.done }

// Exit is how the program ended, once Done: an exit code, or the name of the signal that ended it, without SIG ("TERM"). When the
// guard was killed before it could report, it is the guard's own end, and reported is false.
func (g *Guarded) Exit() (code *int, signal string, reported bool) {
	if !g.reported {
		code, signal = exitStatus(g.guard.ProcessState)
		return code, signal, false
	}
	if g.final.Signal != 0 {
		return nil, signalName(syscall.Signal(g.final.Signal)), true
	}
	return g.final.ExitCode, "", true
}

// Signal has the guard send sig to the program's process group. Once the program has ended it does nothing.
func (g *Guarded) Signal(sig syscall.Signal) error {
	g.controlMu.Lock()
	defer g.controlMu.Unlock()
	if g.control == nil {
		return nil
	}
	data, _ := json.Marshal(guardCommand{Signal: int(sig)})
	if _, err := g.control.Write(append(data, '\n')); err != nil {
		// Only the guard reads the control pipe, so a failed write means it has ended or is ending.
		select {
		case <-g.done:
			return nil
		case <-time.After(cleanupTimeout):
			return fmt.Errorf("cannot reach the guard of process %d: %w", g.Pid, err)
		}
	}
	return nil
}

// Stop asks the guard to end the program and everything under it: SIGTERM, then SIGKILL KillGrace later.
func (g *Guarded) Stop() {
	_ = syscall.Kill(g.guard.Process.Pid, syscall.SIGTERM)
}

// Close lets go of the guard. A guard whose program still runs then ends it, as on Stop.
func (g *Guarded) Close() {
	g.controlMu.Lock()
	defer g.controlMu.Unlock()
	if g.control != nil {
		_ = g.control.Close()
		g.control = nil
	}
}

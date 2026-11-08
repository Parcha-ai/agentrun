package execrun

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	// WaitGroup: the run ends once the program and every process left in its group (with a terminal, its session) have
	// ended, and reports the program's own end. A signal goes to what is left of them once the program is gone.
	WaitGroup bool
	// KeepOrphans: when the run ends, what it left running is not ended: it runs on under the guard until it ends, or
	// the guard is told to end (the computer's end).
	KeepOrphans bool
}

// Guarded is a program running under its guard.
type Guarded struct {
	// Pid is the program's, not the guard's.
	Pid   int
	guard *exec.Cmd
	// controlMu holds the control pipe for one command at a time, a signal to a named group until it is answered.
	controlMu sync.Mutex
	control   *os.File
	seq       uint64
	// awaiting is the seq of the signal to a named group that waits for its answer, 0 when none does; follow hands
	// that answer to answered and drops any other, a late one for a signal that stopped waiting.
	answerMu sync.Mutex
	awaiting uint64
	answered chan groupSignalled
	done     chan struct{}
	// over is closed once the guard reports how the run ended, or at done if it never does; endOnce closes it.
	over     chan struct{}
	endOnce  sync.Once
	final    guardStatus
	reported bool
}

// groupAnswerTimeout bounds the wait for the guard's answer to a signal to a named group.
var groupAnswerTimeout = 2 * time.Second

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

// afterGuardFork and beforeGuardWait are nil outside tests: the first runs in Start right after a guard's fork, before
// it is recorded, with the registry's lock held; the second in follow, right before it reaps the guard.
var afterGuardFork, beforeGuardWait func(guardPid int)

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
// error of the protocol's kinds; once EndAll has begun, every start is refused as unsupported. Should ctx end before the
// guard reports the program's pid (its exec may hang on a stalled filesystem), the guard and everything under it are
// killed and reaped: a cancel is an aborted error, a deadline that passed a *startTimedOut.
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
	if ctx.Err() != nil {
		return nil, cutShort(ctx, p.Argv[0], nil, "")
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
	if err == nil && afterGuardFork != nil {
		afterGuardFork(cmd.Process.Pid)
	}
	if err == nil {
		guards.pids[cmd.Process.Pid] = true
	}
	guards.Unlock()
	closeAll(specReader, statusWriter)
	if err != nil {
		closeAll(specWriter, statusReader)
		return nil, fmt.Errorf("cannot start the guard for %s: %w", p.Argv[0], err)
	}
	g := &Guarded{guard: cmd, control: specWriter, done: make(chan struct{}), over: make(chan struct{})}
	started := make(chan struct{})
	go g.follow(statusReader, started)
	if err := json.NewEncoder(specWriter).Encode(guardSpec{Path: path, Argv: p.Argv, Env: env, Dir: dir, Credential: cred, Terminal: p.Terminal, WaitGroup: p.WaitGroup, KeepOrphans: p.KeepOrphans}); err != nil {
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
	case <-ctx.Done():
		err := killGuard(g)
		g.Close()
		if err != nil {
			return nil, err
		}
		code, signal := exitStatus(cmd.ProcessState)
		return nil, cutShort(ctx, p.Argv[0], code, signal)
	}
	g.Close()
	if g.Pid != 0 {
		return g, nil
	}
	if g.final.StartError != "" {
		return nil, startError(p.Argv[0], g.final.StartErrno, g.final.StartError)
	}
	code, signal := exitStatus(cmd.ProcessState)
	return nil, fmt.Errorf("the guard for %s ended before it reported the program's start (exit code %v, signal %q): the program may have killed it", p.Argv[0], code, signal)
}

// startTimedOut is Start's error when its context's deadline passed before the guard reported the program's pid. The
// guard was killed and reaped by then; code and signal are how it ended (none when it never started).
type startTimedOut struct {
	code   *int
	signal string
}

func (e *startTimedOut) Error() string {
	return "the deadline passed before the program started; its guard and everything under it were ended"
}

// cutShort is Start's error once ctx has ended before the program started.
func cutShort(ctx context.Context, program string, code *int, signal string) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &startTimedOut{code: code, signal: signal}
	}
	return rpc.Errorf(rpc.KindAborted, "the start of %s was cancelled before its program ran; nothing it started is left", program)
}

// follow reads the guard's status lines, the program's pid, answers to signals to named groups, and then how it ended,
// then reaps the guard.
// maxStatusLine bounds one status line from the guard; a real one is a few hundred bytes.
const maxStatusLine = 64 << 10

func (g *Guarded) follow(status *os.File, started chan<- struct{}) {
	// One status a line, each at most maxStatusLine; the stream itself has no total, since every signal to a named group
	// adds an answer. A line past the bound ends the reading, as a malformed one does.
	lines := bufio.NewScanner(status)
	lines.Buffer(make([]byte, 0, 4096), maxStatusLine)
	for lines.Scan() {
		var s guardStatus
		if json.Unmarshal(lines.Bytes(), &s) != nil {
			break
		}
		if s.Pid != 0 && g.Pid == 0 {
			g.Pid = s.Pid
			close(started)
			continue
		}
		if s.Signalled != nil {
			g.answerMu.Lock()
			if g.awaiting != 0 && s.Signalled.Seq == g.awaiting {
				g.answered <- *s.Signalled
				g.awaiting = 0
			}
			g.answerMu.Unlock()
			continue
		}
		g.final, g.reported = s, true
		// A guard that keeps what the run left (KeepOrphans) runs on after this line; the run itself has ended.
		g.end()
	}
	_ = status.Close()
	if beforeGuardWait != nil {
		beforeGuardWait(g.guard.Process.Pid)
	}
	_ = g.guard.Wait()
	guards.Lock()
	delete(guards.pids, g.guard.Process.Pid)
	guards.Unlock()
	close(g.done)
	g.end()
}

// end closes over, once.
func (g *Guarded) end() {
	g.endOnce.Do(func() {
		if g.over != nil {
			close(g.over)
		}
	})
}

// Done is closed once the program and everything under it have ended and the guard is reaped.
func (g *Guarded) Done() <-chan struct{} { return g.done }

// Ended is closed once the run has ended: the guard reported how, or is done. Before Done only with KeepOrphans, whose
// guard runs on for what the run left. Exit says how it ended once Ended.
func (g *Guarded) Ended() <-chan struct{} {
	if g.over == nil {
		return g.done
	}
	return g.over
}

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

// Signal has the guard send sig to the program's group. Once the program has ended it does nothing.
func (g *Guarded) Signal(sig syscall.Signal) error {
	g.controlMu.Lock()
	defer g.controlMu.Unlock()
	if g.control == nil {
		return nil
	}
	if err := g.command(guardCommand{Signal: int(sig)}); err != nil && !g.ended(cleanupTimeout) {
		return fmt.Errorf("cannot reach the guard of process %d: %w", g.Pid, err)
	}
	return nil
}

// SignalGroup has the guard send sig to the process group group, which the caller found in the program's session, and
// returns once the guard says whether it did: the guard checks the group again right before it signals it, and sends
// nothing to a group with no process left in that session. Sent is false, with why, when the guard did not send it,
// or the program ended first. A guard that does not answer within groupAnswerTimeout is an error.
func (g *Guarded) SignalGroup(sig syscall.Signal, group int) (sent bool, why string, err error) {
	g.controlMu.Lock()
	defer g.controlMu.Unlock()
	if g.control == nil {
		return false, programEnded(sig, group), nil
	}
	g.seq++
	answered := make(chan groupSignalled, 1)
	g.answerMu.Lock()
	g.awaiting, g.answered = g.seq, answered
	g.answerMu.Unlock()
	defer func() {
		g.answerMu.Lock()
		g.awaiting, g.answered = 0, nil
		g.answerMu.Unlock()
	}()
	if err := g.command(guardCommand{Signal: int(sig), Group: group, Seq: g.seq}); err != nil {
		if g.ended(cleanupTimeout) {
			return false, programEnded(sig, group), nil
		}
		return false, "", fmt.Errorf("cannot reach the guard of process %d: %w", g.Pid, err)
	}
	timer := time.NewTimer(groupAnswerTimeout)
	defer timer.Stop()
	select {
	case a := <-answered:
		return a.Sent, a.Reason, nil
	case <-g.done:
		// follow hands over every answer the guard wrote before it closes done.
		select {
		case a := <-answered:
			return a.Sent, a.Reason, nil
		default:
			return false, programEnded(sig, group), nil
		}
	case <-timer.C:
		return false, "", rpc.Errorf(rpc.KindTimeout, "the guard of process %d did not say within %v whether it sent %s to group %d, so it may or may not have", g.Pid, groupAnswerTimeout, signalName(sig), group)
	}
}

// command writes c to the control pipe; controlMu is held.
func (g *Guarded) command(c guardCommand) error {
	data, _ := json.Marshal(c)
	_, err := g.control.Write(append(data, '\n'))
	return err
}

// ended waits up to within for the guard to end. Only the guard reads the control pipe, so a write that failed means it
// has ended or is ending.
func (g *Guarded) ended(within time.Duration) bool {
	select {
	case <-g.done:
		return true
	case <-time.After(within):
		return false
	}
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

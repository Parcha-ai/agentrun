// Package execrun runs one program to its end: argv only, never a shell, in a process group of its own.
package execrun

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// MaxOutput is the most bytes kept of each stream. Two full streams, in base64, fit one 1 MiB reply line.
const MaxOutput = 360 << 10

// KillGrace is how long a group has between SIGTERM and SIGKILL.
const KillGrace = 2 * time.Second

// Spec is one run.
type Spec struct {
	Argv    []string
	Cwd     string
	Env     map[string]string
	User    string
	Timeout time.Duration
	// MaxOutput is the bytes kept of each stream: nil is MaxOutput.
	MaxOutput *int
}

// Result is what a run that ended, or timed out, reports. Stdout and Stderr marshal as base64.
type Result struct {
	ExitCode  *int   `json:"exitCode"`
	Signal    string `json:"signal,omitempty"`
	Stdout    []byte `json:"stdout"`
	Stderr    []byte `json:"stderr"`
	TimedOut  bool   `json:"timedOut"`
	Truncated bool   `json:"truncated"`
}

// Run runs spec to its end. On timeout or cancel the whole process group gets SIGTERM, then SIGKILL KillGrace later;
// a timeout is a result with TimedOut set, a cancel an aborted error. When the program ends, whatever it left in its
// group is killed: nothing a run starts outlives it.
func Run(ctx context.Context, spec Spec) (Result, error) {
	if len(spec.Argv) == 0 || spec.Argv[0] == "" {
		return Result{}, rpc.Errorf(rpc.KindInvalid, "argv needs at least a program")
	}
	if spec.Timeout <= 0 {
		return Result{}, rpc.Errorf(rpc.KindInvalid, "the timeout must be positive")
	}
	limit, err := resolveByteLimit("maxOutput", spec.MaxOutput, MaxOutput, MaxOutput)
	if err != nil {
		return Result{}, err
	}
	acct, err := resolveUser(spec.User)
	if err != nil {
		return Result{}, err
	}
	cred, err := credential(acct)
	if err != nil {
		return Result{}, err
	}
	dir, err := resolveCwd(spec.Cwd, acct)
	if err != nil {
		return Result{}, err
	}
	env := environment(acct, spec.Env)
	path, err := lookPath(spec.Argv[0], env)
	if err != nil {
		return Result{}, err
	}
	cmd := &exec.Cmd{Path: path, Args: spec.Argv, Env: env, Dir: dir, SysProcAttr: &syscall.SysProcAttr{Setpgid: true, Credential: cred}}

	stdout, err := newOutputStream(limit)
	if err != nil {
		return Result{}, fmt.Errorf("cannot make a pipe: %w", err)
	}
	defer closeAll(stdout.reader, stdout.writer)
	stderr, err := newOutputStream(limit)
	if err != nil {
		return Result{}, fmt.Errorf("cannot make a pipe: %w", err)
	}
	defer closeAll(stderr.reader, stderr.writer)
	cmd.Stdout, cmd.Stderr = stdout.writer, stderr.writer

	if ctx.Err() != nil {
		return Result{}, rpc.Errorf(rpc.KindAborted, "exec.run was cancelled before it started")
	}
	if err := cmd.Start(); err != nil {
		return Result{}, startError(spec.Argv[0], err)
	}
	stdout.collect()
	stderr.collect()
	leaderDone := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(leaderDone)
	}()

	timer := time.NewTimer(spec.Timeout)
	defer timer.Stop()
	timedOut, aborted := false, false
	select {
	case <-leaderDone:
	case <-timer.C:
		timedOut = true
	case <-ctx.Done():
		aborted = true
	}
	if timedOut || aborted {
		if err := terminate(cmd, leaderDone); err != nil {
			return Result{}, err
		}
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	drain(stdout, stderr)
	if aborted {
		return Result{}, rpc.Errorf(rpc.KindAborted, "exec.run was cancelled; its process group was ended")
	}
	code, sig := exitStatus(cmd.ProcessState)
	return Result{
		ExitCode:  code,
		Signal:    sig,
		Stdout:    stdout.bytes(),
		Stderr:    stderr.bytes(),
		TimedOut:  timedOut,
		Truncated: stdout.truncated || stderr.truncated,
	}, nil
}

// terminate sends the group SIGTERM, and SIGKILL if the leader or any member is still there KillGrace later.
func terminate(cmd *exec.Cmd, leaderDone <-chan struct{}) error {
	grace, cancel := context.WithTimeout(context.Background(), KillGrace)
	defer cancel()
	signalGroup(grace, cmd, syscall.SIGTERM)
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-tick.C:
			if closed(leaderDone) && errors.Is(syscall.Kill(-cmd.Process.Pid, 0), syscall.ESRCH) {
				return nil
			}
		case <-grace.Done():
			signalGroup(context.Background(), cmd, syscall.SIGKILL)
			select {
			case <-leaderDone:
				return nil
			case <-time.After(cleanupTimeout):
				return fmt.Errorf("process %d did not end %v after SIGKILL", cmd.Process.Pid, cleanupTimeout)
			}
		}
	}
}

// cleanupTimeout bounds the wait for a killed leader, and for output pipes held open outside the group.
const cleanupTimeout = 10 * time.Second

// drain waits for both streams to reach end of file. A pipe still held open (by a process that left the group) is
// closed on this side after drainGrace, and what was read so far is kept.
func drain(streams ...*outputStream) {
	deadline := time.After(drainGrace)
	for _, s := range streams {
		select {
		case <-s.done:
		case <-deadline:
			for _, other := range streams {
				_ = other.reader.Close()
			}
			<-s.done
		}
	}
}

const drainGrace = 2 * time.Second

func closed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func closeAll(files ...*os.File) {
	for _, f := range files {
		_ = f.Close()
	}
}

func startError(program string, err error) error {
	switch {
	case errors.Is(err, syscall.EPERM), errors.Is(err, syscall.EACCES):
		return rpc.Errorf(rpc.KindDenied, "cannot start %s: %v", program, err)
	case errors.Is(err, syscall.ENOENT):
		return rpc.Errorf(rpc.KindNotFound, "cannot start %s: %v", program, err)
	default:
		return rpc.Errorf(rpc.KindInvalid, "cannot start %s: %v", program, err)
	}
}

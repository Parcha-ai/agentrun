// Package daemon is computerd's two long-lived roles: init, the computer's first process, which holds every process and
// serves each connection on a unix socket; and stdio, a thin bridge from stdin and stdout to that socket.
package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/methods"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/proctree"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// SocketEnv names the socket's path when it is not DefaultSocket.
const SocketEnv = "AGENTRUN_COMPUTERD_SOCKET"

// DefaultSocket is where init listens, in a directory only the daemon's user may enter.
const DefaultSocket = "/run/agentrun/computerd.sock"

const (
	prSetChildSubreaper = 36
	// sweepEvery is how often init looks for orphans when no SIGCHLD has asked it to.
	sweepEvery = time.Second
	// stopSlack is how long past the guards' KillGrace init waits for them on SIGTERM before it kills what is left.
	stopSlack = 3 * time.Second
	// dialFor is how long the bridge waits for init's socket to appear, as it may when a computer has just started.
	dialFor = 3 * time.Second
)

// SocketPath is SocketEnv's value, or DefaultSocket.
func SocketPath() string {
	if path := os.Getenv(SocketEnv); path != "" {
		return path
	}
	return DefaultSocket
}

// Init runs as the computer's first process. It is a child subreaper (PID 1 is one anyway), serves every connection on
// socket with one process table, and sweeps: a child of its own that is not one of its guards is an orphan whose guard
// died, and is killed with everything under it. SIGTERM, SIGINT or the deadline ends every process, guards first, and
// returns 0, which ends the computer.
func Init(version, socket string, deadline time.Time, logger *log.Logger) int {
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0); errno != 0 {
		logger.Printf("init: cannot become a child subreaper: %v", errno)
		return 1
	}
	signals := make(chan os.Signal, 1)
	stop := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGCHLD)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	listener, err := listen(socket)
	if err != nil {
		logger.Printf("init: %v", err)
		return 1
	}
	if os.Getpid() != 1 {
		logger.Printf("init: running as pid %d, not 1: orphans outside this process's tree are not reaped", os.Getpid())
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := rpc.NewServer(methods.Handlers(version, process.NewTable(process.Options{})), logger)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				if err := server.Serve(ctx, conn, conn); err != nil {
					logger.Printf("init: a connection failed: %v", err)
				}
				_ = conn.Close()
			}()
		}
	}()
	tick := time.NewTicker(sweepEvery)
	defer tick.Stop()
	end := time.NewTimer(time.Until(deadline))
	defer end.Stop()
	for {
		select {
		case <-signals:
			sweep()
		case <-tick.C:
			sweep()
		case sig := <-stop:
			logger.Printf("init: %v, ending every process", sig)
			_ = listener.Close()
			shutdown()
			return 0
		case <-end.C:
			logger.Printf("init: the deadline %s has come, ending every process and the computer", deadline.UTC().Format(time.RFC3339Nano))
			_ = listener.Close()
			shutdown()
			return 0
		}
	}
}

// listen listens on a socket only the daemon's user may use, in a directory that must already be there, the daemon's
// user's alone (0700) and writable by it: a non-root init cannot make one under /run, so the provider mounts it. A
// socket left by an init that is gone is replaced; a live one is refused.
func listen(socket string) (net.Listener, error) {
	dir := filepath.Dir(socket)
	info, err := os.Stat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("the socket's directory %s is missing; the computer's provider must make it, 0700 and owned by uid %d (Docker: --tmpfs %s:uid=%d,gid=%d,mode=0700), or %s must name a socket in one", dir, os.Geteuid(), dir, os.Geteuid(), os.Getegid(), SocketEnv)
	}
	if err != nil {
		return nil, fmt.Errorf("cannot read the socket's directory %s: %w", dir, err)
	}
	if st, ok := info.Sys().(*syscall.Stat_t); !info.IsDir() || !ok || int(st.Uid) != os.Geteuid() || info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("the socket's directory %s must be a directory of the daemon's user, uid %d, alone (mode 0700), not %v", dir, os.Geteuid(), info.Mode())
	}
	if err := syscall.Access(dir, 0o3); err != nil {
		return nil, fmt.Errorf("the socket's directory %s is not writable by the daemon's user, uid %d (mode %v): %w", dir, os.Geteuid(), info.Mode().Perm(), err)
	}
	if conn, err := net.Dial("unix", socket); err == nil {
		_ = conn.Close()
		return nil, fmt.Errorf("another daemon already listens on %s", socket)
	}
	if info, err := os.Lstat(socket); err == nil && info.Mode()&os.ModeSocket != 0 {
		_ = os.Remove(socket)
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return nil, fmt.Errorf("cannot listen on %s: %w", socket, err)
	}
	listener.(*net.UnixListener).SetUnlinkOnClose(true)
	if err := os.Chmod(socket, 0o600); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("cannot make %s private: %w", socket, err)
	}
	return listener, nil
}

// sweep reaps every child that has ended and is no guard, and kills every other child that is no guard, with all under
// it: such a child is an orphan handed to init because the guard above it died.
func sweep() {
	execrun.WithGuards(func(isGuard func(int) bool) {
		self := os.Getpid()
		children := proctree.Children()
		for _, child := range children[self] {
			if isGuard(child) {
				continue
			}
			if proctree.Zombie(child) {
				_, _ = syscall.Wait4(child, nil, syscall.WNOHANG, nil)
				continue
			}
			for _, d := range proctree.Descendants(child) {
				_ = syscall.Kill(d, syscall.SIGKILL)
			}
			_ = syscall.Kill(child, syscall.SIGKILL)
		}
	})
}

// shutdown asks every guard to end its program (SIGTERM, then the guard's SIGKILL KillGrace later), waits for them,
// then kills whatever is left under init and reaps it.
func shutdown() {
	for _, guard := range execrun.Guards() {
		_ = syscall.Kill(guard, syscall.SIGTERM)
	}
	deadline := time.Now().Add(execrun.KillGrace + stopSlack)
	for len(execrun.Guards()) > 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	deadline = time.Now().Add(stopSlack)
	for time.Now().Before(deadline) {
		left := proctree.Descendants(os.Getpid())
		for _, pid := range left {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
		for {
			pid, err := syscall.Wait4(-1, nil, syscall.WNOHANG, nil)
			if pid <= 0 && !errors.Is(err, syscall.EINTR) {
				break
			}
		}
		if len(left) == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// afterHalfClose is nil outside tests: it runs right after the bridge half-closes the connection.
var afterHalfClose func()

// Bridge copies in to the daemon at socket and the daemon's replies to out, until either side ends. With no daemon to
// reach it says so on errOut and returns 1; it returns 0 when its input ended first.
func Bridge(socket string, in io.Reader, out io.Writer, errOut io.Writer) int {
	conn, err := dial(socket)
	if err != nil {
		fmt.Fprintf(errOut, "computerd stdio: no daemon listens at %s (%v); the computer's first process must be `computerd init`, and %s names another socket\n", socket, err, SocketEnv)
		return 1
	}
	defer conn.Close()
	inputEnded := make(chan struct{})
	replies := make(chan struct{})
	go func() {
		_, _ = io.Copy(conn, in)
		// Marked before the half-close: the daemon's answering close can only come after it.
		close(inputEnded)
		_ = conn.CloseWrite()
		if afterHalfClose != nil {
			afterHalfClose()
		}
	}()
	go func() {
		_, _ = io.Copy(out, conn)
		close(replies)
	}()
	select {
	case <-inputEnded:
		// The daemon answers what was sent, then closes its end.
		<-replies
		return 0
	case <-replies:
		select {
		case <-inputEnded:
			return 0
		default:
		}
		fmt.Fprintln(errOut, "computerd stdio: the daemon closed the connection")
		return 1
	}
}

// dial connects to socket, waiting up to dialFor while it is missing or not yet listening.
func dial(socket string) (*net.UnixConn, error) {
	deadline := time.Now().Add(dialFor)
	for {
		conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: socket, Net: "unix"})
		if err == nil {
			return conn, nil
		}
		retry := errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED)
		if !retry || time.Now().After(deadline) {
			return nil, err
		}
		time.Sleep(50 * time.Millisecond)
	}
}

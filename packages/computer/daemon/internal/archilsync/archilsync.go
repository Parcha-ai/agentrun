// Package archilsync is the resident sync of a computer's Archil mount: `computerd sync-serve`, which the root helper's
// serve verb becomes, and the mount.sync call computerd makes of it.
//
// The server runs as root, holds no token, and listens on a unix socket in a folder of its own (0750, root and the tool
// user's group; the socket 0660). It takes one fixed request byte on a connection the client then half-closes, runs
// `archil sync <mountpoint>` (every write so far durable when it returns), and answers that sync's exit code as one
// byte. Any other input is refused: the connection is closed and nothing runs. Requests during a sync in flight wait for
// it, then share one more. It exits when the archil mount is gone from the mount table, or when its socket is taken away
// (the helper's checkin removes it first), and then removes its socket only if it is still its own.
package archilsync

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// SocketPath is where every computer's serve listens: not in computerd's own socket folder (/run/agentrun), which is
// the tool user's alone.
const SocketPath = "/run/agentrun-archil/archil.sock"

// Request is the one byte that asks for a sync.
const Request byte = 's'

// ErrNotMounted is a Listen with no archil mount at the mountpoint: nothing to sync (the helper's exit 3).
var ErrNotMounted = errors.New("nothing is mounted at the mountpoint as an archil mount")

// ErrServing is a Listen where a server already answers on the socket.
var ErrServing = errors.New("a sync server already answers on the socket")

// Config is what sync-serve is given, by the helper alone, with fixed values.
type Config struct {
	// Socket is the unix socket to listen on.
	Socket string
	// Mountpoint is the archil mount's mountpoint, /workspace.
	Mountpoint string
	// Mounts is the mount table to watch, /proc/self/mounts.
	Mounts string
	// Archil is the archil client.
	Archil string
	// GID is the group that may connect: the tool user's.
	GID int
	// Poll is how often the server checks its mount and its socket; zero is a second.
	Poll time.Duration
	// SyncTimeout bounds one sync; zero is five minutes.
	SyncTimeout time.Duration
}

const configWords = "sync-serve takes --socket <path> --mountpoint <path> --mounts <path> --archil <path> --gid <gid>, each once, every path absolute and the gid a number above 0"

// ConfigOf reads sync-serve's arguments: exactly the helper's five, each once.
func ConfigOf(args []string) (Config, error) {
	var config Config
	seen := map[string]bool{}
	if len(args) != 10 {
		return Config{}, errors.New(configWords)
	}
	for i := 0; i < len(args); i += 2 {
		name, value := args[i], args[i+1]
		if seen[name] {
			return Config{}, errors.New(configWords)
		}
		seen[name] = true
		switch name {
		case "--socket", "--mountpoint", "--mounts", "--archil":
			if !filepath.IsAbs(value) || filepath.Clean(value) != value {
				return Config{}, errors.New(configWords)
			}
			switch name {
			case "--socket":
				config.Socket = value
			case "--mountpoint":
				config.Mountpoint = value
			case "--mounts":
				config.Mounts = value
			default:
				config.Archil = value
			}
		case "--gid":
			gid, err := strconv.Atoi(value)
			if err != nil || gid <= 0 || strconv.Itoa(gid) != value {
				return Config{}, errors.New(configWords)
			}
			config.GID = gid
		default:
			return Config{}, errors.New(configWords)
		}
	}
	config.Poll = time.Second
	config.SyncTimeout = 5 * time.Minute
	return config, nil
}

// mounted is whether the mount table lists an archil mount at the mountpoint.
func mounted(config Config) bool {
	data, err := os.ReadFile(config.Mounts)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && unescape(fields[1]) == config.Mountpoint && fields[2] == "fuse.archil" {
			return true
		}
	}
	return false
}

// unescape undoes the mount table's octal escapes (a space is \040).
func unescape(field string) string {
	var out strings.Builder
	for i := 0; i < len(field); i++ {
		if field[i] == '\\' && i+4 <= len(field) {
			if n, err := strconv.ParseUint(field[i+1:i+4], 8, 8); err == nil {
				out.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		out.WriteByte(field[i])
	}
	return out.String()
}

// Listen makes the socket's folder (0750, this user's and the group's; a link or another user's is refused) and listens
// on the socket (0660, the same owner and group). A stale socket is replaced; a live one is ErrServing. With no archil
// mount at the mountpoint, it is ErrNotMounted, and nothing is made.
func Listen(config Config) (*Listener, error) {
	if !mounted(config) {
		return nil, ErrNotMounted
	}
	dir := filepath.Dir(config.Socket)
	info, err := os.Lstat(dir)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if err := os.Mkdir(dir, 0o750); err != nil {
			return nil, fmt.Errorf("making the socket's folder %s: %w", dir, err)
		}
	case err != nil:
		return nil, fmt.Errorf("reading the socket's folder %s: %w", dir, err)
	case !info.IsDir():
		return nil, fmt.Errorf("the socket's folder %s is not a folder (a link, or a file)", dir)
	default:
		if st, ok := info.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != os.Geteuid() {
			return nil, fmt.Errorf("the socket's folder %s is not this user's", dir)
		}
	}
	if err := os.Lchown(dir, os.Geteuid(), config.GID); err != nil {
		return nil, fmt.Errorf("giving the socket's folder %s to group %d: %w", dir, config.GID, err)
	}
	if err := os.Chmod(dir, 0o750); err != nil {
		return nil, fmt.Errorf("making the socket's folder %s 0750: %w", dir, err)
	}
	if info, err := os.Lstat(config.Socket); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("%s is not a socket", config.Socket)
		}
		if conn, err := net.DialTimeout("unix", config.Socket, time.Second); err == nil {
			_ = conn.Close()
			return nil, ErrServing
		}
		if err := os.Remove(config.Socket); err != nil {
			return nil, fmt.Errorf("removing the stale socket %s: %w", config.Socket, err)
		}
	}
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: config.Socket, Net: "unix"})
	if err != nil {
		return nil, fmt.Errorf("listening on %s: %w", config.Socket, err)
	}
	l.SetUnlinkOnClose(false)
	if err := os.Lchown(config.Socket, os.Geteuid(), config.GID); err != nil {
		_ = l.Close()
		_ = os.Remove(config.Socket)
		return nil, fmt.Errorf("giving the socket %s to group %d: %w", config.Socket, config.GID, err)
	}
	if err := os.Chmod(config.Socket, 0o660); err != nil {
		_ = l.Close()
		_ = os.Remove(config.Socket)
		return nil, fmt.Errorf("making the socket %s 0660: %w", config.Socket, err)
	}
	own, _ := identityOf(config.Socket)
	return &Listener{UnixListener: l, own: own}, nil
}

// Listener is the socket's listener, with the socket as it was when it was made, so a socket put in its place is told
// apart, however soon.
type Listener struct {
	*net.UnixListener
	own identity
}

// Inherit is a listener Listen made in another process, given as file (sync-serve passes it to the server it starts):
// the socket at config.Socket is taken as its own as it is now.
func Inherit(file *os.File, config Config) (*Listener, error) {
	l, err := net.FileListener(file)
	if err != nil {
		return nil, fmt.Errorf("taking the listener on %s: %w", config.Socket, err)
	}
	unix, ok := l.(*net.UnixListener)
	if !ok {
		_ = l.Close()
		return nil, fmt.Errorf("the listener given for %s is not a unix socket's", config.Socket)
	}
	unix.SetUnlinkOnClose(false)
	own, _ := identityOf(config.Socket)
	return &Listener{UnixListener: unix, own: own}, nil
}

// identity is a file's device, inode, kind and change time: the socket as this server made it. An inode is reused
// when a file is removed and another made, so the kind and the change time tell the new one apart.
type identity struct {
	dev, ino uint64
	mode     os.FileMode
	ctime    syscall.Timespec
}

func identityOf(path string) (identity, bool) {
	info, err := os.Lstat(path)
	if err != nil {
		return identity{}, false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return identity{}, false
	}
	return identity{dev: uint64(st.Dev), ino: st.Ino, mode: info.Mode().Type(), ctime: st.Ctim}, true //nolint:unconvert // Dev's type differs by platform.
}

// Serve answers requests on l until ctx ends, the mount is gone from the mount table, or the socket is taken away. It
// then removes the socket if it is still the one it listened on, and returns nil.
func Serve(ctx context.Context, l *Listener, config Config, sync func(context.Context) int) error {
	poll := config.Poll
	if poll <= 0 {
		poll = time.Second
	}
	own := l.own
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		ticker := time.NewTicker(poll)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = l.Close()
				return
			case <-ticker.C:
				now, ok := identityOf(config.Socket)
				if !mounted(config) || !ok || now != own {
					cancel()
				}
			}
		}
	}()
	requests := make(chan chan int)
	go coalesce(ctx, requests, sync)
	for {
		conn, err := l.Accept()
		if err != nil {
			if ctx.Err() == nil {
				cancel()
				return fmt.Errorf("accepting on %s: %w", config.Socket, err)
			}
			if now, ok := identityOf(config.Socket); ok && now == own {
				_ = os.Remove(config.Socket)
			}
			return nil
		}
		go answer(ctx, conn, requests)
	}
}

// coalesce runs one sync for every batch of requests: those waiting when the last one ended.
func coalesce(ctx context.Context, requests chan chan int, sync func(context.Context) int) {
	for {
		var batch []chan int
		select {
		case <-ctx.Done():
			return
		case reply := <-requests:
			batch = append(batch, reply)
		}
	drain:
		for {
			select {
			case reply := <-requests:
				batch = append(batch, reply)
			default:
				break drain
			}
		}
		code := sync(ctx)
		for _, reply := range batch {
			reply <- code
		}
	}
}

// answer reads one connection's request: exactly the request byte, then the client's half-close. Anything else closes
// the connection with no answer, and nothing runs.
func answer(ctx context.Context, conn net.Conn, requests chan chan int) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got, err := io.ReadAll(io.LimitReader(conn, 2))
	if err != nil || len(got) != 1 || got[0] != Request {
		return
	}
	reply := make(chan int, 1)
	select {
	case requests <- reply:
	case <-ctx.Done():
		return
	}
	select {
	case code := <-reply:
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_, _ = conn.Write([]byte{byte(code)})
	case <-ctx.Done():
	}
}

// RunSync is one `archil sync <mountpoint>` with a clean environment, bounded by timeout: its exit code, 124 past the
// bound, 127 when it could not start.
func RunSync(archil, mountpoint string, timeout time.Duration) func(context.Context) int {
	return func(ctx context.Context) int {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, archil, "sync", mountpoint)
		cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
		cmd.WaitDelay = time.Second
		err := cmd.Run()
		if ctx.Err() != nil {
			return 124
		}
		var exit *exec.ExitError
		switch {
		case err == nil:
			return 0
		case errors.As(err, &exit):
			if code := exit.ExitCode(); code >= 0 {
				return code
			}
			return 128
		default:
			return 127
		}
	}
}

// Ask asks the server at socket for one sync and returns its exit code. With no server there it is not_found, in words.
func Ask(ctx context.Context, socket string) (int, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		if ctx.Err() != nil {
			return 0, rpc.Errorf(rpc.KindAborted, "mount.sync was cancelled")
		}
		return 0, rpc.Errorf(rpc.KindNotFound, "no Archil sync server answers at %s: this computer has no Archil mount, or it was let go", socket)
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	unix := conn.(*net.UnixConn)
	if _, err := unix.Write([]byte{Request}); err != nil {
		return 0, rpc.Errorf(rpc.KindNotFound, "the Archil sync server at %s went away: %v", socket, err)
	}
	_ = unix.CloseWrite()
	got := make([]byte, 1)
	if _, err := io.ReadFull(unix, got); err != nil {
		if ctx.Err() != nil {
			return 0, rpc.Errorf(rpc.KindAborted, "mount.sync was cancelled")
		}
		return 0, rpc.Errorf(rpc.KindNotFound, "the Archil sync server at %s gave no answer (it exits when the mount is let go)", socket)
	}
	return int(got[0]), nil
}

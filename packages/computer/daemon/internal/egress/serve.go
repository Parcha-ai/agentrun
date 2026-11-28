package egress

// Where a hosted computer's egress proxy runs and who holds it. Init, as root and still in the machine's own network,
// starts it before it leaves for a network of its own (`computerd init --own-network --network <form>`): it listens on
// ProxySocket, in a folder that is root's and the computer's user's group's alone, writes the form it serves to
// PolicyPath, and leaves the proxy as itself again (`computerd egress-proxy`) as nobody, with the listener. So the
// proxy holds the machine's network, its programs reach it only through init's relay on their own loopback, and the
// computer's user can neither signal it nor read its memory (another uid). The proxy ends at the computer's latest end,
// or once init, its parent, is gone.

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

const (
	// ProxySocket is where a hosted computer's proxy listens: beside the daemon, under the folder install makes root's
	// alone. The same path as the Docker computer's (src/docker/egress.ts EGRESS_SOCKET).
	ProxySocket = "/opt/agentrun/egress/egress.sock"
	// PolicyPath holds the form the proxy serves, as init was given it: "open", or "allow:" and the list's entries
	// joined by commas. The computer's user may read it; the provider reads it back.
	PolicyPath = "/opt/agentrun/egress/policy"
	// ProxyLogPath is the proxy's log, root's alone: one line per decision, host, port, address and class.
	ProxyLogPath = "/opt/agentrun/egress-proxy.log"
	// ProxyRun is the proxy init leaves: itself again, given the listener as fd 3.
	ProxyRun = "egress-proxy"
	// ProxyUser is the uid and gid the proxy runs as: nobody, which no computer's user is.
	ProxyUser = 65534
	// parentEvery is how often the proxy looks for init, its parent.
	parentEvery = time.Second
)

// Network is a form init's proxy serves: Open, or a host list.
type Network struct {
	Allow *Allow
}

// String is the form as init takes it and PolicyPath holds it.
func (n Network) String() string {
	if n.Allow == nil {
		return "open"
	}
	return "allow:" + strings.Join(n.Allow.Entries(), ",")
}

// NetworkWords is how init's --network is written.
const NetworkWords = "--network takes open, or allow: and a list of names (two labels or more, or *. and one) and CIDRs joined by commas, such as allow:example.com,*.example.org,203.0.114.0/24"

// NetworkOf reads `open` or `allow:<list>`.
func NetworkOf(text string) (Network, error) {
	if text == "open" {
		return Network{}, nil
	}
	list, found := strings.CutPrefix(text, "allow:")
	if !found {
		return Network{}, errors.New(NetworkWords)
	}
	allow, err := ParseAllow(list)
	if err != nil {
		return Network{}, fmt.Errorf("%s: %w", NetworkWords, err)
	}
	return Network{Allow: &allow}, nil
}

// PublicEgressWords is how init's --public-egress is written.
const PublicEgressWords = "--public-egress is the operator's public egress, <IPv4>:<port> such as 192.0.2.40:8443, a port from 1 to 65535 and no leading zero in either, given once, with --network"

// publicEgressPattern is a public egress as the provider checks it (publicEgressOf) and as attach checks its relay: an
// IPv4 address and a port from 1 to 65535, with no leading zero in either.
var publicEgressPattern = regexp.MustCompile(`^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d):(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$`)

// PublicEgressOf reads `<IPv4>:<port>`, the address a tunnel to port 443 opens TCP to (Options.PublicEgress).
func PublicEgressOf(text string) (netip.AddrPort, error) {
	if !publicEgressPattern.MatchString(text) {
		return netip.AddrPort{}, errors.New(PublicEgressWords)
	}
	return netip.ParseAddrPort(text)
}

// StartProxy listens on ProxySocket (its folder root's and gid's, 0750; the socket 0660), writes PolicyPath (0640, root's
// and gid's), and starts self as the proxy, nobody, in a session of its own, with the listener as fd 3 and its log at
// ProxyLogPath, given config's arguments (ProxyConfig.Args) with this process its parent: the proxy's pid. As root only.
// The folder above the socket's must be root's and writable by no one else (install makes it so); a socket that answers
// is refused (another proxy holds it), a stale one replaced.
func StartProxy(self string, config ProxyConfig, gid int) (int, error) {
	dir := filepath.Dir(ProxySocket)
	if err := rootsAlone(filepath.Dir(dir)); err != nil {
		return 0, err
	}
	info, err := os.Lstat(dir)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if err := os.Mkdir(dir, 0o750); err != nil {
			return 0, fmt.Errorf("making the egress proxy's folder %s: %w", dir, err)
		}
	case err != nil:
		return 0, fmt.Errorf("reading the egress proxy's folder %s: %w", dir, err)
	case !info.IsDir():
		return 0, fmt.Errorf("the egress proxy's folder %s is not a folder (a link, or a file)", dir)
	}
	if err := os.Lchown(dir, 0, gid); err != nil {
		return 0, fmt.Errorf("giving the egress proxy's folder %s to root and group %d: %w", dir, gid, err)
	}
	if err := os.Chmod(dir, 0o750); err != nil {
		return 0, fmt.Errorf("making the egress proxy's folder %s 0750: %w", dir, err)
	}
	if info, err := os.Lstat(ProxySocket); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return 0, fmt.Errorf("%s is not a socket", ProxySocket)
		}
		if conn, err := net.DialTimeout("unix", ProxySocket, time.Second); err == nil {
			_ = conn.Close()
			return 0, fmt.Errorf("an egress proxy answers on %s already", ProxySocket)
		}
		if err := os.Remove(ProxySocket); err != nil {
			return 0, fmt.Errorf("removing the stale socket %s: %w", ProxySocket, err)
		}
	}
	if err := writeOwned(PolicyPath, config.Network.String()+"\n", gid); err != nil {
		return 0, err
	}
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: ProxySocket, Net: "unix"})
	if err != nil {
		return 0, fmt.Errorf("listening on %s: %w", ProxySocket, err)
	}
	l.SetUnlinkOnClose(false)
	file, err := l.File()
	_ = l.Close()
	if err != nil {
		return 0, fmt.Errorf("listening on %s: %w", ProxySocket, err)
	}
	defer file.Close()
	if err := os.Lchown(ProxySocket, 0, gid); err != nil {
		return 0, fmt.Errorf("giving the socket %s to root and group %d: %w", ProxySocket, gid, err)
	}
	if err := os.Chmod(ProxySocket, 0o660); err != nil {
		return 0, fmt.Errorf("making the socket %s 0660: %w", ProxySocket, err)
	}
	null, err := os.Open(os.DevNull)
	if err != nil {
		return 0, err
	}
	defer null.Close()
	log, err := os.OpenFile(ProxyLogPath, os.O_WRONLY|os.O_APPEND|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return 0, fmt.Errorf("the egress proxy's log %s: %w", ProxyLogPath, err)
	}
	defer log.Close()
	config.Parent = os.Getpid()
	process, err := os.StartProcess(self, append([]string{"computerd", ProxyRun}, config.Args()...), &os.ProcAttr{
		Env:   []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"},
		Dir:   "/",
		Files: []*os.File{null, null, log, file},
		Sys: &syscall.SysProcAttr{
			Setsid:     true,
			Credential: &syscall.Credential{Uid: ProxyUser, Gid: ProxyUser, Groups: []uint32{}},
		},
	})
	if err != nil {
		return 0, fmt.Errorf("starting the egress proxy: %w", err)
	}
	pid := process.Pid
	_ = process.Release()
	return pid, nil
}

// rootsAlone is nil when dir is a folder root owns that no group or other user may write, else why not.
func rootsAlone(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("the egress proxy's folder must be under %s, which is missing: %w", dir, err)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || !ok || st.Uid != 0 || info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%s is not root's alone (a folder root owns that no group or other user may write), so the egress proxy's socket cannot be made under it", dir)
	}
	return nil
}

// writeOwned writes text to path, root's and gid's, 0640, through a file beside it renamed into place.
func writeOwned(path, text string, gid int) error {
	part := path + ".part"
	_ = os.Remove(part)
	file, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o640)
	if err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	_, err = file.WriteString(text)
	if err == nil {
		err = file.Chown(0, gid)
	}
	if err == nil {
		err = file.Chmod(0o640)
	}
	if closed := file.Close(); err == nil {
		err = closed
	}
	if err == nil {
		err = os.Rename(part, path)
	}
	if err != nil {
		_ = os.Remove(part)
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

// ProxyConfig is what `computerd egress-proxy` takes: the form, the latest end, init's pid, and the public egress, if any.
type ProxyConfig struct {
	Network      Network
	Until        time.Time
	Parent       int
	PublicEgress netip.AddrPort
}

const proxyWords = "egress-proxy takes --network <form> --until <RFC 3339 time> --parent <pid> and, optionally, --public-egress <IPv4>:<port>, each once; init starts it, nothing else"

// Args are egress-proxy's arguments for config, which ProxyConfigOf reads back: the network, the end, the parent, and the
// public egress when there is one.
func (c ProxyConfig) Args() []string {
	args := []string{"--network", c.Network.String(), "--until", c.Until.UTC().Format(time.RFC3339Nano), "--parent", fmt.Sprint(c.Parent)}
	if c.PublicEgress.IsValid() {
		args = append(args, "--public-egress", c.PublicEgress.String())
	}
	return args
}

// Options are what the proxy config's egress-proxy serves: its network's list, and its public egress.
func (c ProxyConfig) Options(logf func(string)) Options {
	return Options{Allow: c.Network.Allow, Log: logf, PublicEgress: c.PublicEgress}
}

// ProxyConfigOf reads egress-proxy's arguments.
func ProxyConfigOf(args []string) (ProxyConfig, error) {
	var config ProxyConfig
	seen := map[string]bool{}
	for i := 0; i < len(args); i += 2 {
		if i+1 >= len(args) || seen[args[i]] {
			return config, errors.New(proxyWords)
		}
		seen[args[i]] = true
		value := args[i+1]
		var err error
		switch args[i] {
		case "--network":
			config.Network, err = NetworkOf(value)
		case "--until":
			config.Until, err = time.Parse(time.RFC3339Nano, value)
		case "--parent":
			_, err = fmt.Sscanf(value, "%d", &config.Parent)
		case "--public-egress":
			config.PublicEgress, err = PublicEgressOf(value)
		default:
			err = errors.New(proxyWords)
		}
		if err != nil {
			return config, fmt.Errorf("%s: %w", proxyWords, err)
		}
	}
	if !seen["--network"] || !seen["--until"] || !seen["--parent"] || config.Parent <= 0 {
		return config, errors.New(proxyWords)
	}
	return config, nil
}

// RunProxy serves the listener on fd 3 until the latest end comes or the parent is gone, then returns nil.
func RunProxy(l net.Listener, config ProxyConfig, logf func(string)) error {
	go func() {
		tick := time.NewTicker(parentEvery)
		defer tick.Stop()
		for range tick.C {
			if os.Getppid() != config.Parent || !time.Now().Before(config.Until) {
				_ = l.Close()
				return
			}
		}
	}()
	return Serve(l, config.Options(logf))
}

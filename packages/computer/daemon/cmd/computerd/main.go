// computerd is the open platform's computer daemon: one static program in every computer.
//
//	computerd init --deadline <RFC 3339 time> [--max-deadline <RFC 3339 time>] [--user <uid:gid>] [--own-network [--network open|allow:<list> [--public-egress <IPv4>:<port>]]] [--egress <socket>] [--window-manager]
//	                    run as the computer's first process: hold every process and serve the protocol on a unix socket
//	                    (AGENTRUN_COMPUTERD_SOCKET, default /run/agentrun/computerd.sock) until SIGTERM or the deadline;
//	                    deadline.extend moves the deadline up to --max-deadline, and not at all without it. With DISPLAY
//	                    set, the screen and input methods drive that X display.
//	                    With --window-manager (and DISPLAY), for a desktop whose host runs one, init, still root, forks
//	                    the window manager's start as the user its programs run as, in a network namespace it makes, and
//	                    starts xfwm4 there once the display answers (internal/windowmanager); hello says how it goes
//	                    (windowManager: starting, running, or ended with why)
//	                    With --user, init starts as root, gives HOME and the socket's directory to uid:gid and becomes
//	                    it: for a vendor that runs every computer as root (Modal), or whose images' privilege tools
//	                    cannot be relied on (Daytona). As any user, root included, init first leaves every thread no
//	                    capability in any set and no_new_privs set, or refuses to start.
//	                    With --own-network (and --user), for a remote computer whose vendor runs its own agent in it,
//	                    init, still root, refuses to start while another process holds uid, moves itself into a network
//	                    namespace of its own whose loopback alone is up, and once dropped refuses vsock and io_uring to
//	                    every thread: its programs reach their own loopback and nothing else (internal/isolate)
//	                    Where root may not make the network namespace itself (EPERM: no CAP_SYS_ADMIN, as on gVisor),
//	                    init makes it inside a user namespace instead: it starts itself again as `computerd userns-init`
//	                    in a user namespace that maps every id to itself and a network namespace, both its own; that init
//	                    does all of the above but make the namespace, and this one keeps no capability, passes SIGTERM
//	                    and SIGINT on, and ends with it (daemon.InitInUserNamespace). If neither can be made, init
//	                    refuses to start, in words that name both. hello says which fence holds: "netns" or "userns-netns"
//	                    With --network (and --own-network), for a remote computer whose network is open or a host list,
//	                    init, still root and in the machine's network, first starts the egress proxy (internal/egress):
//	                    it listens on /opt/agentrun/egress/egress.sock (root's and the user's group's), writes the form
//	                    to /opt/agentrun/egress/policy and serves as `computerd egress-proxy`, nobody, in a session of
//	                    its own, to the public internet only (and with a list, its hosts alone), until the latest
//	                    deadline or init is gone. Init then relays as --egress does, to that socket
//	                    With --public-egress (the operator's <IPv4>:<port>, for a vendor whose machines reach only the
//	                    addresses the operator allows), that proxy opens each tunnel to port 443 whose checks pass to
//	                    that address instead of the checked one, the program's TLS carried unchanged
//	                    With --egress, for a computer whose network is an allowlist, init relays its loopback port 3128
//	                    to the egress proxy's unix socket and tells every program it starts that port is its proxy
//	computerd stdio     bridge stdin and stdout to init's socket (stdout carries protocol lines only; stderr is the log)
//	computerd pair <server URL> [--name <name>]
//	                    pair this machine with a server (spec/computer/attach.md): read the pairing code from stdin, send
//	                    it with the name (the hostname by default) and init's own hello to POST /v2/computers/pair, and
//	                    keep the token in a file only this user can read (attach.TokenPath: ~/.config/agentrun/
//	                    computer.token, root's /etc/agentrun/computer.token); print the computer's id, the attach URL and
//	                    the file, never the token. Refused when the file is there already; a refused code or hello is the
//	                    server's words, and nothing is written. Exits 0 paired, 2 for other arguments or no code, 1 failed
//	computerd unpair    delete the token file, and say how the owner removes the computer on the server
//	computerd attach    for a machine the server cannot reach: dial the server's attach socket (AGENTRUN_ATTACH_URL,
//	                    wss:// or ws://) with the machine's token (AGENTRUN_ATTACH_TOKEN, art_ and 43 base64url; when it
//	                    is empty, pair's token file, refused when it is a link, another user's, or
//	                    readable by group or others) as a bearer
//	                    and the subprotocol agentrun.computer.<protocol>, and bridge each socket to a connection of
//	                    init's as stdio does, a text message a line (spec/computer/attach.md). It pings every 20 s,
//	                    closes with 4408 after 60 s with nothing heard, and dials again as attach.md's close codes say
//	                    (1 s doubling to 60 s, less up to a fifth at random). It exits 0 on SIGTERM or SIGINT, 1 when
//	                    init's socket is gone, 2 with no URL or token or a malformed one, 3 when the server refuses the
//	                    token (401 at the upgrade, or 4401), 4 when its hello is not what the token was minted for
//	                    (4400), 5 for another protocol version or a hello its kind does not serve (426, or 4426). No
//	                    line it logs holds the token. With AGENTRUN_ATTACH_EGRESS (<IPv4>:<port>, the operator's relay),
//	                    each dial opens TCP to the relay and speaks TLS and HTTP to the URL's host over it as it would
//	                    directly; a malformed one exits 2
//	computerd probe [--sockets] [--connect <host:port>[/udp]]...
//	                    print one JSON line: this process's uid and gid, the kernel's release, the network interfaces
//	                    it sees (interfaces, live; quiet; raised), with --sockets the unix sockets it can connect to
//	                    (sockets, by real path or abstract name: a walk of /run, /tmp and the like, and /proc/net/unix's
//	                    paths and abstract names) and the TCP and UDP sockets that listen in its own network namespace (listeners: TCP in
//	                    LISTEN and UDP bound with no peer, from /proc/net/tcp, tcp6, udp and udp6, each with the process
//	                    that holds it where /proc shows its descriptors, and whether that process runs computerd), the
//	                    addresses that
//	                    answered (reached: bytes came back), those that accepted a TCP connection and sent nothing back
//	                    (accepted), and each target's outcome (results). A TCP target gets a request by its port (443 a
//	                    TLS ClientHello, 80 an HTTP HEAD, 53 a DNS query, any other an HTTP HEAD), a host:port/udp one
//	                    a DNS query in one datagram (no reply is refused: UDP has no accept); 10 s to connect and 10 s
//	                    to answer, and at most 4 KiB is read
//	computerd probe --diagnose
//	                    print one JSON line: per well-known public address and port (1.1.1.1, 8.8.8.8, 9.9.9.9 and
//	                    151.101.1.57 on 443/tcp, 80/tcp and 53/udp), whether it refused, accepted with no answer, or
//	                    answered (any byte back, as for --connect), each step bounded, 15 s in all
//	computerd version   print the version
//	computerd sync-serve --socket <path> --mountpoint <path> --mounts <path> --archil <path> --gid <gid>
//	                    as root, from the Archil helper's serve verb alone: listen on the socket (its folder 0750 and
//	                    the socket 0660, root's and the gid's) and leave a server there, in a session of its own, that
//	                    answers one request byte with the exit code of `archil sync <mountpoint>`, coalesced, until the
//	                    mount goes or the socket is taken away. Exits 0 once it serves (or one served already), 2 for
//	                    other arguments, 3 with no archil mount there, 4 when it cannot listen. It holds no token.
//	computerd archil-relay --gateway <IPv4 address> --mount-lane <port> --data-lane <port>
//	                    as root, from the Archil helper's mount alone, when the provider names an egress gateway: listen
//	                    on the computer's loopback (127.0.0.1:3129, where the helper redirects root's TCP to 8100 and
//	                    32050) and leave a server there, in a session of its own, that carries each connection to the
//	                    gateway's lane for its original port with a PROXY v2 header naming the original destination
//	                    (internal/archilrelay). Exits 0 once it serves (or root's relay serves already), 2 for other
//	                    arguments, 4 when it cannot listen. It holds no token.
//
// Each exec.run and process.start starts itself again as `computerd guard`, with no other caller (see execrun.Guard).
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/archilrelay"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/archilsync"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/attach"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/egress"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/isolate"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/lifetime"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/methods"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/probe"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/windowmanager"
)

var version = "0.0.0-dev"

func main() {
	logger := log.New(os.Stderr, "computerd: ", log.LstdFlags)
	if len(os.Args) < 2 || (os.Args[1] != "init" && os.Args[1] != daemon.UserNamespaceInitArg && os.Args[1] != "probe" && os.Args[1] != "pair" && os.Args[1] != "sync-serve" && os.Args[1] != syncServeRun && os.Args[1] != "archil-relay" && os.Args[1] != archilRelayRun && os.Args[1] != egress.ProxyRun && len(os.Args) != 2) {
		usage()
	}
	switch os.Args[1] {
	case egress.ProxyRun:
		os.Exit(egressProxy(logger, os.Args[2:]))
	case "sync-serve":
		os.Exit(syncServe(logger, os.Args[2:]))
	case syncServeRun:
		os.Exit(syncServeRunning(logger, os.Args[2:]))
	case "archil-relay":
		os.Exit(archilRelay(logger, os.Args[2:]))
	case archilRelayRun:
		os.Exit(archilRelayRunning(logger, os.Args[2:]))
	case "version":
		fmt.Println(version)
	case "stdio":
		os.Exit(daemon.Bridge(daemon.SocketPath(), os.Stdin, os.Stdout, os.Stderr))
	case "pair":
		os.Exit(pair(logger, os.Args[2:], os.Stdin))
	case "unpair":
		os.Exit(unpair(logger))
	case "attach":
		cfg, err := attach.FromEnv(daemon.SocketPath(), "agentrun.computer."+methods.ProtocolVersion, rpc.MaxLine)
		if err != nil {
			logger.Printf("attach: %v", err)
			os.Exit(attach.ExitUsage)
		}
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		code := attach.Run(ctx, cfg, logger)
		stop()
		os.Exit(code)
	case "init":
		opts, ok := initOptionsOf(logger, os.Args[2:])
		if !ok {
			os.Exit(2)
		}
		os.Exit(runInit(opts, daemon.Isolation{OwnNetwork: opts.ownNetwork}, os.Args[2:], logger))
	case daemon.UserNamespaceInitArg:
		// The init InitInUserNamespace started, already in a user and a network namespace of its own.
		args := os.Args[2:]
		if len(args) < 2 || args[0] != "--started-in" || args[1] == "" {
			logger.Printf("init: %s takes --started-in <network namespace> and then init's own arguments", daemon.UserNamespaceInitArg)
			os.Exit(2)
		}
		opts, ok := initOptionsOf(logger, args[2:])
		if !ok {
			os.Exit(2)
		}
		if !opts.ownNetwork {
			logger.Printf("init: %s runs only with --own-network among init's arguments", daemon.UserNamespaceInitArg)
			os.Exit(2)
		}
		os.Exit(runInit(opts, daemon.Isolation{OwnNetwork: true, StartedIn: args[1]}, args[2:], logger))
	case "probe":
		if diagnose, ok := diagnoseOf(logger, os.Args[2:]); !ok {
			os.Exit(2)
		} else if diagnose {
			if err := json.NewEncoder(os.Stdout).Encode(probe.Diagnose(probe.DiagnoseChecks(), probe.DiagnoseBounds)); err != nil {
				logger.Printf("probe: %v", err)
				os.Exit(1)
			}
			return
		}
		args := os.Args[2:]
		sockets := len(args) > 0 && args[0] == "--sockets"
		if sockets {
			args = args[1:]
		}
		targets, ok := probeTargetsOf(logger, args)
		if !ok {
			os.Exit(2)
		}
		result := probe.Run(targets, probe.ConnectBounds)
		if sockets {
			search := probe.ConnectableSockets(probe.SocketRoots, "/proc/net/unix", "/proc/self/mountinfo", probe.DefaultSocketBounds, 2*time.Second)
			result.Sockets = &search
			listeners := probe.Listeners("/proc")
			result.Listeners = &listeners
		}
		if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
			logger.Printf("probe: %v", err)
			os.Exit(1)
		}
	case execrun.GuardCommand:
		os.Exit(execrun.Guard())
	case windowmanager.ChildArg:
		os.Exit(windowmanager.Child())
	default:
		usage()
	}
}

// runInit drops (Become with isolation, as --user asks, else Unprivileged), then serves until the computer ends, and
// gives init's exit code; a drop that fails is said and init refuses to start (1). Where root may not make the network
// namespace itself (isolate.ErrNoNetworkNamespace), init makes it inside a user namespace instead: it starts itself again
// with args, init's own (daemon.InitInUserNamespace), and ends with that init.
func runInit(opts initOptions, isolation daemon.Isolation, args []string, logger *log.Logger) int {
	var dropped error
	// A desktop's user gets a name first, while init is root, where the image has none for it: its programs look it up
	// (daemon.NameUser). An init started again in a user namespace finds the name its first start gave.
	if opts.user != nil && os.Getenv("DISPLAY") != "" && os.Geteuid() == 0 {
		if err := daemon.NameUser("/etc", opts.user.uid, opts.user.gid, os.Getenv("HOME")); err != nil {
			logger.Printf("init refuses to start: the desktop's user has no name, and %v", err)
			return 1
		}
	}
	// A computer with a network of its own whose form is open or a host list gets its egress proxy now, from root in the
	// machine's own network, before init leaves it; an init started again in a user namespace finds the one its first
	// start left, which is that init's child and not this one's. An init that is not root starts none: Become refuses it.
	var relay daemon.Egress
	if opts.network != nil {
		relay = daemon.Egress{Listen: egress.Address, Socket: egress.ProxySocket}
		if isolation.StartedIn == "" && os.Geteuid() == 0 {
			self, err := os.Executable()
			if err == nil {
				relay.Proxy, err = egress.StartProxy(self, opts.proxyConfig(), opts.user.gid)
			}
			if err != nil {
				logger.Printf("init refuses to start: its egress proxy (the network %s): %v", opts.network, err)
				return 1
			}
			logger.Printf("init: the egress proxy (the network %s) listens on %s as uid %d, pid %d", opts.network, egress.ProxySocket, egress.ProxyUser, relay.Proxy)
		}
	} else if opts.egress != "" {
		relay = daemon.Egress{Listen: egress.Address, Socket: opts.egress}
	}
	// The desktop's window manager, forked while init is still root (the drop below), as the user its programs run as.
	if opts.windowManager {
		uid, gid := 0, 0
		if opts.user != nil {
			uid, gid = opts.user.uid, opts.user.gid
		}
		isolation.WindowManager = windowmanager.New(os.Getenv("DISPLAY"), os.Getenv("HOME"), opts.user != nil, uid, gid)
	}
	if opts.user != nil {
		dropped = daemon.Become(opts.user.uid, opts.user.gid, os.Getenv("HOME"), daemon.SocketPath(), isolation)
	} else {
		dropped = daemon.Unprivileged(isolation.WindowManager)
	}
	if dropped != nil && !errors.Is(dropped, isolate.ErrNoNetworkNamespace) && relay.Proxy != 0 {
		_ = syscall.Kill(relay.Proxy, syscall.SIGKILL)
	}
	if errors.Is(dropped, isolate.ErrNoNetworkNamespace) && isolation.StartedIn == "" {
		self, err := os.Executable()
		if err != nil {
			logger.Printf("init refuses to start: %v, and cannot name its own program to start again inside a user namespace: %v", dropped, err)
			return 1
		}
		logger.Printf("init: %v; making it inside a user namespace of its own", dropped)
		return daemon.InitInUserNamespace(self, args, dropped, logger)
	}
	if dropped != nil {
		logger.Printf("init refuses to start: %v", dropped)
		return 1
	}
	return daemon.Init(version, daemon.SocketPath(), opts.deadline, relay, fenceOf(isolation), isolation.WindowManager, logger)
}

// proxyConfig is the egress proxy init starts for opts, with a network: its form, its public egress, and the latest end.
// StartProxy names init its parent.
func (opts initOptions) proxyConfig() egress.ProxyConfig {
	return egress.ProxyConfig{Network: *opts.network, Until: opts.latest, PublicEgress: opts.publicEgress}
}

// fenceOf is how init fences its programs off the computer's network, as hello says it: "netns", a network namespace of
// its own; "userns-netns", one made inside a user namespace of its own; "" with no network of its own.
func fenceOf(isolation daemon.Isolation) string {
	switch {
	case !isolation.OwnNetwork:
		return ""
	case isolation.StartedIn != "":
		return daemon.FenceUserNetwork
	default:
		return daemon.FenceNetwork
	}
}

// syncServeRun is the server sync-serve leaves behind: itself again, given the listener as fd 3.
const syncServeRun = "sync-serve-run"

// syncServe listens, then starts the server in a session of its own with the listener, and returns once it is started:
// the helper's caller gets an answer, and the server stays.
func syncServe(logger *log.Logger, args []string) int {
	config, err := archilsync.ConfigOf(args)
	if err != nil {
		logger.Printf("%v", err)
		return 2
	}
	l, err := archilsync.Listen(config)
	switch {
	case errors.Is(err, archilsync.ErrServing):
		logger.Printf("sync-serve: a server answers on %s already", config.Socket)
		return 0
	case errors.Is(err, archilsync.ErrNotMounted):
		logger.Printf("sync-serve: nothing is mounted at %s as an archil mount", config.Mountpoint)
		return 3
	case err != nil:
		logger.Printf("sync-serve: %v", err)
		return 4
	}
	file, err := l.File()
	_ = l.Close()
	if err != nil {
		logger.Printf("sync-serve: %v", err)
		return 4
	}
	defer file.Close()
	null, err := os.Open(os.DevNull)
	if err != nil {
		logger.Printf("sync-serve: %v", err)
		return 4
	}
	defer null.Close()
	self, err := os.Executable()
	if err != nil {
		logger.Printf("sync-serve: %v", err)
		return 4
	}
	process, err := os.StartProcess(self, append([]string{"computerd", syncServeRun}, args...), &os.ProcAttr{
		Env:   []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"},
		Files: []*os.File{null, null, null, file},
		Sys:   &syscall.SysProcAttr{Setsid: true},
	})
	if err != nil {
		logger.Printf("sync-serve: starting the server: %v", err)
		return 4
	}
	_ = process.Release()
	return 0
}

// syncServeRunning is the server: the listener on fd 3, until the mount goes or the socket is taken away.
func syncServeRunning(logger *log.Logger, args []string) int {
	config, err := archilsync.ConfigOf(args)
	if err != nil {
		logger.Printf("%v", err)
		return 2
	}
	l, err := archilsync.Inherit(os.NewFile(3, config.Socket), config)
	if err != nil {
		logger.Printf("sync-serve: %v", err)
		return 4
	}
	if err := archilsync.Serve(context.Background(), l, config, archilsync.RunSync(config.Archil, config.Mountpoint, config.SyncTimeout)); err != nil {
		logger.Printf("sync-serve: %v", err)
		return 1
	}
	return 0
}

// archilRelayRun is the server archil-relay leaves behind: itself again, given the listener as fd 3.
const archilRelayRun = "archil-relay-run"

// archilRelay listens on the computer's loopback, then starts the relay in a session of its own with the listener, and
// returns once it is started: the helper's mount goes on to the archil client, and the relay stays.
func archilRelay(logger *log.Logger, args []string) int {
	config, err := archilrelay.ConfigOf(args)
	if err != nil {
		logger.Printf("%v", err)
		return 2
	}
	l, err := archilrelay.Listen(archilrelay.Address)
	switch {
	case errors.Is(err, archilrelay.ErrServing):
		logger.Printf("archil-relay: %v", err)
		return 0
	case err != nil:
		logger.Printf("archil-relay: %v", err)
		return 4
	}
	file, err := l.(*net.TCPListener).File()
	_ = l.Close()
	if err != nil {
		logger.Printf("archil-relay: %v", err)
		return 4
	}
	defer file.Close()
	null, err := os.Open(os.DevNull)
	if err != nil {
		logger.Printf("archil-relay: %v", err)
		return 4
	}
	defer null.Close()
	// The relay's log: root's alone, appended to, so a mount that fails at the gateway can be read back afterwards
	// without holding the helper's session pipes open.
	relayLog, err := os.OpenFile(archilrelay.LogPath, os.O_WRONLY|os.O_APPEND|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		logger.Printf("archil-relay: the relay's log %s: %v", archilrelay.LogPath, err)
		return 4
	}
	defer relayLog.Close()
	self, err := os.Executable()
	if err != nil {
		logger.Printf("archil-relay: %v", err)
		return 4
	}
	process, err := os.StartProcess(self, append([]string{"computerd", archilRelayRun}, config.Args()...), &os.ProcAttr{
		Env:   []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"},
		Files: []*os.File{null, null, relayLog, file},
		Sys:   &syscall.SysProcAttr{Setsid: true},
	})
	if err != nil {
		logger.Printf("archil-relay: starting the relay: %v", err)
		return 4
	}
	_ = process.Release()
	return 0
}

// archilRelayRunning is the relay: the listener on fd 3, until the computer ends.
func archilRelayRunning(logger *log.Logger, args []string) int {
	config, err := archilrelay.ConfigOf(args)
	if err != nil {
		logger.Printf("%v", err)
		return 2
	}
	l, err := net.FileListener(os.NewFile(3, archilrelay.Address))
	if err != nil {
		logger.Printf("archil-relay: %v", err)
		return 4
	}
	if err := archilrelay.Serve(l, config, archilrelay.OriginalDestination, logger); err != nil {
		logger.Printf("archil-relay: %v", err)
		return 1
	}
	return 0
}

// egressProxy is the egress proxy init starts (egress.StartProxy): the listener on fd 3, as nobody, until the
// computer's latest end or init is gone.
func egressProxy(logger *log.Logger, args []string) int {
	config, err := egress.ProxyConfigOf(args)
	if err != nil {
		logger.Printf("%v", err)
		return 2
	}
	if os.Geteuid() == 0 {
		logger.Printf("egress-proxy: refuses to run as root; init starts it as uid %d", egress.ProxyUser)
		return 2
	}
	l, err := net.FileListener(os.NewFile(3, egress.ProxySocket))
	if err != nil {
		logger.Printf("egress-proxy: %v", err)
		return 4
	}
	logger.Printf("egress-proxy: serving the network %s until %s", config.Network, config.Until.UTC().Format(time.RFC3339))
	if err := egress.RunProxy(l, config, func(line string) { logger.Print(line) }); err != nil {
		logger.Printf("egress-proxy: %v", err)
		return 1
	}
	return 0
}

const pairWords = "pair takes the server's URL and, once, --name <name> (the hostname by default), such as computerd pair https://agentrun.example.com --name build-box; the pairing code is read from stdin, never an argument"

// pair reads the pairing code from in (a prompt on stderr when in is a terminal), pairs this machine with the server
// as attach.Pair does at attach.TokenPath, and prints the computer's id, the attach URL and the token file, never the
// token. Exits 0 once paired, 2 for other arguments or no code, 1 when the pairing fails.
func pair(logger *log.Logger, args []string, in *os.File) int {
	if len(args) != 1 && (len(args) != 3 || args[1] != "--name") {
		logger.Printf("%s", pairWords)
		return 2
	}
	name, err := os.Hostname()
	if len(args) == 3 {
		name, err = args[2], nil
	}
	if err != nil {
		logger.Printf("pair: this machine's hostname: %v; give --name <name>", err)
		return 2
	}
	path, err := attach.TokenPath()
	if err != nil {
		logger.Printf("pair: %v", err)
		return 1
	}
	if info, err := in.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
		fmt.Fprint(os.Stderr, "the pairing code the console's Computers page shows (such as K7PD-W3QX): ")
	}
	line, err := bufio.NewReader(io.LimitReader(in, 256)).ReadString('\n')
	code := strings.TrimSpace(line)
	if code == "" || (err != nil && !errors.Is(err, io.EOF)) {
		logger.Printf("pair: no pairing code on stdin: make one on the console's Computers page (Pair a computer) and type it, or pipe it in")
		return 2
	}
	paired, err := attach.Pair(context.Background(), args[0], code, name, daemon.SocketPath(), path, rpc.MaxLine)
	if err != nil {
		logger.Printf("pair: %v", err)
		return 1
	}
	fmt.Printf("computer: %s\nattach url: %s\ntoken file: %s\n", paired.Computer, paired.AttachURL, paired.TokenFile)
	if paired.RunsRefused != "" {
		logger.Printf("pair: %s", paired.RunsRefused)
	}
	return 0
}

// unpair deletes this machine's token file. Removing the computer on the server takes its owner's session (the
// console's Computers page, or DELETE /v2/computers/{id}): the machine's own token cannot, so unpair says so.
func unpair(logger *log.Logger) int {
	path, err := attach.TokenPath()
	if err != nil {
		logger.Printf("unpair: %v", err)
		return 1
	}
	if err := os.Remove(path); errors.Is(err, fs.ErrNotExist) {
		logger.Printf("unpair: no token file at %s: this machine is not paired as this user", path)
		return 1
	} else if err != nil {
		logger.Printf("unpair: cannot delete %s: %v", path, err)
		return 1
	}
	fmt.Printf("deleted %s. The computer stays on the server, offline, until its owner removes it: Remove on the console's Computers page (DELETE /v2/computers/{id}); its token is good there until then. Stop computerd attach if it runs.\n", path)
	return 0
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: computerd init --deadline <RFC 3339 time> [--max-deadline <RFC 3339 time>] [--user <uid:gid>] [--own-network [--network open|allow:<list> [--public-egress <IPv4>:<port>]]] [--egress <socket>] [--window-manager] | stdio | pair <server URL> [--name <name>] | unpair | attach | probe [--sockets] [--connect <host:port>[/udp]]... | probe --diagnose | sync-serve --socket <path> --mountpoint <path> --mounts <path> --archil <path> --gid <gid> | archil-relay --gateway <IPv4 address> --mount-lane <port> --data-lane <port> | version")
	os.Exit(2)
}

type account struct{ uid, gid int }

type initOptions struct {
	// deadline is the computer's end, which deadline.extend moves up to --max-deadline, and not at all without it.
	deadline *lifetime.Deadline
	user     *account
	// latest is the computer's latest end: the maximum, else the deadline.
	latest time.Time
	// egress is the egress proxy's socket init relays to; empty is none.
	egress string
	// ownNetwork: init, as root, gives itself and its programs a network of their own (daemon.Isolation), made inside a
	// user namespace where root may not make it directly.
	ownNetwork bool
	// network is the form the egress proxy init starts serves (with ownNetwork); nil is none: no proxy, no way out.
	network *egress.Network
	// publicEgress is where that proxy sends a tunnel to port 443 once its checks pass (with network); invalid is none.
	publicEgress netip.AddrPort
	// windowManager: init starts the desktop's window manager on DISPLAY once it answers (internal/windowmanager).
	windowManager bool
}

const deadlineWords = "--deadline <time> is required, in RFC 3339 such as 2026-01-02T15:04:05Z: the computer ends then; --max-deadline <time> (the most deadline.extend may move it to), --user <uid:gid>, --egress <socket>, --network <form> and --public-egress <IPv4>:<port> may follow, each once"
const userWords = "--user takes uid:gid in numbers, such as 1000:1000"
const egressWords = "--egress takes the egress proxy's socket, one absolute path, given once"
const ownNetworkWords = "--own-network takes no value, given once, with --user (init starts as root to give itself and its programs a network of their own, their loopback alone) and with no --egress (their way out, if any, is the proxy --network has init start)"
const networkWords = "--network is given once, with --own-network: init, still root, starts the egress proxy that form names, and relays its programs' loopback port 3128 to it"
const windowManagerWords = "--window-manager takes no value, given once, with DISPLAY set: init, as root, starts the desktop's window manager on that display once it answers"

// initOptionsOf reads init's `--deadline <time>`, `--max-deadline <time>`, `--user <uid:gid>`, `--egress <socket>` and
// `--network <form>`, in any order, each at most once. With no deadline, a time that is not RFC 3339, or a maximum
// before the deadline, it says why and init refuses to start, so no computer lives forever or past what its provider
// allows.
func initOptionsOf(logger *log.Logger, args []string) (initOptions, bool) {
	var opts initOptions
	var deadline, most time.Time
	var sawDeadline, sawMost, sawUser, sawEgress bool
	for i := 0; i < len(args); i += 2 {
		flag := args[i]
		if flag == "--own-network" {
			if opts.ownNetwork {
				logger.Printf("init: %s", ownNetworkWords)
				return opts, false
			}
			opts.ownNetwork = true
			i-- // a flag with no value
			continue
		}
		if flag == "--window-manager" {
			if opts.windowManager || os.Getenv("DISPLAY") == "" {
				logger.Printf("init: %s", windowManagerWords)
				return opts, false
			}
			opts.windowManager = true
			i-- // a flag with no value
			continue
		}
		if i+1 >= len(args) {
			switch flag {
			case "--user":
				logger.Printf("init: %s", userWords)
			case "--egress":
				logger.Printf("init: %s", egressWords)
			case "--network":
				logger.Printf("init: %s", egress.NetworkWords)
			case "--public-egress":
				logger.Printf("init: %s", egress.PublicEgressWords)
			default:
				logger.Printf("init: %s", deadlineWords)
			}
			return opts, false
		}
		value := args[i+1]
		switch {
		case flag == "--deadline" && !sawDeadline:
			sawDeadline = true
			parsed, err := time.Parse(time.RFC3339Nano, value)
			if err != nil {
				logger.Printf("init: --deadline %q is not a time in RFC 3339, such as 2026-01-02T15:04:05Z", value)
				return opts, false
			}
			deadline = parsed
		case flag == "--max-deadline" && !sawMost:
			sawMost = true
			parsed, err := time.Parse(time.RFC3339Nano, value)
			if err != nil {
				logger.Printf("init: --max-deadline %q is not a time in RFC 3339, such as 2026-01-02T15:04:05Z", value)
				return opts, false
			}
			most = parsed
		case flag == "--user" && !sawUser:
			sawUser = true
			user, ok := accountOf(value)
			if !ok {
				logger.Printf("init: %s, not %q", userWords, value)
				return opts, false
			}
			opts.user = &user
		case flag == "--user":
			logger.Printf("init: %s, given once", userWords)
			return opts, false
		case flag == "--egress" && !sawEgress:
			sawEgress = true
			if !filepath.IsAbs(value) {
				logger.Printf("init: %s, not %q", egressWords, value)
				return opts, false
			}
			opts.egress = value
		case flag == "--egress":
			logger.Printf("init: %s", egressWords)
			return opts, false
		case flag == "--network" && opts.network == nil:
			network, err := egress.NetworkOf(value)
			if err != nil {
				logger.Printf("init: %v, not %q", err, value)
				return opts, false
			}
			opts.network = &network
		case flag == "--network":
			logger.Printf("init: %s", networkWords)
			return opts, false
		case flag == "--public-egress" && !opts.publicEgress.IsValid():
			address, err := egress.PublicEgressOf(value)
			if err != nil {
				logger.Printf("init: %s, not %q", egress.PublicEgressWords, value)
				return opts, false
			}
			opts.publicEgress = address
		case flag == "--public-egress":
			logger.Printf("init: %s", egress.PublicEgressWords)
			return opts, false
		default:
			logger.Printf("init: %s; %q is none of them", deadlineWords, flag)
			return opts, false
		}
	}
	if !sawDeadline {
		logger.Printf("init: %s", deadlineWords)
		return opts, false
	}
	if opts.ownNetwork && (opts.user == nil || opts.egress != "") {
		logger.Printf("init: %s", ownNetworkWords)
		return opts, false
	}
	if opts.network != nil && !opts.ownNetwork {
		logger.Printf("init: %s", networkWords)
		return opts, false
	}
	if opts.publicEgress.IsValid() && opts.network == nil {
		logger.Printf("init: %s", egress.PublicEgressWords)
		return opts, false
	}
	// The proxy runs as ProxyUser so its programs' user can't signal it: a user who is that uid, or in that group, could.
	if opts.network != nil && (opts.user.uid == egress.ProxyUser || opts.user.gid == egress.ProxyUser) {
		logger.Printf("init: --network starts its egress proxy as uid and gid %d, so --user may be neither", egress.ProxyUser)
		return opts, false
	}
	if sawMost && most.Before(deadline) {
		logger.Printf("init: --max-deadline %s is before --deadline %s", most.Format(time.RFC3339Nano), deadline.Format(time.RFC3339Nano))
		return opts, false
	}
	opts.deadline = lifetime.New(deadline, most)
	opts.latest = deadline
	if sawMost {
		opts.latest = most
	}
	return opts, true
}

// accountOf reads uid:gid, both whole numbers below 2^32-1, which is no user.
func accountOf(value string) (account, bool) {
	uid, gid, found := strings.Cut(value, ":")
	if !found {
		return account{}, false
	}
	u, errU := strconv.ParseUint(uid, 10, 32)
	g, errG := strconv.ParseUint(gid, 10, 32)
	if errU != nil || errG != nil || u == 1<<32-1 || g == 1<<32-1 {
		return account{}, false
	}
	return account{uid: int(u), gid: int(g)}, true
}

// diagnoseOf reads probe's `--diagnose`, which takes no other argument: true when it is given, alone.
func diagnoseOf(logger *log.Logger, args []string) (bool, bool) {
	for _, arg := range args {
		if arg == "--diagnose" {
			if len(args) != 1 {
				logger.Printf("probe: --diagnose takes no other argument; it tries its own fixed targets")
				return false, false
			}
			return true, true
		}
	}
	return false, true
}

// probeTargetsOf reads probe's `--connect <host:port>[/udp]` flags.
func probeTargetsOf(logger *log.Logger, args []string) ([]string, bool) {
	targets := []string{}
	for i := 0; i < len(args); i += 2 {
		if args[i] != "--connect" || i+1 >= len(args) {
			logger.Printf("probe: each target is --connect <host:port>[/udp], such as --connect example.com:443 or --connect 1.1.1.1:53/udp")
			return nil, false
		}
		if _, _, err := probe.ParseTarget(args[i+1]); err != nil {
			logger.Printf("probe: %q is not host:port or host:port/udp: %v", args[i+1], err)
			return nil, false
		}
		targets = append(targets, args[i+1])
	}
	return targets, true
}

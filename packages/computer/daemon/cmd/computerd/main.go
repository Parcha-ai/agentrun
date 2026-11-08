// computerd is the open platform's computer daemon: one static program in every computer.
//
//	computerd init --deadline <RFC 3339 time> [--max-deadline <RFC 3339 time>] [--user <uid:gid>] [--own-network] [--egress <socket>]
//	                    run as the computer's first process: hold every process and serve the protocol on a unix socket
//	                    (AGENTRUN_COMPUTERD_SOCKET, default /run/agentrun/computerd.sock) until SIGTERM or the deadline;
//	                    deadline.extend moves the deadline up to --max-deadline, and not at all without it. With DISPLAY
//	                    set, the screen and input methods drive that X display.
//	                    With --user, init starts as root, gives HOME and the socket's directory to uid:gid and becomes
//	                    it: for a vendor that runs every computer as root (Modal), or whose images' privilege tools
//	                    cannot be relied on (Daytona). As any user, root included, init first leaves every thread no
//	                    capability in any set and no_new_privs set, or refuses to start.
//	                    With --own-network (and --user), for a remote computer whose vendor runs its own agent in it,
//	                    init, still root, refuses to start while another process holds uid, moves itself into a network
//	                    namespace of its own whose loopback alone is up, and once dropped refuses vsock and io_uring to
//	                    every thread: its programs reach their own loopback and nothing else (internal/isolate)
//	                    With --egress, for a computer whose network is an allowlist, init relays its loopback port 3128
//	                    to the egress proxy's unix socket and tells every program it starts that port is its proxy
//	computerd stdio     bridge stdin and stdout to init's socket (stdout carries protocol lines only; stderr is the log)
//	computerd probe [--sockets] [--connect <host:port>[/udp]]...
//	                    print one JSON line: this process's uid and gid, the kernel's release, the network interfaces
//	                    it sees (interfaces, live; quiet; raised), with --sockets the unix sockets with a path it can
//	                    connect to (sockets, by real path: a walk of /run, /tmp and the like, and /proc/net/unix's
//	                    paths), the addresses that
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
//
// Each exec.run and process.start starts itself again as `computerd guard`, with no other caller (see execrun.Guard).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/archilsync"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/egress"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/lifetime"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/probe"
)

var version = "0.0.0-dev"

func main() {
	logger := log.New(os.Stderr, "computerd: ", log.LstdFlags)
	if len(os.Args) < 2 || (os.Args[1] != "init" && os.Args[1] != "probe" && os.Args[1] != "sync-serve" && os.Args[1] != syncServeRun && len(os.Args) != 2) {
		usage()
	}
	switch os.Args[1] {
	case "sync-serve":
		os.Exit(syncServe(logger, os.Args[2:]))
	case syncServeRun:
		os.Exit(syncServeRunning(logger, os.Args[2:]))
	case "version":
		fmt.Println(version)
	case "stdio":
		os.Exit(daemon.Bridge(daemon.SocketPath(), os.Stdin, os.Stdout, os.Stderr))
	case "init":
		opts, ok := initOptionsOf(logger, os.Args[2:])
		if !ok {
			os.Exit(2)
		}
		var dropped error
		if opts.user != nil {
			dropped = daemon.Become(opts.user.uid, opts.user.gid, os.Getenv("HOME"), daemon.SocketPath(), daemon.Isolation{OwnNetwork: opts.ownNetwork})
		} else {
			dropped = daemon.Unprivileged()
		}
		if dropped != nil {
			logger.Printf("init refuses to start: %v", dropped)
			os.Exit(1)
		}
		var relay daemon.Egress
		if opts.egress != "" {
			relay = daemon.Egress{Listen: egress.Address, Socket: opts.egress}
		}
		os.Exit(daemon.Init(version, daemon.SocketPath(), opts.deadline, relay, logger))
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
			netUnix, _ := os.ReadFile("/proc/net/unix")
			listed := probe.ConnectableSockets(probe.SocketRoots, string(netUnix), 2*time.Second)
			result.Sockets = &listed
		}
		if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
			logger.Printf("probe: %v", err)
			os.Exit(1)
		}
	case execrun.GuardCommand:
		os.Exit(execrun.Guard())
	default:
		usage()
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

func usage() {
	fmt.Fprintln(os.Stderr, "usage: computerd init --deadline <RFC 3339 time> [--max-deadline <RFC 3339 time>] [--user <uid:gid>] [--own-network] [--egress <socket>] | stdio | probe [--sockets] [--connect <host:port>[/udp]]... | probe --diagnose | sync-serve --socket <path> --mountpoint <path> --mounts <path> --archil <path> --gid <gid> | version")
	os.Exit(2)
}

type account struct{ uid, gid int }

type initOptions struct {
	// deadline is the computer's end, which deadline.extend moves up to --max-deadline, and not at all without it.
	deadline *lifetime.Deadline
	user     *account
	// egress is the egress proxy's socket init relays to; empty is none.
	egress string
	// ownNetwork: init, as root, gives itself and its programs a network of their own (daemon.Isolation).
	ownNetwork bool
}

const deadlineWords = "--deadline <time> is required, in RFC 3339 such as 2026-01-02T15:04:05Z: the computer ends then; --max-deadline <time> (the most deadline.extend may move it to), --user <uid:gid> and --egress <socket> may follow, each once"
const userWords = "--user takes uid:gid in numbers, such as 1000:1000"
const egressWords = "--egress takes the egress proxy's socket, one absolute path, given once"
const ownNetworkWords = "--own-network takes no value, given once, with --user (init starts as root to give itself and its programs a network of their own, their loopback alone) and with no --egress (such a computer's network is none)"

// initOptionsOf reads init's `--deadline <time>`, `--max-deadline <time>`, `--user <uid:gid>` and `--egress <socket>`,
// in any order, each at most once. With no deadline, a time that is not RFC 3339, or a maximum before the deadline, it
// says why and init refuses to start, so no computer lives forever or past what its provider allows.
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
		if i+1 >= len(args) {
			switch flag {
			case "--user":
				logger.Printf("init: %s", userWords)
			case "--egress":
				logger.Printf("init: %s", egressWords)
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
	if sawMost && most.Before(deadline) {
		logger.Printf("init: --max-deadline %s is before --deadline %s", most.Format(time.RFC3339Nano), deadline.Format(time.RFC3339Nano))
		return opts, false
	}
	opts.deadline = lifetime.New(deadline, most)
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

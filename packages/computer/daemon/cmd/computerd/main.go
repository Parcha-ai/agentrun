// computerd is the open platform's computer daemon: one static program in every computer.
//
//	computerd init --deadline <RFC 3339 time> [--max-deadline <RFC 3339 time>] [--user <uid:gid>]
//	                    run as the computer's first process: hold every process and serve the protocol on a unix socket
//	                    (AGENTRUN_COMPUTERD_SOCKET, default /run/agentrun/computerd.sock) until SIGTERM or the deadline;
//	                    deadline.extend moves the deadline up to --max-deadline, and not at all without it. With DISPLAY
//	                    set, the screen and input methods drive that X display.
//	                    With --user, init starts as root, gives HOME and the socket's directory to uid:gid and becomes
//	                    it: for a vendor that runs every computer as root (Modal), or whose images' privilege tools
//	                    cannot be relied on (Daytona). As any user, root included, init first leaves every thread no
//	                    capability in any set and no_new_privs set, or refuses to start
//	computerd stdio     bridge stdin and stdout to init's socket (stdout carries protocol lines only; stderr is the log)
//	computerd probe [--connect <host:port>[/udp]]...
//	                    print one JSON line: this process's uid and gid, the kernel's release, the addresses that
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
//
// Each exec.run and process.start starts itself again as `computerd guard`, with no other caller (see execrun.Guard).
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/execrun"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/lifetime"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/probe"
)

var version = "0.0.0-dev"

func main() {
	logger := log.New(os.Stderr, "computerd: ", log.LstdFlags)
	if len(os.Args) < 2 || (os.Args[1] != "init" && os.Args[1] != "probe" && len(os.Args) != 2) {
		usage()
	}
	switch os.Args[1] {
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
			dropped = daemon.Become(opts.user.uid, opts.user.gid, os.Getenv("HOME"), daemon.SocketPath())
		} else {
			dropped = daemon.Unprivileged()
		}
		if dropped != nil {
			logger.Printf("init refuses to start: %v", dropped)
			os.Exit(1)
		}
		os.Exit(daemon.Init(version, daemon.SocketPath(), opts.deadline, logger))
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
		targets, ok := probeTargetsOf(logger, os.Args[2:])
		if !ok {
			os.Exit(2)
		}
		if err := json.NewEncoder(os.Stdout).Encode(probe.Run(targets, probe.ConnectBounds)); err != nil {
			logger.Printf("probe: %v", err)
			os.Exit(1)
		}
	case execrun.GuardCommand:
		os.Exit(execrun.Guard())
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: computerd init --deadline <RFC 3339 time> [--max-deadline <RFC 3339 time>] [--user <uid:gid>] | stdio | probe [--connect <host:port>[/udp]]... | probe --diagnose | version")
	os.Exit(2)
}

type account struct{ uid, gid int }

type initOptions struct {
	// deadline is the computer's end, which deadline.extend moves up to --max-deadline, and not at all without it.
	deadline *lifetime.Deadline
	user     *account
}

const deadlineWords = "--deadline <time> is required, in RFC 3339 such as 2026-01-02T15:04:05Z: the computer ends then; --max-deadline <time> (the most deadline.extend may move it to) and --user <uid:gid> may follow, each once"
const userWords = "--user takes uid:gid in numbers, such as 1000:1000"

// initOptionsOf reads init's `--deadline <time>`, `--max-deadline <time>` and `--user <uid:gid>`, in any order, each at
// most once. With no deadline, a time that is not RFC 3339, or a maximum before the deadline, it says why and init refuses
// to start, so no computer lives forever or past what its provider allows.
func initOptionsOf(logger *log.Logger, args []string) (initOptions, bool) {
	var opts initOptions
	var deadline, most time.Time
	var sawDeadline, sawMost, sawUser bool
	for i := 0; i < len(args); i += 2 {
		flag := args[i]
		if i+1 >= len(args) {
			if flag == "--user" {
				logger.Printf("init: %s", userWords)
			} else {
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
		default:
			logger.Printf("init: %s; %q is none of them", deadlineWords, flag)
			return opts, false
		}
	}
	if !sawDeadline {
		logger.Printf("init: %s", deadlineWords)
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

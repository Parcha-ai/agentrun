package probe

// The diagnosis: whether bytes come back, not only whether a TCP connection is accepted. Some vendors' firewalls
// (E2B's, by its own docs: network/internet-access, "Behavior of blocked TCP connections") accept every outbound TCP
// connection first and decide after, so an accept says nothing about the destination; bytes back do. Each check is
// asked and judged as `computerd probe --connect` asks and judges a target (askFor and exchange, in probe.go): any byte
// back is answered, the detail saying whether it was the protocol's own answer. It tries a fixed list of well-known
// public addresses only, sends nothing of the computer's (a ClientHello with a random nonce, an HTTP HEAD, a DNS query
// for example.com), reads at most MaxRead bytes, and is bounded at every step.

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"sync"
	"time"
)

// Check is one diagnostic attempt: a TLS ClientHello (tls), an HTTP HEAD (http), each over TCP, or a DNS query over
// UDP (dns), to Address (host:port). Name is the TLS SNI and the HTTP Host header; empty sends neither.
type Check struct {
	Probe   string
	Address string
	Name    string
}

// DiagnoseBounds are `computerd probe --diagnose`'s: 3 s to connect, 3 s to answer, 15 s in all, 4 KiB per check.
var DiagnoseBounds = Bounds{Connect: 3 * time.Second, Read: 3 * time.Second, Whole: 15 * time.Second, MaxRead: 4096}

// Outcome is one check's result. Outcome is refused (no TCP accept, or no UDP reply), accepted (a TCP accept, and no
// byte back in time) or answered (any byte back: a TLS ServerHello or alert, an HTTP status line, a DNS response with
// the query's id, or other bytes, which Detail names).
type Outcome struct {
	Target  string `json:"target"`
	Port    int    `json:"port"`
	Proto   string `json:"proto"`
	Probe   string `json:"probe"`
	Name    string `json:"name,omitempty"`
	Outcome string `json:"outcome"`
	Bytes   int    `json:"bytes"`
	Detail  string `json:"detail"`
}

// Diagnosis is the report, one JSON line. Verdict: egress (a check was answered), accepted-only (none was, and one
// was accepted: what a firewall that accepts first and passes nothing looks like), none (nothing accepted or answered).
type Diagnosis struct {
	UID     int       `json:"uid"`
	GID     int       `json:"gid"`
	Kernel  string    `json:"kernel"`
	Verdict string    `json:"verdict"`
	Results []Outcome `json:"results"`
}

// The diagnostic's targets: three public DNS resolvers, and one address that is no resolver, Fastly's anycast edge
// serving fastly.com (151.101.0.0/16, Fastly's own network; Fastly runs no public resolver), so a DNS answer from it
// would be something on the path answering for every address. Each name is the one that address serves.
var diagnoseTargets = []struct{ address, name string }{
	{"1.1.1.1", "one.one.one.one"},
	{"8.8.8.8", "dns.google"},
	{"9.9.9.9", "dns.quad9.net"},
	{"151.101.1.57", "fastly.com"},
}

// DiagnoseChecks are `computerd probe --diagnose`'s checks: every target on 443/tcp (TLS), 80/tcp (HTTP) and 53/udp
// (DNS), and nothing else.
func DiagnoseChecks() []Check {
	checks := make([]Check, 0, 3*len(diagnoseTargets))
	for _, target := range diagnoseTargets {
		checks = append(checks,
			Check{Probe: "tls", Address: net.JoinHostPort(target.address, "443"), Name: target.name},
			Check{Probe: "http", Address: net.JoinHostPort(target.address, "80"), Name: target.name},
			Check{Probe: "dns", Address: net.JoinHostPort(target.address, "53")},
		)
	}
	return checks
}

// Diagnose runs every check at once, each within bounds and all within bounds.Whole, and reports them in the order given.
func Diagnose(checks []Check, bounds Bounds) Diagnosis {
	end := time.Now().Add(bounds.Whole)
	results := make([]Outcome, len(checks))
	var wg sync.WaitGroup
	for i, check := range checks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = diagnose(check, bounds, end)
		}()
	}
	wg.Wait()
	verdict := "none"
	for _, result := range results {
		if result.Outcome == "answered" {
			verdict = "egress"
			break
		}
		if result.Outcome == "accepted" {
			verdict = "accepted-only"
		}
	}
	return Diagnosis{UID: os.Getuid(), GID: os.Getgid(), Kernel: kernel(), Verdict: verdict, Results: results}
}

func diagnose(check Check, bounds Bounds, end time.Time) Outcome {
	host, port, err := net.SplitHostPort(check.Address)
	number, _ := strconv.Atoi(port)
	result := Outcome{Target: host, Port: number, Proto: "tcp", Probe: check.Probe, Name: check.Name, Outcome: "refused"}
	if err != nil {
		result.Detail = fmt.Sprintf("%q is not host:port", check.Address)
		return result
	}
	if check.Probe == "dns" {
		result.Proto = "udp"
	}
	// The request is --connect's own (askFor), named by check.Name: a DNS check is a host:port/udp target's query.
	ask, ok := askFor(check.Probe, check.Name, result.Proto)
	if !ok || check.Probe == "any" {
		result.Detail = fmt.Sprintf("%q is no probe: tls, http or dns", check.Probe)
		return result
	}
	result.Outcome, result.Bytes, result.Detail = exchange(result.Proto, check.Address, ask, bounds, end)
	return result
}

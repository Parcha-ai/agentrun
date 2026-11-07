package probe

// The diagnosis: whether bytes come back, not only whether a TCP connection is accepted. Some vendors' firewalls
// (E2B's, by its own docs: network/internet-access, "Behavior of blocked TCP connections") accept every outbound TCP
// connection first and decide after, so an accept says nothing about the destination; a protocol-correct answer does.
// It tries a fixed list of well-known public addresses only, sends nothing of the computer's (a ClientHello with a
// random nonce, an HTTP HEAD, a DNS query for example.com), reads at most MaxRead bytes, and is bounded at every step.

import (
	"errors"
	"fmt"
	"io"
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

// Outcome is one check's result. Outcome is refused (no TCP accept, or no UDP answer), accepted (a TCP accept, or a
// UDP reply, with no protocol-correct answer in time: Bytes says whether other bytes came) or answered.
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

// within is now plus d, never past end.
func within(d time.Duration, end time.Time) time.Time {
	if at := time.Now().Add(d); at.Before(end) {
		return at
	}
	return end
}

func diagnose(check Check, bounds Bounds, end time.Time) Outcome {
	host, port, err := net.SplitHostPort(check.Address)
	number, _ := strconv.Atoi(port)
	result := Outcome{Target: host, Port: number, Proto: "tcp", Probe: check.Probe, Name: check.Name, Outcome: "refused"}
	if err != nil {
		result.Detail = fmt.Sprintf("%q is not host:port", check.Address)
		return result
	}
	var request []byte
	var answered func([]byte) (bool, int)
	var expected string
	switch check.Probe {
	case "tls":
		request, answered, expected = clientHello(check.Name), serverHello, "a ServerHello"
	case "http":
		request, answered, expected = httpHead(check.Name), is(statusLine), "an HTTP status line"
	case "dns":
		result.Proto = "udp"
		var id uint16
		request, id = dnsQuery()
		answered, expected = is(dnsResponse(id)), "a DNS response with the query's id"
	default:
		result.Detail = fmt.Sprintf("%q is no probe: tls, http or dns", check.Probe)
		return result
	}
	dialer := net.Dialer{Deadline: within(bounds.Connect, end)}
	conn, err := dialer.Dial(result.Proto, check.Address)
	if err != nil {
		result.Detail = "no connection: " + reason(err)
		return result
	}
	defer conn.Close()
	_ = conn.SetDeadline(within(bounds.Read, end))
	if _, err := conn.Write(request); err != nil {
		if result.Proto == "tcp" {
			result.Outcome = "accepted"
		}
		result.Detail = "the request was not sent: " + reason(err)
		return result
	}
	if result.Proto == "tcp" {
		result.Outcome = "accepted"
	}
	read, err := readAnswer(conn, result.Proto, bounds.MaxRead, func(read []byte) (string, int) {
		ok, need := answered(read)
		if ok {
			return expected, need
		}
		return "", need
	})
	result.Bytes = len(read)
	if ok, _ := answered(read); ok {
		result.Outcome, result.Detail = "answered", expected+" came back"
		return result
	}
	switch {
	case len(read) > 0:
		// For UDP, a reply that is not the answer is still a reply from something on the path.
		result.Outcome = "accepted"
		result.Detail = fmt.Sprintf("%d bytes came back, not %s (first byte 0x%02x)", len(read), expected, read[0])
	case errors.Is(err, io.EOF):
		result.Detail = "the connection closed with no bytes"
	case isTimeout(err) && result.Proto == "udp":
		result.Detail = "no answer within the bound"
	case isTimeout(err):
		result.Detail = "no bytes within the bound"
	case err != nil && result.Proto == "udp":
		result.Detail = "no answer: " + reason(err)
	case err != nil:
		result.Detail = "no bytes: " + reason(err)
	}
	return result
}

// serverHello: a handshake record (0x16, version 3.x) whose first message is a ServerHello (0x02); 6 bytes judge it.
func serverHello(read []byte) (bool, int) {
	return len(read) >= 6 && read[0] == 0x16 && read[1] == 0x03 && read[5] == 0x02, 6
}

// is turns a check that names an answer into one that says whether it is one.
func is(name func([]byte) (string, int)) func([]byte) (bool, int) {
	return func(read []byte) (bool, int) {
		what, need := name(read)
		return what != "", need
	}
}

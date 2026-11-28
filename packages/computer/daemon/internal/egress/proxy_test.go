package egress

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const wait = 30 * time.Second

// own is this test machine's pretend address: the VM's own, which the proxy refuses as this-host.
var own = netip.MustParseAddr("203.0.114.7")

// harness is a proxy on a loopback listener whose lookups answer from names, whose dials reach upstream (a local
// server that answers "hello from <address>:<port>" and closes) and record what was dialled, and whose own addresses
// are own.
type harness struct {
	address string
	mu      sync.Mutex
	dialled []string
	looked  []string
	logged  []string
}

func newHarness(t *testing.T, allow *Allow, names map[string][]string) *harness {
	t.Helper()
	return newHarnessThrough(t, allow, names, netip.AddrPort{})
}

// newHarnessThrough is newHarness whose proxy has a public egress (none when publicEgress is the zero value): its dials
// are recorded as every other, by the address and port they were asked for.
func newHarnessThrough(t *testing.T, allow *Allow, names map[string][]string, publicEgress netip.AddrPort) *harness {
	t.Helper()
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = upstream.Close() })
	go func() {
		for {
			conn, err := upstream.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				reader := bufio.NewReader(conn)
				line, _ := reader.ReadString('\n')
				if strings.HasPrefix(line, "GET ") {
					req, err := http.ReadRequest(bufio.NewReader(io.MultiReader(strings.NewReader(line), reader)))
					if err != nil {
						return
					}
					body := "path " + req.URL.Path + " host " + req.Host
					_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\ncontent-length: "+strconv.Itoa(len(body))+"\r\n\r\n"+body)
					return
				}
				if strings.HasPrefix(line, "POST ") {
					// An upload is answered with an interim 100 Continue first, then the final reply naming what came.
					req, err := http.ReadRequest(bufio.NewReader(io.MultiReader(strings.NewReader(line), reader)))
					if err != nil {
						return
					}
					posted, _ := io.ReadAll(req.Body)
					body := "posted " + string(posted) + " expect " + req.Header.Get("Expect")
					_, _ = io.WriteString(conn, "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: "+strconv.Itoa(len(body))+"\r\n\r\n"+body)
					return
				}
				_, _ = io.WriteString(conn, "echo "+line)
			}()
		}
	}()
	h := &harness{}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	h.address = l.Addr().String()
	options := Options{
		Allow:          allow,
		MaxTunnels:     4,
		MaxConnections: 1000,
		Log: func(line string) {
			h.mu.Lock()
			h.logged = append(h.logged, line)
			h.mu.Unlock()
		},
		Lookup: func(_ context.Context, host string) ([]netip.Addr, error) {
			h.mu.Lock()
			h.looked = append(h.looked, host)
			h.mu.Unlock()
			var out []netip.Addr
			for _, text := range names[host] {
				out = append(out, netip.MustParseAddr(text))
			}
			if len(out) == 0 {
				return nil, errors.New("no such host")
			}
			return out, nil
		},
		Dial: func(ctx context.Context, address netip.Addr, port int) (net.Conn, error) {
			h.mu.Lock()
			h.dialled = append(h.dialled, netip.AddrPortFrom(address, uint16(port)).String())
			h.mu.Unlock()
			var d net.Dialer
			return d.DialContext(ctx, "tcp", upstream.Addr().String())
		},
		Local:        func() []netip.Addr { return []netip.Addr{netip.MustParseAddr("127.0.0.1"), own} },
		PublicEgress: publicEgress,
	}
	go func() { _ = Serve(l, options) }()
	return h
}

// connect sends CONNECT target and gives the status line and the x-egress-refused header, and the connection.
func (h *harness) connect(t *testing.T, target string) (string, string, net.Conn) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", h.address, wait)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(wait))
	if _, err := io.WriteString(conn, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	answer, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatalf("CONNECT %s: %v", target, err)
	}
	return answer.Status, answer.Header.Get("x-egress-refused"), &buffered{Conn: conn, reader: reader}
}

type buffered struct {
	net.Conn
	reader *bufio.Reader
}

func (b *buffered) Read(p []byte) (int, error) { return b.reader.Read(p) }

func (h *harness) dials() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string{}, h.dialled...)
}

func (h *harness) lookups() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string{}, h.looked...)
}

// Open: a public name is reached at the address its lookup gave, and bytes go both ways.
func TestOpenReachesAPublicNameAtTheAddressItWasCheckedAt(t *testing.T) {
	h := newHarness(t, nil, map[string][]string{"example.com": {"93.184.215.14"}})
	status, refused, conn := h.connect(t, "example.com:443")
	if !strings.HasPrefix(status, "200") || refused != "" {
		t.Fatalf("CONNECT example.com:443: %q refused %q; want 200", status, refused)
	}
	_, _ = io.WriteString(conn, "ping\n")
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || line != "echo ping\n" {
		t.Fatalf("through the tunnel: %q, %v; want the upstream's echo", line, err)
	}
	if got := h.dials(); len(got) != 1 || got[0] != "93.184.215.14:443" {
		t.Fatalf("dialled %q; want 93.184.215.14:443 alone", got)
	}
}

// Open: the vendor's agent and metadata stay out of reach. Every refused class answers 403 with the class, before any
// socket opens: metadata, link-local, private, loopback, the machine's own address, and an IPv6 address that carries a
// private IPv4 one. A name that resolves to any refused address is refused as that class, with no dial.
func TestOpenRefusesMetadataPrivateLoopbackAndTheMachinesOwnAddress(t *testing.T) {
	h := newHarness(t, nil, map[string][]string{
		"metadata.google.internal": {"169.254.169.254"},
		"split.example.com":        {"93.184.215.14", "10.1.2.3"},
	})
	for _, test := range []struct{ target, class string }{
		{"169.254.169.254:80", "link-local"},
		{"metadata.google.internal:80", "link-local"},
		{"168.63.129.16:80", "metadata"},
		{"100.100.100.200:80", "metadata"},
		{"[fd00:ec2::254]:80", "metadata"},
		{"10.0.0.5:443", "private"},
		{"172.16.3.4:22", "private"},
		{"192.168.1.1:80", "private"},
		{"127.0.0.1:49983", "loopback"},
		{"[::1]:22", "loopback"},
		{"0.0.0.0:22", "unspecified"},
		{"203.0.114.7:22", "this-host"},
		{"[::ffff:10.0.0.1]:80", "private"},
		{"[2002:a00:1::]:80", "private"},
		{"[64:ff9b::a9fe:a9fe]:80", "link-local"},
		{"split.example.com:443", "private"},
		{"[fe80::1]:22", "link-local"},
		{"100.64.0.1:80", "cgnat"},
	} {
		status, refused, _ := h.connect(t, test.target)
		if !strings.HasPrefix(status, "403") || refused != test.class {
			t.Errorf("CONNECT %s: %q refused %q; want 403 refused as %s", test.target, status, refused, test.class)
		}
	}
	if got := h.dials(); len(got) != 0 {
		t.Fatalf("dialled %q; want no dial at all", got)
	}
}

// Plain HTTP goes to the request URI's host, in origin form, with that host as its Host; a refused one never leaves.
func TestOpenForwardsPlainHTTPInOriginFormAndRefusesMetadata(t *testing.T) {
	h := newHarness(t, nil, map[string][]string{"example.com": {"93.184.215.14"}})
	via, err := url.Parse("http://" + h.address)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(via)}, Timeout: wait}
	answer, err := client.Get("http://example.com/index.html?q=1")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(answer.Body)
	_ = answer.Body.Close()
	if answer.StatusCode != 200 || string(body) != "path /index.html host example.com" {
		t.Fatalf("GET through the proxy: %d %q; want 200 and the origin-form request", answer.StatusCode, body)
	}
	answer, err = client.Get("http://169.254.169.254/latest/meta-data/")
	if err != nil {
		t.Fatal(err)
	}
	_ = answer.Body.Close()
	if answer.StatusCode != 403 || answer.Header.Get("x-egress-refused") != "link-local" {
		t.Fatalf("GET metadata through the proxy: %d refused %q; want 403 link-local", answer.StatusCode, answer.Header.Get("x-egress-refused"))
	}
	if got := h.dials(); len(got) != 1 {
		t.Fatalf("dialled %q; want example.com's alone", got)
	}
}

// SOCKS5: CONNECT by name reaches; a refused address gets reply 2 (not allowed) and no dial; BIND is refused by name.
func TestOpenAnswersSocksConnectAndRefusesItsOtherCommands(t *testing.T) {
	h := newHarness(t, nil, map[string][]string{"example.com": {"93.184.215.14"}})
	socks := func(request []byte) (byte, net.Conn) {
		conn, err := net.DialTimeout("tcp", h.address, wait)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		_ = conn.SetDeadline(time.Now().Add(wait))
		_, _ = conn.Write([]byte{5, 1, 0})
		greeting := make([]byte, 2)
		if _, err := io.ReadFull(conn, greeting); err != nil || greeting[1] != 0 {
			t.Fatalf("socks greeting: %v %v", greeting, err)
		}
		_, _ = conn.Write(request)
		reply := make([]byte, 10)
		if _, err := io.ReadFull(conn, reply); err != nil {
			t.Fatalf("socks reply: %v", err)
		}
		return reply[1], conn
	}
	byName := append([]byte{5, 1, 0, 3, byte(len("example.com"))}, "example.com"...)
	code, conn := socks(append(byName, 1, 187))
	if code != 0 {
		t.Fatalf("socks CONNECT example.com:443: reply %d; want 0", code)
	}
	_, _ = io.WriteString(conn, "ping\n")
	if line, err := bufio.NewReader(conn).ReadString('\n'); err != nil || line != "echo ping\n" {
		t.Fatalf("through the socks tunnel: %q, %v", line, err)
	}
	if code, _ := socks([]byte{5, 1, 0, 1, 169, 254, 169, 254, 0, 80}); code != 2 {
		t.Errorf("socks CONNECT 169.254.169.254:80: reply %d; want 2, not allowed", code)
	}
	if code, _ := socks([]byte{5, 2, 0, 1, 93, 184, 215, 14, 0, 80}); code != 7 {
		t.Errorf("socks BIND: reply %d; want 7, command not supported", code)
	}
	if got := h.dials(); len(got) != 1 {
		t.Fatalf("dialled %q; want example.com's alone", got)
	}
}

// A host list: a name on it is reached on 80 and 443; a name off it and another port are refused before any lookup, so
// no lookup of a name off the list leaves the machine; an address is reached only inside a CIDR on the list, and the
// table still refuses what it refuses.
func TestAllowRefusesOffTheListBeforeAnyLookup(t *testing.T) {
	allow, err := ParseAllow("example.com,*.example.org,93.184.216.0/24")
	if err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, &allow, map[string][]string{
		"example.com":     {"93.184.215.14"},
		"www.example.org": {"93.184.215.15"},
		"evil.example":    {"93.184.215.16"},
	})
	for _, test := range []struct {
		target string
		status string
		class  string
	}{
		{"example.com:443", "200", ""},
		{"www.example.org:80", "200", ""},
		{"93.184.216.34:443", "200", ""},
		{"evil.example:443", "403", "not-listed"},
		{"example.org:443", "403", "not-listed"},
		{"example.com:22", "403", "not-listed"},
		{"93.184.215.14:443", "403", "not-listed"},
		{"169.254.169.254:80", "403", "not-listed"},
	} {
		status, refused, _ := h.connect(t, test.target)
		if !strings.HasPrefix(status, test.status) || refused != test.class {
			t.Errorf("CONNECT %s: %q refused %q; want %s refused %q", test.target, status, refused, test.status, test.class)
		}
	}
	for _, name := range h.lookups() {
		if name != "example.com" && name != "www.example.org" {
			t.Errorf("looked up %q, which is off the list", name)
		}
	}
}

// A host or LAN service is reachable on no network setting: a private address or CIDR is no list entry, and a listed
// LAN name that resolves to a private address is refused, never dialled.
func TestALANServiceIsReachableOnNoNetworkSetting(t *testing.T) {
	for _, entry := range []string{"10.0.0.1", "10.0.0.0/24", "192.168.1.0/24"} {
		if _, err := ParseAllow(entry); err == nil {
			t.Errorf("ParseAllow(%q) took it; want it refused", entry)
		}
	}
	allow, err := ParseAllow("nas.lan")
	if err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, &allow, map[string][]string{"nas.lan": {"10.0.0.1"}})
	if status, refused, _ := h.connect(t, "nas.lan:443"); !strings.HasPrefix(status, "403") || refused != "private" {
		t.Errorf("CONNECT nas.lan:443: %q refused %q; want 403 refused as private", status, refused)
	}
	if got := h.dials(); len(got) != 0 {
		t.Fatalf("dialled %q; want no dial", got)
	}
}

// The cap on connections open at once refuses one past it by name, and gives its slot back when one closes.
func TestTheTunnelCapRefusesOnePastItByName(t *testing.T) {
	h := newHarness(t, nil, map[string][]string{"example.com": {"93.184.215.14"}})
	var open []net.Conn
	for range 4 {
		status, _, conn := h.connect(t, "example.com:443")
		if !strings.HasPrefix(status, "200") {
			t.Fatalf("CONNECT: %q; want 200 within the cap", status)
		}
		open = append(open, conn)
	}
	if status, refused, _ := h.connect(t, "example.com:443"); !strings.HasPrefix(status, "429") || refused != "tunnel cap" {
		t.Fatalf("CONNECT past the cap: %q refused %q; want 429 tunnel cap", status, refused)
	}
	_ = open[0].Close()
	deadline := time.Now().Add(wait)
	for {
		status, _, _ := h.connect(t, "example.com:443")
		if strings.HasPrefix(status, "200") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the slot did not come back: %q", status)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// An upload that waits for 100 Continue is told to go on, its body reaches the upstream without the Expect, and the
// client gets the upstream's final reply past its interim 100.
func TestOpenCarriesAnUploadThatWaitsFor100ContinueToItsFinalReply(t *testing.T) {
	h := newHarness(t, nil, map[string][]string{"example.com": {"93.184.215.14"}})
	conn, err := net.DialTimeout("tcp", h.address, wait)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(wait))
	_, _ = io.WriteString(conn, "POST http://example.com/upload HTTP/1.1\r\nHost: example.com\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n")
	reader := bufio.NewReader(conn)
	post := &http.Request{Method: http.MethodPost}
	interim, err := http.ReadResponse(reader, post)
	if err != nil || interim.StatusCode != 100 {
		t.Fatalf("before the body: %v %v; want 100 Continue", interim, err)
	}
	_, _ = io.WriteString(conn, "hello")
	answer, err := http.ReadResponse(reader, post)
	if err != nil {
		t.Fatalf("after the body: %v", err)
	}
	body, _ := io.ReadAll(answer.Body)
	if answer.StatusCode != 200 || string(body) != "posted hello expect " {
		t.Fatalf("the upload's reply: %d %q; want 200 and the body without an Expect", answer.StatusCode, body)
	}
}

// A request's head past maxHead is refused 431 by name, with no lookup.
func TestARequestHeadPastItsSizeIsRefusedByName(t *testing.T) {
	h := newHarness(t, nil, map[string][]string{"example.com": {"93.184.215.14"}})
	conn, err := net.DialTimeout("tcp", h.address, wait)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(wait))
	// Exactly maxHead bytes of a head that never ends: the proxy reads them all, so its close is a clean one.
	start := "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nX-Big: "
	go func() { _, _ = io.WriteString(conn, start+strings.Repeat("a", maxHead-len(start))) }()
	answer, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("a head past its size: %v; want a 431", err)
	}
	if answer.StatusCode != 431 || answer.Header.Get("x-egress-refused") != "header too large" {
		t.Fatalf("a head past its size: %d refused %q; want 431 header too large", answer.StatusCode, answer.Header.Get("x-egress-refused"))
	}
	if got := h.lookups(); len(got) != 0 {
		t.Fatalf("looked up %q; want no lookup", got)
	}
}

// The clients answered at once have a cap (twice the tunnel cap): one past it is closed unread and logged by name, and
// a slot comes back when a client goes.
func TestTheClientCapClosesOnePastItAndGivesItsSlotBack(t *testing.T) {
	h := newHarness(t, nil, map[string][]string{"example.com": {"93.184.215.14"}})
	dial := func() net.Conn {
		conn, err := net.DialTimeout("tcp", h.address, wait)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		_ = conn.SetDeadline(time.Now().Add(wait))
		return conn
	}
	// Eight clients that send nothing hold every slot, each in its first request.
	var idle []net.Conn
	for range 8 {
		idle = append(idle, dial())
	}
	past := dial()
	_ = past.SetReadDeadline(time.Now().Add(5 * time.Second))
	if n, err := past.Read(make([]byte, 1)); n != 0 || err == nil || errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("a client past the cap: read %d, %v; want it closed at once", n, err)
	}
	h.mu.Lock()
	logged := strings.Join(h.logged, "\n")
	h.mu.Unlock()
	if !strings.Contains(logged, "class=client cap") {
		t.Fatalf("the log: %q; want a client cap line", logged)
	}
	_ = idle[0].Close()
	deadline := time.Now().Add(wait)
	for {
		conn := dial()
		_, _ = io.WriteString(conn, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
		answer, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
		if err == nil && answer.StatusCode == 200 {
			break
		}
		_ = conn.Close()
		if time.Now().After(deadline) {
			t.Fatalf("the slot did not come back: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Check is the Docker proxy's table: the classes, IPv6 carrying IPv4, and the machine's own addresses.
func TestCheckIsTheDockerTable(t *testing.T) {
	local := []netip.Addr{own, netip.MustParseAddr("2600:1f18::7")}
	for _, test := range []struct{ address, class string }{
		{"93.184.215.14", ""},
		{"2606:2800:21f:cb07:6820:80da:af6b:8b2c", ""},
		{"169.254.169.254", "link-local"},
		{"168.63.129.16", "metadata"},
		{"10.255.0.1", "private"},
		{"192.0.0.9", "private"},
		{"198.18.0.1", "benchmarking"},
		{"255.255.255.255", "broadcast"},
		{"240.0.0.1", "reserved"},
		{"224.0.0.1", "multicast"},
		{"::", "unspecified"},
		{"::ffff:169.254.169.254", "link-local"},
		{"::ffff:203.0.114.7", "this-host"},
		{"64:ff9b:1::1", "private"},
		{"2001:db8::1", "reserved"},
		{"2001::1", "reserved"},
		{"fc00::1", "private"},
		{"ff02::1", "multicast"},
		{"3fff::1", ""},
		{"4000::1", "reserved"},
		{"203.0.114.7", "this-host"},
		{"2600:1f18::7", "this-host"},
	} {
		if got := Check(netip.MustParseAddr(test.address), local); got != test.class {
			t.Errorf("Check(%s) = %q; want %q", test.address, got, test.class)
		}
	}
}

// A list is read as the Docker computer's is: names, wildcards and CIDRs; anything else refused in words naming it.
func TestParseAllowReadsTheDockerListAndRefusesTheRest(t *testing.T) {
	allow, err := ParseAllow("Example.COM., *.example.org example.com 93.184.216.0/24,2606:2800::/32")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(allow.Entries(), ","); got != "example.com,*.example.org,93.184.216.0/24,2606:2800::/32" {
		t.Fatalf("entries %q", got)
	}
	for _, test := range []struct{ list, words string }{
		{"", "no entry"},
		{"localhost", "two labels"},
		{"93.184.216.34", "two labels"},
		{"*.com.", "two labels"},
		{"*.example.com.", ""},
		{"10.0.0.0/8", "refused range 10.0.0.0/8"},
		{"0.0.0.0/0", "refused range"},
		{"93.184.216.1/24", "host bits"},
		{"fc00::/7", "refused range"},
		{"4000::/16", "outside global unicast"},
		{"093.184.216.0/24", "two labels"},
	} {
		_, err := ParseAllow(test.list)
		if test.words == "" {
			if err != nil {
				t.Errorf("ParseAllow(%q): %v; want it read", test.list, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), test.words) {
			t.Errorf("ParseAllow(%q): %v; want words with %q", test.list, err, test.words)
		}
	}
}

// The form init takes is the form the policy file holds, both ways.
func TestNetworkOfReadsOpenAndAListBackAsWritten(t *testing.T) {
	for _, text := range []string{"open", "allow:example.com,*.example.org,93.184.216.0/24", "allow:2606:2800:0::/32,93.184.216.0/24,example.com"} {
		network, err := NetworkOf(text)
		if err != nil || network.String() != text {
			t.Errorf("NetworkOf(%q) = %q, %v; want it back as written", text, network, err)
		}
	}
	for _, text := range []string{"none", "", "allow", "allow:", "open:example.com"} {
		if _, err := NetworkOf(text); err == nil {
			t.Errorf("NetworkOf(%q): read; want a refusal", text)
		}
	}
}

// gate is a public egress in the documentation range: the operator's address a tunnel to 443 goes to.
var gate = netip.MustParseAddrPort("192.0.2.40:8443")

// With a public egress, an HTTP CONNECT and a SOCKS5 CONNECT to port 443 whose checks pass open TCP to the gate, not to
// the checked address, and the client's bytes (here a ClientHello's first bytes and a line) reach it unchanged.
func TestAPublicEgressCarriesATunnelTo443ToTheGateWithTheClientsBytes(t *testing.T) {
	h := newHarnessThrough(t, nil, map[string][]string{"example.com": {"93.184.215.14"}}, gate)
	status, refused, conn := h.connect(t, "example.com:443")
	if !strings.HasPrefix(status, "200") || refused != "" {
		t.Fatalf("CONNECT example.com:443: %q refused %q; want 200", status, refused)
	}
	hello := "\x16\x03\x01\x00\xa5\x01 server name example.com\n"
	_, _ = io.WriteString(conn, hello)
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || line != "echo "+hello {
		t.Fatalf("through the tunnel: %q, %v; want the gate to see the client's bytes unchanged", line, err)
	}
	conn, err = net.DialTimeout("tcp", h.address, wait)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(wait))
	_, _ = conn.Write([]byte{5, 1, 0})
	greeting := make([]byte, 2)
	if _, err := io.ReadFull(conn, greeting); err != nil || greeting[1] != 0 {
		t.Fatalf("socks greeting: %v %v", greeting, err)
	}
	_, _ = conn.Write(append(append([]byte{5, 1, 0, 3, byte(len("example.com"))}, "example.com"...), 1, 187))
	reply := make([]byte, 10)
	if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0 {
		t.Fatalf("socks CONNECT example.com:443: reply %v, %v; want 0", reply, err)
	}
	if got := h.dials(); len(got) != 2 || got[0] != gate.String() || got[1] != gate.String() {
		t.Fatalf("dialled %q; want the gate %s twice, never the checked address", got, gate)
	}
}

// With a public egress, a tunnel to any other port and plain HTTP (to port 80, or naming port 443) still dial the
// address they were checked at: the gate admits by the server name a TLS ClientHello carries, which only a tunnel to
// 443 sends.
func TestAPublicEgressNeverCarriesAnotherPortOrPlainHTTP(t *testing.T) {
	h := newHarnessThrough(t, nil, map[string][]string{"example.com": {"93.184.215.14"}}, gate)
	for _, target := range []string{"example.com:80", "example.com:8443", "example.com:22"} {
		if status, refused, _ := h.connect(t, target); !strings.HasPrefix(status, "200") || refused != "" {
			t.Fatalf("CONNECT %s: %q refused %q; want 200", target, status, refused)
		}
	}
	via, err := url.Parse("http://" + h.address)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(via)}, Timeout: wait}
	for _, target := range []string{"http://example.com/index.html", "http://example.com:443/index.html"} {
		answer, err := client.Get(target)
		if err != nil {
			t.Fatalf("GET %s: %v", target, err)
		}
		_ = answer.Body.Close()
		if answer.StatusCode != 200 {
			t.Fatalf("GET %s through the proxy: %d; want 200", target, answer.StatusCode)
		}
	}
	want := []string{"93.184.215.14:80", "93.184.215.14:8443", "93.184.215.14:22", "93.184.215.14:80", "93.184.215.14:443"}
	if got := h.dials(); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("dialled %q; want %q, the gate never", got, want)
	}
}

// With a public egress, every refusal still comes first and nothing refused reaches the gate: a refused class, a name
// that resolves to a refused address, a name that does not resolve, and with a host list, a name off it (never looked up).
func TestAPublicEgressNeverCarriesWhatTheChecksRefuse(t *testing.T) {
	names := map[string][]string{"example.com": {"93.184.215.14"}, "split.example.com": {"93.184.215.14", "10.1.2.3"}}
	open := newHarnessThrough(t, nil, names, gate)
	for _, test := range []struct{ target, status, class string }{
		{"10.0.0.5:443", "403", "private"},
		{"169.254.169.254:443", "403", "link-local"},
		{"203.0.114.7:443", "403", "this-host"},
		{"split.example.com:443", "403", "private"},
		{"nowhere.example:443", "502", "name not resolved"},
	} {
		status, refused, _ := open.connect(t, test.target)
		if !strings.HasPrefix(status, test.status) || refused != test.class {
			t.Errorf("CONNECT %s: %q refused %q; want %s refused as %s", test.target, status, refused, test.status, test.class)
		}
	}
	if got := open.dials(); len(got) != 0 {
		t.Fatalf("dialled %q; want no dial at all", got)
	}
	allow, err := ParseAllow("example.com")
	if err != nil {
		t.Fatal(err)
	}
	listed := newHarnessThrough(t, &allow, map[string][]string{"example.com": {"93.184.215.14"}, "evil.example": {"93.184.215.16"}}, gate)
	if status, refused, _ := listed.connect(t, "evil.example:443"); !strings.HasPrefix(status, "403") || refused != "not-listed" {
		t.Fatalf("CONNECT evil.example:443 off the list: %q refused %q; want 403 not-listed", status, refused)
	}
	if got, looked := listed.dials(), listed.lookups(); len(got) != 0 || len(looked) != 0 {
		t.Fatalf("dialled %q, looked up %q; want neither for a name off the list", got, looked)
	}
	if status, _, _ := listed.connect(t, "example.com:443"); !strings.HasPrefix(status, "200") {
		t.Fatalf("CONNECT example.com:443 on the list: %q; want 200", status)
	}
	if got := listed.dials(); len(got) != 1 || got[0] != gate.String() {
		t.Fatalf("dialled %q; want the gate alone for the listed name", got)
	}
}

// The public egress init gives its proxy reads as attach reads its relay: an IPv4 address and a port, no leading zero.
func TestPublicEgressOfReadsAnIPv4AndAPortAndRefusesTheRest(t *testing.T) {
	for _, text := range []string{"192.0.2.40:8443", "203.0.113.1:443", "198.51.100.255:65535", "192.0.2.4:1"} {
		address, err := PublicEgressOf(text)
		if err != nil || address.String() != text {
			t.Errorf("PublicEgressOf(%q) = %v, %v; want it back as written", text, address, err)
		}
	}
	for _, text := range []string{"", "192.0.2.40", "gate.example:8443", "192.0.2.40:0", "192.0.2.40:65536", "192.0.2.40:08443", "192.0.2.040:8443", "[2001:db8::1]:8443", "192.0.2.40:8443:1", " 192.0.2.40:8443", "192.0.2.40:8443\n"} {
		if _, err := PublicEgressOf(text); err == nil || !strings.Contains(err.Error(), "--public-egress is the operator's public egress") {
			t.Errorf("PublicEgressOf(%q): %v; want a refusal in PublicEgressWords", text, err)
		}
	}
}

// egress-proxy takes the public egress init gives it, once and well formed, and serves it.
func TestProxyConfigOfTakesThePublicEgressOnceAndWellFormed(t *testing.T) {
	until := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	config, err := ProxyConfigOf([]string{"--network", "open", "--until", until, "--parent", "7", "--public-egress", "192.0.2.40:8443"})
	if err != nil || config.PublicEgress != gate || config.Network.Allow != nil || config.Parent != 7 {
		t.Fatalf("ProxyConfigOf with --public-egress: %+v, %v; want the gate", config, err)
	}
	config, err = ProxyConfigOf([]string{"--network", "open", "--until", until, "--parent", "7"})
	if err != nil || config.PublicEgress.IsValid() {
		t.Fatalf("ProxyConfigOf without --public-egress: %+v, %v; want none", config, err)
	}
	for _, args := range [][]string{
		{"--network", "open", "--until", until, "--parent", "7", "--public-egress", "gate.example:8443"},
		{"--network", "open", "--until", until, "--parent", "7", "--public-egress", "192.0.2.40:8443", "--public-egress", "192.0.2.41:8443"},
		{"--network", "open", "--until", until, "--parent", "7", "--public-egress"},
	} {
		if _, err := ProxyConfigOf(args); err == nil || !strings.Contains(err.Error(), "egress-proxy takes") {
			t.Errorf("ProxyConfigOf(%q): %v; want a refusal", args, err)
		}
	}
}

// A proxy config's arguments are what egress-proxy reads back, the public egress among them when there is one, and its
// options serve the network's list and that public egress.
func TestProxyConfigArgsReadBackAndServeThePublicEgress(t *testing.T) {
	allow, err := ParseAllow("example.com")
	if err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(time.Hour).Truncate(time.Second).UTC()
	for _, config := range []ProxyConfig{
		{Network: Network{Allow: &allow}, Until: until, Parent: 7, PublicEgress: gate},
		{Network: Network{}, Until: until, Parent: 7},
	} {
		read, err := ProxyConfigOf(config.Args())
		if err != nil || read.PublicEgress != config.PublicEgress || read.Parent != 7 || !read.Until.Equal(until) || read.Network.String() != config.Network.String() {
			t.Fatalf("ProxyConfigOf(%q) = %+v, %v; want %+v back", config.Args(), read, err, config)
		}
		served := read.Options(func(string) {})
		if served.PublicEgress != config.PublicEgress || served.Allow != read.Network.Allow {
			t.Fatalf("%+v serves %+v; want its list and public egress", read, served)
		}
	}
	if args := (ProxyConfig{Until: until, Parent: 7}).Args(); slices.Contains(args, "--public-egress") {
		t.Fatalf("Args with no public egress: %q; want no --public-egress", args)
	}
}

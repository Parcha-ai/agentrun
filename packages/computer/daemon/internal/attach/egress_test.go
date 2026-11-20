package attach

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// The public host the machine's URL names: .test is reserved (RFC 6761), so it resolves nowhere and only the relay is
// ever dialed.
const publicHost = "attach.example.test"

// certFor is a self-signed certificate for name alone, and a pool that trusts it.
func certFor(t *testing.T, name string) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: name},
		DNSNames:              []string{name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsed)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, roots
}

// relay stands in for the operator's relay and the edge behind it at once: a TLS listener on loopback holding a
// certificate for the public host alone, which records the SNI of each ClientHello and the Host of each upgrade, and
// answers the upgrade as serve does, then closes 1000.
type relay struct {
	addr  string
	mu    sync.Mutex
	snis  []string
	hosts []string
}

func (r *relay) seen() ([]string, []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.snis), slices.Clone(r.hosts)
}

func startRelay(t *testing.T, tlsOn bool) (*relay, *x509.CertPool) {
	r := &relay{}
	answer := upgrading(t, func(conn net.Conn, br *bufio.Reader) {
		_, _ = conn.Write(closeFrame(CloseNormal, "done"))
		_, _ = readClient(br)
	})
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.hosts = append(r.hosts, req.Host)
		r.mu.Unlock()
		answer(w, req)
	}))
	// The handshakes a test fails on purpose are no news.
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	var roots *x509.CertPool
	if tlsOn {
		var cert tls.Certificate
		cert, roots = certFor(t, publicHost)
		srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			r.mu.Lock()
			r.snis = append(r.snis, hello.ServerName)
			r.mu.Unlock()
			return nil, nil
		}}
		srv.StartTLS()
	} else {
		srv.Start()
	}
	t.Cleanup(srv.Close)
	r.addr = srv.Listener.Addr().String()
	return r, roots
}

func TestAWssDialThroughTheEgressGoesToTheRelayWithThePublicHostsSNIHostHeaderAndCertificate(t *testing.T) {
	r, roots := startRelay(t, true)
	o := testOptions()
	o.Egress, o.Roots = r.addr, roots
	c, err := Dial(context.Background(), "wss://"+publicHost+"/v2/computers/attach", o)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.ReadMessage(); c.Ended() == nil || *c.Ended() != (Closed{Code: CloseNormal, Reason: "done", ByServer: true}) {
		t.Fatalf("ended %v", err)
	}
	snis, hosts := r.seen()
	if !slices.Equal(snis, []string{publicHost}) || !slices.Equal(hosts, []string{publicHost}) {
		t.Fatalf("the relay saw SNI %q and Host %q, not the public host's", snis, hosts)
	}

	// The certificate is checked for the URL's host, never the relay's address: a URL naming another host fails the TLS
	// handshake on the public host's certificate, before any upgrade is sent.
	_, err = Dial(context.Background(), "wss://other.example.test/v2/computers/attach", o)
	var hostname x509.HostnameError
	if !errors.As(err, &hostname) {
		t.Fatalf("a certificate for %s taken for other.example.test: %v", publicHost, err)
	}
	// And with no roots given, the system's: the relay's self-signed certificate is not trusted.
	o.Roots = nil
	_, err = Dial(context.Background(), "wss://"+publicHost+"/v2/computers/attach", o)
	var unknown x509.UnknownAuthorityError
	if !errors.As(err, &unknown) {
		t.Fatalf("a self-signed certificate taken with the system's roots: %v", err)
	}
	snis, hosts = r.seen()
	if !slices.Equal(snis, []string{publicHost, "other.example.test", publicHost}) || len(hosts) != 1 {
		t.Fatalf("SNI %q, Host %q", snis, hosts)
	}
}

func TestAWsDialThroughTheEgressGoesToTheRelayWithTheURLsHost(t *testing.T) {
	r, _ := startRelay(t, false)
	o := testOptions()
	o.Egress = r.addr
	c, err := Dial(context.Background(), "ws://"+publicHost+":8080/v2/computers/attach", o)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = c.ReadMessage()
	if _, hosts := r.seen(); !slices.Equal(hosts, []string{publicHost + ":8080"}) {
		t.Fatalf("Host %q", hosts)
	}
}

func TestFromEnvTakesAnEgressOfIPv4AndPortAloneAndRefusesAnyOtherInWords(t *testing.T) {
	t.Setenv(URLEnv, "wss://agentrun.example.com/v2/computers/attach")
	t.Setenv(TokenEnv, testToken)
	for _, bad := range []string{"relay.example:18443", "192.0.2.40", "192.0.2.40:", "192.0.2.40:0", "192.0.2.40:65536", "192.0.2.40:018443", "192.0.2.040:18443", "256.0.2.40:18443", "[2001:db8::1]:18443", "192.0.2.40:18443:1", " 192.0.2.40:18443"} {
		t.Setenv(EgressEnv, bad)
		_, err := FromEnv("/run/agentrun/computerd.sock", subprotocol, 1<<20)
		if err == nil || !strings.Contains(err.Error(), EgressEnv+" is the relay the machine reaches the server through, <IPv4>:<port>") || strings.Contains(err.Error(), testToken) {
			t.Fatalf("%q: %v", bad, err)
		}
	}
	for _, good := range []string{"192.0.2.40:18443", "10.0.0.1:1", "198.51.100.7:65535"} {
		t.Setenv(EgressEnv, good)
		cfg, err := FromEnv("/run/agentrun/computerd.sock", subprotocol, 1<<20)
		if err != nil || cfg.Egress != good || via(cfg) != cfg.URL+" through "+good {
			t.Fatalf("%q: %+v, %v", good, cfg, err)
		}
	}
	t.Setenv(EgressEnv, "")
	cfg, err := FromEnv("/run/agentrun/computerd.sock", subprotocol, 1<<20)
	if err != nil || cfg.Egress != "" || via(cfg) != cfg.URL {
		t.Fatalf("unset: %+v, %v", cfg, err)
	}
}

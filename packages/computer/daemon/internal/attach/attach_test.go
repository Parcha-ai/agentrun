package attach

import (
	"bufio"
	"context"
	"encoding/binary"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeInit listens where init would and answers each line with itself, as `ok <line>`, until its input ends.
func fakeInit(t *testing.T) string {
	socket, _ := listenInit(t, func(conn net.Conn) {
		lines := bufio.NewScanner(conn)
		for lines.Scan() {
			_, _ = conn.Write([]byte("ok " + lines.Text() + "\n"))
		}
	})
	return socket
}

// listenInit listens where init would and serves each connection with serve, closing it after; closing the listener
// is init ending.
func listenInit(t *testing.T, serve func(net.Conn)) (string, net.Listener) {
	socket := filepath.Join(t.TempDir(), "computerd.sock")
	l, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				serve(conn)
			}()
		}
	}()
	return socket, l
}

// server answers the nth upgrade (from 0) with sockets[n]: an HTTP status to refuse it, or what the server does over the
// socket. It records the close code of each socket the client closed.
type server struct {
	t       *testing.T
	sockets []func(conn net.Conn, r *bufio.Reader) int
	dials   atomic.Int32
	mu      sync.Mutex
	closes  []int
}

func (s *server) start() *httptest.Server {
	var refuse http.Handler = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		n := int(s.dials.Add(1)) - 1
		if n >= len(s.sockets) {
			http.Error(w, "no more", http.StatusServiceUnavailable)
			return
		}
		if status := s.sockets[n](nil, nil); status != 0 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "the server's words", status)
			return
		}
		upgrading(s.t, func(conn net.Conn, r *bufio.Reader) {
			s.sockets[n](conn, r)
			for {
				frame, err := readClient(r)
				if err != nil {
					return
				}
				if frame.op == opClose && len(frame.payload) >= 2 {
					s.mu.Lock()
					s.closes = append(s.closes, int(binary.BigEndian.Uint16(frame.payload)))
					s.mu.Unlock()
					return
				}
			}
		})(w, req)
	})
	srv := httptest.NewServer(ours(refuse))
	s.t.Cleanup(srv.Close)
	return srv
}

// ours answers a request for / with 404 and hands every other to h. No client under test asks for /, but a port watcher
// on the machine running the tests may GET / on each new loopback listener, and a test server that counts or records
// what it was sent must not take that for the client's.
func ours(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/" {
			http.NotFound(w, req)
			return
		}
		h.ServeHTTP(w, req)
	})
}

// refuse is a socket refused at the upgrade with status.
func refuse(status int) func(net.Conn, *bufio.Reader) int {
	return func(net.Conn, *bufio.Reader) int { return status }
}

// greetThenClose sends a message, checks init's answer came back over the socket, then closes with code.
func greetThenClose(t *testing.T, code int) func(net.Conn, *bufio.Reader) int {
	return func(conn net.Conn, r *bufio.Reader) int {
		if conn == nil {
			return 0
		}
		_, _ = conn.Write(serverFrame(true, opText, []byte(`{"id":1}`)))
		if got, err := readClient(r); err != nil || string(got.payload) != `ok {"id":1}` {
			t.Errorf("init's answer over the socket: %q, %v", got.payload, err)
		}
		_, _ = conn.Write(closeFrame(code, "the server's reason"))
		return 0
	}
}

// lines is a log's output, safe to write from any goroutine.
type lines struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *lines) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

// run runs attach against s with a fake init, and gives its exit code and log.
func run(t *testing.T, s *server, ctx context.Context, socket string) (int, string) {
	srv := s.start()
	out := &lines{}
	cfg := Config{URL: wsURL(srv), Token: testToken, Socket: socket, Steady: time.Minute, Delay: func(int) time.Duration { return 10 * time.Millisecond }}
	cfg.Options = testOptions()
	cfg.MaxMessage = 1 << 20
	code := Run(ctx, cfg, log.New(out, "computerd: ", log.LstdFlags))
	out.mu.Lock()
	defer out.mu.Unlock()
	return code, out.b.String()
}

// closedBy waits for the server to read the client's close with code.
func closedBy(t *testing.T, s *server, code int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		closes := append([]int(nil), s.closes...)
		s.mu.Unlock()
		if len(closes) == 1 && closes[0] == code {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server read the closes %v, want [%d]", closes, code)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestADialRedialAndRefusalNeverLogTheToken(t *testing.T) {
	s := &server{t: t, sockets: []func(net.Conn, *bufio.Reader) int{greetThenClose(t, CloseGoingAway), refuse(http.StatusBadGateway), greetThenClose(t, CloseReplaced), refuse(http.StatusUnauthorized)}}
	code, log := run(t, s, context.Background(), fakeInit(t))
	if code != ExitUnauthorized || s.dials.Load() != 4 {
		t.Fatalf("exit %d after %d dials, want %d after 4: %s", code, s.dials.Load(), ExitUnauthorized, log)
	}
	for _, want := range []string{"attached to ws://", "closed 1001 by the server", "refused the upgrade: 502", "closed 4409 by the server", "refused the upgrade: 401 the server's words", "stops dialing"} {
		if !strings.Contains(log, want) {
			t.Errorf("the log says no %q: %s", want, log)
		}
	}
	if strings.Contains(log, testToken[len("art_"):]) {
		t.Fatalf("the log holds the token: %s", log)
	}
}

func TestTheCloseCodesThatStopIt(t *testing.T) {
	for _, tc := range []struct {
		socket func(net.Conn, *bufio.Reader) int
		exit   int
	}{
		{greetThenClose(t, CloseUnauthorized), ExitUnauthorized},
		{greetThenClose(t, CloseMismatch), ExitMismatch},
		{greetThenClose(t, CloseVersion), ExitVersion},
		{refuse(http.StatusUpgradeRequired), ExitVersion},
	} {
		s := &server{t: t, sockets: []func(net.Conn, *bufio.Reader) int{tc.socket}}
		if code, log := run(t, s, context.Background(), fakeInit(t)); code != tc.exit || s.dials.Load() != 1 {
			t.Fatalf("exit %d after %d dials, want %d after 1: %s", code, s.dials.Load(), tc.exit, log)
		}
	}
}

func TestWithNoInitItNeverDialsAndExits1(t *testing.T) {
	s := &server{t: t, sockets: []func(net.Conn, *bufio.Reader) int{func(net.Conn, *bufio.Reader) int { return 0 }}}
	code, log := run(t, s, context.Background(), filepath.Join(t.TempDir(), "none.sock"))
	if code != ExitInitGone || s.dials.Load() != 0 || !strings.Contains(log, "no daemon listens") {
		t.Fatalf("exit %d after %d dials: %s", code, s.dials.Load(), log)
	}
}

func TestWhenInitHangsUpItClosesWith1011AndExits1(t *testing.T) {
	socket, _ := listenInit(t, func(net.Conn) {})
	s := &server{t: t, sockets: []func(net.Conn, *bufio.Reader) int{func(net.Conn, *bufio.Reader) int { return 0 }}}
	code, log := run(t, s, context.Background(), socket)
	if code != ExitInitGone || !strings.Contains(log, "closed the connection") {
		t.Fatalf("exit %d: %s", code, log)
	}
	closedBy(t, s, CloseInternal)
}

func TestWhenInitEndsWhileTheServerIsDownItStopsDialing(t *testing.T) {
	socket, l := listenInit(t, func(net.Conn) {})
	s := &server{t: t}
	for range 3 {
		s.sockets = append(s.sockets, refuse(http.StatusBadGateway))
	}
	// init reaches its deadline while the third dial is refused.
	s.sockets[2] = func(net.Conn, *bufio.Reader) int {
		l.Close()
		return http.StatusBadGateway
	}
	code, log := run(t, s, context.Background(), socket)
	if code != ExitInitGone || s.dials.Load() != 3 || !strings.Contains(log, "no daemon listens") {
		t.Fatalf("exit %d after %d dials, want %d after 3: %s", code, s.dials.Load(), ExitInitGone, log)
	}
}

func TestAStopClosesWith1001AndExits0(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	held := make(chan struct{})
	// Once init's answer came back, the socket is carried: the stop comes then.
	s := &server{t: t, sockets: []func(net.Conn, *bufio.Reader) int{func(conn net.Conn, r *bufio.Reader) int {
		if conn != nil {
			_, _ = conn.Write(serverFrame(true, opText, []byte(`{"id":1}`)))
			if _, err := readClient(r); err != nil {
				t.Error(err)
			}
			close(held)
		}
		return 0
	}}}
	go func() {
		<-held
		cancel()
	}()
	if code, log := run(t, s, ctx, fakeInit(t)); code != ExitStopped {
		t.Fatalf("exit %d: %s", code, log)
	}
	closedBy(t, s, CloseGoingAway)
}

func TestTheRedialDelayDoublesToAMinuteLessUpToAFifth(t *testing.T) {
	for attempt, base := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 32 * time.Second, time.Minute, time.Minute} {
		for range 50 {
			if d := RedialDelay(attempt); d > base || d < base*4/5 {
				t.Fatalf("attempt %d waits %s, outside (%s, %s]", attempt, d, base*4/5, base)
			}
		}
	}
	if d := RedialDelay(1000); d > time.Minute || d < 48*time.Second {
		t.Fatalf("attempt 1000 waits %s", d)
	}
}

func TestFromEnvRefusesAMissingOrMalformedURLOrTokenWithoutSayingIt(t *testing.T) {
	// No token file: an empty AGENTRUN_ATTACH_TOKEN finds none to read.
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	for _, tc := range [][2]string{
		{"", testToken},
		{"https://agentrun.example.com/v2/computers/attach", testToken},
		{"wss://host%zz/v2/computers/attach", testToken},
		{"wss:///v2/computers/attach", testToken},
		{"wss://agentrun.example.com", testToken},
		{"wss://agentrun.example.com/v2/computers/attach", ""},
		{"wss://agentrun.example.com/v2/computers/attach", "art_" + strings.Repeat("A", 64)},
		// 32 bytes in hex: no machine token. A server minted one for a hosted machine before tokens had one shape, and
		// that machine runs the computerd its server served then.
		{"wss://agentrun.example.com/v2/computers/attach", "art_" + strings.Repeat("0f", 32)},
		{"wss://agentrun.example.com/v2/computers/attach", testToken + "\r\nX-Other: 1"},
	} {
		t.Setenv(URLEnv, tc[0])
		t.Setenv(TokenEnv, tc[1])
		_, err := FromEnv("/run/agentrun/computerd.sock", subprotocol, 1<<20)
		if err == nil || (tc[1] != "" && strings.Contains(err.Error(), tc[1])) {
			t.Fatalf("%q: %v", tc, err)
		}
	}
	t.Setenv(URLEnv, "wss://agentrun.example.com/v2/computers/attach")
	t.Setenv(TokenEnv, testToken)
	cfg, err := FromEnv("/run/agentrun/computerd.sock", subprotocol, 1<<20)
	if err != nil || cfg.Heartbeat != 20*time.Second || cfg.Idle != time.Minute || cfg.Steady != time.Minute || cfg.Options.Token != testToken {
		t.Fatalf("%+v, %v", cfg, err)
	}
}

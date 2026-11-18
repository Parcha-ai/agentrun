package attach

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const initHello = `{"protocol":"0.2","version":"0.0.0-dev","os":"linux","kind":"linux","arch":"amd64","groups":["exec","files","processes"]}`

// helloInit listens where init would and answers a hello request with initHello.
func helloInit(t *testing.T) string {
	socket, _ := listenInit(t, func(conn net.Conn) {
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		var req struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
		}
		if err != nil || json.Unmarshal(line, &req) != nil || req.JSONRPC != "2.0" || req.Method != "hello" {
			t.Errorf("init was sent %q (%v); want a hello request", line, err)
			return
		}
		_, _ = conn.Write([]byte(`{"jsonrpc":"2.0","id":` + string(req.ID) + `,"result":` + initHello + "}\n"))
	})
	return socket
}

// pairServer answers POST /v2/computers/pair with answer (a status and a body) and records each body it was sent.
func pairServer(t *testing.T, status int, answer string) (*httptest.Server, *[]map[string]json.RawMessage, *atomic.Int32) {
	var bodies []map[string]json.RawMessage
	var tries atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tries.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/base/v2/computers/pair" || r.Header.Get("Authorization") != "" {
			t.Errorf("the server was sent %s %s with Authorization %q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		var body map[string]json.RawMessage
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Errorf("the pairing's body %q: %v", raw, err)
		}
		bodies = append(bodies, body)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, answer)
	}))
	t.Cleanup(srv.Close)
	return srv, &bodies, &tries
}

// pair sends init's own hello with the code and name, writes the server's token to the file and says the computer's
// id and attach URL, never the token.
func TestPairSendsInitsHelloAndKeepsTheTokenInTheFile(t *testing.T) {
	srv, bodies, _ := pairServer(t, http.StatusCreated, `{"computer":"cmp-8f2k3jq7m4xw9tnb","token":"`+pairedToken+`","runs_refused":null}`)
	path := filepath.Join(t.TempDir(), "agentrun", "computer.token")
	paired, err := Pair(context.Background(), srv.URL+"/base/", "K7PD-W3QX", "build-box", helloInit(t), path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if paired.Computer != "cmp-8f2k3jq7m4xw9tnb" || paired.AttachURL != "ws"+strings.TrimPrefix(srv.URL, "http")+"/base/v2/computers/attach" || paired.TokenFile != path || paired.RunsRefused != "" {
		t.Fatalf("paired %+v", paired)
	}
	if len(*bodies) != 1 || string((*bodies)[0]["code"]) != `"K7PD-W3QX"` || string((*bodies)[0]["name"]) != `"build-box"` || string((*bodies)[0]["hello"]) != initHello {
		t.Fatalf("the server was sent %v", *bodies)
	}
	if token, err := ReadToken(path); err != nil || token != pairedToken {
		t.Fatalf("the token file: %v", err)
	}
	// A machine paired already is refused before anything is sent: a second pairing would burn a code and orphan the
	// computer its file names.
	_, err = Pair(context.Background(), srv.URL+"/base", "K7PD-W3QX", "build-box", helloInit(t), path, 1<<20)
	if err == nil || !strings.Contains(err.Error(), "paired already") || !strings.Contains(err.Error(), "computerd unpair") || len(*bodies) != 1 {
		t.Fatalf("pairing again: %v after %d tries", err, len(*bodies))
	}
}

// A code the server refuses, or a hello of another protocol, is answered in the server's own words, and no file is
// written.
func TestARefusedPairingIsTheServersWordsAndWritesNothing(t *testing.T) {
	for _, tc := range []struct {
		status int
		answer string
		words  string
	}{
		{http.StatusNotFound, `{"error":{"code":"not_found","message":"no such pairing code: make a new one on the console's Computers page"}}`, "404 no such pairing code: make a new one on the console's Computers page"},
		{http.StatusUnprocessableEntity, `{"error":{"code":"input_invalid","message":"box's driver 0.3.0 speaks protocol 0.3, and this server 0.2: update whichever is older","fields":[]}}`, "422 box's driver 0.3.0 speaks protocol 0.3, and this server 0.2"},
		{http.StatusTooManyRequests, `{"error":{"code":"rate_limited","message":"too many pairing tries from this address; try again in 30 s"}}`, "429 too many pairing tries"},
		{http.StatusCreated, `{"computer":"cmp-8f2k3jq7m4xw9tnb"}`, "no computer id and machine token"},
	} {
		srv, _, _ := pairServer(t, tc.status, tc.answer)
		path := filepath.Join(t.TempDir(), "agentrun", "computer.token")
		_, err := Pair(context.Background(), srv.URL+"/base", "K7PD-W3QX", "box", helloInit(t), path, 1<<20)
		if err == nil || !strings.Contains(err.Error(), tc.words) {
			t.Fatalf("%d: %v; want %q", tc.status, err, tc.words)
		}
		if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%d: the token file is there (%v)", tc.status, err)
		}
	}
}

// With no init to answer hello, or a server URL that is not one, nothing is sent.
func TestPairWithNoInitOrABadServerURLSendsNothing(t *testing.T) {
	srv, _, tries := pairServer(t, http.StatusCreated, `{}`)
	path := filepath.Join(t.TempDir(), "computer.token")
	if _, err := Pair(context.Background(), srv.URL+"/base", "K7PD-W3QX", "box", filepath.Join(t.TempDir(), "none.sock"), path, 1<<20); err == nil || !strings.Contains(err.Error(), "start computerd init first") {
		t.Fatalf("no init: %v", err)
	}
	for _, server := range []string{"", "agentrun.example.com", "ftp://agentrun.example.com", "https://", "https://user:pass@agentrun.example.com", "https://agentrun.example.com/?code=K7PD-W3QX"} {
		if _, err := Pair(context.Background(), server, "K7PD-W3QX", "box", helloInit(t), path, 1<<20); err == nil || !strings.Contains(err.Error(), "the server's URL is") {
			t.Fatalf("%q: %v", server, err)
		}
	}
	if tries.Load() != 0 {
		t.Fatalf("the server was sent %d pairings", tries.Load())
	}
}

// A paired machine whose token the server refuses (its owner removed it) says which file to delete, and the token
// never.
func TestARefusedTokenFromTheFileSaysWhichFileToDelete(t *testing.T) {
	for _, socket := range []func(net.Conn, *bufio.Reader) int{refuse(http.StatusUnauthorized), greetThenClose(t, CloseUnauthorized)} {
		s := &server{t: t, sockets: []func(net.Conn, *bufio.Reader) int{socket}}
		srv := s.start()
		out := &lines{}
		cfg := Config{URL: wsURL(srv), Token: pairedToken, TokenFile: "/home/box/.config/agentrun/computer.token", Socket: fakeInit(t), Steady: time.Minute, Delay: RedialDelay}
		cfg.Options = testOptions()
		cfg.Options.Token, cfg.MaxMessage = pairedToken, 1<<20
		code := Run(context.Background(), cfg, log.New(out, "computerd: ", log.LstdFlags))
		out.mu.Lock()
		said := out.b.String()
		out.mu.Unlock()
		if code != ExitUnauthorized || !strings.Contains(said, "this machine's pairing was removed or revoked: delete /home/box/.config/agentrun/computer.token and pair again") || strings.Contains(said, pairedToken) {
			t.Fatalf("exit %d: %s", code, said)
		}
	}
}

package attach

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
)

// pairFor bounds init's hello and the server's answer each.
const pairFor = 30 * time.Second

// Paired is what a pairing gives: the computer's id on the server, the attach URL to dial, and the token's file.
type Paired struct {
	Computer, AttachURL, TokenFile string
	// RunsRefused is the server's words when no run there can use a paired computer (its runner runs apart), else empty.
	RunsRefused string
}

// Pair trades a pairing code for this machine's token (spec/computer/attach.md "Pairing: bring your own machine"):
// init's own hello, from the socket attach bridges, goes with the code and the name to server's POST
// /v2/computers/pair, and the token comes back into tokenFile (WriteToken). A machine whose token file is there already
// is refused before anything is sent. A refused code or hello is the server's own words, and nothing is written. The
// token is in no error or answer it gives but the file.
func Pair(ctx context.Context, server, code, name, socket, tokenFile string, maxLine int) (Paired, error) {
	pairURL, attachURL, err := serverURLs(server)
	if err != nil {
		return Paired{}, err
	}
	// One pairing at a time from the check to the write: two at once would each make a computer, and the later rename
	// would replace the other's token.
	unlock, err := lockTokenDir(tokenFile)
	if err != nil {
		return Paired{}, err
	}
	defer unlock()
	if _, err := os.Lstat(tokenFile); err == nil {
		return Paired{}, fmt.Errorf("this machine is paired already: its token is at %s; to pair it again, run computerd unpair first", tokenFile)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Paired{}, fmt.Errorf("cannot read the token file %s: %w", tokenFile, err)
	}
	hello, err := helloOf(socket, maxLine)
	if err != nil {
		return Paired{}, err
	}
	body, err := json.Marshal(struct {
		Code  string          `json:"code"`
		Name  string          `json:"name"`
		Hello json.RawMessage `json:"hello"`
	}{code, name, hello})
	if err != nil {
		return Paired{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, pairFor)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, pairURL, bytes.NewReader(body))
	if err != nil {
		return Paired{}, err
	}
	req.Header.Set("content-type", "application/json")
	// No redirect is followed: one would resend the code, perhaps over plain http or to another host.
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return Paired{}, fmt.Errorf("cannot reach %s: %w", pairURL, err)
	}
	defer res.Body.Close()
	if res.StatusCode/100 == 3 {
		return Paired{}, fmt.Errorf("the server answered the pairing %d, a redirect to %q, which pair doesn't follow: pair with the server's own URL", res.StatusCode, res.Header.Get("Location"))
	}
	answer, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return Paired{}, fmt.Errorf("the server's answer to the pairing: %w", err)
	}
	if res.StatusCode/100 != 2 {
		var refused struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		words := strings.TrimSpace(string(answer[:min(len(answer), 512)]))
		if json.Unmarshal(answer, &refused) == nil && refused.Error.Message != "" {
			words = refused.Error.Message
		}
		return Paired{}, fmt.Errorf("the server refused the pairing: %d %s", res.StatusCode, words)
	}
	var paired struct {
		Computer    string  `json:"computer"`
		Token       string  `json:"token"`
		RunsRefused *string `json:"runs_refused"`
	}
	if err := json.Unmarshal(answer, &paired); err != nil || paired.Computer == "" || !tokenPattern.MatchString(paired.Token) {
		return Paired{}, fmt.Errorf("the server answered the pairing %d with no computer id and machine token: is %s an AgentRun server?", res.StatusCode, server)
	}
	if err := WriteToken(tokenFile, paired.Token); err != nil {
		return Paired{}, fmt.Errorf("paired as %s, but %w: remove %s on the console's Computers page and pair again", paired.Computer, err, paired.Computer)
	}
	out := Paired{Computer: paired.Computer, AttachURL: attachURL, TokenFile: tokenFile}
	if paired.RunsRefused != nil {
		out.RunsRefused = *paired.RunsRefused
	}
	return out, nil
}

// serverURLs gives the pair route and the attach socket of a server's URL, https:// and a host (http:// only on this
// machine's loopback, since the code and the token cross it), with any path it is served under.
func serverURLs(server string) (string, string, error) {
	u, err := url.Parse(server)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", "", fmt.Errorf("the server's URL is https:// and its host, such as https://agentrun.example.com, not %q", server)
	}
	if u.Scheme == "http" && !loopback(u.Hostname()) {
		return "", "", fmt.Errorf("the server's URL is https://, not %q: the pairing code and the machine's token would cross the network in the clear (http:// is for a server on this machine's loopback)", server)
	}
	base := strings.TrimSuffix(u.EscapedPath(), "/")
	ws := map[string]string{"http": "ws", "https": "wss"}[u.Scheme]
	return u.Scheme + "://" + u.Host + base + "/v2/computers/pair", ws + "://" + u.Host + base + "/v2/computers/attach", nil
}

// loopback is a host name that stays on this machine: localhost or a loopback address.
func loopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// helloOf is init's answer to hello at socket: the hello attach's socket gives the server, as the pairing records it.
func helloOf(socket string, maxLine int) (json.RawMessage, error) {
	conn, err := daemon.Dial(socket)
	if err != nil {
		return nil, fmt.Errorf("no daemon listens at %s (%v): start computerd init first, with %s naming the socket attach will use", socket, err, daemon.SocketEnv)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(pairFor))
	if _, err := io.WriteString(conn, `{"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"computerd pair"}}`+"\n"); err != nil {
		return nil, fmt.Errorf("asking the daemon at %s for its hello: %w", socket, err)
	}
	line, err := bufio.NewReaderSize(conn, maxLine).ReadSlice('\n')
	if err != nil {
		return nil, fmt.Errorf("the daemon at %s did not answer hello: %w", socket, err)
	}
	var reply struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(line, &reply); err != nil || (reply.Error == nil && len(reply.Result) == 0) {
		return nil, fmt.Errorf("the daemon at %s answered hello with no result", socket)
	}
	if reply.Error != nil {
		return nil, fmt.Errorf("the daemon at %s refused hello: %s", socket, reply.Error.Message)
	}
	return reply.Result, nil
}

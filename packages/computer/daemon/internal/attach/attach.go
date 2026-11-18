// Package attach is `computerd attach`: a machine that cannot be reached dials the server's attach socket
// (spec/computer/attach.md) and carries each socket to init's, as `computerd stdio` carries its stdin and stdout, a
// message a line. websocket.go is the client side of RFC 6455 that needs, from the standard library alone.
package attach

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/url"
	"os"
	"regexp"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/daemon"
)

// The environment `computerd attach` reads: the attach socket's URL and the machine's token.
const (
	URLEnv   = "AGENTRUN_ATTACH_URL"
	TokenEnv = "AGENTRUN_ATTACH_TOKEN"
)

// The exit codes of `computerd attach`.
const (
	ExitStopped      = 0 // SIGTERM or SIGINT: the socket closed with 1001
	ExitInitGone     = 1 // init's socket is gone or closed
	ExitUsage        = 2 // no URL or token, or a malformed one
	ExitUnauthorized = 3 // the server refused the token: 401 at the upgrade, or 4401
	ExitMismatch     = 4 // the machine's hello is not what its token was minted for: 4400
	ExitVersion      = 5 // another protocol version, or a hello its kind does not serve: 426 at the upgrade, or 4426
)

// A machine's token: a hosted machine's minted one (art_ and 64 hex) or a paired computer's (art_ and 43 base64url).
var tokenPattern = regexp.MustCompile(`^art_(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43})$`)

// Config is what attach runs by: the server, init's socket, and the numbers of attach.md.
type Config struct {
	URL, Token, Socket string
	// TokenFile is the file the token was read from (TokenPath); empty when it came from TokenEnv.
	TokenFile string
	Options
	// Steady is how long a socket stays up before the redial count starts again.
	Steady time.Duration
	// Delay is the wait before redial number attempt, from 0.
	Delay func(attempt int) time.Duration
}

// FromEnv reads the URL and the token, TokenEnv's or else the file pair wrote (ReadToken, at TokenPath), and gives
// attach.md's numbers; an error says what is wrong in words that never hold the token.
func FromEnv(socket, subprotocol string, maxMessage int) (Config, error) {
	cfg := Config{URL: os.Getenv(URLEnv), Token: os.Getenv(TokenEnv), Socket: socket, Steady: time.Minute, Delay: RedialDelay}
	if u, err := url.Parse(cfg.URL); err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Hostname() == "" || u.Path == "" {
		return cfg, fmt.Errorf("%s is the server's attach socket, such as wss://agentrun.example.com/v2/computers/attach", URLEnv)
	}
	if cfg.Token == "" {
		path, err := TokenPath()
		if err == nil {
			cfg.Token, err = ReadToken(path)
		}
		if err != nil {
			return cfg, fmt.Errorf("%s is empty, so attach reads the token pair wrote: %w", TokenEnv, err)
		}
		cfg.TokenFile = path
	}
	if !tokenPattern.MatchString(cfg.Token) {
		return cfg, fmt.Errorf("%s is the machine's token, art_ and 64 lowercase hex (a hosted machine's) or 43 base64url (a paired computer's)", TokenEnv)
	}
	cfg.Options = Options{Token: cfg.Token, Subprotocol: subprotocol, MaxMessage: maxMessage, Heartbeat: 20 * time.Second, Idle: time.Minute}
	return cfg, nil
}

// RedialDelay is attach.md's redialDelay: 1 s doubling to 60 s, less up to a fifth at random.
func RedialDelay(attempt int) time.Duration {
	base := min(time.Minute, time.Second<<min(attempt, 16))
	return base - rand.N(base/5)
}

// Run dials until the server says stop, ctx ends or init is gone, and gives the exit code. The token goes in the
// upgrade alone: no line logger writes holds it.
func Run(ctx context.Context, cfg Config, logger *log.Logger) int {
	for attempt := 0; ; attempt++ {
		code, why, up := once(ctx, cfg, logger)
		if code >= 0 {
			return code
		}
		if up >= cfg.Steady {
			attempt = 0
		}
		wait := cfg.Delay(attempt)
		logger.Printf("attach: %s; dialing %s again in %s", why, cfg.URL, wait.Round(time.Millisecond))
		select {
		case <-ctx.Done():
			return ExitStopped
		case <-time.After(wait):
		}
	}
}

const (
	stopping   = "the machine's attach is stopping"
	tokenWords = "its token is unknown, revoked or past its end"
)

// once connects to init, dials one socket and carries it to init until either ends. It gives an exit code when attach
// ends here; else -1, why the socket ended or never opened, and how long it was up.
func once(ctx context.Context, cfg Config, logger *log.Logger) (int, string, time.Duration) {
	// init first, each time: once init has ended (at its deadline) the machine stops dialing and ends with it, whether
	// the server answers or not.
	initConn, err := daemon.Dial(cfg.Socket)
	if err != nil {
		logger.Printf("attach: no daemon listens at %s (%v): init has ended or never started, so the machine stops dialing", cfg.Socket, err)
		return ExitInitGone, "", 0
	}
	defer initConn.Close()
	conn, err := Dial(ctx, cfg.URL, cfg.Options)
	var refused *Refused
	switch {
	case ctx.Err() != nil:
		if conn != nil {
			conn.Close(CloseGoingAway, stopping)
		}
		return ExitStopped, "", 0
	case errors.As(err, &refused) && refused.Status == 401:
		return stop(logger, ExitUnauthorized, err.Error(), unauthorized(cfg)), "", 0
	case errors.As(err, &refused) && refused.Status == 426:
		return stop(logger, ExitVersion, err.Error(), "it speaks another protocol version"), "", 0
	case err != nil:
		return -1, err.Error(), 0
	}
	logger.Printf("attach: attached to %s", cfg.URL)
	up := time.Now()
	defer context.AfterFunc(ctx, func() { conn.Close(CloseGoingAway, stopping) })()
	daemon.Carry(initConn, conn, conn)
	// The socket ended first (Carry's input ended), or as the daemon closed: either way the machine dials again.
	closed := conn.Ended()
	switch {
	case ctx.Err() != nil:
		return ExitStopped, "", 0
	case closed == nil:
		conn.Close(CloseInternal, "the machine's daemon is gone")
		logger.Printf("attach: the daemon at %s closed the connection, so the machine stops dialing", cfg.Socket)
		return ExitInitGone, "", 0
	case closed.Code == CloseUnauthorized:
		return stop(logger, ExitUnauthorized, closed.Error(), unauthorized(cfg)), "", 0
	case closed.Code == CloseMismatch:
		return stop(logger, ExitMismatch, closed.Error(), "its hello is not the kind, os or arch its token was minted for"), "", 0
	case closed.Code == CloseVersion:
		return stop(logger, ExitVersion, closed.Error(), "it speaks another protocol version, or lacks a group its kind needs"), "", 0
	}
	return -1, closed.Error(), time.Since(up)
}

// unauthorized is what a refused token means: a paired machine's (read from its token file) was removed or revoked,
// and its file is what to delete before pairing again.
func unauthorized(cfg Config) string {
	if cfg.TokenFile != "" {
		return fmt.Sprintf("this machine's pairing was removed or revoked: delete %s and pair again", cfg.TokenFile)
	}
	return tokenWords
}

func stop(logger *log.Logger, code int, why, meaning string) int {
	logger.Printf("attach: %s: %s, so the machine stops dialing", why, meaning)
	return code
}

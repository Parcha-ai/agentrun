// Package attach is `computerd attach`: a machine that cannot be reached dials the server's attach socket
// (spec/computer/attach.md) and carries each socket to init's, as `computerd stdio` carries its stdin and stdout, a
// message a line. websocket.go is the client side of RFC 6455 that needs, from the standard library alone.
package attach

import (
	"context"
	"fmt"
	"log"
	"math/rand/v2"
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

var (
	urlPattern   = regexp.MustCompile(`^wss?://[^/?#\s]+/`)
	tokenPattern = regexp.MustCompile(`^art_[0-9a-f]{64}$`)
)

// Config is what attach runs by: the server, init's socket, and the numbers of attach.md.
type Config struct {
	URL, Token, Socket string
	Options
	// Steady is how long a socket stays up before the redial count starts again.
	Steady time.Duration
	// Delay is the wait before redial number attempt, from 0.
	Delay func(attempt int) time.Duration
}

// FromEnv reads the URL and token, and gives attach.md's numbers; an error says what is wrong in words that never hold
// the token.
func FromEnv(socket, subprotocol string, maxMessage int) (Config, error) {
	cfg := Config{URL: os.Getenv(URLEnv), Token: os.Getenv(TokenEnv), Socket: socket, Steady: time.Minute, Delay: RedialDelay}
	cfg.Options = Options{Token: cfg.Token, Subprotocol: subprotocol, MaxMessage: maxMessage, Heartbeat: 20 * time.Second, Idle: time.Minute}
	if !urlPattern.MatchString(cfg.URL) {
		return cfg, fmt.Errorf("%s is the server's attach socket, such as wss://agentrun.example.com/v2/computers/attach", URLEnv)
	}
	if !tokenPattern.MatchString(cfg.Token) {
		return cfg, fmt.Errorf("%s is the machine's token, art_ and 64 lowercase hex", TokenEnv)
	}
	return cfg, nil
}

// RedialDelay is attach.md's redialDelay: 1 s doubling to 60 s, less up to a fifth at random.
func RedialDelay(attempt int) time.Duration {
	base := min(time.Minute, time.Second<<min(attempt, 16))
	return base - rand.N(base/5)
}

// Run dials until the server says stop, ctx ends or init's socket is gone, and gives the exit code. The token goes in
// the upgrade alone: no line logger writes holds it.
func Run(ctx context.Context, cfg Config, logger *log.Logger) int {
	for attempt := 0; ; attempt++ {
		conn, err := Dial(ctx, cfg.URL, cfg.Options)
		var why string
		if refused, ok := err.(*Refused); ok {
			why = fmt.Sprintf("the upgrade was refused %d (%s)", refused.Status, refused.Words)
			switch refused.Status {
			case 401:
				return stop(logger, ExitUnauthorized, why, "its token is unknown, revoked or past its end")
			case 426:
				return stop(logger, ExitVersion, why, "it speaks another protocol version")
			}
		} else if err != nil {
			why = err.Error()
		}
		if ctx.Err() != nil {
			if conn != nil {
				conn.Close(CloseGoingAway, "the machine's attach is stopping")
			}
			return ExitStopped
		}
		if conn != nil {
			logger.Printf("attach: attached to %s", cfg.URL)
			up := time.Now()
			code, closed := carry(ctx, conn, cfg.Socket, logger)
			if code >= 0 {
				return code
			}
			if time.Since(up) >= cfg.Steady {
				attempt = 0
			}
			switch closed.Code {
			case CloseUnauthorized:
				return stop(logger, ExitUnauthorized, closed.Error(), "its token is unknown, revoked or past its end")
			case CloseMismatch:
				return stop(logger, ExitMismatch, closed.Error(), "its hello is not the kind, os or arch its token was minted for")
			case CloseVersion:
				return stop(logger, ExitVersion, closed.Error(), "it speaks another protocol version, or lacks a group its kind needs")
			}
			why = closed.Error()
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

// carry bridges one socket to a connection of init's until either ends: -1 and how the socket ended, or an exit code
// when attach ends here (ctx done, init gone).
func carry(ctx context.Context, conn *Conn, socket string, logger *log.Logger) (int, *Closed) {
	defer context.AfterFunc(ctx, func() { conn.Close(CloseGoingAway, "the machine's attach is stopping") })()
	initConn, err := daemon.Dial(socket)
	if err != nil {
		conn.Close(CloseInternal, "the machine's daemon is gone")
		logger.Printf("attach: no daemon listens at %s (%v); the machine's first process must be `computerd init`", socket, err)
		return ExitInitGone, nil
	}
	defer initConn.Close()
	daemon.Carry(initConn, conn, conn)
	if ctx.Err() != nil {
		return ExitStopped, nil
	}
	// The socket ended first (Carry's input), or as the daemon closed: either way the machine dials again.
	if closed := conn.Ended(); closed != nil {
		return -1, closed
	}
	conn.Close(CloseInternal, "the machine's daemon is gone")
	logger.Printf("attach: the daemon at %s closed the connection", socket)
	return ExitInitGone, nil
}

func stop(logger *log.Logger, code int, why, meaning string) int {
	logger.Printf("attach: %s: %s, so the machine stops dialing", why, meaning)
	return code
}

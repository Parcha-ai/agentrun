package rpc_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

type reply struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Kind string `json:"kind"`
		} `json:"data"`
	} `json:"error"`
}

type conn struct {
	t     *testing.T
	in    *io.PipeWriter
	lines chan []byte
	done  chan error
}

func start(t *testing.T, handlers map[string]rpc.Handler) *conn {
	t.Helper()
	cr, cw := io.Pipe()
	sr, sw := io.Pipe()
	server := rpc.NewServer(handlers, log.New(io.Discard, "", 0))
	c := &conn{t: t, in: cw, lines: make(chan []byte, 64), done: make(chan error, 1)}
	go func() {
		err := server.Serve(context.Background(), cr, sw)
		_ = cr.CloseWithError(fmt.Errorf("the server stopped reading (Serve returned %v)", err))
		_ = sw.Close()
		c.done <- err
	}()
	go func() {
		scanner := bufio.NewScanner(sr)
		scanner.Buffer(make([]byte, 0, 64<<10), 4<<20)
		for scanner.Scan() {
			c.lines <- append([]byte(nil), scanner.Bytes()...)
		}
		close(c.lines)
	}()
	t.Cleanup(func() { _ = cw.Close() })
	return c
}

func (c *conn) send(text string) {
	c.t.Helper()
	if _, err := c.in.Write([]byte(text)); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *conn) next() reply {
	c.t.Helper()
	select {
	case line, ok := <-c.lines:
		if !ok {
			var err error
			select {
			case err = <-c.done:
			default:
			}
			c.t.Fatalf("the server closed its output (Serve returned %v)", err)
		}
		var r reply
		if err := json.Unmarshal(line, &r); err != nil {
			c.t.Fatalf("reply is not JSON: %q", line)
		}
		return r
	case <-time.After(5 * time.Second):
		c.t.Fatal("no reply within 5 s")
	}
	return reply{}
}

func ping(context.Context, json.RawMessage) (any, error) { return struct{}{}, nil }

func TestSplitAndJoinedLines(t *testing.T) {
	c := start(t, map[string]rpc.Handler{"ping": ping})
	c.send(`{"jsonrpc":"2.0","id":1,"method":"ping"}` + "\n" + `{"jsonrpc":"2.0","id":2,"method":"ping"}` + "\n")
	c.send(`{"jsonrpc":"2.0",`)
	time.Sleep(20 * time.Millisecond)
	c.send(`"id":3,"meth`)
	time.Sleep(20 * time.Millisecond)
	c.send(`od":"ping"}` + "\r\n")
	seen := map[string]bool{}
	for range 3 {
		r := c.next()
		if r.Error != nil || string(r.Result) != "{}" {
			t.Fatalf("unexpected reply %+v", r)
		}
		seen[string(r.ID)] = true
	}
	for _, id := range []string{"1", "2", "3"} {
		if !seen[id] {
			t.Fatalf("no reply for id %s: %v", id, seen)
		}
	}
}

func TestOversizedLineGetsAnErrorAndTheConnectionContinues(t *testing.T) {
	c := start(t, map[string]rpc.Handler{"ping": ping})
	big := strings.Repeat("x", rpc.MaxLine+10)
	c.send(`{"jsonrpc":"2.0","id":7,"method":"ping","params":{"s":"` + big + `"}}` + "\n")
	c.send(`{"jsonrpc":"2.0","id":8,"method":"ping"}` + "\n")
	r := c.next()
	if string(r.ID) != "7" || r.Error == nil || r.Error.Code != rpc.CodeInvalidRequest || r.Error.Data.Kind != "limit" {
		t.Fatalf("want a limit error for id 7, got %+v", r)
	}
	if r := c.next(); string(r.ID) != "8" || r.Error != nil {
		t.Fatalf("want ping 8 answered, got %+v", r)
	}
}

func TestBadJSON(t *testing.T) {
	c := start(t, map[string]rpc.Handler{"ping": ping})
	c.send("{not json\n")
	r := c.next()
	if string(r.ID) != "null" || r.Error == nil || r.Error.Code != rpc.CodeParse || r.Error.Data.Kind != "invalid" {
		t.Fatalf("want a parse error with id null, got %+v", r)
	}
	c.send(`{"jsonrpc":"2.0","id":"after","method":"ping"}` + "\n")
	if r := c.next(); string(r.ID) != `"after"` || r.Error != nil {
		t.Fatalf("want ping answered after bad JSON, got %+v", r)
	}
}

func TestUnknownMethodAndInvalidRequest(t *testing.T) {
	c := start(t, map[string]rpc.Handler{"ping": ping})
	c.send(`{"jsonrpc":"2.0","id":1,"method":"nope"}` + "\n")
	r := c.next()
	if r.Error == nil || r.Error.Code != rpc.CodeMethodNotFound || r.Error.Data.Kind != "unsupported" {
		t.Fatalf("want method not found, got %+v", r)
	}
	c.send(`{"id":2,"method":"ping"}` + "\n")
	r = c.next()
	if string(r.ID) != "2" || r.Error == nil || r.Error.Code != rpc.CodeInvalidRequest {
		t.Fatalf("want invalid request without jsonrpc 2.0, got %+v", r)
	}
}

func TestNotificationsGetNoReply(t *testing.T) {
	c := start(t, map[string]rpc.Handler{"ping": ping})
	c.send(`{"jsonrpc":"2.0","method":"ping"}` + "\n")
	c.send(`{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":99}}` + "\n")
	c.send(`{"jsonrpc":"2.0","id":1,"method":"ping"}` + "\n")
	if r := c.next(); string(r.ID) != "1" {
		t.Fatalf("want only the request answered, got %+v", r)
	}
}

func TestRequestsRunConcurrently(t *testing.T) {
	release := make(chan struct{})
	c := start(t, map[string]rpc.Handler{
		"ping": ping,
		"slow": func(ctx context.Context, _ json.RawMessage) (any, error) {
			<-release
			return "slow", nil
		},
	})
	c.send(`{"jsonrpc":"2.0","id":1,"method":"slow"}` + "\n")
	c.send(`{"jsonrpc":"2.0","id":2,"method":"ping"}` + "\n")
	if r := c.next(); string(r.ID) != "2" {
		t.Fatalf("want ping first while slow runs, got %+v", r)
	}
	close(release)
	if r := c.next(); string(r.ID) != "1" || string(r.Result) != `"slow"` {
		t.Fatalf("want slow after release, got %+v", r)
	}
}

func TestCancelRequest(t *testing.T) {
	c := start(t, map[string]rpc.Handler{
		"wait": func(ctx context.Context, _ json.RawMessage) (any, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	})
	c.send(`{"jsonrpc":"2.0","id":"w1","method":"wait"}` + "\n")
	time.Sleep(50 * time.Millisecond)
	c.send(`{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"w1"}}` + "\n")
	r := c.next()
	if string(r.ID) != `"w1"` || r.Error == nil || r.Error.Code != rpc.CodeRequestCancelled || r.Error.Data.Kind != "aborted" {
		t.Fatalf("want aborted, got %+v", r)
	}
}

func TestEndOfInputCancelsWhatRuns(t *testing.T) {
	cancelled := make(chan struct{})
	c := start(t, map[string]rpc.Handler{
		"wait": func(ctx context.Context, _ json.RawMessage) (any, error) {
			<-ctx.Done()
			close(cancelled)
			return nil, ctx.Err()
		},
	})
	c.send(`{"jsonrpc":"2.0","id":1,"method":"wait"}` + "\n")
	time.Sleep(50 * time.Millisecond)
	_ = c.in.Close()
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the handler was not cancelled when the input ended")
	}
	select {
	case err := <-c.done:
		if err != nil {
			t.Fatalf("Serve returned %v at end of input", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return at end of input")
	}
}

func TestOversizedReplyBecomesALimitError(t *testing.T) {
	c := start(t, map[string]rpc.Handler{
		"big": func(context.Context, json.RawMessage) (any, error) { return strings.Repeat("y", rpc.MaxLine), nil },
	})
	c.send(`{"jsonrpc":"2.0","id":1,"method":"big"}` + "\n")
	if r := c.next(); r.Error == nil || r.Error.Data.Kind != "limit" {
		t.Fatalf("want a limit error, got %+v", r)
	}
}

func TestHandlerErrorsKeepTheirKind(t *testing.T) {
	c := start(t, map[string]rpc.Handler{
		"denied": func(context.Context, json.RawMessage) (any, error) {
			return nil, rpc.Errorf(rpc.KindDenied, "no")
		},
		"plain": func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("boom") },
	})
	c.send(`{"jsonrpc":"2.0","id":1,"method":"denied"}` + "\n")
	if r := c.next(); r.Error == nil || r.Error.Data.Kind != "denied" || r.Error.Message != "no" {
		t.Fatalf("want denied, got %+v", r)
	}
	c.send(`{"jsonrpc":"2.0","id":2,"method":"plain"}` + "\n")
	if r := c.next(); r.Error == nil || r.Error.Code != rpc.CodeServer || r.Error.Message != "boom" {
		t.Fatalf("want a server error, got %+v", r)
	}
}

func TestNotificationsLeaveBeforeTheReplyAndNameTheRequest(t *testing.T) {
	c := start(t, map[string]rpc.Handler{
		"count": func(ctx context.Context, _ json.RawMessage) (any, error) {
			for i := range 3 {
				if err := rpc.Notify(ctx, "count.tick", map[string]any{"request": rpc.RequestID(ctx), "n": i}); err != nil {
					return nil, err
				}
			}
			return "done", nil
		},
	})
	c.send(`{"jsonrpc":"2.0","id":"c1","method":"count"}` + "\n")
	for i := range 3 {
		line := <-c.lines
		var note struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
			Params  struct {
				Request json.RawMessage `json:"request"`
				N       int             `json:"n"`
			} `json:"params"`
		}
		if err := json.Unmarshal(line, &note); err != nil || note.JSONRPC != "2.0" || note.ID != nil || note.Method != "count.tick" || string(note.Params.Request) != `"c1"` || note.Params.N != i {
			t.Fatalf("want notification %d for c1, got %s", i, line)
		}
	}
	if r := c.next(); string(r.ID) != `"c1"` || string(r.Result) != `"done"` {
		t.Fatalf("want the reply after the notifications, got %+v", r)
	}
}

func TestANotificationOverTheLineLimitIsRefused(t *testing.T) {
	c := start(t, map[string]rpc.Handler{
		"big": func(ctx context.Context, _ json.RawMessage) (any, error) {
			return nil, rpc.Notify(ctx, "big.data", strings.Repeat("z", rpc.MaxLine))
		},
	})
	c.send(`{"jsonrpc":"2.0","id":1,"method":"big"}` + "\n")
	if r := c.next(); string(r.ID) != "1" || r.Error == nil || r.Error.Data.Kind != "limit" {
		t.Fatalf("want a limit error and no notification, got %+v", r)
	}
}

type closer struct{ closed chan struct{} }

func (c *closer) Close() error { close(c.closed); return nil }

func TestLocalValuesAreKeptPerConnectionAndClosedAtItsEnd(t *testing.T) {
	made := make(chan *closer, 4)
	c := start(t, map[string]rpc.Handler{
		"local": func(ctx context.Context, _ json.RawMessage) (any, error) {
			value := rpc.Local(ctx, "k", func() io.Closer {
				v := &closer{closed: make(chan struct{})}
				made <- v
				return v
			})
			return fmt.Sprintf("%p", value), nil
		},
	})
	c.send(`{"jsonrpc":"2.0","id":1,"method":"local"}` + "\n")
	first := c.next()
	c.send(`{"jsonrpc":"2.0","id":2,"method":"local"}` + "\n")
	second := c.next()
	if first.Error != nil || string(first.Result) != string(second.Result) || len(made) != 1 {
		t.Fatalf("want one value for the connection, got %s and %s (%d made)", first.Result, second.Result, len(made))
	}
	value := <-made
	select {
	case <-value.closed:
		t.Fatal("the value was closed while the connection is open")
	default:
	}
	_ = c.in.Close()
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return at end of input")
	}
	select {
	case <-value.closed:
	default:
		t.Fatal("Serve returned before closing the connection's value")
	}
}

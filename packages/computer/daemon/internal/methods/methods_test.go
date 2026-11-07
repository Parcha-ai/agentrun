package methods_test

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/methods"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

type reply struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Kind string `json:"kind"`
		} `json:"data"`
	} `json:"error"`
}

// call sends one request to a fresh daemon over pipes and returns its reply.
func call(t *testing.T, line string) reply {
	t.Helper()
	cr, cw := io.Pipe()
	sr, sw := io.Pipe()
	server := rpc.NewServer(methods.Handlers("0.0.0-test", process.NewTable(process.Options{})), log.New(io.Discard, "", 0))
	go func() {
		_ = server.Serve(context.Background(), cr, sw)
		_ = cr.Close()
		_ = sw.Close()
	}()
	t.Cleanup(func() { _ = cw.Close() })
	go func() { _, _ = cw.Write([]byte(line + "\n")) }()
	got := make(chan []byte, 1)
	go func() {
		scanner := bufio.NewScanner(sr)
		scanner.Buffer(make([]byte, 0, 64<<10), 2<<20)
		if scanner.Scan() {
			got <- append([]byte(nil), scanner.Bytes()...)
		}
		close(got)
	}()
	select {
	case data, ok := <-got:
		if !ok {
			t.Fatalf("the daemon closed its output without a reply to %s", line)
		}
		var r reply
		if err := json.Unmarshal(data, &r); err != nil {
			t.Fatalf("reply is not JSON: %q", data)
		}
		return r
	case <-time.After(10 * time.Second):
		t.Fatalf("no reply to %s", line)
	}
	return reply{}
}

func TestHello(t *testing.T) {
	r := call(t, `{"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"test"}}`)
	var hello methods.HelloResult
	if r.Error != nil || json.Unmarshal(r.Result, &hello) != nil {
		t.Fatalf("hello failed: %+v", r)
	}
	if hello.Version != "0.0.0-test" || hello.OS != "linux" || hello.Kind != "linux" || hello.Arch != runtime.GOARCH || strings.Join(hello.Groups, ",") != "exec,files,processes" {
		t.Fatalf("hello %+v", hello)
	}
	// The protocol's hello has exactly these fields: capabilities is now groups, and kind is new.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(r.Result, &fields); err != nil {
		t.Fatal(err)
	}
	var names []string
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "arch,groups,kind,os,version" {
		t.Fatalf("hello's fields %v", names)
	}
}

func TestDeadlineExtendIsNotAnsweredYet(t *testing.T) {
	// deadline.extend is typed in protocol.ts; init answers it from the X11 shim's PR on. Until then it is unsupported.
	r := call(t, `{"jsonrpc":"2.0","id":1,"method":"deadline.extend","params":{"at":"2030-01-01T00:00:00.000Z"}}`)
	if r.Error == nil || r.Error.Code != -32601 {
		t.Fatalf("deadline.extend %+v", r)
	}
}

func TestPing(t *testing.T) {
	if r := call(t, `{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}`); r.Error != nil || string(r.Result) != "{}" {
		t.Fatalf("ping %+v", r)
	}
}

func TestExecRunOverTheWire(t *testing.T) {
	r := call(t, `{"jsonrpc":"2.0","id":2,"method":"exec.run","params":{"argv":["sh","-c","printf hi; printf oops >&2; exit 4"],"timeoutMs":5000}}`)
	var res struct {
		ExitCode  *int    `json:"exitCode"`
		Signal    *string `json:"signal"`
		Stdout    string  `json:"stdout"`
		Stderr    string  `json:"stderr"`
		TimedOut  bool    `json:"timedOut"`
		Truncated bool    `json:"truncated"`
	}
	if r.Error != nil || json.Unmarshal(r.Result, &res) != nil {
		t.Fatalf("exec.run failed: %+v", r)
	}
	out, _ := base64.StdEncoding.DecodeString(res.Stdout)
	errOut, _ := base64.StdEncoding.DecodeString(res.Stderr)
	if res.ExitCode == nil || *res.ExitCode != 4 || res.Signal != nil || string(out) != "hi" || string(errOut) != "oops" || res.TimedOut || res.Truncated {
		t.Fatalf("exec.run result %s", r.Result)
	}
}

func TestExecRunEmptyOutputIsAnEmptyString(t *testing.T) {
	r := call(t, `{"jsonrpc":"2.0","id":3,"method":"exec.run","params":{"argv":["true"],"timeoutMs":5000}}`)
	var res map[string]any
	if r.Error != nil || json.Unmarshal(r.Result, &res) != nil || res["stdout"] != "" || res["stderr"] != "" || res["exitCode"] != float64(0) {
		t.Fatalf("exec.run result %s %+v", r.Result, r.Error)
	}
}

func TestExecRunRefusesBadParams(t *testing.T) {
	for name, params := range map[string]string{
		"no argv":            `{"timeoutMs":1000}`,
		"empty argv":         `{"argv":[],"timeoutMs":1000}`,
		"no timeout":         `{"argv":["true"]}`,
		"zero timeout":       `{"argv":["true"],"timeoutMs":0}`,
		"unknown field":      `{"argv":["true"],"timeoutMs":1000,"shell":true}`,
		"maxOutput too big":  `{"argv":["true"],"timeoutMs":1000,"maxOutput":99999999}`,
		"maxOutput negative": `{"argv":["true"],"timeoutMs":1000,"maxOutput":-1}`,
		"argv not strings":   `{"argv":"true","timeoutMs":1000}`,
	} {
		r := call(t, `{"jsonrpc":"2.0","id":4,"method":"exec.run","params":`+params+`}`)
		if r.Error == nil || r.Error.Code != rpc.CodeInvalidParams || r.Error.Data.Kind != "invalid" {
			t.Errorf("%s: want invalid params, got %+v", name, r)
		}
	}
}

func TestExecRunNamesTheSignalWithoutSIG(t *testing.T) {
	r := call(t, `{"jsonrpc":"2.0","id":5,"method":"exec.run","params":{"argv":["sh","-c","kill -KILL $$"],"timeoutMs":5000}}`)
	var res map[string]any
	if r.Error != nil || json.Unmarshal(r.Result, &res) != nil || res["signal"] != "KILL" || res["exitCode"] != nil {
		t.Fatalf("exec.run result %s %+v", r.Result, r.Error)
	}
}

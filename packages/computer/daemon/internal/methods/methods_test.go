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

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/desktop"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/lifetime"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/methods"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/x11/x11fake"
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
	return callWith(t, methods.Options{}, line)
}

// callWith is call to a daemon with options: its display and its deadline.
func callWith(t *testing.T, options methods.Options, line string) reply {
	t.Helper()
	cr, cw := io.Pipe()
	sr, sw := io.Pipe()
	server := rpc.NewServer(methods.Handlers("0.0.0-test", process.NewTable(process.Options{}), options), log.New(io.Discard, "", 0))
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

func TestHelloWithADisplayThatIsNotThereIsALinuxComputer(t *testing.T) {
	r := callWith(t, methods.Options{Display: desktop.New(":4242")}, `{"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"test"}}`)
	var hello methods.HelloResult
	if r.Error != nil || json.Unmarshal(r.Result, &hello) != nil || hello.Kind != "linux" || strings.Join(hello.Groups, ",") != "exec,files,processes" {
		t.Fatalf("hello %+v %s", r.Error, r.Result)
	}
}

// A desktop's hello says the display it drives (its DISPLAY), so a reader needs no /proc/<pid>/environ: once init drops
// to its programs' uid the kernel makes it non-dumpable and its environ root's, which the Orgo live run read as none.
func TestHelloOfADesktopSaysItsDisplayAndALinuxComputerSaysNone(t *testing.T) {
	_, name := x11fake.Listen(t, nil)
	r := callWith(t, methods.Options{Display: desktop.New(name)}, `{"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"test"}}`)
	var hello struct {
		Kind    string  `json:"kind"`
		Display *string `json:"display"`
	}
	if r.Error != nil || json.Unmarshal(r.Result, &hello) != nil || hello.Kind != "desktop" || hello.Display == nil || *hello.Display != name {
		t.Fatalf("hello of a desktop on %s: %+v %s", name, r.Error, r.Result)
	}
	for _, options := range []methods.Options{{}, {Display: desktop.New(":4242")}} {
		r := callWith(t, options, `{"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"test"}}`)
		if r.Error != nil || strings.Contains(string(r.Result), `"display"`) {
			t.Fatalf("hello of a computer with no display: %+v %s; want no display", r.Error, r.Result)
		}
	}
}

func TestScreenAndInputWithNoDisplayAreUnsupportedInWords(t *testing.T) {
	for _, line := range []string{
		`{"jsonrpc":"2.0","id":1,"method":"screen.shot","params":{}}`,
		`{"jsonrpc":"2.0","id":1,"method":"screen.read","params":{"id":"s1","offset":0}}`,
		`{"jsonrpc":"2.0","id":1,"method":"input.actions","params":{"actions":[]}}`,
	} {
		r := call(t, line)
		if r.Error == nil || r.Error.Data.Kind != "unsupported" || !strings.Contains(r.Error.Message, "DISPLAY") {
			t.Errorf("%s: %+v", line, r)
		}
	}
}

func extend(t *testing.T, d *lifetime.Deadline, at string) reply {
	t.Helper()
	return callWith(t, methods.Options{Deadline: d}, `{"jsonrpc":"2.0","id":1,"method":"deadline.extend","params":{"at":"`+at+`"}}`)
}

func TestDeadlineExtendMovesInitsDeadline(t *testing.T) {
	start := time.Now().UTC().Truncate(time.Millisecond)
	d := lifetime.New(start.Add(time.Minute), start.Add(time.Hour))
	to := start.Add(10 * time.Minute)
	r := extend(t, d, to.Format("2006-01-02T15:04:05.000Z"))
	var res struct {
		At string `json:"at"`
	}
	if r.Error != nil || json.Unmarshal(r.Result, &res) != nil || res.At != to.Format("2006-01-02T15:04:05.000Z") || !d.At().Equal(to) {
		t.Fatalf("deadline.extend: %+v %s; deadline %v", r.Error, r.Result, d.At())
	}
}

func TestDeadlineExtendRefusesInWords(t *testing.T) {
	start := time.Now().UTC()
	d := lifetime.New(start.Add(time.Minute), start.Add(time.Hour))
	for at, kind := range map[string]string{
		start.Add(30 * time.Second).Format(time.RFC3339Nano): "invalid",
		start.Add(2 * time.Hour).Format(time.RFC3339Nano):    "limit",
		"tomorrow": "invalid",
		"":         "invalid",
	} {
		r := extend(t, d, at)
		if r.Error == nil || r.Error.Data.Kind != kind || r.Error.Message == "" {
			t.Errorf("deadline.extend to %q: %+v; want %s", at, r, kind)
		}
	}
	if !d.At().Equal(start.Add(time.Minute)) {
		t.Fatalf("a refusal moved the deadline: %v", d.At())
	}
	if r := callWith(t, methods.Options{Deadline: d}, `{"jsonrpc":"2.0","id":1,"method":"deadline.extend","params":{"at":"2030-01-01T00:00:00Z","by":1}}`); r.Error == nil || r.Error.Data.Kind != "invalid" {
		t.Errorf("an unknown field: %+v", r)
	}
	// A daemon whose provider gave no maximum, or that holds no deadline at all, cannot move it.
	for _, options := range []methods.Options{{Deadline: lifetime.New(start.Add(time.Minute), time.Time{})}, {}} {
		r := callWith(t, options, `{"jsonrpc":"2.0","id":1,"method":"deadline.extend","params":{"at":"`+start.Add(2*time.Minute).Format(time.RFC3339Nano)+`"}}`)
		if r.Error == nil || r.Error.Data.Kind != "unsupported" || r.Error.Message == "" {
			t.Errorf("deadline.extend with %+v: %+v", options, r)
		}
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

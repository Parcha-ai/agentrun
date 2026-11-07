package desktop_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/desktop"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

var x11Groups = []string{"screen", "input.pointer", "input.keys"}

func check(t *testing.T, actions string, groups []string) *desktop.Failure {
	t.Helper()
	return desktop.Check(json.RawMessage(actions), groups)
}

// refused asserts the batch is refused at index with kind, in words.
func refused(t *testing.T, actions string, groups []string, index int, kind rpc.Kind) {
	t.Helper()
	failed := check(t, actions, groups)
	if failed == nil {
		t.Errorf("%.120s: passed the check; want refused at %d as %s", actions, index, kind)
		return
	}
	if failed.Index != index || failed.Kind != kind || strings.TrimSpace(failed.Message) == "" {
		t.Errorf("%.120s: refused as %+v; want index %d, kind %s, in words", actions, failed, index, kind)
	}
}

func repeat(action string, n int) string {
	return "[" + strings.TrimSuffix(strings.Repeat(action+",", n), ",") + "]"
}

// TestCheckIsCheckActionsOnX11: the cases of checkActions' test in test/conformance-groups.test.mjs, for a computer
// that declares screen, input.pointer and input.keys and scrolls by clicks only.
func TestCheckIsCheckActionsOnX11(t *testing.T) {
	valid := `[
		{"type":"move","at":[1,2]},
		{"type":"down","button":"right"},
		{"type":"up"},
		{"type":"click","at":[3,4],"count":3,"keys":["shift","a"]},
		{"type":"drag","path":[[0,0],[5,5],[9,9]]},
		{"type":"scroll","dy":-3,"unit":"clicks"},
		{"type":"key","keys":["ctrl","s"],"repeat":2},
		{"type":"hold","keys":["alt"],"ms":100},
		{"type":"type","text":"anything at all, ü too"},
		{"type":"wait","ms":10}
	]`
	if failed := check(t, valid, x11Groups); failed != nil {
		t.Fatalf("a valid batch was refused: %+v", failed)
	}
	if failed := check(t, `[]`, nil); failed != nil {
		t.Fatalf("an empty batch is valid anywhere: %+v", failed)
	}
	refused(t, `"click"`, x11Groups, 0, rpc.KindInvalid)
	refused(t, repeat(`{"type":"wait","ms":0}`, 101), x11Groups, 100, rpc.KindLimit)
	if failed := check(t, repeat(`{"type":"wait","ms":0}`, 100), x11Groups); failed != nil {
		t.Errorf("MAX_ACTIONS is allowed: %+v", failed)
	}
	refused(t, `[{"type":"click","at":[1,1]},{"type":"key","keys":["Hyper_Q"]}]`, x11Groups, 1, rpc.KindInvalid)
	refused(t, `[{"type":"click","at":[1,1],"keys":["Return"]}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"key","keys":[]}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"drag","path":[[1,1]]}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"click","count":4}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"move","at":[1,"2"]}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"teleport"}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[null]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"wait","ms":1},{"type":"tap","at":[1,1]}]`, []string{"input.pointer"}, 1, rpc.KindUnsupported)
	refused(t, `[{"type":"wait","ms":1}]`, nil, 0, rpc.KindUnsupported)
	refused(t, `[{"type":"scroll","dy":10,"unit":"px"}]`, x11Groups, 0, rpc.KindUnsupported)
	refused(t, `[{"type":"wait","ms":299990},{"type":"hold","keys":["shift"],"ms":5},{"type":"wait","ms":6}]`, x11Groups, 2, rpc.KindLimit)
	if failed := check(t, `[{"type":"wait","ms":300000}]`, x11Groups); failed != nil {
		t.Errorf("MAX_BATCH_WAIT_MS is allowed: %+v", failed)
	}
}

// TestCheckOnX11RefusesWhatX11CannotDo: X11 has no touch, its points are whole pixels, its wheel turns in whole clicks,
// and type takes only characters with a key.
func TestCheckOnX11RefusesWhatX11CannotDo(t *testing.T) {
	for _, touch := range []string{`{"type":"tap","at":[1,1]}`, `{"type":"long_press","at":[1,1]}`, `{"type":"swipe","path":[[1,1],[2,2]]}`, `{"type":"pinch","at":[1,1],"scale":2}`, `{"type":"button","name":"back"}`} {
		refused(t, "["+touch+"]", x11Groups, 0, rpc.KindUnsupported)
	}
	refused(t, `[{"type":"move","at":[1.5,2]}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"drag","path":[[0,0],[2,2.25]]}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"scroll","dy":1.5,"unit":"clicks"}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"move","at":[1,1],"speed":3}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"wait","ms":1},{"type":"type","text":"bell \u0007"}]`, x11Groups, 1, rpc.KindInvalid)
	refused(t, `[{"type":"type","text":"a\r\n"}]`, x11Groups, 0, rpc.KindInvalid)
	refused(t, `[{"type":"type","text":`+fmt.Sprintf("%q", strings.Repeat("a", desktop.MaxTypeRunes+1))+`}]`, x11Groups, 0, rpc.KindLimit)
	refused(t, `[{"type":"key","keys":["a"],"repeat":1001}]`, x11Groups, 0, rpc.KindLimit)
	refused(t, `[{"type":"scroll","dy":10001,"unit":"clicks"}]`, x11Groups, 0, rpc.KindLimit)
	refused(t, `[{"type":"wait","ms":-1}]`, x11Groups, 0, rpc.KindInvalid)
	for _, ok := range []string{
		`[{"type":"type","text":"line one\nline two\ttabbed, 日本語 and € too"}]`,
		`[{"type":"type","text":""}]`,
		`[{"type":"move","at":[100000,100000]}]`, // off the display: a failure when it runs, not here
		`[{"type":"scroll","at":[5,5],"dx":2,"unit":"clicks","keys":["ctrl"]}]`,
	} {
		if failed := check(t, ok, x11Groups); failed != nil {
			t.Errorf("%s: refused %+v", ok, failed)
		}
	}
}

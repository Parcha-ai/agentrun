package desktop

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/keys"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

const (
	// MaxActions is the most actions one batch holds (MAX_ACTIONS).
	MaxActions = 100
	// MaxBatchWaitMs is the most time one batch asks for, summed over its timed actions (MAX_BATCH_WAIT_MS).
	MaxBatchWaitMs = 300_000
	// MaxTypeRunes is the most characters one type action takes.
	MaxTypeRunes = 64 << 10
	// maxRepeat is the most times one key action presses its keys (MAX_KEY_REPEAT).
	maxRepeat = 100
	// maxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER, 2^53 - 1: the largest repeat checkActions takes as whole.
	maxSafeInteger = 1<<53 - 1
	// maxClicks is the most wheel clicks one scroll turns, each way.
	maxClicks = 10_000
	// maxPath is the most points one drag holds.
	maxPath = 1000
	// maxKeys is the most keys one action presses at once.
	maxKeys = 16
)

// Failure is input.actions' failed: the action that stopped the batch, and why.
type Failure struct {
	Index   int      `json:"index"`
	Kind    rpc.Kind `json:"kind"`
	Message string   `json:"message"`
}

type point [2]int

// action is one checked action.
type action struct {
	Type   string
	At     *point
	Button string
	Count  int
	Keys   []string
	Path   []point
	DX, DY int
	Unit   string
	Repeat int
	MS     int
	Text   string
}

// groupOf is the group each action type needs; "input" is any input group.
var groupOf = map[string]string{
	"move": "input.pointer", "down": "input.pointer", "up": "input.pointer", "click": "input.pointer", "drag": "input.pointer", "scroll": "input.pointer",
	"key": "input.keys", "hold": "input.keys", "type": "input.keys",
	"tap": "input.touch", "long_press": "input.touch", "swipe": "input.touch", "pinch": "input.touch", "button": "input.touch",
	"wait": "input",
}

// fieldsOf is the fields each action type takes, past type.
var fieldsOf = map[string][]string{
	"move": {"at"}, "down": {"button"}, "up": {"button"},
	"click":  {"at", "button", "count", "keys"},
	"drag":   {"path", "button", "keys"},
	"scroll": {"at", "dx", "dy", "unit", "keys"},
	"key":    {"keys", "repeat"}, "hold": {"keys", "ms"}, "type": {"text"},
	"tap": {"at", "count"}, "long_press": {"at", "ms"}, "swipe": {"path", "ms"}, "pinch": {"at", "scale", "ms"}, "button": {"name"},
	"wait": {"ms"},
}

// Check is checkActions of src/actions.ts on X11: the first reason the whole batch must not run, or nil when it may.
// Nothing runs on a failure. The batch's shape and length come first, then each action in order: its shape (invalid,
// or limit past this daemon's bounds), its keys (invalid), its group against groups (unsupported), a pixel scroll,
// which X11's wheel does not have (unsupported), a key's repeat over MAX_KEY_REPEAT (limit), and the summed wait and
// hold (limit). Beyond checkActions, X11 takes
// whole pixels and whole clicks, and type takes only characters that have a key: printable ones, newlines and tabs.
// timed are the actions whose ms is a duration, summed toward MaxBatchWaitMs (TIMED in actions.ts).
var timed = map[string]bool{"wait": true, "hold": true, "long_press": true, "swipe": true, "pinch": true}

func Check(raw json.RawMessage, groups []string) *Failure {
	_, failed := check(raw, groups)
	return failed
}

func check(raw json.RawMessage, groups []string) ([]action, *Failure) {
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil || list == nil && !bytes.Equal(bytes.TrimSpace(raw), []byte("[]")) {
		return nil, &Failure{0, rpc.KindInvalid, "actions is not a list"}
	}
	if len(list) > MaxActions {
		return nil, &Failure{MaxActions, rpc.KindLimit, fmt.Sprintf("a batch holds at most %d actions; this one has %d", MaxActions, len(list))}
	}
	input := slices.ContainsFunc(groups, func(g string) bool { return strings.HasPrefix(g, "input.") })
	actions := make([]action, len(list))
	waited := 0
	for i, one := range list {
		a, kind, why := parse(one)
		if why != "" {
			return nil, &Failure{i, kind, fmt.Sprintf("action %d (%s): %s", i, a.Type, why)}
		}
		if bad := slices.IndexFunc(a.Keys, func(k string) bool { return !keys.IsKey(k) }); bad >= 0 {
			return nil, &Failure{i, rpc.KindInvalid, fmt.Sprintf("action %d: %q is not a key: a key is a name in KEYS or one printable ASCII character", i, a.Keys[bad])}
		}
		group := groupOf[a.Type]
		if group == "input" && !input || group != "input" && !slices.Contains(groups, group) {
			needs := group
			if group == "input" {
				needs = "an input group"
			}
			return nil, &Failure{i, rpc.KindUnsupported, fmt.Sprintf("action %d (%s) needs %s, which this computer does not declare", i, a.Type, needs)}
		}
		if a.Type == "scroll" && a.Unit == "px" {
			return nil, &Failure{i, rpc.KindUnsupported, fmt.Sprintf("action %d: this computer scrolls by clicks, not pixels: X11's wheel turns in clicks", i)}
		}
		if a.Type == "key" && a.Repeat > maxRepeat {
			return nil, &Failure{i, rpc.KindLimit, fmt.Sprintf("action %d: repeat %d is over %d", i, a.Repeat, maxRepeat)}
		}
		// Every duration counts, as checkActions sums it: wait, hold, long_press, swipe and pinch. X11 refuses the touch
		// three above as unsupported, so here only wait and hold reach the sum.
		if timed[a.Type] {
			waited += a.MS
			if waited > MaxBatchWaitMs {
				return nil, &Failure{i, rpc.KindLimit, fmt.Sprintf("the batch's durations reach %d ms at action %d, over %d ms", waited, i, MaxBatchWaitMs)}
			}
		}
		actions[i] = a
	}
	return actions, nil
}

// parse reads one action and checks its shape. A failure is its kind and why, in words.
func parse(raw json.RawMessage) (a action, kind rpc.Kind, why string) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return a, rpc.KindInvalid, "it is not an object"
	}
	if err := json.Unmarshal(fields["type"], &a.Type); err != nil || fieldsOf[a.Type] == nil {
		return a, rpc.KindInvalid, fmt.Sprintf("type %s is not an input action", show(fields["type"]))
	}
	for name := range fields {
		if name != "type" && !slices.Contains(fieldsOf[a.Type], name) {
			return a, rpc.KindInvalid, fmt.Sprintf("%s takes no field %q", a.Type, name)
		}
	}
	has := func(name string) bool { _, ok := fields[name]; return ok && string(fields[name]) != "null" }
	invalid := func(format string, args ...any) (action, rpc.Kind, string) {
		return a, rpc.KindInvalid, fmt.Sprintf(format, args...)
	}
	if has("at") {
		p, ok := pointOf(fields["at"])
		if !ok {
			return invalid("at %s is not a point [x, y] of whole pixels", show(fields["at"]))
		}
		a.At = &p
	} else if a.Type == "move" || a.Type == "tap" || a.Type == "long_press" || a.Type == "pinch" {
		return invalid("at is required: a point [x, y]")
	}
	a.Button = "left"
	if has("button") {
		if json.Unmarshal(fields["button"], &a.Button) != nil || (a.Button != "left" && a.Button != "right" && a.Button != "middle") {
			return invalid("button %s is not left, right or middle", show(fields["button"]))
		}
	}
	a.Count = 1
	if has("count") {
		most := 3
		if a.Type == "tap" {
			most = 2
		}
		if n, ok := whole(fields["count"]); !ok || n < 1 || n > most {
			return invalid("count %s is not 1 to %d", show(fields["count"]), most)
		} else {
			a.Count = n
		}
	}
	required := a.Type == "key" || a.Type == "hold"
	if has("keys") || required {
		if json.Unmarshal(fields["keys"], &a.Keys) != nil || a.Keys == nil && has("keys") || required && len(a.Keys) == 0 {
			return invalid("keys %s is not a list of keys", show(fields["keys"]))
		}
		if len(a.Keys) > maxKeys {
			return a, rpc.KindLimit, fmt.Sprintf("%d keys at once; at most %d", len(a.Keys), maxKeys)
		}
	}
	if a.Type == "drag" || a.Type == "swipe" {
		var points []json.RawMessage
		if json.Unmarshal(fields["path"], &points) != nil || len(points) < 2 {
			return invalid("path is not a list of 2 or more points")
		}
		if len(points) > maxPath {
			return a, rpc.KindLimit, fmt.Sprintf("a path of %d points; at most %d", len(points), maxPath)
		}
		for _, raw := range points {
			p, ok := pointOf(raw)
			if !ok {
				return invalid("path point %s is not a point [x, y] of whole pixels", show(raw))
			}
			a.Path = append(a.Path, p)
		}
	}
	if a.Type == "scroll" {
		if json.Unmarshal(fields["unit"], &a.Unit) != nil || (a.Unit != "clicks" && a.Unit != "px") {
			return invalid("unit %s is not clicks or px", show(fields["unit"]))
		}
		for _, d := range []struct {
			name string
			to   *int
		}{{"dx", &a.DX}, {"dy", &a.DY}} {
			if !has(d.name) {
				continue
			}
			var n float64
			if json.Unmarshal(fields[d.name], &n) != nil {
				return invalid("dx and dy are numbers")
			}
			if a.Unit == "clicks" {
				if n != math.Trunc(n) {
					return invalid("%s %s is not a whole number of clicks", d.name, show(fields[d.name]))
				}
				if math.Abs(n) > maxClicks {
					return a, rpc.KindLimit, fmt.Sprintf("%s %s: at most %d clicks each way", d.name, show(fields[d.name]), maxClicks)
				}
				*d.to = int(n)
			}
		}
	}
	if a.Type == "key" {
		a.Repeat = 1
		if has("repeat") {
			// Any safe integer above 0 is a repeat's shape, as checkActions reads it; one over maxRepeat is limit, checked
			// after the action's group.
			var n float64
			if json.Unmarshal(fields["repeat"], &n) != nil || n != math.Trunc(n) || n < 1 || n > maxSafeInteger {
				return invalid("repeat %s is not a whole number above 0", show(fields["repeat"]))
			}
			a.Repeat = int(n)
		}
	}
	if has("ms") || a.Type == "hold" || a.Type == "wait" {
		n, ok := whole(fields["ms"])
		if !ok || n < 0 {
			return invalid("ms %s is not a whole number of milliseconds", show(fields["ms"]))
		}
		a.MS = n
	}
	if a.Type == "type" {
		if json.Unmarshal(fields["text"], &a.Text) != nil || !has("text") {
			return invalid("text is not a string")
		}
		if n := utf8.RuneCountInString(a.Text); n > MaxTypeRunes {
			return a, rpc.KindLimit, fmt.Sprintf("text of %d characters; one type takes at most %d", n, MaxTypeRunes)
		}
		at := 0
		for _, r := range a.Text {
			if _, ok := keys.ForRune(r); !ok {
				return invalid("text has %U at character %d, which no key types: type takes printable characters, newlines and tabs", r, at)
			}
			at++
		}
	}
	if a.Type == "pinch" {
		var scale float64
		if json.Unmarshal(fields["scale"], &scale) != nil || !(scale > 0) {
			return invalid("scale %s is not a number above 0", show(fields["scale"]))
		}
	}
	if a.Type == "button" {
		var name string
		if json.Unmarshal(fields["name"], &name) != nil || (name != "back" && name != "home" && name != "app_switch") {
			return invalid("name %s is not back, home or app_switch", show(fields["name"]))
		}
	}
	return a, "", ""
}

// pointOf reads [x, y] in whole pixels.
func pointOf(raw json.RawMessage) (point, bool) {
	var xy []json.RawMessage
	if json.Unmarshal(raw, &xy) != nil || len(xy) != 2 {
		return point{}, false
	}
	var p point
	for i, v := range xy {
		n, ok := whole(v)
		if !ok {
			return point{}, false
		}
		p[i] = n
	}
	return p, true
}

// whole reads a JSON number that is a whole number in int32's range.
func whole(raw json.RawMessage) (int, bool) {
	var f float64
	if json.Unmarshal(raw, &f) != nil || f != math.Trunc(f) || math.Abs(f) > math.MaxInt32 {
		return 0, false
	}
	return int(f), true
}

func show(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "undefined"
	}
	if len(raw) > 60 {
		return string(raw[:60]) + "..."
	}
	return string(raw)
}

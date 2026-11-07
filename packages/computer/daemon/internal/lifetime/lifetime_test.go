package lifetime_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/lifetime"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

func kindOf(t *testing.T, err error) rpc.Kind {
	t.Helper()
	var e *rpc.Error
	if !errors.As(err, &e) {
		t.Fatalf("%v is not a protocol error", err)
	}
	if strings.TrimSpace(e.Message) == "" {
		t.Fatalf("a refusal with no words: %+v", e)
	}
	return e.Kind
}

func TestExtendMovesTheDeadlineAndSaysSo(t *testing.T) {
	start := time.Now()
	d := lifetime.New(start.Add(time.Minute), start.Add(time.Hour))
	to := start.Add(10 * time.Minute)
	got, err := d.Extend(to)
	if err != nil || !got.Equal(to) || !d.At().Equal(to) {
		t.Fatalf("Extend(%v) = %v, %v; At() %v", to, got, err, d.At())
	}
	select {
	case <-d.Changed():
	default:
		t.Fatal("Changed() did not fire after the deadline moved")
	}
	// The same deadline again moves nothing and is no refusal.
	if got, err := d.Extend(to); err != nil || !got.Equal(to) {
		t.Fatalf("Extend to the current deadline: %v, %v", got, err)
	}
	// Up to the maximum exactly.
	if got, err := d.Extend(start.Add(time.Hour)); err != nil || !got.Equal(start.Add(time.Hour)) {
		t.Fatalf("Extend to the maximum: %v, %v", got, err)
	}
}

func TestExtendRefusesAnEarlierDeadlineInWords(t *testing.T) {
	start := time.Now()
	d := lifetime.New(start.Add(time.Minute), start.Add(time.Hour))
	_, err := d.Extend(start.Add(30 * time.Second))
	if kindOf(t, err) != rpc.KindInvalid || !strings.Contains(err.Error(), "earlier") {
		t.Fatalf("an earlier deadline: %v", err)
	}
	if !d.At().Equal(start.Add(time.Minute)) {
		t.Fatalf("the deadline moved on a refusal: %v", d.At())
	}
}

func TestExtendNeverMovesPastTheMaximumTheProviderGave(t *testing.T) {
	start := time.Now()
	d := lifetime.New(start.Add(time.Minute), start.Add(time.Hour))
	_, err := d.Extend(start.Add(time.Hour + time.Millisecond))
	if kindOf(t, err) != rpc.KindLimit || !strings.Contains(err.Error(), "maximum") {
		t.Fatalf("past the maximum: %v", err)
	}
	if !d.At().Equal(start.Add(time.Minute)) {
		t.Fatalf("the deadline moved on a refusal: %v", d.At())
	}
	select {
	case <-d.Changed():
		t.Fatal("Changed() fired on a refusal")
	default:
	}
}

func TestADeadlineWithNoMaximumCannotMove(t *testing.T) {
	start := time.Now()
	d := lifetime.New(start.Add(time.Minute), time.Time{})
	_, err := d.Extend(start.Add(2 * time.Minute))
	if kindOf(t, err) != rpc.KindUnsupported || !strings.Contains(err.Error(), "--max-deadline") {
		t.Fatalf("no maximum: %v", err)
	}
}

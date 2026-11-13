package lifetime_test

import (
	"errors"
	"strings"
	"sync"
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

func TestOnceInitEndsTheComputerEveryExtensionIsRefusedInWords(t *testing.T) {
	start := time.Now()
	d := lifetime.New(start.Add(time.Minute), start.Add(time.Hour))
	if !d.End(start.Add(time.Minute)) {
		t.Fatal("End at the deadline decided nothing")
	}
	got, err := d.Extend(start.Add(30 * time.Minute))
	if kindOf(t, err) != rpc.KindUnsupported || !strings.Contains(err.Error(), "the computer is ending: its deadline passed") {
		t.Fatalf("Extend after End: %v", err)
	}
	if want := start.Add(time.Minute); !got.Equal(want) || !d.At().Equal(want) {
		t.Fatalf("a refused Extend moved the deadline: %v, At() %v", got, d.At())
	}
	stopped := lifetime.New(start.Add(time.Hour), start.Add(2*time.Hour))
	stopped.Stop("init was sent terminated")
	if _, err := stopped.Extend(start.Add(90 * time.Minute)); kindOf(t, err) != rpc.KindUnsupported || !strings.Contains(err.Error(), "the computer is ending: init was sent terminated") {
		t.Fatalf("Extend after Stop: %v", err)
	}
}

func TestEndDecidesNothingBeforeTheDeadlineAnExtensionMoved(t *testing.T) {
	start := time.Now()
	d := lifetime.New(start.Add(time.Minute), start.Add(time.Hour))
	if _, err := d.Extend(start.Add(2 * time.Minute)); err != nil {
		t.Fatal(err)
	}
	if d.End(start.Add(time.Minute)) {
		t.Fatal("End at the old deadline decided to end the computer after an extension moved it")
	}
	if got, err := d.Extend(start.Add(3 * time.Minute)); err != nil || !got.Equal(start.Add(3*time.Minute)) {
		t.Fatalf("Extend after an End that decided nothing: %v, %v", got, err)
	}
}

// An extension and init's decision race as the deadline comes: either the extension lands first and the deadline it
// answers is kept (End decides nothing), or it is refused. Never both an answer and an end at the old deadline.
func TestAnExtensionRacingTheDeadlineIsKeptOrRefusedNeverBoth(t *testing.T) {
	start := time.Now()
	at := start.Add(time.Minute)
	extended, refused := 0, 0
	for i := 0; i < 500; i++ {
		d := lifetime.New(at, start.Add(time.Hour))
		var wg sync.WaitGroup
		var err error
		var ended bool
		wg.Add(2)
		go func() { defer wg.Done(); _, err = d.Extend(at.Add(time.Minute)) }()
		go func() { defer wg.Done(); ended = d.End(at) }()
		wg.Wait()
		switch {
		case err == nil && ended:
			t.Fatalf("run %d: Extend succeeded and End still ended the computer at the old deadline", i)
		case err == nil:
			extended++
		case ended:
			refused++
			if !strings.Contains(err.Error(), "the computer is ending") {
				t.Fatalf("run %d: refused, but not in words: %v", i, err)
			}
		default:
			t.Fatalf("run %d: Extend refused (%v) and End decided nothing", i, err)
		}
	}
	t.Logf("%d extended first, %d refused", extended, refused)
}

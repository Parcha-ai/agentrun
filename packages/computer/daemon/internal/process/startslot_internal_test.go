package process

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// A start that waits behind another start (one stalled before its guard reported) must still end when its own request
// is cancelled. The slot is held here as that stalled start would hold it.
func TestAQueuedStartEndsWhenItsRequestIsCancelled(t *testing.T) {
	table := NewTable(Options{})
	release := holdStartSlot(table)
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	ended := make(chan error, 1)
	go func() {
		_, err := table.Start(ctx, StartParams{Argv: []string{"true"}})
		ended <- err
	}()
	cancel()
	select {
	case err := <-ended:
		var e *rpc.Error
		if !errors.As(err, &e) || e.Kind != rpc.KindAborted {
			t.Fatalf("a cancelled queued start: want an aborted error, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a cancelled start was still waiting for another start's slot after 10 s")
	}
}

// holdStartSlot takes the table's start slot, as a start stalled before its guard reported holds it.
func holdStartSlot(t *Table) (release func()) {
	t.startSlot <- struct{}{}
	return func() { <-t.startSlot }
}

package files_test

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/files"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// Moves to one missing destination at once, without overwrite: exactly one wins, and the rest are exists.
func TestConcurrentMovesToOneDestination(t *testing.T) {
	const movers = 8
	for round := range 200 {
		dir := t.TempDir()
		to := filepath.Join(dir, "to")
		for i := range movers {
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprint(i)), []byte(fmt.Sprint(i)), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		start := make(chan struct{})
		errs := make([]error, movers)
		var wg sync.WaitGroup
		for i := range movers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				_, errs[i] = files.Move(files.MoveParams{From: filepath.Join(dir, fmt.Sprint(i)), To: to})
			}()
		}
		close(start)
		wg.Wait()
		winner := -1
		for i, err := range errs {
			var e *rpc.Error
			switch {
			case err == nil && winner >= 0:
				t.Fatalf("round %d: moves %d and %d both succeeded to one destination", round, winner, i)
			case err == nil:
				winner = i
			case !errors.As(err, &e) || e.Kind != rpc.KindExists:
				t.Fatalf("round %d: move %d: want exists, got %v", round, i, err)
			default:
				if _, err := os.Stat(filepath.Join(dir, fmt.Sprint(i))); err != nil {
					t.Fatalf("round %d: the refused move %d lost its source: %v", round, i, err)
				}
			}
		}
		if data, err := os.ReadFile(to); winner < 0 || err != nil || string(data) != fmt.Sprint(winner) {
			t.Fatalf("round %d: winner %d, the destination holds %q %v", round, winner, data, err)
		}
	}
}

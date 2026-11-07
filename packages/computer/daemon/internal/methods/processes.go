package methods

import (
	"context"
	"encoding/json"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// processHandlers are the process.* methods on one table, which every connection shares. Their params and results are
// in package process.
func processHandlers(table *process.Table) map[string]rpc.Handler {
	return map[string]rpc.Handler{
		"process.start":  handleCtx(table.Start),
		"process.read":   handleCtx(table.Read),
		"process.write":  handleCtx(table.Write),
		"process.signal": handle(table.Signal),
		"process.resize": handle(table.Resize),
		"process.list":   handle(table.List),
		"process.wait":   handleCtx(table.Wait),
	}
}

// handleCtx is handle for a method that waits, and so needs the request's context.
func handleCtx[P, R any](fn func(context.Context, P) (R, error)) rpc.Handler {
	return func(ctx context.Context, raw json.RawMessage) (any, error) {
		return handle(func(params P) (R, error) { return fn(ctx, params) })(ctx, raw)
	}
}

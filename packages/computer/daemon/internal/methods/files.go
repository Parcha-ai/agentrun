package methods

import (
	"context"
	"encoding/json"
	"io"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/files"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// fileHandlers are the files.* and tar.* methods. Their params and results are in package files, beside what answers
// them.
func fileHandlers() map[string]rpc.Handler {
	return map[string]rpc.Handler{
		"files.read":   handle(files.Read),
		"files.write":  handle(files.Write),
		"files.stat":   handle(files.Stat),
		"files.list":   handle(files.List),
		"files.mkdir":  handle(files.Mkdir),
		"files.move":   handle(files.Move),
		"files.remove": handle(files.Remove),
		"tar.pull.begin": func(ctx context.Context, raw json.RawMessage) (any, error) {
			return handle(pulls(ctx).Begin)(ctx, raw)
		},
		"tar.pull.read": func(ctx context.Context, raw json.RawMessage) (any, error) {
			return handle(pulls(ctx).Read)(ctx, raw)
		},
		"tar.pull.end": func(ctx context.Context, raw json.RawMessage) (any, error) {
			return handle(pulls(ctx).End)(ctx, raw)
		},
		"tar.push.begin": func(ctx context.Context, raw json.RawMessage) (any, error) {
			return handle(pushes(ctx).Begin)(ctx, raw)
		},
		"tar.push.write": func(ctx context.Context, raw json.RawMessage) (any, error) {
			return handle(pushes(ctx).Write)(ctx, raw)
		},
		"tar.push.end": func(ctx context.Context, raw json.RawMessage) (any, error) {
			return handle(pushes(ctx).End)(ctx, raw)
		},
	}
}

// handle decodes a method's params strictly and answers with fn.
func handle[P, R any](fn func(P) (R, error)) rpc.Handler {
	return func(_ context.Context, raw json.RawMessage) (any, error) {
		var params P
		if err := strict(raw, &params); err != nil {
			return nil, err
		}
		result, err := fn(params)
		if err != nil {
			return nil, err
		}
		return result, nil
	}
}

type pushesKey struct{}

type pullsKey struct{}

// pushes are the connection's open tar pushes: what is unfinished when it ends is ended with it.
func pushes(ctx context.Context) *files.Pushes {
	return rpc.Local(ctx, pushesKey{}, func() io.Closer { return files.NewPushes() }).(*files.Pushes)
}

// pulls are the connection's open tar pulls, ended with it.
func pulls(ctx context.Context) *files.Pulls {
	return rpc.Local(ctx, pullsKey{}, func() io.Closer { return files.NewPulls() }).(*files.Pulls)
}

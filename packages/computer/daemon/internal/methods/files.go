package methods

import (
	"context"
	"encoding/json"
	"io"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/files"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// TarDataMethod is the notification that carries a tar.pull's bytes, naming the pull's request id.
const TarDataMethod = "tar.data"

type TarData struct {
	Request json.RawMessage `json:"request"`
	Data    []byte          `json:"data"`
}

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
		"tar.pull": func(ctx context.Context, raw json.RawMessage) (any, error) {
			return handle(func(params files.PullParams) (files.PullResult, error) {
				id := rpc.RequestID(ctx)
				return files.Pull(ctx, params, func(chunk []byte) error {
					return rpc.Notify(ctx, TarDataMethod, TarData{Request: id, Data: chunk})
				})
			})(ctx, raw)
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

// pushes are the connection's open tar pushes: what is unfinished when it ends is ended with it.
func pushes(ctx context.Context) *files.Pushes {
	return rpc.Local(ctx, pushesKey{}, func() io.Closer { return files.NewPushes() }).(*files.Pushes)
}

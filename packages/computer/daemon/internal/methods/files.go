package methods

import (
	"context"
	"encoding/json"
	"io"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/files"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// TarDataMethod is the notification that carries a tar.pull's bytes, named by its request id.
const TarDataMethod = "tar.data"

type FilesReadParams struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset,omitempty"`
	Length *int   `json:"length,omitempty"`
}

type FilesWriteParams struct {
	Path    string  `json:"path"`
	Data    []byte  `json:"data"`
	Offset  *int64  `json:"offset,omitempty"`
	Append  bool    `json:"append,omitempty"`
	Mode    *uint32 `json:"mode,omitempty"`
	Parents bool    `json:"parents,omitempty"`
}

type FilesStatParams struct {
	Path   string `json:"path"`
	Follow bool   `json:"follow,omitempty"`
}

type FilesListParams struct {
	Path   string `json:"path"`
	Depth  *int   `json:"depth,omitempty"`
	Offset int    `json:"offset,omitempty"`
}

type FilesMkdirParams struct {
	Path    string  `json:"path"`
	Parents bool    `json:"parents,omitempty"`
	Mode    *uint32 `json:"mode,omitempty"`
}

type FilesMoveParams struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Overwrite bool   `json:"overwrite,omitempty"`
}

type FilesRemoveParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive,omitempty"`
}

type TarPullParams struct {
	Path string `json:"path"`
}

type TarPullResult struct {
	Bytes int64 `json:"bytes"`
}

type TarData struct {
	Request json.RawMessage `json:"request"`
	Data    []byte          `json:"data"`
}

type TarPushBeginParams struct {
	Path string `json:"path"`
}

type TarPushBeginResult struct {
	ID string `json:"id"`
}

type TarPushWriteParams struct {
	ID   string `json:"id"`
	Data []byte `json:"data"`
}

type TarPushEndParams struct {
	ID string `json:"id"`
}

type TarPushEndResult struct {
	Entries int `json:"entries"`
}

type empty struct{}

func filesRead(_ context.Context, raw json.RawMessage) (any, error) {
	var params FilesReadParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	path, err := files.Path("path", params.Path)
	if err != nil {
		return nil, err
	}
	length := files.MaxChunk
	if params.Length != nil {
		length = *params.Length
	}
	return files.Read(path, params.Offset, length)
}

func filesWrite(_ context.Context, raw json.RawMessage) (any, error) {
	var params FilesWriteParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	path, err := files.Path("path", params.Path)
	if err != nil {
		return nil, err
	}
	return files.Write(path, files.WriteSpec{Data: params.Data, Offset: params.Offset, Append: params.Append, Mode: params.Mode, Parents: params.Parents})
}

func filesStat(_ context.Context, raw json.RawMessage) (any, error) {
	var params FilesStatParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	path, err := files.Path("path", params.Path)
	if err != nil {
		return nil, err
	}
	return files.Stat(path, params.Follow)
}

func filesList(_ context.Context, raw json.RawMessage) (any, error) {
	var params FilesListParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	path, err := files.Path("path", params.Path)
	if err != nil {
		return nil, err
	}
	depth := 1
	if params.Depth != nil {
		depth = *params.Depth
	}
	return files.List(path, depth, params.Offset)
}

func filesMkdir(_ context.Context, raw json.RawMessage) (any, error) {
	var params FilesMkdirParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	path, err := files.Path("path", params.Path)
	if err != nil {
		return nil, err
	}
	return empty{}, files.Mkdir(path, params.Parents, params.Mode)
}

func filesMove(_ context.Context, raw json.RawMessage) (any, error) {
	var params FilesMoveParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	from, err := files.Path("from", params.From)
	if err != nil {
		return nil, err
	}
	to, err := files.Path("to", params.To)
	if err != nil {
		return nil, err
	}
	return empty{}, files.Move(from, to, params.Overwrite)
}

func filesRemove(_ context.Context, raw json.RawMessage) (any, error) {
	var params FilesRemoveParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	path, err := files.Path("path", params.Path)
	if err != nil {
		return nil, err
	}
	return empty{}, files.Remove(path, params.Recursive)
}

func tarPull(ctx context.Context, raw json.RawMessage) (any, error) {
	var params TarPullParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	path, err := files.Path("path", params.Path)
	if err != nil {
		return nil, err
	}
	id := rpc.RequestID(ctx)
	n, err := files.Pull(ctx, path, func(chunk []byte) error {
		return rpc.Notify(ctx, TarDataMethod, TarData{Request: id, Data: chunk})
	})
	if err != nil {
		return nil, err
	}
	return TarPullResult{Bytes: n}, nil
}

type pushesKey struct{}

// pushes are the connection's open tar pushes: what is unfinished when it ends is ended with it.
func pushes(ctx context.Context) *files.Pushes {
	return rpc.Local(ctx, pushesKey{}, func() io.Closer { return files.NewPushes() }).(*files.Pushes)
}

func tarPushBegin(ctx context.Context, raw json.RawMessage) (any, error) {
	var params TarPushBeginParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	path, err := files.Path("path", params.Path)
	if err != nil {
		return nil, err
	}
	id, err := pushes(ctx).Begin(path)
	if err != nil {
		return nil, err
	}
	return TarPushBeginResult{ID: id}, nil
}

func tarPushWrite(ctx context.Context, raw json.RawMessage) (any, error) {
	var params TarPushWriteParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	return empty{}, pushes(ctx).Write(params.ID, params.Data)
}

func tarPushEnd(ctx context.Context, raw json.RawMessage) (any, error) {
	var params TarPushEndParams
	if err := strict(raw, &params); err != nil {
		return nil, err
	}
	entries, err := pushes(ctx).End(params.ID)
	if err != nil {
		return nil, err
	}
	return TarPushEndResult{Entries: entries}, nil
}

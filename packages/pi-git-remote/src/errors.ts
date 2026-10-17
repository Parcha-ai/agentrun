export type GitRemoteErrorCode = "refused" | "conflict" | "missing" | "git";

/** The one error this package throws. Its message never carries a credential. */
export class GitRemoteError extends Error {
  /**
   * `refused`: the input or the tree breaks a rule (a path, a mode, a size, a URL with userinfo).
   * `conflict`: a merge or revert conflicts, or the remote moved and a push is not a fast-forward.
   * `missing`: no such ref, commit or path.
   * `git`: git itself failed.
   */
  readonly code: GitRemoteErrorCode;
  /** The paths a refusal or a conflict is about, when it is about paths. */
  readonly paths: readonly string[];

  constructor(code: GitRemoteErrorCode, message: string, paths: readonly string[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitRemoteError";
    this.code = code;
    this.paths = Object.freeze([...paths]);
  }
}

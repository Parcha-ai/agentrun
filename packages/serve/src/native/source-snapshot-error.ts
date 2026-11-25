export class SourceSnapshotError extends Error {
  constructor(readonly code: "source_changed" | "source_unavailable" | "unsupported_platform" | "limit", message: string) { super(message); this.name = "SourceSnapshotError"; }
}

// A part of the package declared in its interface whose implementation has not landed in this release. Calling it
// throws this error, never a half answer; the README lists which parts are built.

export class NotBuiltError extends Error {
  readonly code = "not_built";
  constructor(readonly part: string) {
    super(`${part} is not built in this release of @parcha/pi-vision`);
    this.name = "NotBuiltError";
  }
}

export function notBuilt(part: string): never {
  throw new NotBuiltError(part);
}

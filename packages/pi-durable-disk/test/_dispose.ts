// Disposal at the end of the test that made the thing. The suites would use `using`, but explicit resource management does
// not parse before Node 24 and the package supports Node 22.19.
import { afterEach } from "node:test";

type Owned = { [Symbol.dispose](): void };
const owned: Owned[] = [];

afterEach(() => {
  for (const resource of owned.splice(0).reverse()) resource[Symbol.dispose]();
});

/** The resource, disposed (latest first) when the running test ends. */
export function disposeAfter<T extends Owned>(resource: T): T {
  owned.push(resource);
  return resource;
}

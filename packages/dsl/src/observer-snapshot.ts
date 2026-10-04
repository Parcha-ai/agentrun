import { isProxy } from "node:util/types";

/** Copy observation data without reading accessors or sharing mutable data objects.
 * Keep invalid JSON shapes visible so required host trace validation can reject them. */
export function observerSnapshot<T>(value: T): T {
  const seen = new Map<object, object>();
  const pending: Array<[object, object]> = [];
  const copy = (item: unknown): unknown => {
    // A proxy can execute code even when its property descriptors are inspected.
    if (isProxy(item)) return function unavailable() {};
    if (item === null || typeof item !== "object") {
      // Functions are invalid observation data; an inert function preserves that
      // fact without giving an observer the original callable or its properties.
      return typeof item === "function" ? function unavailable() {} : item;
    }
    const known = seen.get(item);
    if (known) return known;
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return function unavailable() {};
    const target: object = Array.isArray(item) ? [] : Object.create(prototype);
    seen.set(item, target);
    pending.push([item, target]);
    return target;
  };
  const result = copy(value);
  while (pending.length) {
    const [source, target] = pending.pop()!;
    for (const key of Reflect.ownKeys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
      if ("value" in descriptor) descriptor.value = copy(descriptor.value);
      else {
        // Never invoke authored getters, including during cloning. Their shape
        // remains an accessor so a JSON-validating host still fails closed.
        if (descriptor.get) descriptor.get = () => undefined;
        if (descriptor.set) descriptor.set = () => {};
      }
      Object.defineProperty(target, key, descriptor);
    }
  }
  return result as T;
}

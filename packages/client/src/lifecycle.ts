/** @module lifecycle Shares cancellation checks and safe record copying across stores. */
import { TCGError } from "./errors.js";

/** Turn an already-aborted signal into the client's stable cancellation error. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new TCGError("ABORTED", "The operation was cancelled", {
      cause: signal.reason,
    });
}

/** Cancel this caller's wait without cancelling the shared promise underneath it. */
export function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    // Every completion path removes its listener to avoid retaining finished callers.
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(
        new TCGError("ABORTED", "The operation was cancelled", {
          cause: signal.reason,
        }),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Combine client and request signals; omit undefined inputs and unnecessary wrappers. */
export function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const values = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return values.length === 0
    ? undefined
    : values.length === 1
      ? values[0]
      : AbortSignal.any(values);
}

/** Detach returned JSON records so callers cannot mutate a cached copy. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Recursively protect the plain JSON records retained by a store. */
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

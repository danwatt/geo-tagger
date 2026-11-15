/* Latest-only loaders. Port of common.js latestOnly.
 *
 * A loader triggered by navigation (a new search, arrowing through results) can
 * be called again before its previous fetch returns, and responses don't come
 * back in order — so without a guard, the slower, older one lands last and
 * paints its data over the newer view. latestOnly(loader) returns a wrapper where:
 *   - each call gets a fresh AbortController and aborts the previous call's, so
 *     the superseded request is cancelled in flight (pass `signal` to fetch);
 *   - `signal.aborted` doubles as the "am I still the latest call?" token. A
 *     fetch that already resolved isn't un-resolved by abort(), so the loader
 *     must check `if (signal.aborted) return;` after every await, before it
 *     touches shared state, and in its catch (an aborted fetch rejects with
 *     AbortError, which is not a user-facing failure);
 *   - a superseded call resolves to LATEST_ONLY_STALE instead of the loader's
 *     return value, and its errors are swallowed;
 *   - wrapper.cancel() aborts the in-flight call without starting a new one.
 * Calls that share one piece of state (several loaders filling the same grid)
 * must share one wrapper, or they won't supersede each other. */

export const LATEST_ONLY_STALE: unique symbol = Symbol("latestOnly.stale");

export type LatestOnly<A extends unknown[], R> = ((...args: A) => Promise<R | typeof LATEST_ONLY_STALE>) & {
  cancel: () => void;
};

export function latestOnly<A extends unknown[], R>(
  loader: (signal: AbortSignal, ...args: A) => Promise<R>,
): LatestOnly<A, R> {
  let controller: AbortController | null = null;
  const run = async (...args: A) => {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    try {
      const result = await loader(mine.signal, ...args);
      return mine.signal.aborted ? LATEST_ONLY_STALE : result;
    } catch (err) {
      if (mine.signal.aborted) return LATEST_ONLY_STALE;
      throw err;
    } finally {
      if (controller === mine) controller = null;
    }
  };
  return Object.assign(run, {
    cancel: () => {
      controller?.abort();
      controller = null;
    },
  });
}

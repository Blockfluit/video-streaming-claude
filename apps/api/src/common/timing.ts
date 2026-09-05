import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where a request's time went, and how much it read to get there.
 *
 * There was no way to answer either question about a deployed server. Search on
 * a production box was reported slow while the same code measured 20–36 ms here,
 * and every candidate explanation — the engine, the network, the reads, the
 * scoring — looked identical from outside. The only honest way to tell them
 * apart is to have the server say.
 *
 * **`AsyncLocalStorage`, not a request-scoped provider.** Nest's `Scope.REQUEST`
 * is contagious: making `LibraryService` request-scoped would rebuild it, and
 * everything it injects, on every request — a measurable cost added by the thing
 * measuring the cost. A store opened by an interceptor and read by a service
 * needs no wiring in between and changes nothing about how anything is built.
 */
const store = new AsyncLocalStorage<Map<string, number>>();

/**
 * Runs `run` with `into` as the store for everything it starts.
 *
 * The caller supplies the map rather than receiving one, and that is not a
 * style choice. An interceptor returns an Observable, and the route handler does
 * not execute until something *subscribes* — which happens after `run` has
 * returned. Wrapping the construction therefore captures nothing at all: the
 * store has to be active across the subscription, and the reporter has to hold
 * its own reference rather than asking for the current one, because by the time
 * it reports the context is gone again.
 *
 * This was written the other way round first, and the symptom was a header that
 * never appeared and no error anywhere.
 */
export function runWithTimings<T>(into: Map<string, number>, run: () => T): T {
  return store.run(into, run);
}

/**
 * Times one phase.
 *
 * A no-op when nothing opened a store — which is every unit test and every code
 * path that is not an HTTP request, so nothing has to know whether it is being
 * measured.
 */
export async function time<T>(label: string, run: () => Promise<T>): Promise<T> {
  const current = store.getStore();
  if (!current) return run();

  const started = process.hrtime.bigint();
  try {
    return await run();
  }
  finally {
    current.set(label, Number(process.hrtime.bigint() - started) / 1e6);
  }
}

/**
 * Records a count rather than a duration.
 *
 * Counts are what separate the causes. A slow read that returned four rows and a
 * slow read that returned five hundred are different faults, and the duration
 * alone cannot tell them apart — so `n.*` entries carry how much was read, and
 * the reader compares them against the caps.
 */
export function count(label: string, value: number): void {
  store.getStore()?.set(label, value);
}

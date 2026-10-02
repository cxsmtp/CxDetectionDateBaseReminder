/**
 * A small time-to-live cache with request coalescing.
 *
 * `wrap(key, loader, ttl)` returns the cached value while it is fresh; when
 * it is not, the first caller runs the loader and every concurrent caller for
 * the same key awaits that one promise, so a thousand reports polling the same
 * finding cost one upstream call. `ttl` may be a function of the loaded value,
 * so settled answers can be kept longer than ones still changing.
 */

export class TtlCache {
  #entries = new Map();
  #inFlight = new Map();
  #max;
  hits = 0;
  misses = 0;

  constructor({ max = 20_000 } = {}) {
    this.#max = max;
  }

  get(key, now = Date.now()) {
    const entry = this.#entries.get(key);
    if (!entry || entry.expires <= now) return undefined;
    // Refresh recency, so eviction drops the least recently used first.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs, now = Date.now()) {
    if (!(ttlMs > 0)) return;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expires: now + ttlMs });
    while (this.#entries.size > this.#max) this.#entries.delete(this.#entries.keys().next().value);
  }

  /**
   * Stale-while-revalidate: whatever is known now — fresh, or stale (kept
   * until evicted) — without waiting. A missing or stale value is loaded in
   * the background, coalesced with any load already running.
   * Returns {value, fresh} or undefined when nothing is known yet.
   */
  peek(key, loader, ttl, now = Date.now()) {
    const entry = this.#entries.get(key);
    const fresh = Boolean(entry && entry.expires > now);
    if (fresh) {
      this.hits += 1;
      return { value: entry.value, fresh: true };
    }
    if (loader) this.wrap(key, loader, ttl, { background: true }).catch(() => {});
    return entry ? { value: entry.value, fresh: false } : undefined;
  }

  delete(key) {
    this.#entries.delete(key);
  }

  /** Drop every key starting with `prefix`. */
  deletePrefix(prefix) {
    for (const key of this.#entries.keys()) if (key.startsWith(prefix)) this.#entries.delete(key);
  }

  /**
   * `background`: the load was started by a background refresh (peek), whose upstream call
   * may wait behind everything else. A person waiting (not background) never joins such a
   * load: they start their own, and later callers join theirs.
   */
  async wrap(key, loader, ttl, { background = false } = {}) {
    const cached = this.get(key);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }
    const running = this.#inFlight.get(key);
    if (running && (background || !running.background)) {
      this.hits += 1;
      return running.promise;
    }
    this.misses += 1;
    const entry = { background, promise: null };
    entry.promise = (async () => {
      try {
        const value = await loader();
        this.set(key, value, typeof ttl === 'function' ? ttl(value) : ttl);
        return value;
      } finally {
        if (this.#inFlight.get(key) === entry) this.#inFlight.delete(key);
      }
    })();
    this.#inFlight.set(key, entry);
    return entry.promise;
  }

  get size() {
    return this.#entries.size;
  }
}

/**
 * Limit how many async tasks run at once; the rest wait their turn. Tasks
 * marked low priority (background refreshes) only get a slot when no
 * interactive task is waiting, so a backlog of refreshes never delays a
 * reader's request.
 */
export class Semaphore {
  #high = [];
  #low = [];
  #active = 0;

  constructor(limit) {
    this.limit = limit;
  }

  get active() {
    return this.#active;
  }

  get waiting() {
    return this.#high.length + this.#low.length;
  }

  get waitingLow() {
    return this.#low.length;
  }

  async run(task, { low = false } = {}) {
    // A finished task hands its slot straight to the next in line, so a new
    // caller can never slip in between and exceed the limit.
    if (this.#active >= this.limit) await new Promise((resolve) => (low ? this.#low : this.#high).push(resolve));
    else this.#active += 1;
    try {
      return await task();
    } finally {
      const next = this.#high.shift() ?? this.#low.shift();
      if (next) next();
      else this.#active -= 1;
    }
  }
}

import { createElement } from 'react';
import type { ReactNode } from 'react';
import type { CacheEntry, CacheStore } from './store.js';

/**
 * A cache key, TanStack-Query style: an array of parts (a bare string is shorthand
 * for a one-part key). Invalidation matches by prefix, so `['product']` covers
 * `['product', 'abc']`. Each part is serialized with `JSON.stringify`.
 */
export type CacheKey = string | readonly unknown[];

const encodeSegments = (key: CacheKey): string[] =>
  (typeof key === 'string' ? [key] : key).map((part) =>
    encodeURIComponent(JSON.stringify(part)),
  );

const hashBytes = (bytes: Uint8Array): string => {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

/** Options for {@link Cache.fn}. `key` is a function of the arguments. */
export interface FnOptions<Args extends unknown[]> {
  key: (...args: Args) => CacheKey;
  ttl?: number;
}

/** Options for {@link Cache.rsc}. `key` is a function of the props. */
export interface RscOptions<Props> {
  key: (props: Props) => CacheKey;
  ttl?: number;
}

/** Target of {@link Cache.invalidate}: a key, matched by prefix. */
export interface InvalidateOptions {
  key: CacheKey;
}

/** The pair returned by {@link Cache.rsc}. */
export interface CachedRsc<Props> {
  /** Drop-in replacement for the wrapped component. */
  Component: (props: Props) => Promise<ReactNode>;
  /**
   * The cached subtree's element tag — a hash of its serialized bytes. It
   * changes whenever the content changes (on invalidation or TTL expiry) and is
   * stable while the entry is fresh. Optional: wire it into `getConfig`'s
   * `unstable_getEtag` so Waku skips re-sending the slot during client
   * navigation while the tag is unchanged.
   */
  getEtag: (props: Props) => Promise<string>;
}

export interface Cache {
  /** Cache a function's result by key; the wrapper always returns a promise. */
  fn<Args extends unknown[], Result>(
    fn: (...args: Args) => Result | Promise<Result>,
    options: FnOptions<Args>,
  ): (...args: Args) => Promise<Result>;
  /**
   * Wrap a Server Component so its serialized subtree is cached by key.
   * Render failures reject without storing an entry and can be retried.
   * Server-side `useId()` is unsupported; pass explicit IDs in props and keys.
   */
  rsc<Props extends Record<string, unknown> = Record<string, unknown>>(
    Component: (props: Props) => ReactNode | Promise<ReactNode>,
    options: RscOptions<Props>,
  ): CachedRsc<Props>;
  /** Drop every entry whose key starts with `options.key` (prefix match). */
  invalidate(options: InvalidateOptions): Promise<void>;
}

export interface CreateCacheOptions {
  store: CacheStore;
  defaults?: { ttl?: number };
}

let rscModule: Promise<typeof import('waku/server')> | undefined;
const getRscModule = () => (rscModule ??= import('waku/server'));

/**
 * Creates a server cache backed by `store`. TTLs are milliseconds; entries
 * use their own TTL, then `defaults.ttl`, and do not expire if neither is set.
 * Keys must distinguish all inputs that affect a result, including user data.
 */
export function createCache(options: CreateCacheOptions): Cache {
  const { store } = options;
  const defaultTtl = options.defaults?.ttl;

  const makeEntry = (
    value: Uint8Array,
    ttl: number | undefined,
  ): CacheEntry => {
    const effectiveTtl = ttl ?? defaultTtl;
    return {
      value,
      createdAt: Date.now(),
      ...(effectiveTtl !== undefined
        ? { expiresAt: Date.now() + effectiveTtl }
        : {}),
    };
  };

  const inflightFn = new Map<string, Promise<unknown>>();
  const inflightRsc = new Map<string, Promise<CacheEntry>>();

  return {
    fn<Args extends unknown[], Result>(
      fn: (...args: Args) => Result | Promise<Result>,
      opts: FnOptions<Args>,
    ): (...args: Args) => Promise<Result> {
      return async (...args: Args): Promise<Result> => {
        const segments = encodeSegments(opts.key(...args));
        const id = segments.join('\0');
        const { serializeRsc, deserializeRsc } = await getRscModule();
        const hit = await store.get(segments);
        if (hit) return (await deserializeRsc(hit.value)) as Result;
        const existing = inflightFn.get(id) as Promise<Result> | undefined;
        if (existing) return existing;
        const promise = (async (): Promise<Result> => {
          const result = await fn(...args);
          await store.set(
            segments,
            makeEntry(await serializeRsc(result), opts.ttl),
          );
          return result;
        })();
        inflightFn.set(id, promise);
        try {
          return await promise;
        } finally {
          inflightFn.delete(id);
        }
      };
    },

    rsc<Props extends Record<string, unknown> = Record<string, unknown>>(
      Component: (props: Props) => ReactNode | Promise<ReactNode>,
      opts: RscOptions<Props>,
    ): CachedRsc<Props> {
      const fill = async (props: Props): Promise<CacheEntry> => {
        const segments = encodeSegments(opts.key(props));
        const id = segments.join(' ');
        const existing = inflightRsc.get(id);
        if (existing) return existing;
        const pending = (async (): Promise<CacheEntry> => {
          const { renderToReadableStream } =
            await import('react-server-dom-webpack/server.edge');
          const errors: unknown[] = [];
          const stream = renderToReadableStream(
            createElement(Component, props),
            {},
            {
              onError(error) {
                errors.push(error);
              },
            },
          );
          const bytes = new Uint8Array(
            await new Response(stream).arrayBuffer(),
          );
          if (errors.length) throw errors[0];
          const entry = makeEntry(bytes, opts.ttl);
          await store.set(segments, entry);
          return entry;
        })();
        inflightRsc.set(id, pending);
        try {
          return await pending;
        } finally {
          inflightRsc.delete(id);
        }
      };
      const CachedComponent = async (props: Props): Promise<ReactNode> => {
        const { deserializeRsc } = await getRscModule();
        const entry =
          (await store.get(encodeSegments(opts.key(props)))) ??
          (await fill(props));
        return (await deserializeRsc(entry.value)) as ReactNode;
      };
      const getEtag = async (props: Props): Promise<string> => {
        const entry =
          (await store.get(encodeSegments(opts.key(props)))) ??
          (await fill(props));
        return hashBytes(entry.value);
      };
      return { Component: CachedComponent, getEtag };
    },

    invalidate(opts: InvalidateOptions): Promise<void> {
      return store.delete(encodeSegments(opts.key));
    },
  };
}

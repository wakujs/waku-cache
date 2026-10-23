import { deserialize, serialize } from 'node:v8';
import { isValidElement } from 'react';
import { createStorage } from 'unstorage';
import { describe, expect, test, vi } from 'vitest';
import { createCache } from 'waku-cache';
import type { CacheKey } from 'waku-cache';
import { memoryStore } from 'waku-cache/stores/memory';
import { unstorageStore } from 'waku-cache/stores/unstorage';

vi.mock('waku/server', () => ({
  serializeRsc: (value: unknown) => Promise.resolve(serialize(value)),
  deserializeRsc: (bytes: Uint8Array) => Promise.resolve(deserialize(bytes)),
}));

vi.mock('react-server-dom-webpack/server.edge', () => ({
  renderToReadableStream: (
    element: unknown,
    _webpackMap: unknown,
    options: { onError: (error: unknown) => void },
  ) =>
    new ReadableStream({
      async start(controller) {
        let value: unknown;
        try {
          if (isValidElement(element) && typeof element.type === 'function') {
            const Component = element.type as (props: unknown) => unknown;
            value = await Component(element.props);
          }
        } catch (error) {
          options.onError(error);
        }
        controller.enqueue(serialize(value));
        controller.close();
      },
    }),
}));

const stores = [
  ['memory', () => memoryStore()],
  ['unstorage', () => unstorageStore(createStorage())],
] as const;

describe.each(stores)('cache.fn (%s store)', (_name, makeStore) => {
  test('caches by key (computes once per key)', async () => {
    const cache = createCache({ store: makeStore() });
    const spy = vi.fn((id: string) => Promise.resolve(id.toUpperCase()));
    const get = cache.fn(spy, { key: (id) => ['item', id] });
    expect(await get('x')).toBe('X');
    expect(await get('x')).toBe('X');
    expect(spy).toHaveBeenCalledTimes(1);
    await get('y');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('invalidate matches by prefix: parent key drops descendants, not siblings', async () => {
    const cache = createCache({ store: makeStore() });
    let calls = 0;
    const getProduct = cache.fn(
      (id: string) => {
        calls++;
        return Promise.resolve(id);
      },
      { key: (id) => ['product', id] },
    );
    const getProduction = cache.fn(
      () => {
        calls++;
        return Promise.resolve('o');
      },
      { key: () => ['production'] }, // a sibling key that shares a string prefix
    );
    await getProduct('a');
    await getProduct('b');
    await getProduction();
    expect(calls).toBe(3);

    await cache.invalidate({ key: ['product'] });

    await getProduction(); // still cached -> no recompute
    expect(calls).toBe(3);
    await getProduct('a'); // dropped -> recompute
    await getProduct('b'); // dropped -> recompute
    expect(calls).toBe(5);
  });

  test('single-flight collapses concurrent misses', async () => {
    const cache = createCache({ store: makeStore() });
    let release!: (value: string) => void;
    let started!: () => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const called = new Promise<void>((resolve) => {
      started = resolve;
    });
    const compute = vi.fn(() => {
      started();
      return pending;
    });
    const get = cache.fn(compute, { key: () => ['k'] });
    const results = Promise.all([get(), get()]);
    await called;
    release('value');
    expect(await results).toEqual(['value', 'value']);
    expect(compute).toHaveBeenCalledOnce();
  });

  test.each([null, undefined])('caches a %s result', async (value) => {
    const cache = createCache({ store: makeStore() });
    const compute = vi.fn(() => Promise.resolve(value));
    const get = cache.fn(compute, { key: () => ['empty'] });

    expect(await get()).toBe(value);
    expect(await get()).toBe(value);
    expect(compute).toHaveBeenCalledOnce();
  });

  test('a failed fill can be retried', async () => {
    const cache = createCache({ store: makeStore() });
    const compute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue('ready');
    const get = cache.fn(compute, { key: () => ['retry'] });

    await expect(get()).rejects.toThrow('temporary failure');
    expect(await get()).toBe('ready');
    expect(await get()).toBe('ready');
    expect(compute).toHaveBeenCalledTimes(2);
  });

  test('keys preserve segment boundaries, types, and string shorthand', async () => {
    const cache = createCache({ store: makeStore() });
    let calls = 0;
    const get = cache.fn((_key: CacheKey) => ++calls, { key: (key) => key });

    expect(await get(['a:b', 'c'])).toBe(1);
    expect(await get(['a', 'b:c'])).toBe(2);
    expect(await get([1])).toBe(3);
    expect(await get(['1'])).toBe(4);
    expect(await get('a:b')).toBe(5);
    expect(await get(['a:b'])).toBe(5);
    expect(await get(['a:b', 'c'])).toBe(1);
  });

  test('TTL expiry recomputes', async () => {
    vi.useFakeTimers();
    try {
      const cache = createCache({
        store: makeStore(),
        defaults: { ttl: 1000 },
      });
      const spy = vi.fn(() => Promise.resolve(1));
      const get = cache.fn(spy, { key: () => ['k'] });
      await get();
      await get();
      expect(spy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      await get();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a function TTL overrides the cache default', async () => {
    vi.useFakeTimers();
    try {
      const cache = createCache({
        store: makeStore(),
        defaults: { ttl: 1000 },
      });
      const compute = vi.fn(() => Promise.resolve('value'));
      const get = cache.fn(compute, { key: () => ['k'], ttl: 2000 });

      await get();
      vi.advanceTimersByTime(1000);
      await get();
      expect(compute).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1000);
      await get();
      expect(compute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.each(stores)('cache.rsc (%s store)', (_name, makeStore) => {
  test('stable until content changes (invalidation re-renders new content)', async () => {
    const cache = createCache({ store: makeStore() });
    let n = 0;
    const { getEtag } = cache.rsc(() => `v${++n}`, { key: () => ['card'] });
    const e1 = await getEtag({}); // fills: content "v1"
    expect(await getEtag({})).toBe(e1); // fresh hit: same content, same tag
    await cache.invalidate({ key: ['card'] });
    expect(await getEtag({})).not.toBe(e1); // re-rendered "v2": new tag
  });

  test('re-rendering identical content keeps the same etag', async () => {
    const cache = createCache({ store: makeStore() });
    const { getEtag } = cache.rsc(() => 'same', { key: () => ['card'] });
    const e1 = await getEtag({});
    await cache.invalidate({ key: ['card'] });
    expect(await getEtag({})).toBe(e1); // identical bytes -> identical tag
  });

  test('a component and its etag share an in-flight render', async () => {
    const cache = createCache({ store: makeStore() });
    let release!: (value: string) => void;
    let started!: () => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const called = new Promise<void>((resolve) => {
      started = resolve;
    });
    const render = vi.fn(() => {
      started();
      return pending;
    });
    const { Component, getEtag } = cache.rsc(render, { key: () => ['card'] });
    const results = Promise.all([Component({}), getEtag({})]);
    await called;
    release('content');

    const [content, etag] = await results;
    expect(content).toBe('content');
    expect(await getEtag({})).toBe(etag);
    expect(await Component({})).toBe(content);
    expect(render).toHaveBeenCalledOnce();
  });

  test('a failed etag render rejects and the component can retry', async () => {
    const cache = createCache({ store: makeStore() });
    const render = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary render failure'))
      .mockResolvedValue('ready');
    const { Component, getEtag } = cache.rsc(render, { key: () => ['card'] });

    await expect(getEtag({})).rejects.toThrow('temporary render failure');
    expect(await Component({})).toBe('ready');
    expect(await getEtag({})).toEqual(expect.any(String));
    expect(render).toHaveBeenCalledTimes(2);
  });

  test('TTL expiry changes the etag and the component together', async () => {
    vi.useFakeTimers();
    try {
      const cache = createCache({ store: makeStore() });
      let calls = 0;
      const { Component, getEtag } = cache.rsc(() => `content ${++calls}`, {
        key: () => ['card'],
        ttl: 1000,
      });
      const firstEtag = await getEtag({});
      expect(await Component({})).toBe('content 1');

      vi.advanceTimersByTime(1000);

      expect(await getEtag({})).not.toBe(firstEtag);
      expect(await Component({})).toBe('content 2');
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { createStorage } from 'unstorage';
import { describe, expect, test, vi } from 'vitest';
import type { CacheEntry } from 'waku-cache';
import { unstorageStore } from 'waku-cache/stores/unstorage';

const entry = (value: string, over: Partial<CacheEntry> = {}): CacheEntry => ({
  value: new TextEncoder().encode(value),
  createdAt: Date.now(),
  ...over,
});

describe('unstorageStore', () => {
  test('round-trips arbitrary bytes through base64', async () => {
    const store = unstorageStore(createStorage());
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    await store.set(['a'], { value: bytes, createdAt: Date.now() });
    const got = await store.get(['a']);
    expect(got).not.toBeNull();
    expect([...got!.value]).toEqual([...bytes]);
  });

  test('lazy TTL expiry on read', async () => {
    vi.useFakeTimers();
    try {
      const store = unstorageStore(createStorage());
      await store.set(['a'], entry('1', { expiresAt: Date.now() + 1000 }));
      expect(await store.get(['a'])).not.toBeNull();
      vi.advanceTimersByTime(1000);
      expect(await store.get(['a'])).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('delete partial-matches at segment boundaries (via getKeys(base))', async () => {
    const store = unstorageStore(createStorage());
    await store.set(['product'], entry('p'));
    await store.set(['product', 'abc'], entry('a'));
    await store.set(['product', 'abc', 'x'], entry('x'));
    await store.set(['production'], entry('o')); // sibling
    await store.delete(['product']);
    expect(await store.get(['product'])).toBeNull();
    expect(await store.get(['product', 'abc'])).toBeNull();
    expect(await store.get(['product', 'abc', 'x'])).toBeNull();
    expect(await store.get(['production'])).not.toBeNull();
  });

  test('an empty prefix clears the cache without removing other storage keys', async () => {
    const storage = createStorage();
    const store = unstorageStore(storage);
    await store.set(['a'], entry('1'));
    await store.set(['b', 'c'], entry('2'));
    await storage.setItem('unrelated:value', 'keep');

    await store.delete([]);

    expect(await store.get(['a'])).toBeNull();
    expect(await store.get(['b', 'c'])).toBeNull();
    expect(await storage.getItem('unrelated:value')).toBe('keep');
  });
});

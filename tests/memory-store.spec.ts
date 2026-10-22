import { describe, expect, test, vi } from 'vitest';
import type { CacheEntry } from 'waku-cache';
import { memoryStore } from 'waku-cache/stores/memory';

const entry = (value: string, over: Partial<CacheEntry> = {}): CacheEntry => ({
  value: new TextEncoder().encode(value),
  createdAt: Date.now(),
  ...over,
});

const read = (e: CacheEntry | null) =>
  e ? new TextDecoder().decode(e.value) : null;

describe('memoryStore', () => {
  test('set / get', async () => {
    const store = memoryStore();
    expect(await store.get(['a'])).toBeNull();
    await store.set(['a'], entry('1'));
    expect(read(await store.get(['a']))).toBe('1');
  });

  test('lazy TTL expiry on read', async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore();
      await store.set(['a'], entry('1', { expiresAt: Date.now() + 1000 }));
      expect(await store.get(['a'])).not.toBeNull();
      vi.advanceTimersByTime(1000);
      expect(await store.get(['a'])).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('delete partial-matches at segment boundaries', async () => {
    const store = memoryStore();
    await store.set(['product'], entry('p'));
    await store.set(['product', 'abc'], entry('a'));
    await store.set(['production'], entry('o')); // sibling, shares a string prefix
    await store.delete(['product']);
    expect(await store.get(['product'])).toBeNull();
    expect(await store.get(['product', 'abc'])).toBeNull();
    expect(await store.get(['production'])).not.toBeNull();
  });

  test('delete with an empty prefix clears everything', async () => {
    const store = memoryStore();
    await store.set(['a'], entry('1'));
    await store.set(['b', 'c'], entry('2'));
    await store.delete([]);
    expect(await store.get(['a'])).toBeNull();
    expect(await store.get(['b', 'c'])).toBeNull();
  });
});

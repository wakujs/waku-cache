import { cache } from '../../lib/cache.js';

let calls = 0;
let missingCalls = 0;

const getValues = cache.fn(
  () => ({
    generation: ++calls,
    date: new Date('2026-01-01T00:00:00.000Z'),
    map: new Map([['answer', 42]]),
    set: new Set(['a', 'b']),
    bigint: 123n,
    bytes: new Uint8Array([0, 255]),
    empty: null,
  }),
  { key: () => ['values'] },
);

const getMissing = cache.fn(
  () => {
    missingCalls++;
    return undefined;
  },
  { key: () => ['missing'] },
);

export async function GET() {
  const values = await getValues();
  const missing = await getMissing();
  return Response.json({
    generation: values.generation,
    date: values.date.toISOString(),
    map: [...values.map],
    set: [...values.set],
    bigint: values.bigint.toString(),
    bytes: [...values.bytes],
    empty: values.empty,
    missing: missing === undefined,
    missingCalls,
  });
}

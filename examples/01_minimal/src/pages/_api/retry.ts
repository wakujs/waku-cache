import { createElement } from 'react';
import { cache } from '../../lib/cache.js';

let calls = 0;

const { Component, getEtag } = cache.rsc(
  () => {
    if (++calls === 1) {
      throw new Error('Transient render failure');
    }
    return 'ready';
  },
  { key: () => ['retry'] },
);

let nestedCalls = 0;

async function FailingChild() {
  await Promise.resolve();
  if (++nestedCalls === 1) {
    throw new Error('Transient nested render failure');
  }
  return 'ready';
}

const { getEtag: getNestedEtag } = cache.rsc(
  () => createElement('div', null, createElement(FailingChild)),
  { key: () => ['retry-nested'] },
);

export async function GET(request: Request) {
  try {
    if (new URL(request.url).searchParams.has('nested')) {
      return Response.json({
        etag: await getNestedEtag({}),
        calls: nestedCalls,
      });
    }
    const etag = await getEtag({});
    return Response.json({ content: await Component({}), etag, calls });
  } catch {
    return new Response('Retry this request', { status: 503 });
  }
}

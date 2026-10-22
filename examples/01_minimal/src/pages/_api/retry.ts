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

export async function GET() {
  try {
    const etag = await getEtag({});
    return Response.json({ content: await Component({}), etag, calls });
  } catch {
    return new Response('Retry this request', { status: 503 });
  }
}

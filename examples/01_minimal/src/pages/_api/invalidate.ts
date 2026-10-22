import { cache } from '../../lib/cache.js';

export async function POST() {
  await cache.invalidate({ key: ['cached-page'] });
  return new Response('ok');
}

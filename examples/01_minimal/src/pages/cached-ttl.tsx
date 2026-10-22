import { Link } from 'waku';
import { cache } from '../lib/cache.js';

let renderCount = 0;

const CachedTtlContent = () => {
  ++renderCount;
  return (
    <div>
      <h1>Cached (TTL)</h1>
      <p data-testid="cached-ttl-content">cached-ttl render #{renderCount}</p>
      <p>
        <Link to="/" data-testid="ttl-to-home">
          Go home
        </Link>
      </p>
    </div>
  );
};

const { Component, getEtag } = cache.rsc(CachedTtlContent, {
  key: () => ['cached-ttl-page'],
  ttl: 5000,
});

export default Component;

export const getConfig = () => {
  return {
    render: 'dynamic',
    unstable_getEtag: getEtag,
  } as const;
};

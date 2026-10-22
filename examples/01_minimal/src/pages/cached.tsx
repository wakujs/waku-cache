import { use } from 'react';
import { Link } from 'waku';
import { Counter } from '../components/counter.js';
import { cache } from '../lib/cache.js';

let renderCount = 0;
let nestedRenderCount = 0;
const heading = Promise.resolve('Cached');

const NestedContent = async () => (
  <p data-testid="nested-content">nested render #{++nestedRenderCount}</p>
);

const CachedContent = () => {
  const title = use(heading);
  ++renderCount;
  return (
    <div>
      <h1>{title}</h1>
      <p data-testid="cached-content">cached render #{renderCount}</p>
      <NestedContent />
      <Counter />
      <p>
        <Link to="/" data-testid="to-home">
          Go home
        </Link>
      </p>
    </div>
  );
};

const { Component, getEtag } = cache.rsc(CachedContent, {
  key: () => ['cached-page'],
});

export default Component;

export const getConfig = () => {
  return {
    render: 'dynamic',
    unstable_getEtag: getEtag,
  } as const;
};

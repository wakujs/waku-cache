import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^waku-cache\/stores\/(.*)$/,
        replacement: resolve('src/stores') + '/$1',
      },
      { find: 'waku-cache', replacement: resolve('src/index') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.{ts,tsx}'],
  },
});

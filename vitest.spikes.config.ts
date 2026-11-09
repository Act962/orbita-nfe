import { defineConfig } from 'vitest/config';

// Spikes da Fase 1 (spikes/README.md): exigem Docker e, opcionalmente, openssl.
export default defineConfig({
  test: {
    include: ['spikes/**/*.spike.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

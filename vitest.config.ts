import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main/api.ts'],
      thresholds: {
        // docs/architecture/10: domínio e application ≥ 90% de branches.
        'src/**/domain/**': { branches: 90, statements: 90 },
      },
    },
  },
});

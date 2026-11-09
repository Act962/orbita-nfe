import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // PostgreSQL real via Testcontainers (requer Docker). ADR-0004 / ADR-0011.
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main/api.ts', 'src/db/migrate.ts', 'src/db/schema.ts'],
      thresholds: {
        // docs/architecture/10: domínio e application ≥ 90% de branches.
        'src/**/domain/**': { branches: 90, statements: 90 },
      },
    },
  },
});

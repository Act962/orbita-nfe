// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Logs passam pelo logger com redaction (docs/architecture/13 §7). console.* é proibido.
      'no-console': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Domínio: sem dependências de Node, frameworks ou infraestrutura (ADR-0002).
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'O domínio não pode depender de APIs do Node.' },
            {
              group: ['fastify*', 'zod', 'pino*', 'drizzle-orm*', 'pg', 'undici'],
              message: 'O domínio não pode depender de frameworks ou infraestrutura.',
            },
          ],
        },
      ],
    },
  },
  {
    // Spikes (código temporário, spikes/README.md) imprimem medições nos testes.
    files: ['spikes/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', require: 'readonly' } },
  },
);

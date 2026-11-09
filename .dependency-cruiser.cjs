/**
 * Regras de camadas e de módulos (ADR-0001 / ADR-0002 / docs/architecture/01 §3).
 * Uma violação quebra o CI.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment: 'domain só importa domain (do próprio módulo ou de shared/domain).',
      severity: 'error',
      from: { path: '^src/(shared|modules/[^/]+)/domain/' },
      to: { pathNot: ['^src/(shared|modules/[^/]+)/domain/', '^node_modules/decimal\\.js'] },
    },
    {
      name: 'application-no-outer-layers',
      comment: 'application não conhece infrastructure nem presentation.',
      severity: 'error',
      from: { path: '^src/(shared|modules/[^/]+)/application/' },
      to: { path: '^src/(shared|modules/[^/]+)/(infrastructure|presentation)/' },
    },
    {
      name: 'no-cross-module-internals',
      comment: 'Um módulo só acessa outro pelo seu public.ts.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/([^/]+)/', pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/public\\.ts$'] },
    },
    {
      name: 'only-main-wires',
      comment: 'Somente src/main (composition root) pode importar de src/main.',
      severity: 'error',
      from: { pathNot: '^src/main/' },
      to: { path: '^src/main/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};

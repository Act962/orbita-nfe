# 03 — Estrutura inicial de diretórios

Repositório único, pacote único (sem monorepo multi-pacote no início — ver ADR-0001).
Se/quando o NFC-e precisar rodar em um agente local do PDV (ver riscos R-07), os
módulos `shared/domain`, `dfe-sefaz` e `nfce/domain` serão extraídos para um pacote
publicável — por isso eles já nascem sem dependências de Node/infra.

```text
orbita-nfe/
├── docs/
│   ├── README.md
│   ├── ACOMPANHAMENTO.md            # status do projeto (implementado/pendente/riscos)
│   ├── architecture/                # documentos de arquitetura
│   ├── adr/                         # Architecture Decision Records
│   └── fiscal/
│       ├── fontes-oficiais.md       # registro de fontes e versões consultadas
│       └── regras/                  # cada regra fiscal implementada → origem documentada
├── resources/
│   └── fiscal/
│       ├── schemas/                 # XSDs oficiais, versionados, com SHA-256 e origem
│       │   ├── nfe/PL_009_xxx/      # pacote de liberação (nome real a confirmar)
│       │   └── nfse-nacional/vX.YY/
│       ├── webservices/             # URLs por UF/ambiente/serviço/versão (dados, não código)
│       └── catalogs/                # tabelas oficiais: cStat, municípios IBGE, cTribNac, etc.
├── src/
│   ├── main/                        # composition roots
│   │   ├── api.ts
│   │   ├── worker.ts
│   │   ├── container.ts             # fábricas explícitas
│   │   └── config.ts                # config validada por Zod (fail fast)
│   ├── shared/
│   │   ├── domain/                  # Result, DomainError, Decimal/Money, Cnpj, Cpf, Uf, CodigoIbge, Clock, Id
│   │   ├── application/             # UnitOfWork, JobQueue, EventPublisher, CorrelationContext (portas)
│   │   └── infrastructure/          # db (drizzle client, tx), logger, otel, s3, kms, http-client mTLS
│   ├── modules/
│   │   ├── iam/
│   │   │   ├── domain/
│   │   │   ├── application/
│   │   │   ├── infrastructure/
│   │   │   ├── presentation/
│   │   │   └── public.ts            # única superfície acessível por outros módulos
│   │   ├── company/
│   │   ├── fiscal-settings/
│   │   ├── certificates/
│   │   ├── dfe-sefaz/               # shared kernel NF-e/NFC-e
│   │   ├── nfse/
│   │   │   ├── domain/
│   │   │   │   ├── service-invoice.ts       # agregado
│   │   │   │   ├── service-invoice-status.ts# máquina de estados
│   │   │   │   ├── dps-id.ts
│   │   │   │   └── events/
│   │   │   ├── application/
│   │   │   │   ├── commands/ (issue, cancel, reconcile, process-submission)
│   │   │   │   ├── queries/
│   │   │   │   └── ports/ (nfse-gateway.ts, service-invoice-repository.ts)
│   │   │   ├── infrastructure/
│   │   │   │   ├── persistence/ (drizzle schema + repository)
│   │   │   │   └── gateways/
│   │   │   │       ├── national/    # Sefin Nacional / ADN
│   │   │   │       ├── fake/        # simulador para dev/test
│   │   │   │       └── municipal/<provedor>/   # somente quando necessário
│   │   │   └── presentation/ (http routes, job handlers)
│   │   ├── nfe/
│   │   ├── nfce/
│   │   ├── archive/
│   │   ├── notifications/
│   │   └── audit/
│   └── db/
│       ├── schema.ts                # re-export dos schemas Drizzle de cada módulo (para drizzle-kit)
│       └── migrations/              # SQL gerado + revisado (inclui RLS, triggers, grants)
├── test/
│   ├── fixtures/fiscal/             # XMLs oficiais/anonimizados e retornos reais
│   ├── support/                     # testcontainers, builders, fakes
│   ├── integration/
│   ├── contract/                    # suites de contrato por porta (rodam contra fake e homologação)
│   └── e2e/
├── tools/
│   └── fake-authorities/            # servidor simulador SEFAZ/NFS-e com modos de falha
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml           # postgres, minio, redis, fake-authorities
├── .github/workflows/ci.yml
├── drizzle.config.ts
├── vitest.config.ts
├── tsconfig.json
├── .dependency-cruiser.cjs          # regras de camadas e de módulos
└── package.json
```

## Convenções

- Nomes de código em **inglês** (padrão do ecossistema), termos fiscais oficiais preservados quando não houver tradução fiel: `Dps`, `AccessKey` (chave de acesso), `cStat`, `Csc`, `Danfe`. Glossário em `docs/fiscal/glossario.md` (a criar na Fase 1).
- Documentação em **português**.
- Cada arquivo de regra fiscal no domínio referencia `docs/fiscal/regras/<id>.md` (origem: manual, versão, seção, NT).

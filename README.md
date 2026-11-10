# orbita-nfe — Motor Fiscal

Motor fiscal brasileiro próprio (NFS-e, NFC-e, NF-e) consumido por Orbita, NERP e futuros sistemas através de uma única API.

> **Aviso**: este software emite documentos fiscais oficiais. Validação local não confere validade fiscal; somente a autorização do órgão oficial. A política tributária (CST, alíquotas, enquadramentos) é responsabilidade do emitente e do seu contador.

## Documentação
Toda a arquitetura, ADRs, riscos e roadmap estão em [`docs/`](docs/README.md). Status atual: [`docs/ACOMPANHAMENTO.md`](docs/ACOMPANHAMENTO.md).

## Desenvolvimento

Requisitos: Node.js 24, Docker.

```bash
npm ci
npm run check          # typecheck + lint + regras de camadas + testes (unitários + integração; requer Docker)
npm run spikes         # spikes da Fase 1 (requer Docker e PostgreSQL local na porta 15432)
npm run test:coverage
docker compose -f docker/docker-compose.yml up -d   # PostgreSQL (com bootstrap de papéis) + S3 local
cp .env.example .env && npm run db:migrate          # migrations com o dono das tabelas
npm run dev:api                                     # documentação em http://localhost:3000/docs/
```

Regras do projeto (resumo):
- Domínio sem dependências de infraestrutura (verificado por `npm run deps` e ESLint).
- Nenhuma regra fiscal sem fonte oficial registrada em `docs/fiscal/` e sem teste.
- Nenhum segredo em log: o teste canário (`test/support/canary.ts`) falha o CI se algum vazar.
- Sem dependências GPL/AGPL (ADR-0023).
- Erros da API sempre em problem+json com `code` estável; nunca erro genérico nem do Drizzle (ADR-0024).

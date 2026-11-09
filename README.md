# orbita-nfe — Motor Fiscal

Motor fiscal brasileiro próprio (NFS-e, NFC-e, NF-e) consumido por Orbita, NERP e futuros sistemas através de uma única API.

> **Aviso**: este software emite documentos fiscais oficiais. Validação local não confere validade fiscal; somente a autorização do órgão oficial. A política tributária (CST, alíquotas, enquadramentos) é responsabilidade do emitente e do seu contador.

## Documentação
Toda a arquitetura, ADRs, riscos e roadmap estão em [`docs/`](docs/README.md). Status atual: [`docs/ACOMPANHAMENTO.md`](docs/ACOMPANHAMENTO.md).

## Desenvolvimento

Requisitos: Node.js 24, Docker.

```bash
npm ci
npm run check          # typecheck + lint + regras de camadas + testes
npm run spikes         # spikes da Fase 1 (requer Docker e PostgreSQL local na porta 54329)
npm run test:coverage
docker compose -f docker/docker-compose.yml up -d   # PostgreSQL + S3 local
npm run dev:api
```

Regras do projeto (resumo):
- Domínio sem dependências de infraestrutura (verificado por `npm run deps` e ESLint).
- Nenhuma regra fiscal sem fonte oficial registrada em `docs/fiscal/` e sem teste.
- Nenhum segredo em log: o teste canário (`test/support/canary.ts`) falha o CI se algum vazar.
- Sem dependências GPL/AGPL (ADR-0023).

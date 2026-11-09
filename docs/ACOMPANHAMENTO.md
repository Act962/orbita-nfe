# Acompanhamento do projeto

Última atualização: 2026-11-09

## Status geral
**Fase 1 — Fundação em andamento** (iniciada em 2026-11-09 após aprovação da arquitetura consolidada e do ADR-0023).

## Fase 1 — progresso
### Concluído (semana 1–2 do plano)
- [x] Repositório git, Node 24, TypeScript strict (ESM/NodeNext), scripts `npm run check`.
- [x] ESLint (type-checked) com `no-console` e bloqueio de imports de infraestrutura no domínio.
- [x] dependency-cruiser: domínio puro, application sem camadas externas, módulos só via `public.ts`, composition root exclusivo, sem ciclos. **Testado com violações propositais** (as três foram detectadas).
- [x] Vitest + fast-check + cobertura com meta de 90% de branches no domínio.
- [x] Shared domain: `Result`, `ValidationIssue`, `Cnpj` (numérico e alfanumérico, regra [CNPJ-001](fiscal/regras/CNPJ-001.md), exemplo da RFB validado), `Decimal` (sem `number`, arredondamento sempre explícito).
- [x] Config validada com Zod (fail fast, sem ecoar valores).
- [x] Logger pino com sanitização profunda + **teste canário**. O teste encontrou um vazamento real: o pino não aplica `formatters.bindings` em loggers filhos; corrigido com sanitização final em `hooks.streamWrite`.
- [x] API Fastify: correlation id (validado), erros RFC 9457 com código estável, 404, 500 sem vazar detalhe, `/health/live` e `/health/ready` (com timeout e sem expor erro).
- [x] Dockerfile multi-stage (usuário não-root), testado localmente: imagem sobe e responde ao health check.
- [x] Docker Compose dev (PostgreSQL 17, SeaweedFS 4.50) e CI no GitHub Actions (typecheck, lint, camadas, testes com cobertura, `npm audit`, build da imagem).

Resultado atual: 48 testes passando; cobertura geral 94,7% de linhas.

### Spikes obrigatórios — concluídos (2026-11-09)
Os quatro foram aprovados, com 41 testes ([resultados](spikes/resultados-fase1.md)):
- [x] **01** PKCS#12 em memória (inclusive legado RC2) + XMLDSig **verificado pelo xmlsec1**.
- [x] **02** mTLS com classificação da fase de falha; nenhum envio duplicado; achado do TLS 1.3 registrado no ADR-0022.
- [x] **03** XSD com include/import via libxml2/wasm (cerca de 88 ms/doc) + parser seguro contra XXE.
- [x] **04** pg-boss com enqueue na transação (COMMIT/ROLLBACK), `exclusive` + `singletonKey` e DLQ.

ADRs atualizados: 0005 (pg-boss confirmado), 0009, 0014 (aceito), 0022.

### Persistência, isolamento e padrão de erros da API — concluído (2026-11-09)
- [x] Drizzle ORM + Drizzle Kit somente na infraestrutura; migrations versionadas (`0000_taxpayer_tables` gerada e revisada; `0001_security_roles_rls` em SQL explícito).
- [x] Papéis `fiscal_owner` (sem superuser), `fiscal_api/worker/general/system` (sem BYPASSRLS), RLS `ENABLE` + `FORCE`, política *fail-closed* via `app_current_tenant()`, sem `DELETE` para a aplicação.
- [x] `TenantTransactions`: contexto de tenant por transação (`set_config(..., true)`), sem vazamento no pool.
- [x] Testcontainers (PostgreSQL 17) com a topologia de produção; **meta-teste de RLS** + "teste do teste" (4 cenários de falha detectados).
- [x] Testes de isolamento com o papel real da aplicação: leitura, INSERT/UPDATE cruzados, DELETE negado, pool, concorrência, FORCE sobre o dono.
- [x] **Erros da API sem genéricos nem erros do Drizzle** (ADR-0024): validação Fastify + Zod (body, params, query, headers e **resposta**), mensagens em pt-BR, hierarquia de erros de aplicação com códigos estáveis, tradução de SQLSTATE, constraint não mapeada = bug.
- [x] **Teste canário encontrou o 2º vazamento real**: erro bruto do Drizzle gravava query e parâmetros no log. Corrigido na sanitização dos logs.
- [x] **Documentação da API com Scalar** em `/docs/` + OpenAPI 3.1 em `/docs/openapi.json`, gerada dos schemas Zod, sem CDN, sem recursos de nuvem da Scalar. Conferida no navegador.
- [x] Runbook [bootstrap-banco.md](runbooks/bootstrap-banco.md); imagem Docker leva as migrations; ambiente local com a mesma topologia.

Resultado: 108+ testes (unitários + integração com PostgreSQL real), cobertura geral ≈ 96% de linhas.

### Atividades permanentes (valem para todo endpoint novo)
- [ ] Toda rota declara schemas Zod para body/params/querystring/headers **e** para cada status de resposta, inclusive erros (`ProblemSchema`).
- [ ] Todo erro esperado é um `ApplicationError` com `code` estável registrado no [catálogo](architecture/11-api.md#catálogo-de-códigos-de-erro) e coberto por teste.
- [ ] Todo repository declara o mapa `constraint → erro de negócio` das constraints que podem ocorrer; operações de banco passam por `TenantTransactions`/`withDatabaseErrors`.
- [ ] Toda tabela nova com `tenant_id` ganha RLS na migration de segurança (o meta-teste bloqueia o build se faltar).
- [ ] A rota aparece corretamente no Scalar (`/docs/`) com resumo, descrição e tag.

### Próximos passos (ordem)
1. ~~Spikes obrigatórios~~ ✔
2. ~~Drizzle + migrations + papéis de banco + RLS + meta-teste de schema + Testcontainers~~ ✔
3. IAM, Taxpayer, Fiscal Settings, matriz de isolamento da API.
4. Certificate Vault, Audit log, fila/outbox/write-ahead, webhooks, endpoints `ops`.
5. Deploy no Coolify, backup WAL, runbooks.

### Versões adotadas
Node 24.12, TypeScript 6.0, Fastify 5.12, Zod 4.6, fastify-type-provider-zod 7.0, pino 10.4, Vitest 5.1, ESLint 10, decimal.js 10.6 (fixadas no `package-lock.json`).

## Implementado (Fase 0)
- [x] Documentação de arquitetura (`docs/architecture/01..15`)
- [x] Aprofundamentos: recuperação `UNKNOWN` (12), certificados A1 (13), integridade e isolamento (14), infraestrutura (15)
- [x] Investigação NFS-e Teresina (`docs/fiscal/nfse-teresina.md`)
- [x] ADRs 0001–0022
- [x] Roadmap revisado (1 dev + agente + especialista pontual)
- [x] Avaliação de 5 repositórios de terceiros ([fiscal/avaliacao-repositorios.md](fiscal/avaliacao-repositorios.md)) + ADR-0023 (proposto)

## Decisões tomadas
| Data | Decisão | ADR |
|---|---|---|
| 2026-11-09 | Monólito modular, API e workers separados, PostgreSQL + fila persistente | 0001, 0005 |
| 2026-11-09 | Drizzle ORM + Drizzle Kit, somente na infraestrutura | 0004 |
| 2026-11-09 | Idempotência + UNKNOWN + write-ahead de tentativas | 0006, 0007, 0022 |
| 2026-11-09 | RLS com testes rigorosos de isolamento como gate | 0011 |
| 2026-11-09 | Envelope encryption com KEK assimétrica; workers separados por privilégio | 0009, 0021 |
| 2026-11-09 | Motor não decide política tributária, mas valida dados, consistência, matemática e leiaute | 0018 |
| 2026-11-09 | Piloto NFS-e Teresina: API Nacional (Simples) primeiro, emissor municipal depois | 0017 |
| 2026-11-09 | VPS Hostinger + Coolify; Redis adiado; S3 externo | 0020, 0010 |
| 2026-11-09 | NFC-e Piauí: motor central primeiro, contingência local NERP/Tauri preparada | 0019 |

## Pendente de decisão do responsável
1. ~~Aprovação final da arquitetura consolidada~~ — aprovada em 2026-11-09.
2. Provedor S3 (recomendado Backblaze B2; alternativa AWS S3 sa-east-1) e parecer LGPD se fora do Brasil.
3. CNPJ real + certificado A1 para a produção restrita da NFS-e (dados de nota fictícios).
4. Contato com a SEMF Teresina para o manual do webservice municipal.

## Riscos ativos principais
R-01 duplicidade · R-03 Reforma Tributária · R-07 NFC-e offline · R-17 VPS única · R-19 Teresina em transição · R-21 obrigação Simples já vigente. Ver [riscos.md](riscos.md).

## Código temporário / dívidas registradas
| Item | Finalidade | Remoção |
|---|---|---|
| `spikes/` (+ job `spikes` no CI, `vitest.spikes.config.ts`) | Provas técnicas da Fase 1 | Promover a adapters em `src/` com testes definitivos e apagar até o fim da Fase 1 |
| Vulnerabilidade moderada `minimatch` (cadeia do ESLint, só em desenvolvimento) | — | Atualizar quando o ESLint publicar a correção; o CI audita só dependências de produção |
| Porta do PostgreSQL local alterada para 54329 | Evitar conflito com outro PostgreSQL na máquina de desenvolvimento | Configurável por `POSTGRES_PORT` |

## Evidências de homologação
Nenhuma ainda.

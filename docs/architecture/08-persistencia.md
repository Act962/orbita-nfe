# 08 — Estratégia de persistência

## 1. Princípios
- Drizzle **somente** em `modules/*/infrastructure/persistence`. Repositories mapeiam linha ↔ agregado explicitamente (mappers), sem expor tipos Drizzle.
- Repositories orientados a casos de uso (`ServiceInvoiceRepository.findForProcessing(id)`, `.saveTransition(invoice, expectedVersion)`), não `GenericRepository<T>`.
- `UnitOfWork` (porta) = transação PostgreSQL; repositories recebem o executor da transação.
- Migrations geradas pelo Drizzle Kit **e revisadas**; RLS, triggers, grants e índices parciais escritos em SQL explícito nas migrations.

## 2. Multi-tenancy
- Schema compartilhado, coluna `tenant_id NOT NULL` em toda tabela de tenant.
- **Row-Level Security** ativado nessas tabelas: `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. A aplicação faz `SET LOCAL app.tenant_id` no início de cada transação. Defesa em profundidade: mesmo um bug de query não vaza dados entre empresas.
- Papel de banco da aplicação **sem** `BYPASSRLS`; jobs de sistema que varrem todos os tenants (reconciliação) usam papel separado e explícito, auditado.
- FKs compostas `(tenant_id, id)` onde fizer sentido para impedir referência cruzada entre tenants.

## 3. Tabelas principais (esboço)
| Tabela | Destaques |
|---|---|
| `tenants`, `establishments`, `state_registrations` | `UNIQUE (cnpj)` por estabelecimento ativo |
| `client_applications`, `credentials`, `tenant_grants` | hash da credencial, escopos |
| `document_series` | `UNIQUE (establishment_id, kind, environment, series)`; `next_number` |
| `service_invoices` | `UNIQUE (tenant_id, client_application_id, idempotency_key)`; `UNIQUE (establishment_id, environment, series, number)`; `UNIQUE (dps_id)`; `version` (lock otimista); `status`; payload em `jsonb` **imutável** após aceitação |
| `processing_attempts` | append-only: fase, início/fim, hash do payload enviado, classificação, `cStat`, latência, referência ao S3 |
| `fiscal_events` | cancelamentos etc., `UNIQUE` por (documento, tipo, sequência) |
| `artifacts` | metadados de objetos S3: tipo, chave, sha256, tamanho, content-type |
| `certificates` | metadados + material criptografado (ou ref S3) + `wrapped_dek`, `kek_id` |
| `outbox_events`, `webhook_subscriptions`, `webhook_deliveries` | |
| `audit_log` | append-only (REVOKE UPDATE/DELETE + trigger), `prev_hash`/`hash` encadeado por tenant |
| `idempotency_keys` | (tenant, app, key) → hash do request, resposta, expiração |

## 4. Numeração
```sql
UPDATE document_series
   SET next_number = next_number + 1
 WHERE id = $1 AND status = 'ACTIVE'
RETURNING next_number - 1 AS allocated;
```
Executado dentro da transação de aceitação: se a transação falhar, o número não é
consumido. Lacunas que ocorram depois (documento `FAILED` com número já reservado) são
tratadas por regra de cada modalidade: NF-e/NFC-e → inutilização; NFS-e → conforme manual
nacional (a confirmar). Contenção na linha da série é aceitável para o volume esperado;
reavaliar com teste de carga.

## 5. Concorrência
- Lock otimista (`version`) nos agregados de documento.
- `SKIP LOCKED` para jobs.
- `pg_advisory_xact_lock` apenas em operações raras (ex.: rotação de certificado).
- Isolamento padrão `READ COMMITTED` + constraints; `SERIALIZABLE` onde um caso de uso provar necessidade.

## 6. Índices iniciais
Parciais por status ativo (`WHERE status IN ('PENDING','PROCESSING','UNKNOWN')`) para o
reconciliador; `(tenant_id, created_at DESC)` para listagem; por chave de acesso.

## 7. Testes
Repositories testados contra PostgreSQL real (Testcontainers), incluindo: RLS bloqueando
acesso cruzado, constraints de unicidade sob concorrência, migrações aplicadas do zero.

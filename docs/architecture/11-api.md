# 11 — API pública interna (proposta)

Versionada por path (`/v1`), JSON, OpenAPI 3.1 gerado dos schemas Zod e publicado em `/docs`.
Recursos separados por modalidade (contratos diferentes), com consulta unificada opcional.

## Endpoints iniciais
| Método | Rota | Escopo |
|---|---|---|
| POST | `/v1/service-invoices` | `nfse:issue` — **implementado** (contrato v1, ADR-0033) |
| GET | `/v1/service-invoices/{id}` | `nfse:read` — **implementado** (404 para outra aplicação ou outro ambiente) |
| POST | `/v1/service-invoices/{id}/cancellation` | `nfse:cancel` — **implementado** (ADR-0035) |
| GET | `/v1/service-invoices/{id}/cancellation` | `nfse:read` — **implementado** |
| POST | `/v1/service-invoices/{id}/substitution` | `nfse:issue` — **implementado** (ADR-0036) |
| GET | `/v1/service-invoices/{id}/xml` | `nfse:read` → redirect para URL pré-assinada |
| GET | `/v1/service-invoices/{id}/pdf` | `nfse:read` |
| POST | `/v1/product-invoices` / `/v1/consumer-invoices` | Fases 4 e 3 |
| POST | `/v1/product-invoices/{id}/correction-letters` | NF-e apenas |
| POST | `/v1/number-voidings` | NF-e/NFC-e |
| GET | `/v1/fiscal-documents?status=&kind=&from=&to=&cursor=` | listagem unificada, paginação por cursor |
| POST | `/v1/companies` (sem `X-Company-Id`; concede a empresa à aplicação criadora) | `companies:create` — **implementado** |
| GET | `/v1/company` (empresa do `X-Company-Id`) | `companies:read` — **implementado** |
| POST / GET | `/v1/establishments`, `/v1/establishments/{establishmentId}` | `companies:manage` / `companies:read` — **implementado** |
| POST / GET | `/v1/establishments/{establishmentId}/document-series` | `fiscal-settings:manage` / `fiscal-settings:read` — **implementado** |
| POST / GET | `/v1/establishments/{establishmentId}/certificates`, `.../certificates/{certificateId}` | `certificates:manage` / `certificates:read` — **implementado** (upload responde 202 `PENDING_VALIDATION`) |
| POST | `/v1/establishments/{establishmentId}/certificates/{certificateId}/revocation` | `certificates:manage` — **implementado** |
| GET | `/v1/webhook-event-types` (catálogo e calendário de reentrega; sem empresa) | `webhooks:read` — **implementado** |
| POST / GET / PATCH | `/v1/webhook-subscriptions`, `/v1/webhook-subscriptions/{id}` | `webhooks:manage` / `webhooks:read` — **implementado** |
| POST | `/v1/webhook-subscriptions/{id}/secret-rotation`, `/v1/webhook-subscriptions/{id}/test` | `webhooks:manage` — **implementado** |
| GET / POST | `/v1/webhook-deliveries`, `/v1/webhook-deliveries/{id}`, `/v1/webhook-deliveries/{id}/redeliver` | `webhooks:read` / `webhooks:manage` — **implementado** |
| GET | `/health/live`, `/health/ready`, `/metrics` | interno |

## Convenções
- `Idempotency-Key` **obrigatório** em todo POST que cria documento ou evento fiscal.
- `Authorization: Bearer fk_<live|test>_<keyId>_<segredo>` em toda rota `/v1` (padrão fechado: rota sem `config.auth` impede a API de subir). Runbook: [credenciais-api.md](../runbooks/credenciais-api.md).
- `X-Company-Id` obrigatório nas rotas de empresa; validado contra a concessão da aplicação **a cada requisição** (sem cache). Ordem: credencial (401) → escopo (403) → header (400) → concessão (403).
- `X-Correlation-Id` opcional (gerado se ausente, sempre devolvido).
- Emissão retorna `201` quando o resultado final sai dentro do `Prefer: wait=<s>` (máx. curto; padrão curto na NFC-e/PDV) e `202` + `Location` quando ainda processa ([ADR-0026](../adr/0026-convencoes-api-referencia-mercado.md)).
- `externalReference` (id do documento no sistema de origem) única por (empresa, aplicação, modalidade); consulta `GET /v1/<modalidade>/by-reference/{ref}`; reuso só após falha definitiva (ADR-0026).
- Ambiente fiscal derivado da credencial: chave `test` → homologação; `live` → produção (ADR-0026).
- Erros no formato RFC 9457 (`application/problem+json`) com `code` estável (`VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REUSED`, `CERTIFICATE_EXPIRED`, `COMPANY_ACCESS_DENIED`…). Rejeições fiscais não são erro HTTP: o documento existe com `status: REJECTED` e `rejection: { code, message, source }`.
- Valores monetários como **string decimal** (`"1234.50"`), nunca number.
- Respostas não incluem XML embutido; usam links.

## Exemplo (NFS-e — campos ilustrativos, contrato final na Fase 2)
```json
POST /v1/service-invoices
{
  "establishmentId": "0192f…",
  "series": "1",
  "competenceDate": "2026-11-09",
  "taker": { "document": { "type": "CNPJ", "number": "…" }, "name": "…", "address": { … } },
  "service": { "nationalTaxCode": "…", "description": "…", "municipalityCode": "…" },
  "values": { "serviceAmount": "1500.00", "taxes": { … } },
  "externalReference": "orbita:invoice:8812"
}
→ 202 { "id": "0192f…", "status": "PENDING", "links": { "self": "/v1/service-invoices/0192f…" } }
```

## Documentação interativa (ADR-0024)
- Interface **Scalar**: `GET /docs/`, documento OpenAPI 3.1: `GET /docs/openapi.json` (ou `.yaml`).
- Gerada dos schemas Zod das rotas: o contrato validado é o contrato documentado.
- Controlada por `API_DOCS_ENABLED`; recursos de nuvem da Scalar desligados.

## Catálogo de códigos de erro
Todas as respostas de erro: `application/problem+json` com `type`, `title`, `status`, `code`, `instance`, `correlationId` e, quando houver, `issues[]` (`field`, `code`, `message`, `ruleId`; `hint` com a orientação de correção vinda do catálogo de regras).

| HTTP | `code` | Quando |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body, params, querystring ou headers fora do schema Zod; `issues[]` lista cada campo (`body.taker.name`, `querystring.page`...) com código derivado do Zod (`INVALID_TYPE`, `TOO_SMALL`, `INVALID_FORMAT`...) e mensagem em pt-BR |
| 400 | `MALFORMED_BODY` | JSON inválido, corpo vazio ou Content-Length inválido |
| 401 | `UNAUTHORIZED` | Credencial ausente, malformada, errada, revogada, expirada ou de aplicação desativada (mesma resposta em todos os casos; header `WWW-Authenticate: Bearer`) |
| 403 | `INSUFFICIENT_SCOPE` | Credencial sem o escopo da rota |
| 403 | `COMPANY_ACCESS_DENIED` | Sem concessão para a empresa **ou empresa inexistente** (mesma resposta) |
| 403 | `COMPANY_SUSPENDED` | Empresa suspensa |
| 404 | `ROUTE_NOT_FOUND` | Rota inexistente |
| 404 | `<RECURSO>_NOT_FOUND` | Recurso inexistente **ou de outra empresa** (nunca 403, para não revelar existência) |
| 404 | `ESTABLISHMENT_NOT_FOUND`, `DOCUMENT_SERIES_NOT_FOUND`, `CERTIFICATE_NOT_FOUND` | Inexistente ou de outra empresa |
| 409 | `COMPANY_ALREADY_REGISTERED`, `ESTABLISHMENT_ALREADY_REGISTERED`, `DOCUMENT_SERIES_ALREADY_EXISTS`, `IDEMPOTENCY_KEY_REUSED` | Conflito de negócio mapeado explicitamente |
| 422 | `ESTABLISHMENT_ROOT_MISMATCH` (COMPANY-001), `DOCUMENT_SERIES_EXHAUSTED`, `DOCUMENT_SERIES_INACTIVE`, `CERTIFICATE_ALREADY_REVOKED` | Regra de negócio |
| 400 | `VALIDATION_FAILED` com issues `CERTIFICATE_FILE_SIZE` / `CERTIFICATE_PASSWORD_LENGTH` | PFX vazio ou acima de 50 KB; senha vazia ou acima de 128 bytes |
| 409 | `CONCURRENT_UPDATE` | Conflito de concorrência (serialização/deadlock); pode repetir |
| 413 | `PAYLOAD_TOO_LARGE` | Corpo acima de `HTTP_BODY_LIMIT` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type não suportado |
| 422 | `<REGRA>` (ex.: `CERTIFICATE_EXPIRED`) | Regra de negócio/fiscal violada; `ruleId` aponta a origem documentada |
| 404 | `WEBHOOK_SUBSCRIPTION_NOT_FOUND`, `WEBHOOK_DELIVERY_NOT_FOUND` | Inexistente, de outra empresa **ou de outra aplicação** |
| 400 | `VALIDATION_FAILED` com issues `URL_NOT_HTTPS`, `URL_PRIVATE_ADDRESS`, `URL_HAS_CREDENTIALS`, `URL_HAS_FRAGMENT`, `URL_INVALID`, `URL_TOO_LONG`, `UNKNOWN_EVENT_TYPE`, `DUPLICATED` | Assinatura de webhook inválida (proteção contra SSRF) |
| 422 | `WEBHOOK_SUBSCRIPTION_LIMIT`, `WEBHOOK_SUBSCRIPTION_DISABLED` | Limite de 10 assinaturas por aplicação e empresa; assinatura desativada |
| 429 | `RATE_LIMITED` | Limite por credencial (padrão 600/min, rajada 120) ou por endereço antes da autenticação (1200/min, rajada 300); headers `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (estes também nas respostas de sucesso) |
| 503 | `DATABASE_UNAVAILABLE`, `DATABASE_TIMEOUT`, `SERVICE_UNAVAILABLE` | Dependência indisponível; header `Retry-After` |
| 500 | `INTERNAL_ERROR` | Qualquer falha não prevista (inclusive constraint não mapeada e resposta fora do schema). Sem detalhes; use o `correlationId` para suporte |

Códigos internos que **só aparecem no log** (nunca na resposta): `ROUTE_WITHOUT_AUTH_CONTEXT`, `ROUTE_WITHOUT_COMPANY_CONTEXT`, `COMPANY_CONTEXT_WITHOUT_COMPANY`, `DATABASE_UNMAPPED_UNIQUE_VIOLATION`, `DATABASE_FOREIGN_KEY_VIOLATION`, `DATABASE_INTEGRITY_VIOLATION`, `DATABASE_ACCESS_VIOLATION` (RLS/privilégio, sinal de segurança), `DATABASE_DATA_EXCEPTION`, `DATABASE_ERROR`, `AUDIT_DETAILS_REJECTED` (detalhe de auditoria com nome sensível ou tipo não permitido), `AUDIT_ACTION_UNKNOWN`, `AUDIT_WITHOUT_COMPANY_CONTEXT`.

Motivos de rejeição de certificado (campo `rejectionReason`, não é erro HTTP): ver [CERT-001](../fiscal/regras/CERT-001.md).

## Webhooks (implementado na semana 6; ADR-0015, ADR-0027 B6)
- **Eventos disponíveis:**
  - `certificate.activated`, `certificate.rejected` (com `data.reason`) e `certificate.revoked`;
  - `certificate.expiring` (30, 15, 7 e 1 dia antes; `data.thresholdDays`, `data.daysRemaining`) e `certificate.expired` (semana 7);
  - `webhook.test`, que só sai pelo endpoint de teste.
  - `service_invoice.status_changed` (ADR-0032): `data.status` = `AUTHORIZED`, `REJECTED` (`data.rejectionCode`), `FAILED` (`data.failureCode`) ou `UNKNOWN`, que significa **em verificação, não reemita**. As rotas de emissão chegam com o contrato da DPS.
- **Corpo:** `{ id, type, occurredAt, companyId, subject: { type, id }, data }`. Só identificadores e status, nunca XML ou dados pessoais.
- **Headers (Standard Webhooks):**
  - `webhook-id` = `id` do evento, igual em todas as tentativas e reenvios: o consumidor deduplica por ele;
  - `webhook-timestamp` em segundos Unix;
  - `webhook-signature: v1,<base64(HMAC-SHA256(segredo, "<id>.<timestamp>.<corpo>"))>`, com chave = bytes do base64 depois de `whsec_`.
  - O cliente deve recusar timestamp com mais de 5 minutos de diferença.
- **Calendário publicado** (também em `GET /v1/webhook-event-types`):
  - imediata, depois 1 min, 5 min, 15 min, 1 h, 3 h, 6 h e 12 h, ou seja, 8 tentativas em cerca de 22 h;
  - esgotadas, a entrega fica `FAILED` e pode ser reenviada (`/redeliver`).
- **Sucesso** = resposta 2xx em até 10 s. Redirecionamentos não são seguidos.
- **Segredo** exibido uma única vez (criação e rotação). A rotação invalida o anterior na hora.
- **Destino:** só https público (proteção contra SSRF no cadastro e de novo na resolução de DNS da entrega).

## Semana 7: ensaio, habilitação de produção, documentação e descontinuação
- **`?dryRun=true`** (ADR-0026 item 4) em `POST /v1/companies`, `/v1/establishments`, `…/document-series`, `/v1/webhook-subscriptions` e `…/production-enablements`:
  - a transação roda inteira (restrições, triggers, auditoria) e é desfeita no fim;
  - resposta `200 { dryRun: true, result }`; os erros são os do cadastro real.
  - O upload de certificado **não** tem ensaio: a validação só acontece no worker-fiscal.
- **Habilitação de produção** (ADR-0027 item 1, regra [PROD-001](../fiscal/regras/PROD-001.md)):
  - `GET` e `POST /v1/establishments/{id}/production-enablements` e `POST …/{enablementId}/revocation`;
  - escopos `production:read` e `production:manage`; alterar exige credencial `live` (`403 LIVE_CREDENTIAL_REQUIRED`);
  - erros: `422 PRODUCTION_PREREQUISITES_NOT_MET` (itens em `issues`), `409 PRODUCTION_ALREADY_ENABLED`, `404 PRODUCTION_ENABLEMENT_NOT_FOUND`.
- **Documentação para agentes** (ADR-0027 item 8):
  - `/openapi.json` (URL estável) e `/llms.txt` (índice);
  - guias em Markdown em `/guides/{guia-rapido,webhooks,versionamento,changelog}.md`, com fonte em `docs/api/`.
- **Descontinuação** (ADR-0026 item 9, política em `docs/api/versionamento.md`):
  - a rota declara `config.deprecation` e `schema.deprecated`;
  - as respostas levam `Deprecation: @<unix>` (RFC 9745), `Sunset` (RFC 8594, mínimo de 180 dias) e `Link rel="deprecation"`;
  - declaração incompleta ou prazo curto impedem a subida.

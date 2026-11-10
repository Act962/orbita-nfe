# 11 — API pública interna (proposta)

Versionada por path (`/v1`), JSON, OpenAPI 3.1 gerado dos schemas Zod e publicado em `/docs`.
Recursos separados por modalidade (contratos diferentes), com consulta unificada opcional.

## Endpoints iniciais
| Método | Rota | Escopo |
|---|---|---|
| POST | `/v1/service-invoices` | `nfse:issue` |
| GET | `/v1/service-invoices/{id}` | `nfse:read` |
| POST | `/v1/service-invoices/{id}/cancellation` | `nfse:cancel` |
| POST | `/v1/service-invoices/{id}/substitution` | `nfse:issue` (quando suportado) |
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
| CRUD | `/v1/webhook-subscriptions`, `POST /v1/webhook-deliveries/{id}/redeliver` | `webhooks:manage` |
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
| 503 | `DATABASE_UNAVAILABLE`, `DATABASE_TIMEOUT`, `SERVICE_UNAVAILABLE` | Dependência indisponível; header `Retry-After` |
| 500 | `INTERNAL_ERROR` | Qualquer falha não prevista (inclusive constraint não mapeada e resposta fora do schema). Sem detalhes; use o `correlationId` para suporte |

Códigos internos que **só aparecem no log** (nunca na resposta): `ROUTE_WITHOUT_AUTH_CONTEXT`, `ROUTE_WITHOUT_COMPANY_CONTEXT`, `COMPANY_CONTEXT_WITHOUT_COMPANY`, `DATABASE_UNMAPPED_UNIQUE_VIOLATION`, `DATABASE_FOREIGN_KEY_VIOLATION`, `DATABASE_INTEGRITY_VIOLATION`, `DATABASE_ACCESS_VIOLATION` (RLS/privilégio, sinal de segurança), `DATABASE_DATA_EXCEPTION`, `DATABASE_ERROR`, `AUDIT_DETAILS_REJECTED` (detalhe de auditoria com nome sensível ou tipo não permitido), `AUDIT_ACTION_UNKNOWN`, `AUDIT_WITHOUT_COMPANY_CONTEXT`.

Motivos de rejeição de certificado (campo `rejectionReason`, não é erro HTTP): ver [CERT-001](../fiscal/regras/CERT-001.md).

## Webhooks
Eventos: `fiscal_document.authorized`, `.rejected`, `.cancelled`, `.failed`, `.status_changed`, `certificate.expiring`.
Headers `Webhook-Id`, `Webhook-Timestamp`, `Webhook-Signature: v1=<hmac>`; tolerância de timestamp para replay; retries exponenciais; consumidor deduplica por `Webhook-Id`.

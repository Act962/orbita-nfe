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
| CRUD | `/v1/tenants`, `/v1/establishments`, `/v1/establishments/{id}/certificates`, `/v1/document-series` | `tenants:manage`, `certificates:manage` |
| CRUD | `/v1/webhook-subscriptions`, `POST /v1/webhook-deliveries/{id}/redeliver` | `webhooks:manage` |
| GET | `/health/live`, `/health/ready`, `/metrics` | interno |

## Convenções
- `Idempotency-Key` **obrigatório** em todo POST que cria documento ou evento fiscal.
- `X-Tenant-Id` obrigatório; validado contra concessões da credencial.
- `X-Correlation-Id` opcional (gerado se ausente, sempre devolvido).
- Emissão retorna `202` + `Location`; `Prefer: wait=<s>` (máx. curto) para PDV.
- Erros no formato RFC 9457 (`application/problem+json`) com `code` estável (`VALIDATION_FAILED`, `IDEMPOTENCY_KEY_REUSED`, `CERTIFICATE_EXPIRED`, `TENANT_ACCESS_DENIED`…). Rejeições fiscais não são erro HTTP: o documento existe com `status: REJECTED` e `rejection: { code, message, source }`.
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
Todas as respostas de erro: `application/problem+json` com `type`, `title`, `status`, `code`, `instance`, `correlationId` e, quando houver, `issues[]` (`field`, `code`, `message`, `ruleId`).

| HTTP | `code` | Quando |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body, params, querystring ou headers fora do schema Zod; `issues[]` lista cada campo (`body.taker.name`, `querystring.page`...) com código derivado do Zod (`INVALID_TYPE`, `TOO_SMALL`, `INVALID_FORMAT`...) e mensagem em pt-BR |
| 400 | `MALFORMED_BODY` | JSON inválido, corpo vazio ou Content-Length inválido |
| 401 | `UNAUTHORIZED` | Credencial ausente ou inválida (módulo IAM) |
| 403 | `TENANT_ACCESS_DENIED` / `FORBIDDEN` | Credencial sem concessão para o tenant ou sem escopo (IAM) |
| 404 | `ROUTE_NOT_FOUND` | Rota inexistente |
| 404 | `<RECURSO>_NOT_FOUND` | Recurso inexistente **ou de outro tenant** (nunca 403, para não revelar existência) |
| 409 | `IDEMPOTENCY_KEY_REUSED`, `ESTABLISHMENT_ALREADY_REGISTERED`, ... | Conflito de negócio mapeado explicitamente |
| 409 | `CONCURRENT_UPDATE` | Conflito de concorrência (serialização/deadlock); pode repetir |
| 413 | `PAYLOAD_TOO_LARGE` | Corpo acima de `HTTP_BODY_LIMIT` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type não suportado |
| 422 | `<REGRA>` (ex.: `CERTIFICATE_EXPIRED`) | Regra de negócio/fiscal violada; `ruleId` aponta a origem documentada |
| 503 | `DATABASE_UNAVAILABLE`, `DATABASE_TIMEOUT`, `SERVICE_UNAVAILABLE` | Dependência indisponível; header `Retry-After` |
| 500 | `INTERNAL_ERROR` | Qualquer falha não prevista (inclusive constraint não mapeada e resposta fora do schema). Sem detalhes; use o `correlationId` para suporte |

Códigos internos que **só aparecem no log** (nunca na resposta): `DATABASE_UNMAPPED_UNIQUE_VIOLATION`, `DATABASE_FOREIGN_KEY_VIOLATION`, `DATABASE_INTEGRITY_VIOLATION`, `DATABASE_ACCESS_VIOLATION` (RLS/privilégio, sinal de segurança), `DATABASE_DATA_EXCEPTION`, `DATABASE_ERROR`.

## Webhooks
Eventos: `fiscal_document.authorized`, `.rejected`, `.cancelled`, `.failed`, `.status_changed`, `certificate.expiring`.
Headers `Webhook-Id`, `Webhook-Timestamp`, `Webhook-Signature: v1=<hmac>`; tolerância de timestamp para replay; retries exponenciais; consumidor deduplica por `Webhook-Id`.

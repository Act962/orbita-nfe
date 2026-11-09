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

## Webhooks
Eventos: `fiscal_document.authorized`, `.rejected`, `.cancelled`, `.failed`, `.status_changed`, `certificate.expiring`.
Headers `Webhook-Id`, `Webhook-Timestamp`, `Webhook-Signature: v1=<hmac>`; tolerância de timestamp para replay; retries exponenciais; consumidor deduplica por `Webhook-Id`.

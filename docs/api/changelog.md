---
title: Changelog da API
status: current
last_updated: 2026-11-13
---

# Changelog da API

Mudanças da API pública por data, da mais recente para a mais antiga. Política de compatibilidade em [versionamento](/guides/versionamento.md).

## 2026-11-13 — v1 (Fase 2a, etapa 6)

**Adicionado**

- `POST /v1/service-invoices/{id}/substitution` (escopo `nfse:issue`, `Idempotency-Key` obrigatório): substituição de NFS-e autorizada (DPS com o grupo `subst`).
  - O corpo é o contrato v1 da DPS, sem `establishmentId`, mais `substitution: { reasonCode, reasonText? }`, com os códigos de TSCodJustSubst (`01` a `05` e `99`).
  - A resposta é a substituta, com `202`; a repetição devolve `200`.
  - A original vira `SUBSTITUTED` só quando a substituta é autorizada.
- Na NFS-e, os campos `substitution` (na substituta) e `substitutedById` (na original), e o status `SUBSTITUTED`.
- No webhook `service_invoice.status_changed`: status `SUBSTITUTED` com `data.substitutedById`, e `data.substitutesInvoiceId` nos eventos da substituta.
- Novos códigos de erro:
  - `422 SUBSTITUTION_LOCKED_FIELDS`: campos travados pelo Anexo I, um por `issues[]`;
  - `400 VALIDATION_FAILED` com `SUBSTITUTION_REASON_TEXT_REQUIRED`: motivo `99` sem descrição;
  - `409 SUBSTITUTION_IN_PROGRESS` e `409 CANCELLATION_IN_PROGRESS`.
- O cancelamento passa a responder `409 SUBSTITUTION_IN_PROGRESS` quando a nota tem substituta em andamento.

**Migração:** nenhuma. Quem trata `status` como enumeração fechada deve aceitar o valor novo `SUBSTITUTED`.

## 2026-11-12 — v1 (Fase 2a, etapa 5)

**Adicionado**

- `POST /v1/service-invoices/{id}/cancellation` (escopo `nfse:cancel`): cancelamento pelo evento e101101.
  - O corpo é `{ reasonCode, reasonText }`, com os valores e limites do XSD.
  - A resposta é `202`; a repetição devolve `200`.
- `GET /v1/service-invoices/{id}/cancellation` (escopo `nfse:read`).
- Status `CANCELLED` na NFS-e e no webhook `service_invoice.status_changed`.
- Webhook `service_invoice.cancellation_changed` (`REGISTERED`, `REJECTED`, `FAILED`, `UNKNOWN`).

**Migração:** nenhuma. Quem trata `status` como enumeração fechada deve aceitar o valor novo `CANCELLED`.

## 2026-11-12 — v1 (Fase 2a, etapa 4)

**Adicionado**

- Roteamento da NFS-e pela competência (ADR-0028). `POST /v1/service-invoices` pode responder `422 NFSE_CHANNEL_NOT_AVAILABLE`, antes de numerar, com o motivo em `issues[].code` (`ROUTE_CHANNEL_NOT_SUPPORTED`, `ROUTE_PENDING_CONFIRMATION`, `ROUTE_REGIME_REQUIRED`, `ROUTE_AMBIGUOUS`, `ROUTE_NOT_FOUND`).

**Migração:** para ME/EPP (`opSimpNac` 3), informe `provider.simplesNacionalRegime`. Sem ele, o pedido é recusado com `ROUTE_REGIME_REQUIRED`.

## 2026-11-12 — v1 (Fase 2a, etapa 2)

**Adicionado**

- `POST /v1/service-invoices` (escopo `nfse:issue`): emissão de NFS-e com o contrato v1 da DPS.
  - `Idempotency-Key` é obrigatório.
  - A resposta é `202` com `Location`; a repetição idempotente devolve `200`.
  - O ambiente vem da credencial.
- `GET /v1/service-invoices/{id}` (escopo `nfse:read`). Devolve 404 para nota de outra aplicação ou de outro ambiente.
- Evento de webhook `service_invoice.status_changed` (`AUTHORIZED`, `REJECTED`, `FAILED`, `UNKNOWN`).

**Observação:** nesta etapa, o autorizador ligado fora de produção é um simulador. A transmissão real à SEFIN Nacional entra com o certificado A1.

**Migração:** nenhuma. Todas as mudanças são compatíveis.

## 2026-11-11 — v1 (Fase 1, semana 7)

**Adicionado**

- Habilitação de produção por estabelecimento e modalidade:
  - `GET` e `POST /v1/establishments/{id}/production-enablements`;
  - `POST …/{enablementId}/revocation`;
  - escopos `production:read` e `production:manage`;
  - exige credencial `live` e os pré-requisitos da regra PROD-001.
- `?dryRun=true` nos cadastros: empresa, estabelecimento, série, assinatura de webhook e habilitação de produção.
- Eventos de webhook `certificate.expiring` (30, 15, 7 e 1 dia antes do vencimento) e `certificate.expired`.
- OpenAPI em URL estável (`/openapi.json`), índice para agentes (`/llms.txt`) e guias em Markdown (`/guides/`).
- Política de descontinuação com os headers `Deprecation`, `Sunset` e `Link`.

**Migração:** nenhuma. Todas as mudanças são compatíveis.

## 2026-11-10 — v1 (Fase 1, semana 6)

**Adicionado**

- Webhooks:
  - assinaturas por aplicação, com filtro por tipo de evento;
  - entregas assinadas no padrão Standard Webhooks;
  - calendário publicado de reentrega, reenvio manual e evento de teste;
  - catálogo de eventos (`certificate.activated`, `certificate.rejected`, `certificate.revoked`).
- Escopos `webhooks:read` e `webhooks:manage`.
- Rate limit por credencial e por endereço: `429` com `Retry-After` e headers `RateLimit-*`.

## 2026-11-10 — v1 (Fase 1, semanas 4 e 5)

**Adicionado**

- Empresas, estabelecimentos e séries de numeração.
- Certificados A1: o upload responde `202`, a validação é assíncrona e a API devolve só metadados; troca com sobreposição.

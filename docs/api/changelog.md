---
title: Changelog da API
status: current
last_updated: 2026-11-12
---

# Changelog da API

Mudanças da API pública por data, da mais recente para a mais antiga. Política de compatibilidade em [versionamento](/guides/versionamento.md).

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

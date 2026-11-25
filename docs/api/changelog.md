---
title: Changelog da API
status: current
last_updated: 2026-11-24
---

# Changelog da API

Mudanças da API pública por data, da mais recente para a mais antiga. Política de compatibilidade em [versionamento](/guides/versionamento.md).

## 2026-11-24 — v1 (reenvio de webhook por documento)

**Adicionado:**

- `POST /v1/webhook-deliveries/redeliveries` (`webhooks:manage`) com `{ subjectId }`: reenvia o evento mais recente do documento para cada assinatura ativa da aplicação que já o recebeu, com o mesmo `webhook-id`.
- Filtro `subjectId` em `GET /v1/webhook-deliveries`.

## 2026-11-24 — v1 (Prefer: wait no cancelamento)

**Adicionado:**

- `Prefer: wait=<segundos>` em `POST /v1/service-invoices/{id}/cancellation`: `201` se o pedido terminou dentro da espera (`REGISTERED`, `REJECTED` ou `FAILED`), `202` se não.

## 2026-11-24 — v1 (diagnóstico da nota)

**Adicionado:**

- `GET /v1/service-invoices/{id}/diagnostics`, com o escopo novo `nfse:debug`: canal, pacote de leiaute, hashes, arquivamento, cada tentativa de transmissão e todos os pedidos de cancelamento. Só metadados e códigos, sem XML e sem dados do tomador.

## 2026-11-24 — v1 (situação do autorizador)

**Adicionado:**

- `authorizerStatus { code, message, source }` na NFS-e. Na nota gerada, `code` é o `cStat` do XML (100 NFS-e Gerada, 102 Decisão Judicial, 103 Avulsa, 107 MEI, pelas descrições do XSD oficial); na rejeitada, o código e a mensagem da rejeição. `null` enquanto o autorizador não respondeu. `rejection` continua igual.

## 2026-11-24 — v1 (Prefer: wait na emissão)

**Adicionado:**

- `Prefer: wait=<segundos>` (RFC 7240, até 20 s) em `POST /v1/service-invoices` e `POST /v1/service-invoices/{id}/substitution`. Responde `201` se a nota terminou dentro da espera (`AUTHORIZED`, `REJECTED` ou `FAILED`) e `202` se ainda não, com `Preference-Applied`. Sem o cabeçalho, nada muda.

## 2026-11-24 — v1 (links na nota)

**Adicionado:**

- `links` em toda resposta com a NFS-e: `self`, `xml`, `cancellation`, `cancellationXml`, `substitutes` e `substitutedBy`. Caminhos relativos ao endereço da API, com a mesma autenticação; `null` enquanto o recurso não existe. Campo novo: mudança compatível.

## 2026-11-24 — v1 (download do XML)

**Adicionado:**

- `GET /v1/service-invoices/{id}/xml`: o XML da NFS-e devolvido pelo autorizador, também na nota cancelada ou substituída. `404 NFSE_XML_NOT_AVAILABLE` enquanto a nota não for autorizada.
- `GET /v1/service-invoices/{id}/cancellation/xml`: o XML do evento de cancelamento registrado. `404 CANCELLATION_XML_NOT_AVAILABLE` enquanto o pedido não for registrado.
- As duas respondem `application/xml` com `ETag` (SHA-256 dos bytes), `Repr-Digest` (RFC 9530) e `Cache-Control: private, no-store`.

## 2026-11-23 — v1 (consulta pela referência e validação sem efeitos)

**Adicionado:**

- `GET /v1/service-invoices?externalReference=…`: as notas da referência no ambiente da credencial, da mais nova para a mais antiga (até 50), incluindo as REJECTED e FAILED.
- `POST /v1/service-invoices/validation`: as mesmas conferências e os mesmos erros da emissão, sem numerar, gravar nem transmitir, e sem `Idempotency-Key`. Responde `200` com o canal e a série que seriam usados.

**Mudado:**

- A `externalReference` passa a ser única **por ambiente**. Uma referência ocupada em homologação não dá mais `409 DOCUMENT_IN_PROGRESS` em produção.

## 2026-11-23 — v1 (substituição pela DSF e E0065)

**Adicionado:**

- `POST /v1/service-invoices/{id}/substitution` passa a aceitar nota emitida pelo emissor municipal de Teresina (DSF). A substituta sai pela DSF.

**Corrigido** (pode recusar pedido que antes era aceito):

- E0065: a substituta que, pela tabela de roteamento, sairia por outro autorizador que não o da original (por exemplo, ao mudar de ME/EPP para não optante) é recusada com `422 NFSE_RULES_VIOLATED`, antes de numerar. Vale para a SEFIN e para a DSF.

**Sem mudança:** o cancelamento de nota da DSF continua indisponível (`NFSE_CHANNEL_NOT_AVAILABLE`); faça-o no emissor municipal.

## 2026-11-23 — v1 (prestação no exterior)

**Adicionado:**

- `service.countryCode` (cPaisPrestacao), alternativa a `service.municipalityCode`. Informe exatamente um dos dois (400 se faltar ou se vierem os dois).
- Regras novas no aceite: E0304 (país diferente de BR) e E0318.

**Corrigido** (pode recusar DPS que antes era aceita):

- E0318: com tomador ou intermediário no exterior, ou com prestação no exterior, `service.nbsCode` é obrigatório.

## 2026-11-23 — v1 (tomador no exterior e exportação)

**Adicionado** (campos opcionais):

- `taker.document` e `intermediary.document`: tipos `NIF` (`value`) e `NO_NIF` (`reason`: 1 dispensado; 2 não exigência).
- `taker.address` e `intermediary.address`: endereço no exterior, com `countryCode`, `postalCode`, `city`, `region`, `street`, `number`, `complement` e `district`.
- `service.foreignTrade`: grupo de comércio exterior (modo de prestação, vínculo, moeda, valor na moeda, mecanismos de apoio, movimentação temporária de bens, nDI, nRE e `shareWithMdic`).
- `values.issqn.resultCountryCode`: país do resultado do serviço.
- Regras novas no aceite: E0223, E0226, E0242, E0246, E0281, E0286, E0298, E0299, E0330, E0333, E0341, E0343, E0345, E0352, E0354 e E0356.

**Corrigido** (pode recusar DPS que antes era aceita):

- E1388 e E0293: o intermediário com CNPJ, e o intermediário com retenção do ISSQN, agora exigem `intermediary.address` nacional, como o Anexo I determina. Antes, essa DPS iria para o autorizador e seria rejeitada lá.
- E0204 e E0264: a retenção exige tomador ou intermediário identificado por CNPJ ou CPF (NIF não serve).

## 2026-11-23 — v1 (exigibilidade suspensa e benefício municipal)

**Adicionado** (campos opcionais em `values.issqn`):

- `suspension`: `type` (1 decisão judicial, 2 processo administrativo) e `processNumber` (30 dígitos).
- `municipalBenefit`: `id` (o nBM de 14 dígitos cadastrado pelo município) e `reduction` opcional (`AMOUNT` ou `PERCENTAGE`).
- Regras novas no aceite: E0533, E0534, E0535, E0574, E0585 e E0586 (parcial). A E0427 passa a somar a redução por benefício em valor.

## 2026-11-16 — v1 (dedução da base do ISSQN)

**Adicionado** (campo opcional):

- `values.deduction`: `{ "kind": "PERCENTAGE", "rate": "10.00" }` ou `{ "kind": "AMOUNT", "amount": "150.00" }`. O motor monta o grupo certo para o leiaute do autorizador (`vDedRed` ou `vAjusteBC`).
- Regras novas no aceite: E0427, E0435, E0436, E0438 (produção), E0445 (produção restrita) e E0453.

## 2026-11-16 — v1 (descontos e tributos federais)

**Adicionado** (campos opcionais, sem mudança para quem já integra):

- `values.discounts`: `unconditional` (desconto incondicionado) e `conditional` (desconto condicionado), com ao menos um.
- `values.federalTaxes`: `pisCofins` (`cst`, `baseAmount`, `pisRate`, `cofinsRate`, `pisAmount`, `cofinsAmount`, `retentionType`), `socialSecurityWithheld` (CP), `incomeTaxWithheld` (IRRF) e `contributionsWithheld` (PIS/COFINS/CSLL retidos), com ao menos um campo.
- Regras novas no aceite: E0428 (parcial), E0431, E0432, E0699, E0700, E0701, E0720 e E0724.

## 2026-11-16 — v1 (contrato v2 da DPS)

**Adicionado** (campos opcionais, sem mudança para quem já integra):

- `taker.address`: endereço nacional, com `municipalityCode`, `postalCode` (8 dígitos), `street`, `number`, `complement` e `district`.
- `taker.phone`: de 6 a 20 dígitos.
- `intermediary`: intermediário, com a mesma forma do tomador.
- `values.issqn.immunityType`: tipo de imunidade, de 1 a 5, só com `taxation` 2.
- Regras novas no aceite: E0248, E0262 e E0593.
- E0235, E0237, E0264 e E0592 agora só recusam quando o grupo exigido falta.

**Migração:** tomador com CNPJ, retenção (`retention` 2 ou 3) e imunidade passam a ser aceitos quando o grupo correspondente é informado. O campo de `issues[]` da E0235 e da E0237 passa a ser `taker.address`, e o da E0264 passa a ser `intermediary`.

## 2026-11-13 — v1 (Fase 2a, etapa 7)

**Adicionado**

- Regras do Anexo I no aceite de `POST /v1/service-invoices` e de `POST /v1/service-invoices/{id}/substitution` (ADR-0037).
  - A violação devolve `422 NFSE_RULES_VIOLATED`, sem consumir número.
  - Todas as violações vêm de uma vez em `issues[]`, com `code` (código de rejeição do Anexo, ex.: `E0235`), `field` e `ruleId: "NFSE-DPS"`.
  - Catálogo: [NFSE-DPS](../fiscal/regras/NFSE-DPS.md).

**Migração:** pedidos que o autorizador rejeitaria passam a ser recusados no aceite. Com o contrato v1, o tomador identificado por CNPJ, a retenção do ISSQN (`retention` 2 ou 3) e a imunidade (`taxation` 2, em produção) são recusados, porque a DPS exige grupos que só entram no contrato v2 (endereço do tomador, intermediário, tipo de imunidade).

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

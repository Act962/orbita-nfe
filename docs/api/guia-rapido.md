---
title: Guia rápido
status: current
last_updated: 2026-11-13
---

# Guia rápido

Este guia cobre o caminho mínimo: credencial, empresa, cadastro e leitura de erros. Rotas, campos e escopos estão no contrato: [`/openapi.json`](/openapi.json).

## 1. Credencial

O operador da plataforma emite a credencial da sua aplicação. Ela tem este formato:

```
fk_<live|test>_<keyId>_<segredo>
```

Envie a credencial em toda requisição:

```
Authorization: Bearer fk_test_...
```

- **O ambiente vem da credencial.** Uma chave `test` só opera em homologação; uma chave `live`, em produção. A credencial é a primeira trava contra emissão em produção por engano. A segunda é a [habilitação de produção](#5-produção-duas-travas).
- Cada credencial recebe só os escopos de que precisa (`companies:manage`, `certificates:manage`, `webhooks:manage` e outros). Faltando escopo, a resposta é `403 INSUFFICIENT_SCOPE`.
- Guarde o segredo como senha. Ele aparece uma única vez, na emissão.

## 2. Empresa e estabelecimentos

A empresa é o contribuinte, identificado pela raiz do CNPJ (8 posições). Cada estabelecimento (matriz ou filial) tem o seu CNPJ completo, com a mesma raiz.

```http
POST /v1/companies
{ "legalName": "EMPRESA EXEMPLO LTDA", "rootCnpj": "12345678" }
```

A resposta traz o `id` da empresa, gerado pelo servidor. A partir daí, toda rota de empresa exige o header:

```
X-Company-Id: <id da empresa>
```

A empresa é conferida no servidor: a credencial precisa ter concessão para ela. **CNPJ ou id enviados no corpo nunca definem a empresa.** Sem concessão, a resposta é `403 COMPANY_ACCESS_DENIED`. Recurso de outra empresa responde `404`, como se não existisse.

```http
POST /v1/establishments
X-Company-Id: <id>
{ "cnpj": "12.345.678/0001-95", "tradeName": "Matriz", "municipalityCode": "2211001" }
```

## 3. Erros

Toda resposta de erro segue a RFC 9457 (`application/problem+json`):

```json
{
  "type": "urn:orbita-nfe:problem:validation-failed",
  "title": "Requisição inválida",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "correlationId": "…",
  "issues": [{ "field": "body.cnpj", "code": "CNPJ_INVALID_CHECK_DIGITS", "message": "…", "ruleId": "CNPJ-001" }]
}
```

- Trate o erro pelo `code`, nunca pela mensagem.
- `issues[].ruleId` aponta a regra documentada que recusou o dado.
- Envie `X-Correlation-Id` para rastrear a requisição nos logs. Ele volta em toda resposta.
- `429 RATE_LIMITED` vem com `Retry-After` (segundos). Os headers `RateLimit-*` mostram o saldo de requisições.

## 4. Ensaio (`dryRun`)

Os cadastros aceitam `?dryRun=true`: empresa, estabelecimento, série, assinatura de webhook e habilitação de produção. O ensaio:

- passa pelas mesmas validações e regras do cadastro real, inclusive as restrições do banco (CNPJ repetido devolve o mesmo `409`);
- não grava nada, não dispara evento nem webhook e não deixa auditoria;
- responde `200` com `{ "dryRun": true, "result": { … } }`. O `id` em `result` é provisório e não existe no sistema. O ensaio de webhook não devolve segredo.

## 5. Produção: duas travas

Para um documento ir à produção, duas condições independentes precisam valer:

1. a requisição usa uma credencial `live`;
2. a modalidade (`NFSE_DPS`, `NFE` ou `NFCE`) está habilitada para produção no estabelecimento.

Estabelecimento novo nasce só com homologação. Para habilitar a produção:

```http
POST /v1/establishments/{id}/production-enablements
Authorization: Bearer fk_live_...
X-Company-Id: <id>
{ "kind": "NFSE_DPS", "confirmCnpj": "12.345.678/0001-95" }
```

- Exige o escopo `production:manage`.
- Pré-requisitos (regra PROD-001): estabelecimento ativo, certificado `ACTIVE` dentro da validade e série `ACTIVE` de produção da modalidade.
- `confirmCnpj` repete o CNPJ do estabelecimento, como proteção contra habilitar o estabelecimento errado.
- O que faltar volta em `issues` de um `422 PRODUCTION_PREREQUISITES_NOT_MET`.
- A revogação é `POST …/production-enablements/{enablementId}/revocation`, com o motivo. A partir dela, a modalidade volta a operar só em homologação.

## 6. Certificado A1

Envie o PFX em base64 junto com a senha:

```http
POST /v1/establishments/{id}/certificates
```

- A resposta `202` vem com status `PENDING_VALIDATION`. A validação é assíncrona: assine o evento `certificate.activated` (veja o guia de [webhooks](/guides/webhooks.md)) ou consulte o certificado.
- A API devolve só metadados: titular, validade e thumbprint. Chave privada e senha nunca saem do cofre.
- A troca de certificado tem sobreposição: o anterior só sai quando o novo é validado.
- Antes do vencimento chegam os avisos `certificate.expiring`, a 30, 15, 7 e 1 dia.

## 7. Emitir NFS-e

Pré-requisitos no estabelecimento:
- série de DPS ativa no ambiente da credencial (`kind: NFSE_DPS`);
- certificado A1 ativo;
- em produção, a habilitação da modalidade.

```http
POST /v1/service-invoices
Authorization: Bearer fk_test_...
X-Company-Id: <empresa>
Idempotency-Key: pedido-123-tentativa-1
Content-Type: application/json

{
  "establishmentId": "<estabelecimento>",
  "externalReference": "pedido-123",
  "competenceDate": "2026-11-12",
  "provider": { "simplesNacionalOption": "3", "specialTaxRegime": "0" },
  "taker": { "document": { "type": "CNPJ", "value": "<CNPJ do tomador>" }, "name": "<nome>" },
  "service": { "municipalityCode": "2211001", "nationalTaxCode": "<cTribNac>", "description": "<descrição>" },
  "values": {
    "serviceAmount": "1500.00",
    "issqn": { "taxation": "1", "retention": "1", "rate": "<alíquota>" },
    "approximateTaxes": { "kind": "AMOUNTS", "federal": "0.00", "state": "0.00", "municipal": "0.00" }
  }
}
```

- **Os valores fiscais são seus** (ou do seu contador): opção do Simples, regime, códigos, alíquota, retenção e totais aproximados. A API só confere se cada um existe no XSD oficial. A tabela de campos está no contrato v1 da DPS.
- **Resposta `202`** com `status: PENDING` e `Location`. A transmissão é assíncrona: consulte `GET /v1/service-invoices/{id}` ou assine o webhook `service_invoice.status_changed`.
- **`Idempotency-Key` é obrigatório.** Repetir a mesma chave com o mesmo corpo devolve `200` com a mesma nota. Use uma chave nova só para uma nota nova.
- **Status:**
  - `AUTHORIZED`: autorizada, com `accessKey`;
  - `REJECTED`: rejeitada pelo autorizador, com `rejection.code`;
  - `FAILED`: falha local antes de qualquer envio, com `failureCode`;
  - `UNKNOWN`: **em verificação. Não reemita.** O motor consulta o autorizador e resolve sozinho.
- **Erros:** um corpo fora do contrato ou uma DPS que não passa no XSD oficial dá `400 VALIDATION_FAILED`, sem consumir número.
- **Regras do Anexo I (ADR-0037):** o motor confere antes de numerar as regras oficiais que só dependem da DPS (por exemplo, competência futura, alíquota acima de 5%, regime especial com retenção). A violação dá `422 NFSE_RULES_VIOLATED`, com todas as regras de uma vez em `issues[]` (`code` é o código de rejeição do Anexo, como `E0015`; `field` é o campo). O catálogo completo está em [NFSE-DPS](../fiscal/regras/NFSE-DPS.md).
  - **Limite do contrato v1:** tomador identificado por CNPJ (E0235), retenção pelo tomador (E0237) ou pelo intermediário (E0264), e imunidade em produção (E0592) exigem grupos da DPS que só entram no contrato v2. Até lá, esses casos são recusados no aceite, em vez de rejeitados pela SEFIN.
- **Canal de emissão (ADR-0028):** o canal é escolhido pela tabela de roteamento, pelo município do estabelecimento, `opSimpNac`, `regApTribSN` e a **competência**. Hoje só a SEFIN Nacional está disponível. Sem canal, a resposta é `422 NFSE_CHANNEL_NOT_AVAILABLE`, sem consumir número, e o motivo vai em `issues[].code`:
  - `ROUTE_CHANNEL_NOT_SUPPORTED`: em Teresina, competência anterior a 11/2026 ou prestador não optante; use o emissor municipal;
  - `ROUTE_PENDING_CONFIRMATION`: ME/EPP fora do sublimite em Teresina, canal ainda a confirmar;
  - `ROUTE_REGIME_REQUIRED`: informe `provider.simplesNacionalRegime`;
  - `ROUTE_AMBIGUOUS` / `ROUTE_NOT_FOUND`: caso não coberto pela tabela.
- **Ambientes:** uma credencial `test` não enxerga notas de produção, e vice-versa.

## 8. Cancelar NFS-e

```http
POST /v1/service-invoices/<id>/cancellation
Authorization: Bearer fk_test_...
X-Company-Id: <empresa>
Content-Type: application/json

{ "reasonCode": "1", "reasonText": "Erro na emissão: valor digitado errado" }
```

- **Escopo:** `nfse:cancel`. Só nota `AUTHORIZED`.
- **O motivo é seu:**
  - `reasonCode` (cMotivo): `1` Erro na Emissão, `2` Serviço não Prestado ou `9` Outros;
  - `reasonText` (xMotivo): de 15 a 255 caracteres.
- **Resposta `202`** com `status: PENDING`. Acompanhe por `GET /v1/service-invoices/<id>/cancellation` ou pelo webhook `service_invoice.cancellation_changed`. Repetir o mesmo corpo devolve `200` com o mesmo pedido.
- **Status:**
  - `REGISTERED`: cancelada; a nota passa a `CANCELLED`;
  - `REJECTED`: recusado pelo autorizador (por exemplo, prazo do município), com `rejection.code`; a nota continua autorizada e você pode pedir de novo;
  - `FAILED`: falha local antes de qualquer envio;
  - `UNKNOWN`: **em verificação. Não peça de novo.** O motor consulta o autorizador e resolve.
- **Referência externa:** uma nota cancelada continua ocupando a `externalReference`. Para reemitir a mesma venda, use uma referência nova.

## 9. Substituir NFS-e

```http
POST /v1/service-invoices/<id da original>/substitution
Authorization: Bearer fk_test_...
X-Company-Id: <empresa>
Idempotency-Key: <chave nova>
Content-Type: application/json

{ "competenceDate": "2026-11-11", "provider": { ... }, "taker": { ... }, "service": { ... }, "values": { ... },
  "substitution": { "reasonCode": "99", "reasonText": "Correção da descrição do serviço" } }
```

- **Escopo:** `nfse:issue`. Só nota `AUTHORIZED`, sem cancelamento em andamento.
- **O corpo** é a DPS completa da nota nova (o mesmo contrato da emissão), sem `establishmentId`: a substituta sai do estabelecimento da original.
- **O motivo é seu:**
  - `reasonCode` (cMotivo): `01` Desenquadramento do Simples, `02` Enquadramento no Simples, `03` e `04` Inclusão e exclusão retroativa de imunidade/isenção, `05` Rejeição pelo tomador ou intermediário, `99` Outros;
  - `reasonText` (xMotivo): de 15 a 255 caracteres, obrigatório com `99`.
- **Campos que não podem mudar** dependem da opção pelo Simples da original e da substituta:
  - substituta MEI ou ME/EPP: competência, documento do tomador (se a original tinha) e valor do serviço;
  - substituta não optante: competência, `nationalTaxCode`, `municipalTaxCode` e município da prestação.
  - Se mudar, a resposta é `422 SUBSTITUTION_LOCKED_FIELDS`, com cada campo em `issues[].field` e a regra do Anexo I em `issues[].code`.
- **Resposta `202`** com a substituta em `PENDING`. A original continua `AUTHORIZED` até a substituta ser autorizada; então vira `SUBSTITUTED`, com `substitutedById`.
  - Se a substituta for rejeitada (por exemplo, prazo do município), a original segue autorizada e você pode tentar de novo.
  - Com a substituta em `UNKNOWN`, **não emita outra**: a resposta é `409 SUBSTITUTION_IN_PROGRESS` até o motor resolver.
- **Referência externa:** a original substituída continua ocupando a `externalReference`. Use outra na substituta, ou nenhuma.

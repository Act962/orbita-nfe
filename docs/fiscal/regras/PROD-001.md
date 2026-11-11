# PROD-001 — Pré-requisitos da habilitação de produção

- Implementação: `src/modules/fiscal-settings/domain/production-enablement.ts` · Testes: `test/integration/production-enablement.test.ts`
- Status: **implementada (regra de cadastro do motor, não regra fiscal)**
- Origem: ADR-0027 item 1 (habilitação de produção por estabelecimento e modalidade) e doc 14 §L5

## Natureza
Regra **de cadastro do motor**. Não vem de legislação nem de órgão autorizador, e o motor não decide nada tributário por causa dela (ADR-0018). Ela só impede habilitar a produção num estabelecimento que ainda não consegue emitir, e exige confirmação explícita do estabelecimento.

## Regra implementada
Para habilitar a modalidade `kind` (`NFSE_DPS`, `NFE` ou `NFCE`) em produção no estabelecimento, todas as condições precisam valer. Cada uma que falte volta como item de `issues` em `422 PRODUCTION_PREREQUISITES_NOT_MET`.

| Código | Condição |
|---|---|
| `PRODUCTION_CONFIRMATION_MISMATCH` | `confirmCnpj` (com ou sem máscara) é igual ao CNPJ do estabelecimento |
| `ESTABLISHMENT_INACTIVE` | o estabelecimento está `ACTIVE` |
| `PRODUCTION_CERTIFICATE_REQUIRED` | há certificado `ACTIVE` do estabelecimento com `notAfter` no futuro |
| `PRODUCTION_SERIES_REQUIRED` | há série `ACTIVE` da modalidade com ambiente `PRODUCTION` no estabelecimento |

## Condições de acesso (fora do domínio, na rota)
- Escopo `production:manage`.
- Credencial `live` (`403 LIVE_CREDENTIAL_REQUIRED`), também para revogar.

## No banco
- No máximo uma habilitação `ACTIVE` por (estabelecimento, modalidade). Repetir devolve `409 PRODUCTION_ALREADY_ENABLED`.
- Só a transição `ACTIVE → REVOKED` é permitida, com motivo de 1 a 300 caracteres. A revogação é final, e o trigger `production_enablements_guard` impede reativar ou apagar.
- O worker-fiscal só consulta (`isEnabled`). Essa é a trava L5 do pré-envio, que entra em uso na Fase 2a.

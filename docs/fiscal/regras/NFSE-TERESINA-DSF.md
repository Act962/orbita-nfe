# NFSE-TERESINA-DSF — Regras do emissor municipal de Teresina (DSF)

- Implementação: `src/modules/nfse/domain/channel-rules.ts` (`checkChannelRules`)
- Testes: `test/integration/nfse-api.test.ts` (roteamento para a DSF)
- Decisão: [ADR-0039](../../adr/0039-adapter-emissor-municipal-teresina.md)
- Status: conferida contra o portal e o diagnóstico de 2026-11-10. A confirmar no primeiro envio à homologação da DSF.

As notas do canal `MUNICIPAL_TERESINA_DSF` passam também pelas regras do Anexo I nacional ([NFSE-DPS](NFSE-DPS.md)), na versão de 09/02/2026, que é a que a SEMF linka.

| Código | Regra | Campo | Fonte |
|---|---|---|---|
| THE-001 | `cTribMun` é obrigatório | `service.municipalTaxCode` | Portal da NFS-e de Teresina, aba "Documentação da API": o código é obtido na tabela cTribNac × CNAE do portal (`…/portal/#/tabela`). Consultado em 2026-11-10 ([diagnóstico](../nfse-teresina-api-municipal-x-nacional.md) §1.5, CONFIRMADO) |

O código é escolha do contribuinte: o motor confere só a presença, nunca o valor.

## Pendências
- Confirmar no primeiro envio à homologação da DSF quais códigos de rejeição ela usa. Se forem os nacionais, também ficam confirmados os de duplicidade.

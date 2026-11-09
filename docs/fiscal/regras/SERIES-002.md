# SERIES-002 — Série e número da DPS (NFS-e Padrão Nacional)

- Implementação: `src/modules/fiscal-settings/domain/document-series.ts` · Testes: `document-series.test.ts`
- Status: **PROVISÓRIA**. Bloqueante para a emissão real: conferir com o XSD oficial da DPS na Fase 2a (gate fiscal).

## Regra implementada
1. Série da DPS (`infDPS/serie`, tipo `TSSerieDPS`): de 0 a 89999, conforme o padrão `[0-9]{1,4}|[0-8][0-9]{4}`.
2. Número da DPS (`infDPS/nDPS`, tipo `TSNumDPS`): de 1 a 999.999.999.999.999 (padrão `[1-9]{1}[0-9]{0,14}`).
3. Série (5) e número (15) compõem o identificador da DPS (`infDPS/@Id`, 45 posições).

## Fontes
| Item | Fonte | Situação |
|---|---|---|
| Padrões de `TSSerieDPS` e `TSNumDPS` | Referência de terceiros que reproduz o XSD ([buscadorncm — serie](https://buscadorncm.com.br/nfse/tags-xml/serie), [nDPS](https://buscadorncm.com.br/nfse/tags-xml/ndps)) | Secundária; **conferir no pacote XSD oficial (gov.br/nfse)** |
| Divergência | [Documentação Senior](https://documentacao.senior.com.br/gestaoempresarialerp/5.10.4/integracoes/nfs-e/leiaute.htm) indica `nDPS` com tamanho 5 | Considerada implementação do fornecedor; resolver com o XSD |

## Pendências
- Baixar o XSD oficial (NT 009, risco R-24), registrar hash em `fontes-oficiais.md` e ajustar esta regra.
- Tratamento de lacunas de numeração na NFS-e (ADR-0008, a confirmar no manual nacional).
- Normalização do motor: sem zeros à esquerda (o XSD aceita; o motor é mais restritivo para evitar séries duplicadas).

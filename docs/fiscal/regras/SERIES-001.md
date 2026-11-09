# SERIES-001 — Série e número da NF-e (modelo 55) e NFC-e (modelo 65)

- Implementação: `src/modules/fiscal-settings/domain/document-series.ts` · Testes: `document-series.test.ts`, `test/integration/fiscal-settings.test.ts`
- Status: **implementada para cadastro de séries; conferência obrigatória no MOC vigente antes da Fase 3 (NFC-e)**.

## Regra implementada
1. Série (`ide/serie`): número de 0 a 999.
2. Número (`ide/nNF`): de 1 a 999.999.999.
3. O número nunca diminui nem é reutilizado (ADR-0008; trigger `document_series_guard`).

## Fontes
| Item | Fonte | Situação |
|---|---|---|
| `nNF` de 1 a 999999999 | Leiaute do Ato COTEPE/ICMS 72/2005 (consultado via [normasbrasil](https://www.normasbrasil.com.br/norma/ato-72-2005_746.html)); o campo muda de código (B06/B08) conforme a versão do leiaute | Fonte secundária; **conferir no MOC 7.0 do Portal da NF-e** |
| `serie` de 0 a 999 | Documentações de integração de terceiros ([Senior](https://documentacao.senior.com.br/gestaoempresarialerp/5.10.4/integracoes/nf-e/leiaute-nf-e-nfc-e.htm), [NFE.io](https://nfe.io/docs/documentacao/reforma-tributaria/conceitos-funcionais/nota-fiscal-de-produto/documentacao-layout-nfe-rtc/)) | Fonte secundária; **conferir no XSD oficial** |

## NÃO implementado (fontes conflitantes)
Faixas reservadas de série (890–899 e 900–999: avulsa do Fisco, contingência, aplicativo do contribuinte). As fontes consultadas em 2026-11-09 divergem sobre o uso de cada faixa. Antes da Fase 3, confirmar no MOC e nas NTs vigentes e, se for o caso, recusar as faixas reservadas (risco R-26).

## Normalizações do motor (não são regras fiscais)
Série sem zeros à esquerda (`"1"`, não `"001"`), para que o cadastro não tenha duas séries que o documento trataria como a mesma.

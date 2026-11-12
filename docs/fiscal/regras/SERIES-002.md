# SERIES-002 — Série e número da DPS (NFS-e Padrão Nacional)

- Implementação: `src/modules/fiscal-settings/domain/document-series.ts`
- Testes: `document-series.test.ts`
- Status: **conferida contra o XSD oficial em 2026-11-10**. Resta um ajuste a fazer na Fase 2a (faixa 80000–89999, ver Pendências).

## Regra implementada
1. Série da DPS (`infDPS/serie`, tipo `TSSerieDPS`): de 0 a 89999.
2. Número da DPS (`infDPS/nDPS`, tipo `TSNumDPS`): de 1 a 999.999.999.999.999, padrão `[1-9]{1}[0-9]{0,14}`.
3. Série (5) e número (15) compõem o identificador da DPS (`infDPS/@Id`, 45 posições, `TSIdDPS`).

## Fontes oficiais (XSD em `resources/fiscal/schemas/nfse-nacional/`, hashes no MANIFEST.json)
| Item | Produção (1.01-20260209) | Produção restrita (1.01-20261020) |
|---|---|---|
| `TSNumDPS` | `[1-9]{1}[0-9]{0,14}`, maxLength 15 | idem |
| `TSSerieDPS` | `^0{0,4}\d{1,5}$`, maxLength 5 | `[0-9]{1,4}\|[0-8][0-9]{4}`, maxLength 5 (até 89999) |
| `TSIdDPS` | `DPS[0-9]{42}` | `DPS[0-9]{7}(1[0-9]{14}\|2[0-9A-Z]{14})[0-9]{20}` (CNPJ alfanumérico) |

- O nDPS bate com a regra implementada nos dois pacotes.
- A série implementada (0 a 89999, sem zeros à esquerda) é aceita pelo pacote de produção restrita e, com a errata XSD-ERRATA-001, pelo de produção.
- **Correção (2026-11-11):** no XSD 1.0, `^` e `$` não são âncoras, e isso afeta o motor. A validação de leiaute (L4) usa a libxml2, que segue a especificação: com o arquivo original de produção, **nenhuma série é aceita**, nem `1`. O teste `fiscal-schema-catalog.test.ts` reproduz o defeito. O catálogo aplica em memória a errata [XSD-ERRATA-001](../../../resources/fiscal/schemas/nfse-nacional/1.01-20260209/ERRATA.json), que só remove os dois caracteres (ADR-0013, complemento de 2026-11-11). O arquivo oficial continua intocado e conferido pelo hash.
- A divergência da documentação Senior (nDPS com tamanho 5) fica descartada: é implementação de fornecedor.

## Faixa 80000–89999
Os comunicados de implantação do gov.br/nfse (`…/documentacao-tecnica/atualizacoes-e-implantacoes`, consulta em 2026-11-10) registram:

> "Correção do Emissor Nacional Web para aceitar a faixa de série correta (entre 80000 e 89999) quando emissão indicar transcrição manual de número e série de DPS".

Ou seja, essa faixa é usada pelo Emissor Web na transcrição manual.

## Pendências
- **Fase 2a (decisão técnica do motor, não regra fiscal):** impedir séries de 80000 a 89999 nas séries criadas pelo motor, para não colidir com transcrições manuais no Emissor Web. Uma colisão resultaria na rejeição E0014.
- Tratamento de lacunas de numeração na NFS-e (ADR-0008); o manual nacional não trata do assunto.
- Normalização do motor: sem zeros à esquerda (o XSD aceita; o motor é mais restritivo para evitar séries duplicadas).

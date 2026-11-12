# ADR-0028 — Roteamento de NFS-e pela data de competência

- Status: **Aceito**
- Data: 2026-11-10
- Aprovação: responsável, em 2026-11-10

## Contexto
Em Teresina, uma mesma empresa pode ter que emitir por canais diferentes:
- competência a partir de 01/11/2026 → SEFIN Nacional;
- competência anterior → emissor municipal.

O canal depende do enquadramento no Simples e da **competência**, não da data de emissão (notícia do Portal NFS-e de 29/10/2026; regra E0039 do Anexo I de produção restrita de 20/10/2026). Essas condições mudam por norma, como a adesão do município ao Emissor Nacional ou uma nova resolução.

## Decisão
1. O canal (`NATIONAL_SEFIN` ou `MUNICIPAL_<provedor>`) é escolhido por uma **tabela de roteamento versionada**. A tabela é dado, não `if` no código. Cada linha traz:
   - município (IBGE);
   - `opSimpNac` (1, 2, 3, ou 4 quando existir);
   - `regApTribSN` (opcional);
   - faixa de **competência** (`validFrom` / `validTo`);
   - canal;
   - fonte (documento, versão, data).
2. Quem informa as entradas é o cadastro do estabelecimento ou o cliente: o enquadramento é dado do contribuinte, aprovado pelo contador (ADR-0018). **O motor não deduz o regime.**
3. O resultado do roteamento e a versão da tabela são **gravados no documento na aceitação**. Consulta, cancelamento e substituição usam o mesmo canal.
4. Sem linha aplicável, o documento é recusado na aceitação com erro de negócio explicado, por exemplo `NFSE_CHANNEL_NOT_AVAILABLE` com `hint`. Não há canal padrão implícito.
5. Linhas iniciais, cada uma com fonte:

| Município | opSimpNac | regApTribSN | Competência | Canal | Fonte |
|---|---|---|---|---|---|
| qualquer | 2 (MEI) | — | qualquer (*) | NATIONAL_SEFIN | Res. CGSN (MEI); E0039 |
| qualquer | 3 (ME/EPP) | 1 | ≥ 2026-11-01 | NATIONAL_SEFIN | Res. CGSN 191/2026; notícia de 29/10/2026; E0039 |
| 2211001 | 3 | 2 ou 3 | ≥ 2026-11-01 | **a confirmar** (a E0039 não tem exceção textual) | pendente com a SEMF e o contador |
| 2211001 | qualquer | — | < 2026-11-01 | MUNICIPAL_TERESINA_DSF (indisponível até a Fase 2b) | notícia de 29/10/2026 |
| 2211001 | 1 (não optante) | — | qualquer | MUNICIPAL_TERESINA_DSF (indisponível até a Fase 2b) | Portaria SEMF 20/2026, art. 1º |

(*) A obrigatoriedade do MEI vem de resoluções anteriores. O texto delas ainda precisa ser registrado em fontes-oficiais.

## Alternativas consideradas
- **Canal fixo por empresa.** Rejeitada: a mesma empresa muda de canal conforme a competência.
- **Rotear pela data de emissão.** Rejeitada: contraria o critério oficial.

## Consequências
- Notas retroativas e regimes fora do piloto recebem resposta clara, e não um erro do autorizador.
- A tabela precisa de revisão a cada norma nova, com registro em fontes-oficiais.

## Fontes
[Diagnóstico](../fiscal/nfse-teresina-api-municipal-x-nacional.md) §3.7 e §9; [fontes-oficiais](../fiscal/fontes-oficiais.md).

## Implementação (2026-11-12)
- **Tabela:** [`resources/fiscal/routing/nfse-routing-2026-11-10.json`](../../resources/fiscal/routing/nfse-routing-2026-11-10.json), versão `nfse-routing/2026-11-10`.
  - Transcreve as 5 linhas do item 5, cada uma com a fonte.
  - Validada na subida da API: fonte obrigatória, canal do catálogo, ids únicos, faixas não vazias.
  - Versão nova = arquivo novo + troca em `src/main/fiscal-resources.ts` + revisão deste ADR.
- **Gravação:** canal e versão da tabela são gravados na aceitação (`routing_channel`, `routing_table_version`). São imutáveis, garantido por trigger (migration 0016).
- **Recusa:** `422 NFSE_CHANNEL_NOT_AVAILABLE`, antes de numerar, com o motivo em `issues[].code`:
  - `ROUTE_CHANNEL_NOT_SUPPORTED`: canal municipal, ainda sem adapter (Fase 2b);
  - `ROUTE_PENDING_CONFIRMATION`: linha "a confirmar";
  - `ROUTE_REGIME_REQUIRED`: o canal depende de `regApTribSN`, que não foi informado;
  - `ROUTE_AMBIGUOUS`: linhas aplicáveis com canais diferentes;
  - `ROUTE_NOT_FOUND`: nenhuma linha.
- **Interpretações registradas (para revisão do responsável):**
  1. "Município" é o do **estabelecimento emitente** (`cLocEmi`), não o local da prestação.
  2. **A tabela não define precedência.** Para MEI em Teresina com competência anterior a 11/2026, casam duas linhas: `MEI-NACIONAL` (nacional) e `TERESINA-COMPETENCIA-ANTERIOR` (municipal). O motor **não escolhe** e recusa com `ROUTE_AMBIGUOUS`. Resolver exige confirmar a regra do MEI retroativo (SEMF/contador) e acrescentar ou ajustar a linha.
  3. ME/EPP (`opSimpNac` 3) sem `regApTribSN` não casa nenhuma linha de ME/EPP e é recusada pedindo o regime. Na prática, o campo, opcional no XSD, passa a ser exigido pelo roteamento para ME/EPP.

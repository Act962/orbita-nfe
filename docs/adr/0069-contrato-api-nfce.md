# ADR-0069 — Contrato da API da NFC-e (v1): o que o cliente envia e o que o motor preenche

- Status: **Aceito em parte** · Data: 2026-11-25, revisto em 2026-11-26.
  - A decisão 1 está tomada: a piloto é do Simples Nacional.
  - A decisão 2 (IBS/CBS) continua aberta e não bloqueia as fatias 1 e 2.
- Relacionados:
  - ADR-0026 (convenções da API);
  - ADR-0032 e ADR-0033 (núcleo e contrato da NFS-e, que servem de molde);
  - ADR-0062 (schemas e fonte das regras);
  - ADR-0065 (chave e assinatura);
  - ADR-0066 (QR Code);
  - ADR-0067 (contingência);
  - ADR-0068 (testes reais com o SVRS).
- **Não emite nota.** Este ADR define o formato; nada é transmitido.

## Fonte
- **Leiaute:** `leiauteNFe_v4.00.xsd` do **PL_010h v1.03** (13/11/2026), tipo `TNFe`, lido com uma ferramenta própria (estrutura com cardinalidade e documentação de cada campo).
- **Regras:** o [inventário do Anexo I](../fiscal/regras/NFCE-ANEXO-I.md) cruzado com as NTs. Cada regra que virar validação no aceite terá a sua origem citada, como no ADR-0037.

## Princípio
Seguem as regras já fixadas pelo responsável:
- **O motor não escolhe nada fiscal.** CFOP, NCM, CEST, CST ou CSOSN, alíquotas, bases e valores de tributo vêm do cliente. O motor só confere forma (XSD) e as regras oficiais.
- **O emitente sai do cadastro, nunca do pedido.** A empresa é identificada pela credencial, no servidor. CNPJ, IE e CRT vêm do estabelecimento cadastrado, e um CNPJ mandado pelo cliente não é aceito como identificação.
- **Repetição não duplica:** mesma `Idempotency-Key`, mesma nota, como na NFS-e.

## Recurso
`POST /v1/consumer-invoices`, com o mesmo molde da NFS-e:
- aceite idempotente, 201/202 com `Prefer: wait`;
- consulta por id e por `externalReference`;
- XML autorizado, webhooks e diagnóstico.

O DANFE NFC-e e o cancelamento ficam para ADRs próprios.

## Quem preenche cada grupo do `infNFe`

| Grupo do leiaute | Quem preenche | Observação |
|---|---|---|
| `ide`: `cUF`, `cMunFG` | Motor, pelo estabelecimento | — |
| `ide`: `cNF`, `cDV`, `Id` | Motor | ADR-0065 (regra B03-10, DV mod 11) |
| `ide`: `mod`=65, `serie`, `nNF` | Motor | série do estabelecimento, número pela alocação concorrente da Fase 1 |
| `ide`: `dhEmi`, `tpAmb`, `tpEmis`, `procEmi`, `verProc` | Motor | `tpAmb` pela credencial (`fk_test`/`fk_live`); `tpEmis=1` até a contingência ser decidida (ADR-0067) |
| `ide`: `natOp` | **Cliente** | texto da operação; o motor não deduz |
| `ide`: `tpNF`, `idDest`, `finNFe`, `indFinal`, `indPres`, `tpImp` | Motor, **só com valor fixado por regra oficial do modelo 65**; o que não tiver regra conferida vem do cliente | cada valor fixo cita a regra no código |
| `emit` | Motor, pelo cadastro | CNPJ, nome, endereço, IE e CRT; empresa sem IE no estado não emite NFC-e |
| `dest` | **Cliente**, opcional | CPF/CNPJ/estrangeiro e nome; na NFC-e o consumidor pode não ser identificado |
| `det[]`: `prod` | **Cliente** | `cProd`, `cEAN`, `xProd`, `NCM`, `CEST`, `CFOP`, `uCom`, `qCom`, `vUnCom`, `vDesc`, … |
| `det[]`: `imposto` | **Cliente** | grupo de ICMS pelo CST/CSOSN informado; PIS e COFINS; IBS/CBS conforme a decisão abaixo |
| `total` | Motor | soma dos itens; a regra de tolerância de arredondamento só entra com a fonte citada |
| `pag` | **Cliente** | `detPag[]` (`tPag`, `vPag`, cartão quando houver) e `vTroco` |
| `infAdic.infCpl` | **Cliente**, opcional | — |
| `infRespTec` | Motor, por configuração | dados do desenvolvedor do sistema (nós), se a UF exigir |
| `infNFeSupl` | Motor | QR Code (ADR-0066) e `urlChave` da UF |
| Assinatura | Motor | perfil `nfe400` (ADR-0065) |

Os grupos que a NFC-e de varejo não usa ficam **fora da v1**, e um pedido com eles é recusado:
- NF referenciada;
- veículos, medicamentos, armas e combustíveis;
- exportação, importação e compras públicas;
- cana e agropecuário;
- intermediador;
- retirada e entrega.

Cada um entra depois com o seu ADR, se algum cliente precisar.

## Fatias de implementação
1. Contrato (zod) + validação XSD do `NFe` montado, com o PL_010h versionado em `resources/fiscal/schemas/nfe/4.00-nfe-pl010h/`.
2. Montagem do XML + assinatura + QR Code, conferidos no XSD e no xmlsec1. Ainda sem envio.
3. Núcleo da emissão, que reaproveita o da NFS-e:
   - agregado `ConsumerInvoice`, máquina de estados e write-ahead;
   - envio síncrono `NfeAutorizacao4`;
   - reconciliação pela consulta (ADR-0064).
4. Simulador para os testes e para o sandbox; depois, a primeira emissão em homologação, que depende do credenciamento.

## Fatias 1 e 2: feitas em 2026-11-26 (sem envio)
- **Schema:** o PL_010h v1.03 está versionado em `resources/fiscal/schemas/nfe/4.00-nfe-pl010h/`, com o zip e o SHA-256 de cada arquivo (só a pasta `NFe`).
- **Contrato HTTP:** `presentation/http/consumer-sale-schema.ts`, em zod.
  - Confere os padrões e tamanhos do XSD (`TDec_1302`, `TDec_1104v`, `TDec_1110v`, `TDec_0302a04`, `TString`).
  - Campo fora do contrato é recusado.
  - O tipo do domínio é conferido na compilação.
- **Regras do aceite (domínio, `checkConsumerSale`)**, com a regra citada em cada erro:

| Regra | Fonte | O que confere |
|---|---|---|
| N12a-20 | NT 2026.002 v1.11 | CSOSN do modelo 65: 102, 103, 300, 400 (grupo `ICMSSN102`) e 500 (`ICMSSN500`). O 900 só "a critério da UF" e fica fora até a SEFAZ-PI responder. O contrato nem aceita 101, 201, 202 e 900 |
| N12a-40 / N12a-44 | NT 2026.002 v1.11 | CFOP por CSOSN: 102/103/300/400 → 5101, 5102, 5103, 5104, 5115, 5910; 500 → 5405, 5656, 5667, 5910 |
| I11-10 / I11-20 | Anexo I, nota (*4) | `vProd` = quantidade × preço arredondado em 2 casas, com tolerância de R$ 0,01. O valor vem do cliente: o motor confere e não arredonda |
| E02-20 | Anexo I | destinatário diferente do emitente |
| YA02-10 / -40 / -50 | Anexo I e NT 2020.006 | `tPag` 14, 90 e 99 recusados |
| YA04-10 | NT 2023.004 | cartão (03, 04) e PIX (17) exigem o grupo `card` |
| YA03-10 | Anexo I | pagamentos ≥ total |
| — | ADR-0069 | só CRT 1 na v1; total maior que zero; desconto do item ≤ valor do item; PIS/COFINS "Outros" com base e alíquota **ou** quantidade e valor por unidade (o `choice` do XSD) |

- **Valores fixos do modelo 65 no XML** (`infrastructure/xml/nfce-xml.ts`), cada um com a sua regra no código:

| Campo | Valor | Regra |
|---|---|---|
| `tpNF` | 1 | B11-10 |
| `idDest` | 1 | B11a-10 |
| `tpImp` | 4 | B21-10, que aceita 4 ou 5 |
| `finNFe` | 1 | B25-20 |
| `indFinal` | 1 | B25a-10 |
| `indPres` | 1 ou 5, do cliente | B25b-20; o 4 depende de entrega, fora da v1 |
| `indIEDest` | 9 | E16a-10 |
| `indTot` | 1 | I17b-10 |
| `modFrete` | 9 | X02-10 |
| `procEmi` | 0 | `TProcEmi` |

- **Totais:**
  - `vNF` pela fórmula da W16-10, só com os termos que a v1 admite: produtos − desconto + outras despesas;
  - os somatórios W07, W10, W13, W14 e W15 são exatos, sem arredondar;
  - `vTroco` = pagamentos − `vNF` (YA09-10), só quando positivo.
- **Montagem final:** `finishNfceXml` põe o `infNFeSupl` (QR Code e `urlChave`) entre `infNFe` e `Signature`, na ordem do `TNFe`.
- **Prova nos testes:**
  - uma venda com CSOSN 102 e 500, PIS/COFINS, consumidor com CPF, PIX e troco é montada, assinada com o perfil `nfe400` e **validada no XSD oficial do PL_010h**;
  - a assinatura confere;
  - cada regra acima tem um teste de recusa.
- **Ainda não confirmado:** a `urlChave` do PI. Nos testes ela é um marcador `.invalid`.

## Decisões do responsável
1. ~~**Empresa piloto da NFC-e e o seu regime (CRT).**~~ **Decidido em 26/11/2026: Simples Nacional.** A v1 aceita os grupos `ICMSSN102` e `ICMSSN500`. Isso define os primeiros grupos de ICMS da v1:
   - Simples Nacional: os grupos `ICMSSN…` por CSOSN;
   - regime normal: os grupos `ICMS00`, `ICMS20`, `ICMS40`, `ICMS60` e outros.
   O leiaute tem 22 grupos. A proposta é implementar só os do regime da piloto, e os outros quando aparecer quem precise.
2. **IBS/CBS na NFC-e em 2026.** O leiaute já tem o grupo `IBSCBS` por item. A obrigatoriedade para o modelo 65 precisa ser conferida nas NTs da Reforma (NT 2024.002 e NT 2025.002) antes de entrar no contrato. Os valores são do contribuinte e do contador.
3. **QR Code v2.00 ou v3.00** (ADR-0066). Não bloqueia as fatias 1 e 2.

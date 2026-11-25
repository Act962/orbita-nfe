---
title: NFC-e (modelo 65) — inventário das regras do Anexo I
status: current
last_updated: 2026-11-25
---

# NFC-e (modelo 65) — inventário das regras do Anexo I

**Fonte:** MOC 7.0, Anexo I — Leiaute e Regras de Validação da NF-e e da NFC-e (Portal Nacional da NF-e, baixado em 25/11/2026, SHA-256 em [fontes oficiais](../fontes-oficiais.md)), seção 4, páginas 72 a 139. Decisão: [ADR-0062](../../adr/0062-schemas-e-regras-da-nfce.md).

> **Este inventário NÃO é a regra vigente.** O Anexo I 7.03 consolida as Notas Técnicas publicadas **até outubro de 2020** (controle de versões, p. 5). As NTs posteriores incluem, mudam e revogam regras. Exemplo: a NT 2023.002 permite emitente CPF na NFC-e, o que mexe na C02a-04 (337), e cria as rejeições 126 e 129. Nenhuma regra desta lista vai para o código sem ser conferida contra as NTs posteriores, com o seu próprio ADR.

## Números

Regras extraídas da coluna "Modelo" das tabelas de validação:
- só NFC-e (65): **122**;
- comuns (55/65): **154**;
- só NF-e (55): **188**.

A extração é automática a partir do PDF. O texto da mensagem foi limpo dos espaços que o PDF insere no meio das palavras. Em caso de dúvida, vale o PDF.

## Acréscimos já conferidos em NT posterior

| Regra | Origem | cStat | Mensagem oficial |
|---|---|---|---|
| GAP03a-4 (65) | NT 2023.002 v1.02, item 3.1 | 126 | Rejeição: Enviado lote com mais de 1 NFC-e |
| GAP03a-6 (55/65) | NT 2023.002 v1.02, item 3.1 | 129 | Rejeição: A autorização deve ser solicitada de forma síncrona |

O schema não impõe nenhuma das duas: `TEnviNFe` ainda aceita até 50 `NFe` e `indSinc` 0 ou 1. Quem garante é o motor, no aceite (ADR-0062).

## Regras exclusivas do modelo 65 (Anexo I 7.03)

"Facul." é regra que a UF aplica a seu critério. "Pág." é a página do PDF.


### B — Identificação da NFC-e

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| B06-10 | 75 | Obrig | 702 | Rejeição: NFC-e não é aceita pela UF do Emitente |
| B06-40 | 75 | Facul | 775 | Rejeição: Modelo da NFC-e diferente de 65 |
| B09-40 | 76 | Obrig | 704 | Rejeição: NFC-e com Data-Hora de emissão atrasada |
| B09-50 | 76 | Obrig | 315 | Rejeição: Data de Emissão anterior ao início da autorização de Nota Fiscal na UF |
| B10-10 | 76 | Obrig | 705 | Rejeição: NFC-e com data de entrada/saída |
| B11-10 | 76 | Obrig | 706 | Rejeição: NFC-e para operação de entrada |
| B11a-10 | 76 | Obrig | 707 | Rejeição: NFC-e para operação interestadual ou com o exterior |
| B21-10 | 76 | Obrig | 709 | Rejeição: NFC-e com formato de DANFE inválido |
| B22-20 | 76 | Facul | 712 | Rejeição: NFC-e com contingência off-line para a UF |
| B22-34 | 77 | Facul | 714 | Rejeição: NFC-e com contingência inválida (tpEmis=2, 4 (a critério da UF) ou 5) |
| B22-70 | 77 | Obrig | 783 | Rejeição: NFC-e não é autorizada pela SVC |
| B25-20 | 77 | Obrig | 715 | Rejeição: NFC-e com finalidade inválida |
| B25a-10 | 77 | Obrig | 716 | Rejeição: NFC-e em operação não destinada a consumidor final |
| B25b-20 | 77 | Obrig | 717 | Rejeição: NFC-e em operação não presencial |
| B25b-30 | 77 | Obrig | 785 | Rejeição: NFC-e com entrega a domicílio não permitida pela UF |

### BA — Documento referenciado

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| BA01-10 | 78 | Obrig | 708 | Rejeição: NFC-e não pode referenciar documento fiscal |

### C — Emitente

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| C02a-04 | 81 | Obrig | 337 | Rejeição: NFC-e para emitente pessoa física |
| C18-10 | 82 | Obrig | 718 | Rejeição: NFC-e não deve informar IE de Substituto Tributário |

### E — Destinatário

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| E01-20 | 83 | Obrig | 787 | Rejeição: NFC-e de entrega a domicílio sem a identificação do destinatário |
| E02-20 | 83 | Obrig | 220 | Rejeição: Destinatário com identificação igual à identificação do emitente |
| E05-20 | 83 | Obrig | 788 | Rejeição: NFC-e de entrega a domicílio sem o endereço do destinatário |
| E16a-10 | 86 | Obrig | 789 | Rejeição: NFC-e para destinatário contribuinte de ICMS |
| E17-10 | 86 | Obrig | 729 | Rejeição: NFC-e com informação da IE do destinatário |
| E18-10 | 87 | Obrig | 730 | Rejeição: NFC-e com Inscrição Suframa |

### I — Produtos

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| I04-10 | 89 | Obrig | 373 | Rejeição: Descrição do primeiro item diferente de NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL [nItem:nnn] |
| I05-30 | 90 | Obrig | 779 | Rejeição: NFC-e com NCM incompatível [nItem: 999] |
| I08-150 | 93 | Obrig | 725 | Rejeição: NFC-e com CFOP inválido[nItem:nnn] |
| I08-160 | 93 | Obrig | 374 | Rejeição: CFOP incompatível com o grupo de tributação [nItem:nnn] |
| I08-170 | 93 | Obrig | 374 | Rejeição: CFOP incompatível com o grupo de tributação [nItem: nnn] |
| I09-10 | 93 | Obrig | 734 | Rejeição: NFC-e com Unidade de Comercialização inválida [nItem: 999] |
| I13-10 | 94 | Obrig | 735 | Rejeição: NFC-e com Unidade de Tributação inválida [nItem: 999] |
| I17b-10 | 94 | Obrig | 774 | Rejeição: NFC-e com indicador de item não participante do total [nItem: 999] |

### J — Veículos

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| J01-10 | 96 | Obrig | 736 | Rejeição: NFC-e com grupo de Veículos novos |

### L — Armamentos

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| L01-10 | 97 | Obrig | 738 | Rejeição: NFC-e com grupo de Armamentos |

### LA — Combustíveis

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| LA11-10 | 98 | Facul | 378 | Rejeição: Grupo de Combustível sem a informação de Encerrante [nItem: nnn] |

### LB — Papel imune

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| LB01-10 | 98 | Obrig | 348 | Rejeição: NFC-e com grupo RECOPI |

### N — ICMS

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| N12-30 | 100 | Obrig | 766 | Rejeição: Item com CST indevido [nItem:nnn] |
| N12-34 | 100 | Obrig | 381 | Rejeição: Grupo de tributação ICMS90, informando dados do ICMS - ST [nItem:nnn] |
| N12-40 | 100 | Obrig | 382 | Rejeição: CFOP não permitido para o CST informado [nItem:nnn] |
| N12-44 | 100 | Obrig | 382 | Rejeição: CFOP não permitido para o CST informado [nItem:nnn] |
| N12-50 | 100 | Obrig | 741 | Rejeição: NFC-e com Partilha de ICMS entre UF |
| N12-60 | 100 | Obrig | 740 | Rejeição: Item com Repasse de ICMS retido por Substituto Tributário [nItem: nnn] |
| N12a-20 | 107 | Obrig | 383 | Rejeição: Item com CSOSN indevido [nItem: nnn] |
| N12a-30 | 108 | Obrig | 384 | Rejeição: CSOSN não permitido para a UF [nItem: nnn] |
| N12a-34 | 108 | Obrig | 385 | Rejeição: Grupo de tributação ICMSSN900, informando dados do ICMS - ST [nItem: nnn] |
| N12a-40 | 108 | Obrig | 386 | Rejeição: CFOP não permitido para o CSOSN informado [nItem: nnn] |
| N12a-44 | 108 | Obrig | 386 | Rejeição: CFOP não permitido para o CSOSN informado [nItem: nnn] |

### NA — ICMS UF de destino

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| NA01-10 | 115 | Obrig | 807 | Rejeição: NFC-e com grupo de ICMS para a UF do destinatário |

### O — IPI

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| O01-10 | 118 | Obrig | 742 | Rejeição: NFC-e com grupo do IPI |

### P — Imposto de Importação

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| P01-10 | 118 | Obrig | 743 | Rejeição: NFC-e com grupo do II |

### R — PIS-ST

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| R01-10 | 118 | Obrig | 746 | Rejeição: NFC-e com grupo do PIS - ST |

### T — COFINS-ST

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| T01-10 | 119 | Obrig | 749 | Rejeição: NFC-e com grupo da COFINS - ST |

### UA — Tributos devolvidos

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| UA01-20 | 120 | Obrig | 390 | Rejeição: Nota Fiscal com grupo de devolução de Tributos [nItem: nnn] |

### W — Totais

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| W16-30 | 122 | Obrig | 780 | Rejeição: Total da NFC-e superior ao valor limite estabelecido pela SEFAZ [Limite] |
| W16-40 | 122 | Obrig | 750 | Rejeição: NFC-e com valor total superior ao permitido para destinatário não identificado (Código) [Limite] |
| W16-50 | 122 | Facul | 751 | Rejeição: NFC-e com valor total superior ao permitido para destinatário não identificado (Nome) [Limite] |
| W16-60 | 122 | Obrig | 752 | Rejeição: NFC-e com valor total superior ao permitido para destinatário não identificado (Endereço) [Limite] |

### X — Transporte

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| X02-10 | 123 | Obrig | 753 | Rejeição: NFC-e com Frete |
| X03-10 | 124 | Obrig | 754 | Rejeição: NFC-e com dados do Transportador |
| X03-20 | 124 | Obrig | 786 | Rejeição: NFC-e de entrega a domicílio sem dados do Transportador |
| X11-10 | 124 | Obrig | 755 | Rejeição: NFC-e com dados de Retenção do ICMS no Transporte |
| X18-10 | 124 | Obrig | 756 | Rejeição: NFC-e com dados do veículo de Transporte |
| X22-10 | 124 | Obrig | 757 | Rejeição: NFC-e com dados de Reboque do veículo de Transporte |
| X25a-10 | 124 | Obrig | 758 | Rejeição: NFC-e com dados do Vagão de Transporte |
| X25b-10 | 124 | Obrig | 759 | Rejeição: NFC-e com dados da Balsa de Transporte |

### Y — Cobrança

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| Y01-10 | 125 | Obrig | 760 | Rejeição: NFC-e com dados de cobrança (Fatura, Duplicata) |

### YA — Pagamento

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| YA02-10 | 125 | Obrig | 857 | Rejeição: Informado Duplicata Mercantil como Forma de Pagamento |
| YA02-40 | 125 | Obrig | 899 | Rejeição: Informado incorretamente o campo meio de pagamento |
| YA02-50 | 126 | Obrig | 436 | Rejeição: Informado 99 - Outros como meio de pagamento |
| YA03-10 | 126 | Facul | 865 | Rejeição: Total dos pagamentos menor que o total da nota |
| YA04-10 | 126 | Facul | 391 | Rejeição: Não informados os dados do cartão de crédito / débito nas Formas de Pagamento da Nota Fiscal |

### ZA — Comércio exterior

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| ZA01-30 | 127 | Obrig | 814 | Rejeição: Nota Fiscal com grupo de comércio exterior |

### ZB — Compras

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| ZB01-10 | 127 | Obrig | 762 | Rejeição: NFC-e com dados de compras (Empenho, Pedido, Contrato) |

### ZC — Cana

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| ZC01-10 | 128 | Obrig | 763 | Rejeição: NFC-e com dados de aquisição de Cana |

### ZX — QR Code e consulta

| Regra | Pág. | Aplic. | cStat | Mensagem oficial |
|---|---|---|---|---|
| ZX02-10 | 128 | Obrig | 394 | Rejeição: Nota Fiscal sem a informação do QR Code |
| ZX02-15 | 128 | Obrig | 903 | Rejeição Versão informada no QR Code (“100”) não é mais válida para a data de emissão |
| ZX02-20 | 129 | Obrig | 395 | Rejeição: Endereço do site da UF da Consulta via QR Code diverge do previsto |
| ZX02-22 | 129 | Obrig | 813 | Rejeição: QR Code com sequência de escape para o e - comercial. Usar CDATA |
| ZX02-24 | 129 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (chAcesso) |
| ZX02-28 | 129 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (chAcesso) |
| ZX02-32 | 129 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (nVersao) |
| ZX02-40 | 129 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (tpAmp) |
| ZX02-44 | 129 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (tpAmb) |
| ZX02-48 | 129 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (cDest) |
| ZX02-52 | 129 | Obrig | 399 | Rejeição: Parâmetro de Identificação do destinatário no QR Code para Nota Fiscal sem identificação do destinatário |
| ZX02-56 | 129 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (cDest) |
| ZX02-60 | 129 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (dhEmi) |
| ZX02-64 | 129 | Obrig | 400 | Rejeição: Parâmetro do QR Code não está no formato hexadecimal (dhEmi) |
| ZX02-68 | 129 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (dhEmi) |
| ZX02-72 | 130 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (vNF) |
| ZX02-76 | 130 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (vNF) |
| ZX02-80 | 130 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (vICMS) |
| ZX02-84 | 130 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (vICMS) |
| ZX02-88 | 130 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (digVal) |
| ZX02-92 | 130 | Obrig | 400 | Rejeição: Parâmetro do QR Code não está no formato hexadecimal (digVal) |
| ZX02-96 | 130 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (digVal) |
| ZX02-100 | 130 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (cIdToken) |
| ZX02-104 | 130 | Obrig | 462 | Rejeição: Código Identificador do CSC no QR Code não cadastrado na SEFAZ |
| ZX02-108 | 130 | Obrig | 463 | Rejeição: Código Identificador do CSC no QR Code foi revogado pela empresa |
| ZX02-112 | 130 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (cHashQRCode) |
| ZX02-116 | 130 | Obrig | 400 | Rejeição: Parâmetro do QR Code não está no formato hexadecimal (cHashQRCode) |
| ZX02-120 | 130 | Obrig | 464 | Rejeição: Código de Hash no QR Code difere do calculado |
| ZX02-224 | 131 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx)] |
| ZX02-228 | 131 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal [Param: xxx)]. |
| ZX02-232 | 131 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx)] |
| ZX02-236 | 131 | Obrig | 398 | Rejeição: Parâmetro Versão informada no QR Code diverge do previsto (“2”) |
| ZX02-240 | 131 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx)] |
| ZX02-244 | 131 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal: [Param: xxx)] |
| ZX02-260 | 131 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx |
| ZX02-268 | 131 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal: [Param: xxx)] |
| ZX02-272 | 131 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx |
| ZX02-276 | 132 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal: [Param: xxx)] |
| ZX02-288 | 132 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx |
| ZX02-292 | 132 | Obrig | 400 | Rejeição: Parâmetro Digest Value no QR Code não está no formato hexadecimal (Caracteres: “0 - 9”, “a - f”,“A - F”). |
| ZX02-296 | 132 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal: [Param: xxx)] |
| ZX02-300 | 132 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx |
| ZX02-304 | 132 | Obrig | 462 | Rejeição: Parâmetro Código Identificador do CSC no QR Code não cadastrado na SEFAZ. |
| ZX02-308 | 132 | Obrig | 463 | Rejeição: Parâmetro Código Identificador do CSC no QR Code foi revogado pela empresa anteriormente a Data de Emissão. |
| ZX02-312 | 133 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx |
| ZX02-316 | 133 | Obrig | 400 | Rejeição: Parâmetro Hash no QR Code não está no formato hexadecimal (Caracteres: “0 - 9”, “a - f”,“A - F”). |
| ZX02-320 | 133 | Obrig | 464 | Rejeição: Parâmetro Hash no QR Code diverge do calculado |
| ZX03-20 | 133 | Facul | 878 | Rejeição: Endereço do site da UF da Consulta por chave de acesso diverge do previsto |

## Como ler para a implementação

- **Restrições de operação** (B, BA, E, X, Y, ZA a ZC). A NFC-e é só venda presencial ou entrega a domicílio, dentro do estado, a consumidor final, com finalidade normal, sem documento referenciado e sem os grupos de NF-e. São conferências de forma, que o motor pode fazer no aceite, depois de conferidas contra as NTs.
- **Listas fiscais** (I08-150 CFOP, N12-30 CST, N12a-20 CSOSN e as combinações N12-40/44 e N12a-40/44). O motor confere se o código informado está na lista oficial, mas **não escolhe** CFOP, CST ou CSOSN: isso é do contribuinte e do contador. A Reforma Tributária (NT 2025.002 e NT 2026.005) mexe nesses grupos.
- **Parâmetros da UF** (W16-30 limite do total, B25b-30 entrega a domicílio, N12a-30 CSOSN 103/400, as exceções "a critério da UF"). Dependem da SEFAZ-PI e não podem ser presumidos.
- **QR Code** (ZX02). A versão "100" não vale para NFC-e emitida depois de 30/09/2018 (ZX02-15). Valem as da versão "2" e a versão 3.00 do Manual do DANFE NFC-e v6.0, que é posterior a este Anexo.


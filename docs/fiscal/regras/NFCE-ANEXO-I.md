---
title: NFC-e (modelo 65) — inventário das regras do Anexo I
status: current
last_updated: 2026-11-25
---

# NFC-e (modelo 65) — inventário das regras do Anexo I

**Fonte:** MOC 7.0, Anexo I — Leiaute e Regras de Validação da NF-e e da NFC-e (Portal Nacional da NF-e, baixado em 25/11/2026, SHA-256 em [fontes oficiais](../fontes-oficiais.md)), seção 4, páginas 72 a 139. Decisão: [ADR-0062](../../adr/0062-schemas-e-regras-da-nfce.md).

> **Este inventário NÃO é a regra vigente.** O cruzamento com as NTs posteriores está no fim da página. O Anexo I 7.03 consolida as Notas Técnicas publicadas **até outubro de 2020** (controle de versões, p. 5). As NTs posteriores incluem, mudam e revogam regras. Exemplo: a NT 2023.002 permite emitente CPF na NFC-e, o que mexe na C02a-04 (337), e cria as rejeições 126 e 129. Nenhuma regra desta lista vai para o código sem ser conferida contra as NTs posteriores, com o seu próprio ADR.

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

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| B06-10 | 75 | Obrig | 702 | Rejeição: NFC-e não é aceita pela UF do Emitente | — |
| B06-40 | 75 | Facul | 775 | Rejeição: Modelo da NFC-e diferente de 65 | — |
| B09-40 | 76 | Obrig | 704 | Rejeição: NFC-e com Data-Hora de emissão atrasada | 2021.002 v1.12, 2026.002 v1.11 |
| B09-50 | 76 | Obrig | 315 | Rejeição: Data de Emissão anterior ao início da autorização de Nota Fiscal na UF | — |
| B10-10 | 76 | Obrig | 705 | Rejeição: NFC-e com data de entrada/saída | 2026.002 v1.11 |
| B11-10 | 76 | Obrig | 706 | Rejeição: NFC-e para operação de entrada | 2026.002 v1.11 |
| B11a-10 | 76 | Obrig | 707 | Rejeição: NFC-e para operação interestadual ou com o exterior | 2026.002 v1.11 |
| B21-10 | 76 | Obrig | 709 | Rejeição: NFC-e com formato de DANFE inválido | — |
| B22-20 | 76 | Facul | 712 | Rejeição: NFC-e com contingência off-line para a UF | — |
| B22-34 | 77 | Facul | 714 | Rejeição: NFC-e com contingência inválida (tpEmis=2, 4 (a critério da UF) ou 5) | — |
| B22-70 | 77 | Obrig | 783 | Rejeição: NFC-e não é autorizada pela SVC | — |
| B25-20 | 77 | Obrig | 715 | Rejeição: NFC-e com finalidade inválida | 2026.002 v1.11 |
| B25a-10 | 77 | Obrig | 716 | Rejeição: NFC-e em operação não destinada a consumidor final | 2026.002 v1.11 |
| B25b-20 | 77 | Obrig | 717 | Rejeição: NFC-e em operação não presencial | 2025.002 v1.53, 2026.002 v1.11 |
| B25b-30 | 77 | Obrig | 785 | Rejeição: NFC-e com entrega a domicílio não permitida pela UF | — |

### BA — Documento referenciado

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| BA01-10 | 78 | Obrig | 708 | Rejeição: NFC-e não pode referenciar documento fiscal | 2026.002 v1.11 |

### C — Emitente

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| C02a-04 | 81 | Obrig | 337 | Rejeição: NFC-e para emitente pessoa física | 2021.002 v1.12, 2022.003 v1.11 |
| C18-10 | 82 | Obrig | 718 | Rejeição: NFC-e não deve informar IE de Substituto Tributário | 2026.002 v1.11 |

### E — Destinatário

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| E01-20 | 83 | Obrig | 787 | Rejeição: NFC-e de entrega a domicílio sem a identificação do destinatário | 2026.002 v1.11 |
| E02-20 | 83 | Obrig | 220 | Rejeição: Destinatário com identificação igual à identificação do emitente | — |
| E05-20 | 83 | Obrig | 788 | Rejeição: NFC-e de entrega a domicílio sem o endereço do destinatário | — |
| E16a-10 | 86 | Obrig | 789 | Rejeição: NFC-e para destinatário contribuinte de ICMS | — |
| E17-10 | 86 | Obrig | 729 | Rejeição: NFC-e com informação da IE do destinatário | — |
| E18-10 | 87 | Obrig | 730 | Rejeição: NFC-e com Inscrição Suframa | — |

### I — Produtos

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| I04-10 | 89 | Obrig | 373 | Rejeição: Descrição do primeiro item diferente de NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL [nItem:nnn] | 2026.002 v1.11 |
| I05-30 | 90 | Obrig | 779 | Rejeição: NFC-e com NCM incompatível [nItem: 999] | — |
| I08-150 | 93 | Obrig | 725 | Rejeição: NFC-e com CFOP inválido[nItem:nnn] | 2023.003 v1.40, 2024.001 v1.20, 2026.002 v1.11 |
| I08-160 | 93 | Obrig | 374 | Rejeição: CFOP incompatível com o grupo de tributação [nItem:nnn] | 2019.001 v1.70 |
| I08-170 | 93 | Obrig | 374 | Rejeição: CFOP incompatível com o grupo de tributação [nItem: nnn] | 2019.001 v1.70 |
| I09-10 | 93 | Obrig | 734 | Rejeição: NFC-e com Unidade de Comercialização inválida [nItem: 999] | — |
| I13-10 | 94 | Obrig | 735 | Rejeição: NFC-e com Unidade de Tributação inválida [nItem: 999] | — |
| I17b-10 | 94 | Obrig | 774 | Rejeição: NFC-e com indicador de item não participante do total [nItem: 999] | 2026.002 v1.11 |

### J — Veículos

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| J01-10 | 96 | Obrig | 736 | Rejeição: NFC-e com grupo de Veículos novos | 2026.002 v1.11 |

### L — Armamentos

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| L01-10 | 97 | Obrig | 738 | Rejeição: NFC-e com grupo de Armamentos | 2026.002 v1.11 |

### LA — Combustíveis

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| LA11-10 | 98 | Facul | 378 | Rejeição: Grupo de Combustível sem a informação de Encerrante [nItem: nnn] | 2026.002 v1.11 |

### LB — Papel imune

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| LB01-10 | 98 | Obrig | 348 | Rejeição: NFC-e com grupo RECOPI | 2026.002 v1.11 |

### N — ICMS

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| N12-30 | 100 | Obrig | 766 | Rejeição: Item com CST indevido [nItem:nnn] | 2023.001 v1.60, 2026.002 v1.11 |
| N12-34 | 100 | Obrig | 381 | Rejeição: Grupo de tributação ICMS90, informando dados do ICMS - ST [nItem:nnn] | 2026.002 v1.11 |
| N12-40 | 100 | Obrig | 382 | Rejeição: CFOP não permitido para o CST informado [nItem:nnn] | 2023.003 v1.40, 2024.001 v1.20, 2026.002 v1.11 |
| N12-44 | 100 | Obrig | 382 | Rejeição: CFOP não permitido para o CST informado [nItem:nnn] | 2024.001 v1.20, 2026.002 v1.11 |
| N12-50 | 100 | Obrig | 741 | Rejeição: NFC-e com Partilha de ICMS entre UF | 2026.002 v1.11 |
| N12-60 | 100 | Obrig | 740 | Rejeição: Item com Repasse de ICMS retido por Substituto Tributário [nItem: nnn] | 2026.002 v1.11 |
| N12a-20 | 107 | Obrig | 383 | Rejeição: Item com CSOSN indevido [nItem: nnn] | 2026.002 v1.11 |
| N12a-30 | 108 | Obrig | 384 | Rejeição: CSOSN não permitido para a UF [nItem: nnn] | 2026.002 v1.11 |
| N12a-34 | 108 | Obrig | 385 | Rejeição: Grupo de tributação ICMSSN900, informando dados do ICMS - ST [nItem: nnn] | 2026.002 v1.11 |
| N12a-40 | 108 | Obrig | 386 | Rejeição: CFOP não permitido para o CSOSN informado [nItem: nnn] | 2023.003 v1.40, 2024.001 v1.20, 2026.002 v1.11 |
| N12a-44 | 108 | Obrig | 386 | Rejeição: CFOP não permitido para o CSOSN informado [nItem: nnn] | 2024.001 v1.20, 2026.002 v1.11 |

### NA — ICMS UF de destino

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| NA01-10 | 115 | Obrig | 807 | Rejeição: NFC-e com grupo de ICMS para a UF do destinatário | 2026.002 v1.11 |

### O — IPI

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| O01-10 | 118 | Obrig | 742 | Rejeição: NFC-e com grupo do IPI | 2026.002 v1.11 |

### P — Imposto de Importação

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| P01-10 | 118 | Obrig | 743 | Rejeição: NFC-e com grupo do II | 2026.002 v1.11 |

### R — PIS-ST

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| R01-10 | 118 | Obrig | 746 | Rejeição: NFC-e com grupo do PIS - ST | 2026.002 v1.11 |

### T — COFINS-ST

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| T01-10 | 119 | Obrig | 749 | Rejeição: NFC-e com grupo da COFINS - ST | 2026.002 v1.11 |

### UA — Tributos devolvidos

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| UA01-20 | 120 | Obrig | 390 | Rejeição: Nota Fiscal com grupo de devolução de Tributos [nItem: nnn] | 2026.002 v1.11 |

### W — Totais

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| W16-30 | 122 | Obrig | 780 | Rejeição: Total da NFC-e superior ao valor limite estabelecido pela SEFAZ [Limite] | 2026.002 v1.11 |
| W16-40 | 122 | Obrig | 750 | Rejeição: NFC-e com valor total superior ao permitido para destinatário não identificado (Código) [Limite] | 2026.002 v1.11 |
| W16-50 | 122 | Facul | 751 | Rejeição: NFC-e com valor total superior ao permitido para destinatário não identificado (Nome) [Limite] | 2026.002 v1.11 |
| W16-60 | 122 | Obrig | 752 | Rejeição: NFC-e com valor total superior ao permitido para destinatário não identificado (Endereço) [Limite] | 2026.002 v1.11 |

### X — Transporte

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| X02-10 | 123 | Obrig | 753 | Rejeição: NFC-e com Frete | 2026.002 v1.11 |
| X03-10 | 124 | Obrig | 754 | Rejeição: NFC-e com dados do Transportador | 2023.004 v1.20 |
| X03-20 | 124 | Obrig | 786 | Rejeição: NFC-e de entrega a domicílio sem dados do Transportador | 2023.004 v1.20 |
| X11-10 | 124 | Obrig | 755 | Rejeição: NFC-e com dados de Retenção do ICMS no Transporte | 2026.002 v1.11 |
| X18-10 | 124 | Obrig | 756 | Rejeição: NFC-e com dados do veículo de Transporte | 2026.002 v1.11 |
| X22-10 | 124 | Obrig | 757 | Rejeição: NFC-e com dados de Reboque do veículo de Transporte | 2026.002 v1.11 |
| X25a-10 | 124 | Obrig | 758 | Rejeição: NFC-e com dados do Vagão de Transporte | 2026.002 v1.11 |
| X25b-10 | 124 | Obrig | 759 | Rejeição: NFC-e com dados da Balsa de Transporte | 2026.002 v1.11 |

### Y — Cobrança

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| Y01-10 | 125 | Obrig | 760 | Rejeição: NFC-e com dados de cobrança (Fatura, Duplicata) | 2026.002 v1.11 |

### YA — Pagamento

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| YA02-10 | 125 | Obrig | 857 | Rejeição: Informado Duplicata Mercantil como Forma de Pagamento | — |
| YA02-40 | 125 | Obrig | 899 | Rejeição: Informado incorretamente o campo meio de pagamento | — |
| YA02-50 | 126 | Obrig | 436 | Rejeição: Informado 99 - Outros como meio de pagamento | 2020.006 v1.31 |
| YA03-10 | 126 | Facul | 865 | Rejeição: Total dos pagamentos menor que o total da nota | — |
| YA04-10 | 126 | Facul | 391 | Rejeição: Não informados os dados do cartão de crédito / débito nas Formas de Pagamento da Nota Fiscal | 2023.004 v1.20 |

### ZA — Comércio exterior

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| ZA01-30 | 127 | Obrig | 814 | Rejeição: Nota Fiscal com grupo de comércio exterior | — |

### ZB — Compras

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| ZB01-10 | 127 | Obrig | 762 | Rejeição: NFC-e com dados de compras (Empenho, Pedido, Contrato) | 2026.002 v1.11 |

### ZC — Cana

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| ZC01-10 | 128 | Obrig | 763 | Rejeição: NFC-e com dados de aquisição de Cana | 2026.002 v1.11 |

### ZX — QR Code e consulta

| Regra | Pág. | Aplic. | cStat | Mensagem oficial | Citada em NT posterior |
|---|---|---|---|---|---|
| ZX02-10 | 128 | Obrig | 394 | Rejeição: Nota Fiscal sem a informação do QR Code | 2021.002 v1.12, 2026.002 v1.11 |
| ZX02-15 | 128 | Obrig | 903 | Rejeição Versão informada no QR Code (“100”) não é mais válida para a data de emissão | — |
| ZX02-20 | 129 | Obrig | 395 | Rejeição: Endereço do site da UF da Consulta via QR Code diverge do previsto | 2026.002 v1.11 |
| ZX02-22 | 129 | Obrig | 813 | Rejeição: QR Code com sequência de escape para o e - comercial. Usar CDATA | — |
| ZX02-24 | 129 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (chAcesso) | — |
| ZX02-28 | 129 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (chAcesso) | — |
| ZX02-32 | 129 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (nVersao) | — |
| ZX02-40 | 129 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (tpAmp) | — |
| ZX02-44 | 129 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (tpAmb) | — |
| ZX02-48 | 129 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (cDest) | — |
| ZX02-52 | 129 | Obrig | 399 | Rejeição: Parâmetro de Identificação do destinatário no QR Code para Nota Fiscal sem identificação do destinatário | — |
| ZX02-56 | 129 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (cDest) | — |
| ZX02-60 | 129 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (dhEmi) | — |
| ZX02-64 | 129 | Obrig | 400 | Rejeição: Parâmetro do QR Code não está no formato hexadecimal (dhEmi) | — |
| ZX02-68 | 129 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (dhEmi) | — |
| ZX02-72 | 130 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (vNF) | — |
| ZX02-76 | 130 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (vNF) | — |
| ZX02-80 | 130 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (vICMS) | — |
| ZX02-84 | 130 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (vICMS) | — |
| ZX02-88 | 130 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (digVal) | — |
| ZX02-92 | 130 | Obrig | 400 | Rejeição: Parâmetro do QR Code não está no formato hexadecimal (digVal) | — |
| ZX02-96 | 130 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal (digVal) | — |
| ZX02-100 | 130 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (cIdToken) | — |
| ZX02-104 | 130 | Obrig | 462 | Rejeição: Código Identificador do CSC no QR Code não cadastrado na SEFAZ | — |
| ZX02-108 | 130 | Obrig | 463 | Rejeição: Código Identificador do CSC no QR Code foi revogado pela empresa | — |
| ZX02-112 | 130 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente (cHashQRCode) | — |
| ZX02-116 | 130 | Obrig | 400 | Rejeição: Parâmetro do QR Code não está no formato hexadecimal (cHashQRCode) | — |
| ZX02-120 | 130 | Obrig | 464 | Rejeição: Código de Hash no QR Code difere do calculado | — |
| ZX02-224 | 131 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx)] | 2026.002 v1.11 |
| ZX02-228 | 131 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal [Param: xxx)]. | 2026.002 v1.11 |
| ZX02-232 | 131 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx)] | 2026.002 v1.11 |
| ZX02-236 | 131 | Obrig | 398 | Rejeição: Parâmetro Versão informada no QR Code diverge do previsto (“2”) | 2026.002 v1.11 |
| ZX02-240 | 131 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx)] | 2026.002 v1.11 |
| ZX02-244 | 131 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal: [Param: xxx)] | 2026.002 v1.11 |
| ZX02-260 | 131 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx | 2026.002 v1.11 |
| ZX02-268 | 131 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal: [Param: xxx)] | 2026.002 v1.11 |
| ZX02-272 | 131 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx | 2026.002 v1.11 |
| ZX02-276 | 132 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal: [Param: xxx)] | 2026.002 v1.11 |
| ZX02-288 | 132 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx | — |
| ZX02-292 | 132 | Obrig | 400 | Rejeição: Parâmetro Digest Value no QR Code não está no formato hexadecimal (Caracteres: “0 - 9”, “a - f”,“A - F”). | — |
| ZX02-296 | 132 | Obrig | 397 | Rejeição: Parâmetro do QR Code divergente da Nota Fiscal: [Param: xxx)] | — |
| ZX02-300 | 132 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx | — |
| ZX02-304 | 132 | Obrig | 462 | Rejeição: Parâmetro Código Identificador do CSC no QR Code não cadastrado na SEFAZ. | — |
| ZX02-308 | 132 | Obrig | 463 | Rejeição: Parâmetro Código Identificador do CSC no QR Code foi revogado pela empresa anteriormente a Data de Emissão. | — |
| ZX02-312 | 133 | Obrig | 396 | Rejeição: Parâmetro do QR Code inexistente: [Param: xxx | — |
| ZX02-316 | 133 | Obrig | 400 | Rejeição: Parâmetro Hash no QR Code não está no formato hexadecimal (Caracteres: “0 - 9”, “a - f”,“A - F”). | — |
| ZX02-320 | 133 | Obrig | 464 | Rejeição: Parâmetro Hash no QR Code diverge do calculado | — |
| ZX03-20 | 133 | Facul | 878 | Rejeição: Endereço do site da UF da Consulta por chave de acesso diverge do previsto | — |

## Cruzamento com as NTs posteriores a outubro de 2020

NTs baixadas do Portal Nacional da NF-e em 25/11/2026 (hashes em [fontes oficiais](../fontes-oficiais.md)). Em cada uma, o motor procurou as linhas de regra cuja coluna "Modelo" inclui 65.

- **66 das 122 regras exclusivas** aparecem de novo em alguma NT posterior. Estão marcadas na coluna "Citada em NT posterior" acima. Uma NT que repete a regra normalmente a reescreve: vale o texto da NT mais nova, não o do Anexo.
- As principais mudanças vistas:
  - **NT 2026.002 v1.11:** estende quase todas as restrições da NFC-e à NF-e com DANFE Simplificado Tipo 2 (`tpImp=6`), que passam a ser 55/65, e aceita QR Code nas versões "2 ou 3";
  - **NT 2024.001 v1.20 e NT 2023.003 v1.40:** ampliam a lista de CFOP da NFC-e (I08-150) e as combinações com CST/CSOSN (N12-40/44 e N12a-40/44, inclusive o 5.910 e exceções por UF);
  - **NT 2023.001 v1.60:** acrescenta o CST 61 (monofásico de combustíveis) na N12-30;
  - **NT 2023.004 v1.20:** inclui o PIX (`tPag=17`) na exigência do grupo de cartões (YA04-10);
  - **NT 2025.002 v1.53:** aceita `indPres=5` na B25b-20;
  - **emitente CPF:** a NT 2021.002 v1.12 e a NT 2022.003 v1.11 reescrevem a C02a-04 (337), e a NT 2023.002 v1.02 passa a permitir a emissão de NFC-e por CPF; a NT 2021.002 também muda a B09-40 (SCAN).
- A extração é automática e procura o identificador da regra. Pode deixar passar uma regra com o identificador quebrado no PDF. Antes de virar código, cada regra é relida no PDF da NT mais nova que a cita.

### Regras novas (não existem no Anexo I) que valem para o modelo 65

| NT | Quantidade | Regras |
|---|---|---|
| 2019.001 v1.70 | 2 | I05g-10 (507), I05h-10 (664) |
| 2020.005 v1.21 | 1 | I05c-10 (446) |
| 2020.006 v1.31 | 4 | YA02-60 (436), YA02a-20 (437), YA06-10 (443), YB02-10 (440) |
| 2021.002 v1.12 | 4 | ZE01-10 (819), ZE01-20 (834), I86-10 (820), I87-10 (833) |
| 2021.003 v1.50 | 1 | U01-30 (887) |
| 2021.004 v1.35 | 2 | U06-10 (844), Z02-10 (949) |
| 2023.001 v1.60 | 15 | LA17-10 (907), LA17-20 (908), LA18-10 (909), LA18-20 (909), LA18-30 (747), LA21-10 (958), LA21-20 (958), N12-100 (959), N12-110 (960), N39-10 (962), N41-10 (964), N43a-10 (769), N44-10 (965), N45-10 (966), W06e-10 (969) |
| 2023.002 v1.02 | 3 | GAP03a-04 (126), GAP03a-06 (129), B26-50 (957) |
| 2023.004 v1.20 | 3 | YA03a-10 (657), YA04-20 (963), YA09-20 (965) |
| 2024.001 v1.20 | 3 | N11-10, N12a-81 (782), N12a-91 (337) |
| 2024.002 v1.10 | 91 | B12a-20, B25-80, B25-90, B25-100, B25b-50, B25b-60, BA01-20, UB02-10, UB02-20, UB02-30, UB03-10, UB04-10, UB07-10, UB09-10, UB11-10, UB12-10, UB12-20, UB12-30, UB13-10, UB13-20, UB14-10, UB18-10, UB18-20, UB20-10, UB22-10, UB22-20, UB23-10, UB26-10, UB26-20, UB27-10, UB28-10, UB29-10, UB29-20, UB30-10, UB31-10, UB34-10, UB35-10, UB37-10, UB39-10, UB40-10, UB42-10, UB46-10, UB47-10, UB48-10, UB49-10, UB50-10, UB53-10, UB54-10, UB55-10, UB55-20, UB58-10, UB59-10, UB63-10, UB64-10, UB67-10, UB68-10, UB69-10, UB71-10, UB75-10, UB76-10, UB77-10, UB78-10, UB79-10, UB82-10, UB83-10, UB104-10, UB105-10, VB02-10, VB02-20, W31-10, W33-10, W34-10, W35-10, W38-10, W39-10, W40-10, W41-10, W43-10, W44-10, W45-10, W46-10, W47-10, W48-10, W51-10, W53-10, W54-10, W55-10, W56-10, W58-10, W59-10, W60-10 (267) |
| 2025.002 v1.53 | 146 | B10a-10, B25-90, B25d-10, BB01-10, C22-10, C22-20, LA01-30, N11-10 (966), UB11-10, UB12-10, UB13-20, UB13-30, UB13-39, UB13-40, UB14-10, UB14-20, UB14-25, UB16-10, UB18-10, UB22-10, UB22-20, UB23-10, UB26-10, UB26-20, UB27-10, UB28-10, UB35-10, UB37-10, UB40-10, UB40-20, UB42-10, UB43-10, UB45-10, UB45-20, UB46-10, UB47-10, UB54-10, UB54a-10, UB56-10, UB56-20, UB59-10, UB59-20, UB61-10, UB62-10, UB64-10, UB64-20, UB65-10, UB66-10, UB66a-10, UB66a-20, UB66c-10, UB66e-10, UB67-10, UB68-10, UB68-11, UB69-10, UB70-10, UB72-10, UB72b-10, UB72d-10, UB85a-10, UB85a-20, UB86-10, UB86-20, UB86c-10, UB87-10, UB87-20, UB87c-10, UB88-10, UB88-20, UB89-10, UB89-20, UB89a-10, UB89b-10, UB90-10, UB90-20, UB91-10, UB91-20, UB91c-10, UB91e-10, UB91f-10, UB92-10, UB92-20, UB92c-10, UB93-10, UB93-20, UB94-10, UB94-20, UB94a-10, UB94b-10, UB95a-10, UB95a-20, UB96c-10, UB99-10, UB99-20, UB99a-10, UB99b-10, UB100-10, UB100-20, UB101-10, UB101-20, UB101c-10, UB102-10, UB102-20, UB103-20, UB104-10, UB104-20, UB104a-10, UB104b-10, UB105a-10, UB105b-10, UB112-10, UB116-10, UB120-10, UB131-10, VB01-05, VB01-10, VC02-04 (708), W31-10, W31-20, W33-10, W34-10, W34-20, W35-10, W38-10, W39-10, W41-10, W43-10, W44-10, W46-10, W47-10, W48-10, W53-10, W54-10, W56-10, W56a-10, W58-10, W59-10, W59a-10, W59b-10, W59c-10, W59d-10, W59f-10, W59g-10, W60-05, W60-10 (267) |
| 2026.001 v1.02b | 15 | C21-20, ZG01-10, ZG02-10, ZG02-20, ZG02-30, ZG02-34 (872), ZG02-36, ZG02-40, ZG04-10, P09-10 (252), P12-26 (617), P12-32 (450), P12-44 (574), P31-26 (910), P31-46 (911) |
| 2026.002 v1.11 | 10 | F01-10 (669), G01-10 (670), N12a-81 (782), N12a-91 (337), ZX02-324 (396), ZX02-326 (396), ZX02-328 (397), ZX02-330 (445), ZX02-334 (474), ZX02-338 (583) |
| 2026.005 v1.00 | 1 | W59i-10 |
| 2026.007 v1.11 | 2 | B25-90, C17-42 (156) |
| 2026.008 v1.01 | 3 | I11c-10, NB01-10, VB01-10 |

As NTs 2024.002 (IBS/CBS/IS) e 2025.002 (RTC) concentram a maior parte das regras novas. Elas dependem da política tributária do contribuinte e entram junto com o leiaute da Reforma, não antes.

## Como ler para a implementação

- **Restrições de operação** (B, BA, E, X, Y, ZA a ZC). A NFC-e é só venda presencial ou entrega a domicílio, dentro do estado, a consumidor final, com finalidade normal, sem documento referenciado e sem os grupos de NF-e. São conferências de forma, que o motor pode fazer no aceite, depois de conferidas contra as NTs.
- **Listas fiscais** (I08-150 CFOP, N12-30 CST, N12a-20 CSOSN e as combinações N12-40/44 e N12a-40/44). O motor confere se o código informado está na lista oficial, mas **não escolhe** CFOP, CST ou CSOSN: isso é do contribuinte e do contador. A Reforma Tributária (NT 2025.002 e NT 2026.005) mexe nesses grupos.
- **Parâmetros da UF** (W16-30 limite do total, B25b-30 entrega a domicílio, N12a-30 CSOSN 103/400, as exceções "a critério da UF"). Dependem da SEFAZ-PI e não podem ser presumidos.
- **QR Code** (ZX02). A versão "100" não vale para NFC-e emitida depois de 30/09/2018 (ZX02-15). Valem as da versão "2" e a versão 3.00 do Manual do DANFE NFC-e v6.0, que é posterior a este Anexo.


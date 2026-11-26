# ADR-0076 — DANFE NFC-e em PDF

- Status: **Aceito** · Data: 2026-11-26
- Relacionados:
  - ADR-0057 (DANFSe, o molde);
  - ADR-0066 (QR Code, a versão é escolha do responsável);
  - ADR-0073 (XML da NFC-e);
  - [diagnóstico da NFC-e no PI](../fiscal/nfce-piaui-diagnostico.md) (a `urlChave` do PI está a confirmar).

## Fontes
- **"Manual de Especificações Técnicas do DANFE NFC-e e QR Code", versão 6.0 (março de 2025)**, capítulos 2 e 3 (leiaute e divisões I a IX). O manual está baixado com hash em [fontes oficiais](../fiscal/fontes-oficiais.md).
- **Notas técnicas depois do manual:** nenhuma das NTs baixadas muda o leiaute do DANFE NFC-e. A NT 2026.002 só cria o `tpImp=6` (DANFE Simplificado Tipo 2, que é da NF-e).
- **Descrição das formas de pagamento:** tabela `tPag` do MOC 7.0, Anexo I, campo YA02, atualizada pela NT 2016.002 e pela NT 2020.006.

## Decisão
1. **Só o que está no XML** (manual, cap. 2): o PDF é gerado na hora a partir do `nfeProc` autorizado, com o hash conferido antes, como no download do XML. Nada vem do cadastro nem da venda gravada.
2. **Divisões, na ordem do modelo com QR Code centralizado** (Figura 1B / Figura 5):
   - **I:** CNPJ com máscara, razão social, endereço sem país e "Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica".
   - **II:** código, descrição, quantidade, unidade, valor unitário e valor total de cada item (o mínimo do 3.1.2).
   - **III:**
     - quantidade de itens distintos e valor total;
     - acréscimos e desconto, só se houver;
     - valor a pagar, só se houver acréscimo ou desconto;
     - forma de pagamento com o valor pago;
     - troco.
   - **IV:** "Consulte pela Chave de Acesso em", a `urlChave` do XML e a chave em 11 blocos de 4 dígitos.
   - **VI:** "CONSUMIDOR CPF/CNPJ/Id. Estrangeiro" com o documento e o nome, ou "CONSUMIDOR NÃO IDENTIFICADO".
   - **VII:** número, série, emissão e protocolo, com as datas **convertidas para o horário local** (3.1.7). O fuso é -03:00, só o Piauí.
   - **V:** QR Code com 30 mm e margem segura de 10% (o mínimo do 3.1.5 é 25 mm).
   - **VIII:** em homologação, "EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO – SEM VALOR FISCAL", centralizado e em caixa alta; depois, o `infAdFisco`.
   - **IX:** o `infCpl` e, se o XML trouxer `vTotTrib`, o valor aproximado dos tributos da Lei 12.741/2012 (3.1.9.1, a critério do emissor).
3. **Formato:**
   - vírgula decimal e ponto de milhar (3.1.2 e 3.1.3);
   - bobina de 80 mm com a altura do conteúdo;
   - Helvetica, como no DANFSe (ADR-0057). O manual não fixa fonte nem largura.
   - Forma de pagamento com código fora da tabela sai como "Forma de pagamento NN", ou com o `xPag` se houver. Nunca uma descrição inventada.
4. **Rota:** `GET /v1/consumer-invoices/{id}/danfe` (`nfce:read`):
   - só na nota `AUTHORIZED`;
   - `links.danfe` no corpo da nota;
   - a rota está na matriz de isolamento.

## Fora deste ADR
- **DANFE resumido (sem itens):** depende de permissão na legislação do PI e do pedido do consumidor.
- **DANFE em contingência:** "EMITIDA EM CONTINGÊNCIA" e "Via do Estabelecimento", que entram com o ADR-0067.
- **Logotipo da empresa** (opcional pelo manual).

## Consequências
- A loja já pode imprimir o cupom da NFC-e autorizada.
- O QR Code e a URL de consulta saem do XML. Quando o responsável decidir o QR Code (2.00 ou 3.00) e a SEFAZ-PI confirmar a `urlChave`, o DANFE acompanha sem mudar nada.

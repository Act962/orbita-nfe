# ADR-0062 — Schemas e fonte das regras da NFC-e (preparação da Fase 3)

- Status: **Aceito** · Data: 2026-11-25
- Relacionados:
  - ADR-0013 e ADR-0014 (XSD oficiais versionados, com hash e errata);
  - ADR-0032 e ADR-0029 (write-ahead e reconciliação por consulta);
  - [diagnóstico da NFC-e no PI](../fiscal/nfce-piaui-diagnostico.md);
  - [inventário das regras do Anexo I para o modelo 65](../fiscal/regras/NFCE-ANEXO-I.md).
- Nada foi emitido nem enviado a autorizador.

## Contexto
O diagnóstico da NFC-e deixou duas lacunas técnicas: onde estão os schemas de envio e de status do serviço, e qual é a fonte das regras do modelo 65.

O Portal Nacional da NF-e publica os pacotes de schemas de forma **incremental**. Conferimos o conteúdo de cada um (hashes em [fontes oficiais](../fiscal/fontes-oficiais.md)):

| Pacote | Traz |
|---|---|
| PL_010h v1.03 (13/11/2026) | `leiauteNFe_v4.00.xsd` atual (TNFe, TEnviNFe, TRetEnviNFe, TProtNFe, TConsReciNFe), `nfe_v4.00.xsd`, tipos e três eventos RTC |
| PL_010e v1.02 e PL_010b v1.30 | só o leiaute (versões anteriores do mesmo arquivo) |
| PL_010d v1.03 (10/07/2026) | consulta de situação, inutilização, eventos e consulta de cadastro (CNPJ alfanumérico) |
| **PL_009q v1.00 (19/05/2025)** | o conjunto completo dos serviços: `enviNFe`, `retEnviNFe`, `consStatServ`, `retConsStatServ`, `leiauteConsStatServ`, `consReciNFe`, `inutNFe`, `procNFe` e outros |

Os arquivos `enviNFe_v4.00.xsd` e `retEnviNFe_v4.00.xsd` são só envelopes: declaram o elemento raiz e incluem o `leiauteNFe_v4.00.xsd`, onde estão os tipos. O `leiauteConsStatServ_v4.00.xsd` não mudou desde o PL_006f (comentário no próprio arquivo) e só aparece em pacotes completos.

O **Anexo I do MOC 7.0** traz 464 regras com a coluna "Modelo":
- 122 só da NFC-e;
- 154 comuns;
- 188 só da NF-e.

Mas o seu controle de versões (p. 5) diz que ele consolida as NTs **até outubro de 2020**. As NTs posteriores mudam regras dele. Exemplo conferido: a NT 2023.002 v1.02 cria a GAP03a-4 (cStat 126, lote com mais de uma NFC-e) e a GAP03a-6 (cStat 129, pedido assíncrono), e passa a aceitar emitente CPF, o que mexe na C02a-04 (cStat 337).

## Decisão
1. **Composição dos schemas da NFC-e.** Em vez de esperar um pacote completo que o Portal não publica, juntamos:
   - o leiaute e os tipos do **PL_010h** (o vigente mais novo);
   - os envelopes `enviNFe`/`retEnviNFe` e o status do serviço (`consStatServ`, `retConsStatServ`, `leiauteConsStatServ`) do **PL_009q**;
   - consulta de situação, inutilização e eventos do **PL_010d**.

   Cada arquivo guarda o pacote de origem e o seu SHA-256 no manifesto. A composição foi conferida na mesma libxml2 do motor (`xmllint-wasm`):
   - `consStatServ` e `retConsStatServ` válidos;
   - `retEnviNFe` válido;
   - `enviNFe` sem `NFe` recusado pelo motivo certo.

   Que a SEFAZ use essa mesma composição é **dedução** a partir da forma como o Portal publica os pacotes. Fica a confirmar no primeiro teste em homologação. O status do serviço é o primeiro candidato, porque não emite nada.
2. **Ainda não entram em `resources/fiscal/schemas`.** Entram no primeiro uso pelo código, com o pacote composto e o manifesto por arquivo. Quando isso acontecer, o manifesto precisa aceitar `https://www.nfe.fazenda.gov.br/` como origem: hoje o `sourceUrl` só aceita `https://www.gov.br/`.
3. **Uma NFC-e por envio e só síncrona, garantido pelo motor.** O schema ainda aceita até 50 `NFe` e `indSinc` 0 ou 1. A NT 2023.002 v1.02 proíbe as duas coisas (cStat 126 e 129). O motor monta sempre `enviNFe` com uma única `NFe` e `indSinc=1`. A recuperação de resposta perdida vai pela consulta de protocolo (`NfeConsultaProtocolo4`), como na NFS-e.
4. **Fonte das regras.** O [inventário](../fiscal/regras/NFCE-ANEXO-I.md) lista as 122 regras exclusivas do modelo 65, com página, aplicação, cStat e mensagem oficial. Ele **não é a regra vigente**: cada regra só entra no código depois de conferida contra as NTs publicadas depois de outubro de 2020, com o seu próprio ADR.
   - As regras que dependem de parâmetro da UF, como o limite do total e a entrega a domicílio, esperam a SEFAZ-PI.
   - As listas de CFOP, CST e CSOSN são conferência, nunca escolha.

## Consequências
- O envio e o status do serviço da NFC-e têm schema oficial localizado e compilado, sem emissão.
- **Acréscimo (25/11/2026):** as 31 NTs de NF-e/NFC-e posteriores a out./2020 que faltavam foram baixadas (versão mais nova de cada uma, hashes em [fontes oficiais](../fiscal/fontes-oficiais.md)) e cruzadas com o inventário:
  - 66 das 122 regras exclusivas aparecem de novo em alguma NT, e vale o texto da mais nova;
  - 306 regras novas valem para o modelo 65, a maioria da Reforma Tributária (NT 2024.002 e NT 2025.002).

  O cruzamento está no fim do [inventário](../fiscal/regras/NFCE-ANEXO-I.md).
- A primeira chamada real possível é o status do serviço do SVRS em homologação. Ela precisa de um A1 válido, e o de teste vence em 26/11/2026. Não precisa de CSC.

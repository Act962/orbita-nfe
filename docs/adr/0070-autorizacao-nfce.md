# ADR-0070 — Autorização da NFC-e (`NfeAutorizacao4`): síncrona, uma nota, só a prova vira estado final

- Status: **Aceito** · Data: 2026-11-26
- Relacionados:
  - ADR-0062 (composição dos schemas);
  - ADR-0063 (cliente SOAP comum);
  - ADR-0064 (consulta pela chave);
  - ADR-0068 (TLS do SVRS);
  - ADR-0069 (contrato e XML da NFC-e);
  - ADR-0029 e ADR-0032 (incerteza e reconciliação).
- **Nada foi enviado a autorizador real.** Os testes usam um servidor mTLS local com WSDL e respostas fictícios.

## Fontes
- **MOC 7.0, Visão Geral:**
  - item 5.1: leiautes do `enviNFe` (AP01–AP04) e do `retEnviNFe`; o `protNFe` só vem com cStat 104, "Lote processado";
  - item 5.1.4.3: processamento síncrono, que só existe com uma nota no lote;
  - item 5.1.6: a rejeição descarta a nota; a autorização e a denegação gravam a nota;
  - campo PR10 `digVal`: confere a integridade da nota gravada com a enviada.
- **NT 2023.002 v1.02:** a NFC-e não aceita lote com mais de uma nota (cStat 126) nem pedido assíncrono (cStat 129).
- **MOC 7.0, Anexo I:**
  - tabela 4.4.1: 100, 104, 110, 150;
  - tabela 4.4.2: 204 "Duplicidade de NF-e", 205 "NF-e está denegada na base de dados da SEFAZ", 539 "Duplicidade de NF-e com diferença na Chave de Acesso";
  - tabela 4.4.3: 301 a 303, uso denegado.
- **Schemas:** `enviNFe_v4.00.xsd` e `retEnviNFe_v4.00.xsd` do **PL_009q**. Eles entram no pacote `nfe/4.00-nfe-pl010h` junto com o leiaute do PL_010h:
  - o manifesto ganhou `composedWith`, com o zip e o SHA-256 do segundo pacote;
  - cada arquivo ganhou `from`, com o pacote de origem;
  - o teste de integridade confere os dois zips;
  - os dois envelopes conferem byte a byte com o zip oficial.
- **Endereço:** `https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx`, da relação oficial de webservices de homologação da NFC-e (ENCAT/SVRS).

## Decisão
1. **Lote:** `enviNFe` com **uma** `NFe`, `indSinc=1` e `idLote` de 1 a 15 dígitos, controlado por nós.
   - Validado no XSD antes de sair.
   - Enviado uma vez pelo `callSefaz` comum, que lê o WSDL com o mesmo certificado.
2. **Leitura do retorno.** Só a resposta que prova o resultado vira estado final:

| Resposta | Resultado | Por quê |
|---|---|---|
| 104 + `protNFe` 100/150, **com a nossa chave, o nosso `digVal` e `nProt`** | `AUTHORIZED` | a nota foi gravada e é a que enviamos |
| 104 + `protNFe` 110/301/302/303 | `DENIED` | a nota foi **gravada** como denegada e o número está consumido; não pode ser corrigida e reenviada como se fosse rejeição |
| 104 + `protNFe` 204/205/539 | `ALREADY_EXISTS` | já existe nota com essa chave (ou outra nota com esse número); só a consulta pela chave diz qual é a situação |
| 104 + `protNFe` com outro cStat | `REJECTED` (nota) | a nota foi descartada e pode ser corrigida |
| cStat do lote ≠ 104, sem `infRec` | `REJECTED` (lote) | o lote foi recusado inteiro; não há protocolo |
| 103/105 ou `infRec` (assíncrono) | `UNCERTAIN` | a nota pode sair autorizada depois |
| `protNFe` de outra chave, `digVal` diferente, ou 100/150 sem `nProt` | `UNCERTAIN` | a resposta não prova que a **nossa** nota foi autorizada |
| falha de transporte, SOAP Fault, retorno fora do XSD | `SefazFailure` | como no ADR-0063: `NOT_SENT` quando nada saiu, `UNKNOWN` quando pode ter saído |

3. **Incerteza não se resolve reenviando.** `UNCERTAIN`, `ALREADY_EXISTS` e o `UNKNOWN` do transporte vão para a consulta pela chave (ADR-0064). Isso será ligado na próxima fatia, a do núcleo da emissão.

## Consequências
- O transporte da autorização está pronto e testado. Falta o núcleo da emissão:
  - agregado `ConsumerInvoice`;
  - alocação de série e número;
  - write-ahead e worker;
  - rota `POST /v1/consumer-invoices`.
- O primeiro envio real depende do credenciamento da empresa piloto na SEFAZ-PI (inscrição estadual e CSC, se o QR Code for o 2.00).

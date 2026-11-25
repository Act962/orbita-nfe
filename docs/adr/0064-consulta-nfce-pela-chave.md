# ADR-0064 — Consulta da NFC-e pela chave de acesso (SVRS, homologação)

- Status: **Aceito** · Data: 2026-11-25
- Relacionados:
  - ADR-0062 (schemas; só autorização síncrona);
  - ADR-0063 (status do serviço; mesmo cliente SOAP);
  - ADR-0029 e ADR-0032 (reconciliação de `UNKNOWN` na NFS-e).
- **Não emite nota.**

## Contexto
A NT 2023.002 v1.02 acaba com a autorização assíncrona: o `nRec` deixa de existir. Uma resposta perdida no envio da NFC-e passa a ser resolvida **consultando a chave de acesso** (`NfeConsultaProtocolo4`). A regra do projeto continua a mesma: um timeout não prova que a nota não saiu, e nada se reenvia às cegas.

## Fontes
- **MOC 7.0, Visão Geral, item 5.4:**
  - leiaute de entrada `consSitNFe` (EP01–EP05: `versao`, `tpAmb`, `xServ` = `CONSULTAR`, `chNFe`);
  - leiaute de retorno `retConsSitNFe` (ER01–ER10). O `protNFe` vem quando o cStat é 100, 150 ou 110, e o `retCancNFe` quando é 101 ou 151;
  - regra J03: **217 = "NF-e não consta na base de dados da SEFAZ"**;
  - regras J01–J02k: ambiente, UF da chave (226), dígito (236) e outras.
- **Schemas** `consSitNFe_v4.00.xsd` e `retConsSitNFe_v4.00.xsd` do **PL_010d v1.03** (10/07/2026), que já aceitam o CNPJ alfanumérico na chave (`TChNFe` = `[0-9]{6}[0-9A-Z]{12}[0-9]{26}`). Estão versionados em `resources/fiscal/schemas/nfe/4.00-conssit-pl010d/`, com o zip e o hash de cada arquivo.
- **Endereço:** `https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx`, da relação oficial de webservices de homologação da NFC-e.

## Decisão
1. **Cliente SOAP comum (`sefaz-soap.ts`)** para todos os serviços 4.00. Ele faz, para cada chamada:
   - valida a mensagem no XSD;
   - lê namespace e ação no WSDL do próprio serviço, com mTLS;
   - monta o envelope SOAP 1.2 sem Header e envia uma vez só;
   - reconhece um SOAP Fault, inclusive com HTTP 500;
   - valida o retorno no XSD.

   O status do serviço (ADR-0063) passou a usar o mesmo caminho.
2. **Situação lida só do `cStat` do retorno**, conforme o MOC:

   | cStat | Situação | Exige |
   |---|---|---|
   | 100, 150 | `AUTHORIZED` | `protNFe` presente. Sem ele, não há prova: vira `REFUSED` |
   | 110 | `DENIED` | `protNFe` presente. A NFC-e não tem mais denegação (NT 2023.002), mas o leiaute ainda prevê |
   | 101, 151 | `CANCELLED` | guarda o `retCancNFe`, se vier |
   | 217 | `NOT_FOUND` | — |
   | outro | `REFUSED` | a consulta foi recusada (chave inválida, UF errada…). **Não é prova de nada** |

3. **`NOT_FOUND` é o que a SEFAZ disse, não uma decisão de reenvio.** Quando a emissão da NFC-e existir, o reconciliador decide com as mesmas salvaguardas da NFS-e (ADR-0029): janela de tempo e prova dupla antes de reenviar os mesmos bytes.
4. **Protocolo guardado inteiro:** `protNFe` e `retCancNFe` são devolvidos serializados, para virarem o `nfeProc` e o arquivo imutável na emissão.
5. **CLI:** `npm run nfce:test -- consult <cert.p12> --key <chave>`. Só homologação; a senha é pedida sem eco; a resposta vai para `.local/nfce-teste/`, sem o XML do protocolo no terminal.

## Consequências
- O caminho de recuperação da NFC-e existe antes da emissão, como foi feito na NFS-e.
- Uma consulta com uma chave **fictícia** do PI também serve de diagnóstico. Um 217 indica que o SVRS aceitou a UF da chave, e um 226 indica que a UF do emitente não é atendida ali (regra J02).
- Os testes usam WSDL, chave e respostas **fictícios** contra um servidor mTLS local. A prova com o SVRS real é o CLI.

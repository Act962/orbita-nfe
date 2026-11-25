---
title: NFC-e no Piauí — diagnóstico de preparação da Fase 3
status: current
last_updated: 2026-11-25
---

# NFC-e no Piauí — diagnóstico de preparação (Fase 3)

Este diagnóstico prepara a Fase 3 **sem emitir nada**. As fontes são os documentos oficiais baixados em 25/11/2026, com autorização do responsável. Cada uma tem a origem e o SHA-256 registrados em [fontes oficiais](fontes-oficiais.md).

Marcações usadas:
- **[CONFIRMADO]:** está no documento oficial citado.
- **[PROVÁVEL]:** deduzido de documento oficial, mas sem texto explícito.
- **[A CONFIRMAR]:** depende da SEFAZ-PI ou do credenciamento.

Nenhuma regra fiscal sai daqui para o código sem o seu próprio ADR e sem revisão do especialista.

## 1. Documentos-base

| Documento | Versão | Para quê |
|---|---|---|
| MOC — Manual de Orientação do Contribuinte, NF-e e NFC-e | 7.0 | Serviços, fluxo de autorização, regras gerais |
| MOC, Anexo I — Leiaute e Regras de Validação NF-e e NFC-e | 7.0 | Campos e regras do modelo 65 |
| MOC, Anexo IV — Manual de Contingência NFC-e | 7.0 | Contingência da NFC-e |
| Manual de Especificações Técnicas do DANFE NFC-e e QR Code | 6.0 (março de 2025) | DANFE NFC-e e QR Code nas versões 2.00 e 3.00 |
| Manual de Especificações da Contingência Off-line da NFC-e | 2.0 | Emissão em contingência off-line |
| Manual de Boas Práticas do emissor de NFC-e (BP 2018.001) | 1.0 | Recomendações de implementação |
| NT 2025.002 | v1.53 (30/10/2026) | Reforma Tributária: IBS, CBS e IS no leiaute |
| NT 2023.002 | v1.01 e v1.02 (out. 2026) | Emitente CPF; fim do lote, da denegação, da autorização assíncrona e da inutilização (AC, BA, SP) |
| NT 2026.004 e NT Conjunta 2025.001 | v1.01 / v1.00 | CNPJ alfanumérico no schema |
| NT 2026.005 | v1.00 | Simples Nacional na NF-e e NFC-e (RTC) |
| NT 2026.007 | v1.11 | Validação contra LCC-RFB e CCC |
| NT 2026.008 | v1.01 | Campos de valor líquido do produto |
| Schemas — Pacote de Liberação PL_010h | v1.03 (13/11/2026) | `leiauteNFe_v4.00.xsd` e eventos RTC |
| Portal Nacional da NFC-e (ENCAT) — URLs de QR Code por UF e webservices | consultado em 25/11/2026 | Endereços do PI e do autorizador |

## 2. O que já se sabe

### Autorizador e endereços
- **Autorizador da NFC-e do Piauí: SVRS (Sefaz Virtual do RS)** [PROVÁVEL].
  - A relação oficial de webservices da NFC-e (portal do SVRS e ENCAT) lista os estados com autorizador próprio: AM, GO, MS, MT, PR, RS e SP. Os demais usam o SVRS. O PI não está entre os próprios.
  - Para a NF-e, o Portal Nacional diz explicitamente que o PI usa o SVRS e, em contingência, o SVC-AN [CONFIRMADO].
  - **A confirmar com a SEFAZ-PI** no credenciamento.
- **Endereços SVRS da NFC-e (versão 4.00)** [CONFIRMADO]:
  - homologação em `https://nfce-homologacao.svrs.rs.gov.br/ws/...`;
  - produção em `https://nfce.svrs.rs.gov.br/ws/...`;
  - serviços: `NFeAutorizacao4`, `NFeRetAutorizacao4`, `NfeConsulta4`, `NfeStatusServico4`, `nfeinutilizacao4` e `recepcaoevento4`.
- **URL do QR Code do PI**, a mesma em produção e homologação [CONFIRMADO, lista do ENCAT]: `http://www.sefaz.pi.gov.br/nfce/qrcode`.
- **URL de consulta pela chave (`urlChave`)** [A CONFIRMAR]. A página do ENCAT não trouxe texto legível para o PI. Fontes secundárias citam `www.sefaz.pi.gov.br/nfce/consulta`, e o site da SEFAZ-PI recusou leitura automatizada.

### Fluxo
- **Uma NFC-e por envio** [CONFIRMADO, NT 2023.002]: o lote com mais de uma NFC-e foi eliminado (produção em 04/09/2023).
- **Só autorização síncrona** [CONFIRMADO, NT 2023.002 v1.02]: a assíncrona acaba na NF-e e na NFC-e (testes até 01/02/2027, produção em 05/04/2027). O motor deve nascer síncrono. A recuperação de resposta perdida passa a ser pela consulta da chave (`NfeConsultaProtocolo`), como a reconciliação que já existe na NFS-e.
- **Sem denegação na NFC-e** [CONFIRMADO, NT 2023.002].
- **A inutilização continua no PI** [CONFIRMADO, NT 2023.002 v1.02]: ela acaba só no AC, na BA e em SP.

### QR Code e CSC
O manual do DANFE NFC-e v6.0 traz duas versões de QR Code [CONFIRMADO]:
- **Versão 2.00:** usa o **CSC** (Código de Segurança do Contribuinte).
  - São de 16 a 36 caracteres, com identificador de até 6 dígitos.
  - Cada empresa pode ter até 2 CSC ativos por UF.
  - É obtido na página da SEFAZ da UF, que no PI é o SIATWEB [A CONFIRMAR].
- **Versão 3.00:** não usa CSC. A autenticidade vem da assinatura dos parâmetros do próprio QR Code.
  - É a orientação para o produtor rural pessoa física.
  - Para pessoa jurídica, adotar a v3 é opção da empresa.
- **Consequência de segurança:** com a v2.00, o **CSC é um segredo**. Ele entra no cofre como o certificado (KEK assimétrica, só o worker-fiscal decifra) e nunca vai para log, como já previa o ADR-0027 para a Fase 3.

### Contingência
- **Contingência off-line da NFC-e** (manual v2.0 e Anexo IV) [CONFIRMADO, documentos baixados].
  - Os detalhes de prazo de transmissão posterior e de regras ficam para a leitura completa, no ADR da contingência, que o roadmap já exige ("só após a leitura do MOC").

### Reforma Tributária e cadastro
- NT 2025.002 v1.53, NT 2026.005 e NT 2026.008 alteram o leiaute: IBS, CBS e IS, Simples Nacional e valor líquido.
- A NT 2026.007 cria validações contra a LCC-RFB e o CCC.
- O leiaute atual está no PL_010h v1.03.
- Como na NFS-e, o motor confere e monta, mas a política tributária (CST, cClassTrib, alíquotas) é do contribuinte.

## 3. O que falta e de quem depende

| Item | Depende de |
|---|---|
| Confirmar o SVRS como autorizador do PI e a `urlChave` | SEFAZ-PI (credenciamento ou "Fale com a SEFAZ") |
| Credenciamento da empresa-piloto como emissora de NFC-e em homologação, inscrição estadual e CSC (se for v2.00) | Responsável e SEFAZ-PI |
| Escolha do QR Code v2.00 (com CSC) ou v3.00 (sem CSC) | Responsável, com o contador |
| Schemas do **envio** (`enviNFe`/`retEnviNFe`) e do **status do serviço**. Os pacotes 010x são incrementais: o PL_010h e o PL_010e trazem o leiaute, e o PL_010d v1.03 traz a consulta de situação, a inutilização, os eventos e a consulta de cadastro. O envio e o status vêm do pacote-base anterior, a localizar na implementação | Desenvolvimento, no Portal NF-e |
| Enquadramento tributário dos produtos (CST/CSOSN, CFOP, NCM, cClassTrib) | Contador |
| Leitura completa do Anexo I (regras do modelo 65) e da contingência off-line, com ADRs | Desenvolvimento, na Fase 3 |

## 4. O que a arquitetura atual já resolve
- **Write-ahead, idempotência por chave e reconciliação por consulta** (ADR-0032 e ADR-0029). Como a NFC-e passa a ser só síncrona e de uma nota por envio, o modelo é o mesmo da NFS-e, com consulta por chave de acesso.
- **Cofre de certificados** (ADR-0009), para o A1, e o mesmo desenho para o CSC.
- **Assinatura XMLDSig, XSD com hash conferido e transporte mTLS com fase da falha** (ADR-0014 e ADR-0022). Ainda falta o perfil de assinatura da NF-e.
- **Séries e numeração por modalidade** (`NFCE` já existe na habilitação de produção, PROD-001).
- **DANFE NFC-e:** o mesmo padrão do DANFSe (ADR-0057), com o manual v6.0 como fonte.

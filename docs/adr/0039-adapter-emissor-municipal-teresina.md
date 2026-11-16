# ADR-0039 — Adapter do emissor municipal de Teresina (DSF) e escolha do autorizador pelo canal

- Status: **Aceito** · Data: 2026-11-13
- Relacionados:
  - ADR-0017 (Teresina);
  - ADR-0028 (roteamento pela competência);
  - ADR-0029 (um cliente do padrão nacional com perfil de endpoint);
  - ADR-0038 (adapter da SEFIN).

## Contexto
Pela tabela de roteamento (ADR-0028), em Teresina vão para o **emissor municipal**, operado pela DSF, dois casos:
- o prestador não optante (Portaria SEMF 20/2026, art. 1º);
- qualquer nota com competência anterior a 11/2026.

Até aqui, esses casos eram recusados com `ROUTE_CHANNEL_NOT_SUPPORTED`. A empresa de teste, dona do A1 que vence em 26/11/2026, é não optante. A SEFIN de produção restrita recusou a DPS dela com E0037 (ADR-0038).

O emissor municipal segue o contrato do padrão nacional. Fonte: Guia de Utilização da API THE V7, 20/08/2026, SHA-256 `5a75fca0…42ff`, com a Carta de Serviços e o portal da SEMF ([diagnóstico](../fiscal/nfse-teresina-api-municipal-x-nacional.md) §1):
- **Homologação:** `https://nfse2-the.dsfweb.com.br`, caminhos sob `/notafiscal-ws`. A produção, `nfseapi.teresina.pi.gov.br`, **não** é configurada.
- **Rotas:** `POST /nfse` com `{ dpsXmlGZipB64 }`; `GET /nfse/dps/{id}`; `GET /nfse/{chave}`; `POST /nfse/{chave}/eventos`.
- **O que não existe:** **não há consulta de evento** nem `HEAD /dps`.
- **Leiaute:** XSD nacional v1.01 de **09/02/2026**, linkado pelo portal e pela Carta. Assinatura RSA-SHA1 com C14N, documentada.
- **Regra municipal:** `cTribMun` obrigatório, tirado da tabela cTribNac × CNAE do portal.

## Decisão
1. **Perfil novo sobre o mesmo cliente** (ADR-0029 item 1). O perfil passou a ter os **caminhos** além das URLs:
   - `SEFIN_NACIONAL`: o perfil do ADR-0038;
   - `TERESINA_DSF`: só homologação, consulta pela DPS em `/nfse/dps/{id}`, sem consulta de evento (`EVENT_LOOKUP_NOT_SUPPORTED`).
   - Os códigos de duplicidade (E0014, E0802, E0840) seguem os nacionais: a DSF usa o Anexo I nacional. **Provável**, a confirmar.
2. **O autorizador é escolhido pelo canal gravado na nota.** `GatewayContext` ganhou `channel`, e `ChannelRoutedGateway` despacha para o adapter do canal.
   - Canal sem adapter dá `NOT_SENT`/`ERROR` com `NFSE_CHANNEL_NOT_CONFIGURED`.
   - **Uma nota nunca vai para o outro autorizador.**
   - Nota sem canal, anterior à migration 0015, conta como SEFIN.
3. **Leiaute e Anexo por canal** (`layoutEnvironmentOf`). Na DSF, os dois ambientes usam o pacote e o Anexo I de 09/02/2026, sem `finNFSe`. Na SEFIN, nada muda: produção usa o pacote de produção e homologação usa o da produção restrita.
   - Isso vale para o XML montado pelo worker e para as regras do aceite (ADR-0037).
   - A pré-validação estrutural do aceite continua usando o pacote do ambiente, porque roda antes do roteamento. A validação que vale é a do worker.
   - **A confirmar** no primeiro envio à homologação da DSF.
4. **Regra do canal THE-001**, `cTribMun` obrigatório na DSF, checada no aceite junto com as regras do Anexo I: `422 NFSE_RULES_VIOLATED` com `ruleId: "NFSE-TERESINA-DSF"`. Catálogo: [NFSE-TERESINA-DSF](../fiscal/regras/NFSE-TERESINA-DSF.md).
   - O código é do contribuinte; o motor só confere se ele veio.
5. **`MUNICIPAL_TERESINA_DSF` entra em `SUPPORTED_CHANNELS`.** As duas linhas da tabela que apontam para a DSF passam a ser aceitas.
   - O MEI com competência anterior continua `ROUTE_AMBIGUOUS` (R-39).
6. **Cancelamento e substituição continuam só no canal da SEFIN.**
   - Sem consulta de evento, um cancelamento em `UNKNOWN` na DSF não teria como ser reconciliado.
   - A substituição fica para quando o fluxo for testado na DSF.
7. **Configuração:** `NFSE_GATEWAY=real`, que substitui o `sefin` do ADR-0038. Liga os dois adapters, só com as URLs de homologação.
8. **Teste:** `npm run sefin:test -- send … --channel dsf`. Usa a DPS fictícia com o par cTribNac 010301 / cTribMun 001 do XML modelo da SEMF, só como valor de teste.

## Primeira tentativa de envio (2026-11-13)
- **Resultado:** `NOT_SENT` com `CERT_HAS_EXPIRED`. A DPS foi montada no pacote de 09/02/2026, assinada e validada no XSD, mas **nada foi enviado**: a conexão parou no handshake TLS, antes de qualquer byte da requisição.
- **Causa:** o certificado TLS do **servidor** de homologação da DSF venceu. Ele é emitido para `dsfweb.com.br` pela Let's Encrypt, com validade de 15/08/2026 a **13/11/2026 19:59:22 GMT**, e o envio foi às 20:20 GMT. A conferência leu só o certificado público apresentado no handshake, sem certificado de cliente nem requisição.
- **Decisão:** a verificação do servidor **não é desligada** (`rejectUnauthorized: true`, transporte mTLS). Espera-se a DSF renovar o certificado e tenta-se de novo.
- **Achado para depois:** o host de produção da DSF (`nfseapi.teresina.pi.gov.br`, GoDaddy) tem certificado válido até 05/05/2027, mas o Node não monta a cadeia (`UNABLE_TO_GET_ISSUER_CERT`). Isso precisa ser resolvido quando o perfil de produção for configurado, com a AC intermediária no `serverTrustPem` do perfil, e não desligando a verificação.

## Segunda tentativa (2026-11-16): primeira resposta da DSF
- O certificado TLS do servidor foi renovado, e a conexão mTLS funcionou.
- A homologação respondeu **400** com `{"tipoAmbiente":"2","versaoAplicativo":"1.01", …, "erros":[{"codigo":"L0022","mensagem":"A série informada na DPS deve estar dentro da faixa reservada para esse fim (de 10001 a 49999). As séries de 00001 a 10000 são de uso exclusivo do sistema municipal gerador de NFS-e."}]}`. A DPS de teste usava a série 900.
- **Achados:**
  1. A DSF usa **códigos locais `Lxxxx`** e o campo **`mensagem`**. O adapter tratou a resposta como `UNKNOWN`, o que era seguro.
     - **Correção:** o perfil declara o padrão dos códigos de rejeição. A SEFIN continua `E\d{4}`; a DSF é `[EL]\d{4}`. O texto é lido de `descricao` ou de `mensagem`.
  2. **Regra de série da DSF: 10001 a 49999 por API.** Entrou no aceite como **THE-002**, com recusa antes de numerar. A série de teste da DSF passa a ser 49999.
  3. `tipoAmbiente` vem como texto (`"2"`). O adapter não usa esse campo.
- **Ainda não provado:** a assinatura. A L0022 é uma regra de série, e a DSF respondeu um único erro.
- **3ª tentativa (série 49999):** passou da L0022 e voltou **`E0314`**: "O código de tributação municipal informado não existe ou não está administrado pelo município de incidência do ISSQN na data de competência informada na DPS". A DSF usa também os códigos nacionais.
  - O par enviado foi **010301 / 001**. Ele **consta** na tabela oficial da Prefeitura ("Relatório Atividade", SHA-256 `976d6c8d…865d`, em [fontes oficiais](../fiscal/fontes-oficiais.md)), cujo código de 9 dígitos é cTribNac (6) + cTribMun (3): `010301001`, "Reprodução de software em qualquer suporte".
  - Hipótese a confirmar: a parametrização da homologação difere da tabela de produção. Próximo teste: o par `010101001` ("Análise e desenvolvimento de sistemas"), com `--ctribnac 010101 --ctribmun 001`.
- **4ª tentativa (par 010101 / 001, também da tabela oficial):** `E0314` de novo.
  - O 1º par é o mesmo do XML modelo da SEMF, cujo `dCompet` é 2026-06-30, e a mensagem cita "na data de competência". Próximo teste para isolar a data: `--competence 2026-06-30`.
  - Se ainda for E0314, a pergunta vai para a SEMF/DSF: quais códigos a homologação administra.
- **5ª tentativa (par e competência iguais aos do XML modelo da SEMF, 010301 / 001 / 2026-06-30):** `E0314` de novo.
  - **Conclusão:** a homologação da DSF não reconhece os códigos de tributação de Teresina, nem os do modelo oficial. Não é questão de data nem do par escolhido.
  - Pergunta enviada à lista da SEMF (diagnóstico §10, item 10) e risco R-44. Os testes param até a resposta.
- **O que ficou provado na DSF:**
  - mTLS com o certificado da empresa;
  - envelope, gzip+Base64 e XSD de 09/02/2026, porque a DSF passou a avaliar regras de negócio;
  - formato dos erros;
  - regra de série L0022.
- **Ainda não provado:** a assinatura e uma nota autorizada.

## Consequências
- O motor aceita e prepara notas do emissor municipal de Teresina e pode transmiti-las à homologação da DSF, com a mesma disciplina de `UNKNOWN`, reconciliação e reenvio dos mesmos bytes.
- Ficam a confirmar no primeiro envio: o pacote de leiaute, o formato dos erros e os códigos de duplicidade da DSF.
- Produção da DSF, cancelamento e substituição na DSF ficam para depois do teste em homologação.

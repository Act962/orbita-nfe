# ADR-0038 — Adapter da SEFIN Nacional (produção restrita)

- Status: **Aceito** · Data: 2026-11-13
- Relacionados:
  - ADR-0022 (write-ahead);
  - ADR-0029 (transmissão e reconciliação, com o complemento do Swagger);
  - ADR-0032 (núcleo da emissão);
  - ADR-0035 (cancelamento);
  - spike 02 (transporte mTLS com a fase da falha).

## Contexto
Até aqui, o worker-fiscal só falava com o simulador. Em 2026-11-13 o Swagger da SEFIN da produção restrita foi lido com o A1 real, com o mTLS funcionando, e guardado com hash (ADR-0029, complemento). O Anexo II (eventos) foi conferido para os códigos de duplicidade e o `nSeqEvento`.

## Decisão
1. **`NationalNfseGateway`** em `nfse/infrastructure/gateways/national/` implementa a porta `NfseGateway` sobre o transporte mTLS do projeto (`sendOnce`). Esse transporte só devolve `NOT_SENT` quando prova que nenhum byte saiu.
   - Um agente TLS por chamada, criado com a chave do certificado do estabelecimento dentro de `withCredential`. A chave não fica em pool entre empresas.
   - Nada do certificado, do XML ou da resposta vai para log; o resultado leva só códigos.
2. **Perfil de endpoint como dado.** `SEFIN_NACIONAL` tem **só a produção restrita**: `https://sefin.producaorestrita.nfse.gov.br/SefinNacional`.
   - Uma nota de produção dá `NOT_SENT` local, com `NFSE_ENVIRONMENT_NOT_CONFIGURED`, sem rede. O Swagger de produção não foi lido, e a regra do projeto é não emitir em produção sem habilitação.
3. **Mapeamento do resultado**, pelos formatos do Swagger:

   | Operação | Resposta | Resultado |
   |---|---|---|
   | `POST /nfse` com `{ dpsXmlGZipB64 }` | 201 com `chaveAcesso` e `nfseXmlGZipB64` legíveis e o mesmo `idDps` | `AUTHORIZED` |
   | | 201 ilegível, sem XML ou de outra DPS | `UNKNOWN` (a consulta resolve) |
   | | 400 ou 403 com `erros[]` contendo E0014 | `ALREADY_EXISTS` |
   | | 400 ou 403 com outro `Exxxx` | `REJECTED` com o primeiro código; a mensagem junta todas |
   | | 5xx, status não documentado, sem código `Exxxx` | `UNKNOWN` |
   | `GET /dps/{id}` e depois `GET /nfse/{chave}` | 200 e 200 com o XML | `FOUND` |
   | | 404 em `/dps` | `NOT_FOUND` |
   | | qualquer outra resposta, inclusive DPS encontrada com a NFS-e falhando | `ERROR` (nunca `NOT_FOUND`) |
   | `POST /nfse/{chave}/eventos` com `{ pedidoRegistroEventoXmlGZipB64 }` | 201 com `eventoXmlGZipB64` | `REGISTERED` |
   | | 400 com E0802 ou E0840 | `ALREADY_EXISTS` |
   | | 400 com outro `Exxxx` | `REJECTED` |
   | | resto | `UNKNOWN` |
   | `GET /nfse/{chave}/eventos/{tipo}/{seq}` | 200, 404 ou resto | `FOUND`, `NOT_FOUND` ou `ERROR` |

   - Os erros chegam como `erros: [...]` na emissão e `erro: {...}` nos eventos. O adapter aceita as duas formas.
4. **Duplicidade de evento.** Fonte: Anexo II v1.01 de 22/01/2026, hash igual ao registrado.
   - **E0802:** "Já existe um documento fiscal eletrônico identificado com este id".
   - **E0840:** o cancelamento não é recebido porque já existe evento de cancelamento vinculado. A matriz "RN EVENTOSxEVENTOS" proíbe cancelamento sobre cancelamento, sobre cancelamento por substituição e sobre cancelamento por ofício.
   - Nos dois casos o resultado é `ALREADY_EXISTS`, que leva à consulta e nunca a "não cancelada". **Limite conhecido:** se o E0840 vier de outro tipo de cancelamento (substituição ou ofício), a consulta do 101101 não acha nada, e o pedido fica em `UNKNOWN` para o operador. Confirmar no primeiro caso real.
5. **`nSeqEvento`.** A consulta de evento exige o número sequencial. A porta passou a recebê-lo, e o cancelamento usa **1**: "Para os eventos que ocorrem somente uma vez, como é o caso do cancelamento, o nSeqEvento = 001" (Anexo II, aba LEIAUTE).
6. **Configuração:** `NFSE_GATEWAY=sefin` no worker-fiscal, além de `none` e `simulator`. O worker registra no log que está falando com a SEFIN real e quais URLs estão no perfil.

## Primeiro envio real (2026-11-13, produção restrita)
DPS fictícia (R$ 1,00, série 900, sem tomador) da empresa de teste, não optante, de Teresina. Foi enviada com `npm run sefin:test` e o mesmo preparador e adapter do worker.

1. **Envio pelo cliente HTTP (undici 8):** `ERR_HTTP2_STREAM_ERROR`, que o adapter tratou corretamente como `UNKNOWN`.
   - Causa: o undici 8 negocia HTTP/2 por padrão, e a SEFIN pede o certificado do cliente por renegociação TLS, que não existe em HTTP/2.
   - **Correção:** `allowH2: false` no transporte mTLS, que passa a usar sempre HTTP/1.1.
2. **Consulta `GET /dps/{id}`:** 404, com o corpo `{"erro":{"codigo":"E2404","descricao":"Não foi gerada uma NFS-e…"}}`, lido como `NOT_FOUND`. A DPS não existia, então não houve duplicidade.
3. **Reenvio dos MESMOS bytes:** 400, com o corpo `{"versaoAplicativo":"SefinNacional_1.6.0", …, "erros":[{"Codigo":"E0037","Descricao":"O código do município emissor informado na DPS é inexistente no cadastro de convênio municipal do sistema nacional."}]}`.
   - **Divergência do Swagger:** a emissão usa `Codigo`/`Descricao` com inicial maiúscula, e a consulta usa `codigo` em minúsculas. O adapter tratou a resposta como `UNKNOWN`, o que era seguro.
   - **Correção:** as chaves passam a ser lidas sem distinguir maiúsculas de minúsculas. A mesma resposta agora vira `REJECTED E0037`, e o corpo real entrou no teste.

**O que ficou provado na SEFIN real:**
- mTLS;
- caminhos e envelope `dpsXmlGZipB64`;
- gzip+Base64 e schema XML. As regras de recepção E1225, E1226 e E1235 da aba RN_RECEP_DPS passaram, e a resposta já é uma regra de negócio;
- formato das respostas de erro e de "não encontrada".

**O que ainda NÃO está provado:** a assinatura (E0714–E0718, R-31). Ela fica na mesma aba de regras de negócio da E0037, e a SEFIN respondeu um único erro.

**Achado E0037 (R-43):** na produção restrita, o município 2211001 (Teresina) não consta no cadastro de convênio do Sistema Nacional. A regra só abre exceção para MEI. Enquanto isso, nenhuma DPS de prestador de Teresina que não seja MEI passa dessa regra na produção restrita, seja não optante ou ME/EPP.

## Fora deste ADR
- **O primeiro envio real** de uma DPS à produção restrita. É um passo à parte, que depende de dois pré-requisitos:
  - o bundle de ACs ICP-Brasil para ativar o A1 no cofre (R-29);
  - o OK explícito do responsável.
- A empresa de teste é não optante. Em Teresina, a rejeição esperada é a E0039 (ADR-0028), que ainda assim valida transporte, assinatura e envelope.
- Verificação da assinatura da SEFIN no XML recebido (R-37).
- Perfil de produção, depois de ler o Swagger de produção.
- Adapter da DSF (Teresina, Fase 2b): um novo perfil sobre o mesmo cliente, como previsto no ADR-0029.

## Consequências
- O motor pode falar com a SEFIN real na produção restrita, com a mesma disciplina do simulador: dúvida vira `UNKNOWN` e consulta, nunca reenvio direto nem "não emitida".
- Os testes do adapter usam uma SEFIN falsa local, com HTTPS e mTLS nos formatos do Swagger. Nenhum teste sai da máquina.

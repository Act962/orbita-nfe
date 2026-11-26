# ADR-0073 — Webhook de estado e download do XML da NFC-e

- Status: **Aceito** · Data: 2026-11-26
- Relacionados:
  - ADR-0015 (eventos só com identificadores);
  - ADR-0032 (webhook da NFS-e, o molde);
  - ADR-0048 e ADR-0050 (XML com hash gravado junto e download conferido);
  - ADR-0072 (núcleo da NFC-e).

## Decisão
1. **Evento `consumer_invoice.status_changed`:**
   - **Quando:** publicado pelo outbox na **mesma transação** da mudança de estado, como na NFS-e. Vale para todo caminho: envio, consulta e queda.
   - **Corpo:**
     - `data.status`: `AUTHORIZED`, `REJECTED`, `DENIED`, `FAILED` ou `UNKNOWN`;
     - `consumerInvoiceId`, `establishmentId`, `externalReference`, `environment`, `series` e `number`;
     - conforme o caso: `accessKey`, `statusCode`, `rejectionCode`, `failureCode` e `resolvedBy`.
   - Nunca o XML, os dados do consumidor ou os valores da venda.
   - **Catálogo:** é assinável e aparece em `GET /v1/webhook-event-types`.
   - **`UNKNOWN`:** a descrição avisa "não emita outra".
2. **`GET /v1/consumer-invoices/{id}/xml`** (`nfce:read`):
   - devolve o `nfeProc` (NFe assinada + `protNFe`), só na nota `AUTHORIZED`;
   - antes de sair, os bytes são conferidos contra o SHA-256 gravado junto com eles. Se não baterem, nada sai (`NFCE_XML_HASH_MISMATCH`, erro interno);
   - cabeçalhos: `ETag`, `Repr-Digest` (RFC 9530) e `Cache-Control: private, no-store`;
   - nome sugerido `<chave>-procNFe.xml`;
   - a mesma visibilidade da consulta: outra aplicação ou outro ambiente recebe 404;
   - a rota está na matriz de isolamento;
   - `links.xml` aparece na nota autorizada.
3. **`procNFe_v4.00.xsd`**, do PL_009q, entra no pacote `nfe/4.00-nfe-pl010h`, conferido byte a byte com o zip oficial. O teste de ponta a ponta valida nele o `nfeProc` gravado.

## Consequências
- O cliente acompanha a NFC-e sem consultar em laço, e baixa o XML que precisa guardar.
- **Ainda falta:**
  - **o arquivamento com Object Lock,** como no ADR-0048 (fila e bucket);
  - **o DANFE NFC-e,** que depende do manual do DANFE NFC-e v6.0 e da escolha da versão do QR Code (ADR-0066).

# ADR-0050 — Download do XML da NFS-e e do evento de cancelamento pela API

- Status: **Aceito** · Data: 2026-11-24
- Relacionados:
  - ADR-0010 (artefatos em object storage);
  - ADR-0021 (separação de segredos por processo);
  - ADR-0026 item 8 (links de arquivos com 302): **revisto aqui para o XML**;
  - ADR-0048 e ADR-0049 (hash e arquivamento dos XML).

## Contexto
O doc 11 previa `GET /v1/service-invoices/{id}/xml` respondendo 302 para uma URL pré-assinada do bucket. Isso exigiria duas coisas:
- a API teria de receber uma credencial do bucket de artefatos. Hoje só o worker-fiscal a tem (ADR-0048 item 5), e a API é o processo mais exposto;
- a URL pré-assinada funciona para quem tiver o link enquanto ele valer, sem credencial. O XML tem dados pessoais do tomador (LGPD).

Além disso, o objeto só existe depois que o job de arquivamento roda. Sem o bucket configurado, a nota autorizada ficaria sem download.

O banco já guarda o XML byte a byte e o SHA-256 gravado na mesma transação da autorização (ADR-0048, ADR-0049). A API já lê a nota com RLS.

## Decisão
1. **Duas rotas, escopo `nfse:read`:**
   - `GET /v1/service-invoices/{id}/xml`: o XML da NFS-e devolvido pelo autorizador, na nota AUTHORIZED, CANCELLED ou SUBSTITUTED. Cancelada ou substituída, a nota continua tendo sido autorizada, e o XML é o mesmo.
   - `GET /v1/service-invoices/{id}/cancellation/xml`: o XML do evento de cancelamento (e101101) do pedido mais recente, quando REGISTERED.
2. **A API serve os bytes do banco, sem redirecionar.** A resposta passa pela mesma autenticação, concessão e RLS da consulta da nota. Nota de outra aplicação ou de outro ambiente responde 404, como no `GET` da nota.
3. **Conferência do hash antes de responder.** A API recalcula o SHA-256 e compara com o gravado. Se não bater, responde 500 e registra `NFSE_XML_HASH_MISMATCH` no log, sem mandar os bytes: é sinal de alteração indevida, para investigar.
4. **Cabeçalhos:**
   - `Content-Type: application/xml; charset=utf-8`;
   - `Content-Disposition: attachment` com o nome do arquivo: `nfse-{chave de acesso}.xml`, ou `cancelamento-{chave de acesso}.xml`;
   - `ETag` com o SHA-256 e `Repr-Digest: sha-256=:…:` (RFC 9530), para o cliente conferir o que recebeu;
   - `Cache-Control: private, no-store`, por causa dos dados pessoais.
5. **Sem XML ainda:** 404 com `NFSE_XML_NOT_AVAILABLE` (nota que não chegou a ser autorizada) ou `CANCELLATION_XML_NOT_AVAILABLE` (cancelamento que não foi registrado).
6. **Privilégio:** a API passa a ler a coluna `event_xml` (migration 0027). A coluna `nfse_xml` ela já lia. A gravação continua só com o worker-fiscal.

## Consequências
- O download funciona com ou sem o bucket. O bucket continua sendo a cópia imutável fora da VPS. Ler de lá só vai ser preciso se o banco for perdido, e esse caminho é a restauração, não a API.
- A API continua sem credencial do bucket de artefatos.
- O 302 para URL pré-assinada do ADR-0026 item 8 continua valendo para arquivos grandes, que ainda não existem: o PDF e o ZIP mensal para o contador. Para o XML, vale este ADR.
- Feitos depois: a verificação periódica dos objetos ([ADR-0051](0051-conferencia-periodica-xml-arquivado.md)) e os `links` no corpo da nota ([ADR-0052](0052-links-no-corpo-da-nota.md)).

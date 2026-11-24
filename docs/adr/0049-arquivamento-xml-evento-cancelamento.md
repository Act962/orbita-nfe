# ADR-0049 — Arquivamento do XML do evento de cancelamento

- Status: **Aceito** (prazo de retenção e provedor pendentes, como no ADR-0048) · Data: 2026-11-24
- Relacionados:
  - ADR-0010 (artefatos em object storage);
  - ADR-0035 (cancelamento, e101101);
  - ADR-0048 (arquivamento do XML autorizado).

## Contexto
O ADR-0048 arquivou o XML autorizado da NFS-e e deixou de fora os XML de eventos. O evento de cancelamento registrado pelo autorizador (`service_invoice_cancellations.event_xml`) é a prova de que a nota foi cancelada. Hoje ele fica só no banco, sem hash.

## Decisão
O mesmo desenho do ADR-0048:

1. **Hash junto com o XML do evento.** Quando o cancelamento vira REGISTERED, por envio ou por consulta, o worker-fiscal grava `event_xml_sha256` na mesma transação.
2. **Job na mesma transação.** A mesma transação enfileira `nfse.archive-cancellation`, com a chave `<cancelamento>:archive`. É uma fila própria porque o payload leva o id do cancelamento, não o da nota.
3. **Chave na pasta da nota:** `company/{empresa}/nfse/{aaaa}/{mm}/{nota}/event-101101-{cancelamento}-{sha256}.xml`, com o mês do registro do evento.
   - O ano e o mês podem diferir dos da nota. Mesmo assim, o id da nota no caminho permite achar o evento a partir dela.
   - O id do cancelamento separa um pedido do outro, se houver mais de um.
4. **Mesmas conferências.** Hash antes de enviar, COMPLIANCE, releitura e só então a marca (`event_xml_object_key`, `event_xml_archived_at`, `event_xml_retain_until`). A auditoria registra `service_invoice.cancellation_xml_archived`.
5. **Retenção contada do registro do evento**, com o mesmo `ARTIFACTS_RETENTION_DAYS`. Como o evento é posterior à nota, ele nunca vence antes dela.
6. **Travas no banco (migration 0026)**, iguais às da nota:
   - colunas gravadas uma vez;
   - o hash não pode ser gravado depois do XML;
   - só o `fiscal_worker` grava;
   - API e operador veem a situação do arquivamento, sem o XML.

## Consequências
- Nota e cancelamento passam a ter cópia imutável fora da VPS.
- O evento de substituição (e105102) é registrado pelo autorizador quando a substituta é autorizada, e o motor não recebe esse XML. A prova da substituição é o XML autorizado da substituta, que já é arquivado (ADR-0048).
- **Feitos depois:** o download pela API ([ADR-0050](0050-download-xml-pela-api.md)) e a verificação periódica dos objetos ([ADR-0051](0051-conferencia-periodica-xml-arquivado.md)).

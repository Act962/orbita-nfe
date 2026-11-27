# ADR-0078 — Diagnóstico da NFC-e e reenvio do webhook pela nota

- Status: **Aceito** · Data: 2026-11-27
- Relacionados:
  - ADR-0055 (diagnóstico da NFS-e, o molde);
  - ADR-0056 (reenvio de webhook pelo documento);
  - ADR-0072 (tentativas da NFC-e).

## Decisão
1. **`GET /v1/consumer-invoices/{id}/diagnostics`**, com o escopo próprio **`nfce:debug`**. O `nfce:read` não o inclui, e ele não implica nenhum outro (como o `nfse:debug`). A resposta traz:
   - **protocolo:** chave, `cStat`, número do protocolo, SHA-256 do `nfeProc` (o mesmo do `ETag` do download), data do arquivamento e retenção;
   - **cada tentativa:** sequência, estado, chave e `dhEmi` montados nela (o XML é montado a cada tentativa, regra B09-40), resultado, código (`cStat` ou erro de transporte), horários e consultas pela chave.
2. **Só metadados e códigos:** nenhum XML, nenhum `DigestValue` e nenhum dado do consumidor.
   - O repositório lê só as colunas que a migration 0039 já concede à API: nunca `signed_xml` nem `digest_value`.
   - Mesma visibilidade do `GET` da nota: outra empresa, outra aplicação ou outro ambiente recebe 404.
3. **Reenvio do webhook pela nota:** `POST /v1/webhook-deliveries/redeliveries` já era genérico pelo `subject.id`. Com o id da NFC-e, ele reenvia o último `consumer_invoice.status_changed`. Só a documentação mudou.

## Consequências
- O suporte investiga uma nota incerta (quantas tentativas, qual código, quantas consultas) sem acesso ao banco e sem ver o XML.
- O escopo separado permite dar o diagnóstico a quem não emite nem baixa notas.

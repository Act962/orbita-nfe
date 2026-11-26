# ADR-0075 — Conferência periódica dos XML arquivados da NFC-e

- Status: **Aceito** · Data: 2026-11-26
- Relacionados:
  - ADR-0051 (conferência periódica da NFS-e: o mecanismo);
  - ADR-0074 (arquivamento do XML da NFC-e).

## Decisão
1. **Um mecanismo só para os três documentos.** A conferência diária do ADR-0051 passa a cobrir a NFC-e como um terceiro tipo (`NFCE`), ao lado de `NFSE` e `CANCELLATION_EVENT`. É o mesmo job por empresa, com a mesma regra:
   - **o que se confere:** o XML do banco contra o hash, o objeto no bucket, os bytes do objeto, e a trava COMPLIANCE com a retenção gravada;
   - **quando:** de novo 30 dias depois da última conferência boa; uma falha volta a ser conferida, e alertada, uma vez por dia;
   - **em caso de falha:** alerta no log e auditoria, sem nunca regravar.
2. **Banco (migration 0042):**
   - `ck_archived_xml_checks_kind` passa a aceitar `NFCE`;
   - a consulta da vez inclui `consumer_invoices` arquivadas.
3. **Auditoria da falha no assunto certo:** `consumer_invoice.archived_xml_check_failed`, com o sujeito `consumer_invoice`. A NFS-e segue com `service_invoice`.
4. **Agendamento:**
   - o arquivamento da NFC-e agenda a conferência da empresa, como o da NFS-e;
   - o agendador foi para `shared/application/archive-verification.ts`, comum aos dois;
   - a fila mantém o nome histórico `nfse.verify-archives` e confere os três tipos.
5. **Ligação no worker:** o handler é ligado pelo bucket da NFS-e ou, quando só a NFC-e está configurada, pelo dela. Nenhum arquivado fica sem conferência.

## Consequências
- A NFC-e tem a mesma garantia de guarda da NFS-e: cópia imutável e conferência contínua.
- O nome da fila não diz mais tudo o que ela faz. Renomear exigiria migrar os jobs pendentes, e isso não compensa agora.

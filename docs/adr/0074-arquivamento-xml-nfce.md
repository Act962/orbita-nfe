# ADR-0074 — Arquivamento do XML autorizado da NFC-e com Object Lock

- Status: **Aceito** · Data: 2026-11-26
- Relacionados:
  - ADR-0010 (object storage);
  - ADR-0048 (arquivamento do XML da NFS-e: o molde);
  - ADR-0051 (conferência periódica);
  - ADR-0072 e ADR-0073 (núcleo e XML da NFC-e).

## Decisão
1. **A mesma garantia da NFS-e:**
   - **Enfileiramento:** a autorização grava o `nfeProc` e o SHA-256 juntos e enfileira `nfce.archive` **na mesma transação**, pelo envio e pela consulta. Se a nota ficou `AUTHORIZED`, o job existe.
   - **Antes de enviar:** o job confere os bytes contra o hash gravado.
   - **No bucket:** grava com retenção **COMPLIANCE** e relê.
   - **Só depois:** marca a nota com a chave do objeto, a data e a retenção. Releitura diferente = erro, e a nota não fica marcada.
   - **Repetição:** é segura. A chave tem o hash, e o que já está arquivado não é enviado de novo.
2. **Chave do objeto:** `company/{empresa}/nfce/{aaaa}/{mm}/{nota}/nfce-{sha256}.xml`, com o mês da autorização em UTC.
3. **Retenção:** a mesma `ARTIFACTS_RETENTION_DAYS` da NFS-e, contada da autorização. O prazo legal é decisão do responsável e do contador (ADR-0048), e a configuração não tem valor padrão.
4. **Banco (migrations 0040 e 0041):**
   - colunas `nfe_proc_xml_object_key`, `nfe_proc_xml_archived_at` e `nfe_proc_xml_retain_until`;
   - a constraint `ck_consumer_invoices_proc_archive` exige as três juntas, só com o XML e o hash já gravados, e a chave contendo o hash;
   - a guarda da nota passou a gravar as três uma vez só, inclusive contra o superusuário, e impede "carimbar" hash num XML antigo;
   - o `UPDATE` dessas colunas é permitido só ao worker-fiscal.
5. **Ligação no worker:** o worker-fiscal liga o arquivamento quando o bucket de artefatos está configurado. Sem bucket, a fila `nfce.archive` espera.

## Consequências
- O XML autorizado da NFC-e passa a ter uma cópia imutável fora da VPS, como a NFS-e.
- **Ainda falta:** a conferência periódica dos objetos arquivados (ADR-0051), que hoje cobre só a NFS-e. Ela precisa estender a tabela `archived_xml_checks`, e fica para um passo próprio.

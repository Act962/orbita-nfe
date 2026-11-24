# ADR-0048 — Arquivamento do XML autorizado da NFS-e no bucket com Object Lock

- Status: **Aceito** (prazo de retenção e provedor pendentes) · Data: 2026-11-23
- Relacionados:
  - ADR-0010 (artefatos fiscais em object storage);
  - ADR-0021 (separação de segredos por processo);
  - ADR-0031 (âncora externa da auditoria, o mesmo padrão de bucket);
  - ADR-0032 (núcleo da emissão).

## Contexto
O ADR-0010 e o doc 14 pedem duas coisas para o XML autorizado:
- que fique guardado byte a byte, com o SHA-256 no banco;
- que tenha uma cópia imutável fora da VPS, num bucket com Object Lock.

Até aqui, o XML ficava só na coluna `nfse_xml`, sem hash. Se a VPS fosse perdida, a única cópia seria o backup do banco. Uma alteração indevida da coluna também não seria percebida.

O motor já usa um bucket com Object Lock para a âncora da auditoria (ADR-0031), testado com o SeaweedFS.

## Decisão
1. **Hash junto com o XML.** Quando a nota vira AUTHORIZED, o worker-fiscal grava `nfse_xml_sha256` (SHA-256 dos bytes UTF-8) na mesma transação, por qualquer caminho: envio, consulta ou resolução manual.
2. **Job na mesma transação.** A mesma transação enfileira `nfse.archive`, com a chave `<id>:archive`. Os três caminhos passam por uma função única (`afterAuthorization`), que também fecha a original na substituição. Se a nota ficou AUTHORIZED, o job existe.
3. **O job arquiva com conferência.**
   - Confere os bytes do banco contra o hash gravado. Se não baterem, para em definitivo (`NFSE_XML_HASH_MISMATCH`) e nada vai para o bucket.
   - Grava fora da transação, com `ObjectLockMode=COMPLIANCE` e `Content-MD5`. A chave segue o ADR-0010: `company/{empresa}/nfse/{aaaa}/{mm}/{nota}/nfse-{sha256}.xml`, com o mês da autorização em UTC.
   - Relê o objeto e confere o hash, o modo COMPLIANCE e a data de retenção. Só então marca a nota (`nfse_xml_object_key`, `nfse_xml_archived_at`, `nfse_xml_retain_until`) e audita `service_invoice.xml_archived`. Se a releitura não bater, o job tenta de novo e a nota não fica arquivada.
   - Repetir é seguro: nota já arquivada não é enviada de novo, e a chave contém o hash.
   - O XML continua no banco. O bucket é a cópia imutável fora da VPS.
4. **Travas no banco (migration 0024).**
   - As quatro colunas são gravadas uma única vez (`ck_service_invoices_write_once`).
   - O hash não pode ser gravado depois do XML: ninguém "carimba" um XML que já estava lá.
   - Arquivado exige o XML e o hash, e a chave do objeto contém o hash.
   - Só o `fiscal_worker` grava essas colunas. A API lê; o operador vê só a situação, sem o XML.
   - A checagem "XML ⇔ hash" é `NOT VALID`: vale para toda linha nova. Notas autorizadas antes desta migration existem só em desenvolvimento.
5. **Quem grava é o worker-fiscal.** Ele já tem o XML. O worker-general, que faz requisições a URLs de clientes, não recebe a credencial do bucket de artefatos.
6. **Retenção sem padrão.** `ARTIFACTS_RETENTION_DAYS` é o prazo legal de guarda dos documentos fiscais, contado da autorização. **O motor não escolhe esse prazo:** fica para o responsável com o contador, e o ADR-0010 já registrava a pendência. Bucket configurado sem retenção é configuração pela metade e o processo não sobe.
7. **Obrigatório em produção com NFS-e.** Sem o bucket, o worker-fiscal de produção com `NFSE_GATEWAY` diferente de `none` não sobe. Fora de produção, sem o bucket, a fila fica sem handler e os jobs esperam até ele ser configurado.

## Consequências
- O deploy de produção passa a depender de mais duas decisões: o prazo de retenção e o provedor S3 (decisão pendente 2, a mesma da âncora).
- Com Object Lock COMPLIANCE, nem a credencial de escrita apaga um objeto antes do prazo. Um prazo errado para mais não tem volta, por isso ele precisa ser confirmado.
- **Ainda não fazem parte desta etapa:**
  - os XML de eventos (cancelamento): feito no [ADR-0049](0049-arquivamento-xml-evento-cancelamento.md);
  - a verificação periódica dos objetos contra o hash;
  - o download pela API: feito no [ADR-0050](0050-download-xml-pela-api.md), servido do banco, sem URL pré-assinada.

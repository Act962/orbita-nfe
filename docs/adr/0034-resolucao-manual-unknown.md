# ADR-0034 — Resolução manual de NFS-e em UNKNOWN e alertas por idade

- Status: **Aceito** · Data: 2026-11-12
- Relacionados:
  - ADR-0006 (estado UNKNOWN);
  - ADR-0021 (separação de processos);
  - ADR-0022 (write-ahead);
  - ADR-0032 (núcleo da emissão);
  - doc 12 §6 e §7;
  - risco R-37.

## Contexto
A reconciliação automática consulta o autorizador para sempre, com backoff, e nenhum caminho leva `UNKNOWN` a `FAILED`. Sobram dois casos sem saída:
- **a consulta não resolve**: o serviço de consulta está fora por dias, ou o autorizador responde de forma inesperada;
- **a nota fica presa sem ninguém saber**: não havia alerta, só olhar a fila.

O doc 12 já previa:
- um comando auditado do operador, com resultado alegado, justificativa e evidência;
- alertas a 15 min, 2 h e 24 h.

## Decisão
1. **O operador pede; o worker-fiscal decide.**
   - O operador usa a CLI `ops`, com o papel `fiscal_admin`. Ela grava um pedido em `service_invoice_resolutions` (só se acrescenta), audita na cadeia da empresa e enfileira `nfse.resolve`.
   - O `fiscal_admin` **não** recebe `UPDATE` em `service_invoices`. Continua valendo que só o worker-fiscal muda o estado de um documento fiscal.
   - O operador lê só metadados: nem o pedido do cliente, nem a DPS assinada, nem o XML.
   - **Isolamento sem exceção:** o operador informa a empresa (`--company`), como na verificação da auditoria. Pedido, consulta e painel rodam numa transação dessa empresa (RLS); nota de outra empresa é "não encontrada".
     - Nenhuma política permissiva extra foi criada. O meta-teste de RLS continua exigindo isso.
     - Para o painel saber quais empresas olhar sem `--company`, ele lê a fila (`nfse.reconcile` e `nfse.escalate`), que só tem identificadores.
2. **Dois resultados possíveis.** Não há `FAILED` nem "abandonar":
   - **`AUTHORIZED`**: o operador traz o XML oficial da NFS-e, obtido no portal. O próprio XML é a evidência (SHA-256 gravado).
   - **`NOT_ISSUED`**: o operador confirmou que a nota não existe e guarda a evidência (por exemplo, um print do portal). Só o SHA-256 do arquivo vai para o banco.
     - O documento volta a `PENDING` e o **mesmo XML assinado** é retransmitido, com o mesmo Id e o mesmo número.
     - Se a nota existir lá, a resposta é de duplicidade e a consulta resolve. Não há como surgir uma segunda nota.
     - É recusado se a última resposta do autorizador nesta nota foi de duplicidade (`AUTHORIZER_REPORTED_EXISTING`).
3. **Conferência do XML oficial** (`XmlNfseVerifier`), toda pelo XSD oficial (`NFSe_v1.01.xsd`, tipo TCNFSe), no **mesmo pacote** em que a DPS foi assinada:
   - parse seguro (sem DTD, até 5 MiB);
   - XSD válido;
   - `infNFSe/@Id` no formato de TSIdNFSe, `"NFS"` + 50 dígitos. A chave de acesso (TSChaveNFSe) são os 50 dígitos;
   - `DPS/infDPS/@Id` igual ao Id da DPS do documento;
   - `infDPS/tpAmb` igual ao ambiente do documento;
   - `dhProc` vira a data de autorização;
   - se a DPS embutida vier assinada, o `SignatureValue` tem de ser o da DPS que nós assinamos. Uma DPS com o mesmo Id emitida por outro sistema é recusada (`NFSE_DPS_SIGNATURE_MISMATCH`).

   Recusa:
   - grava um código estável no pedido e audita;
   - a nota continua `UNKNOWN`, com a reconciliação automática seguindo;
   - o operador pode fazer outro pedido.

   Aceite: webhook `AUTHORIZED` com `resolvedBy: MANUAL`.
4. **Corridas.**
   - A mudança de estado é compare-and-set a partir de `UNKNOWN`. Se a consulta resolver antes, o pedido é recusado com `SERVICE_INVOICE_NOT_UNKNOWN`.
   - Há no máximo um pedido aberto por nota (índice único parcial).
   - A decisão é gravada uma única vez (trigger).
5. **Alertas por idade.** Quando a nota entra em `UNKNOWN`, um job `nfse.escalate` é agendado para +15 min, contados do envio da tentativa sem resposta.
   - Cada execução alerta e agenda a próxima verificação: 2 h, 24 h e depois a cada 24 h.
   - Para sozinha quando a nota sai de `UNKNOWN`.
   - O alerta é log estruturado do worker-fiscal (`event: nfse.unknown_age`, só identificadores):
     - `WARNING` vai como `warn`;
     - `CRITICAL` e `INCIDENT` vão como `error`.
   - Não há varredura entre empresas: cada nota agenda a própria verificação, como os avisos de certificado.
   - O painel de pendências é `ops nfse-unknown`, por empresa ou de todas as que têm reconciliação na fila.
6. **Privilégios novos**, todos na migration 0014:
   - `fiscal_admin`, sempre no contexto da empresa:
     - `INSERT` nas colunas do pedido;
     - `SELECT` dos metadados de notas, tentativas e pedidos;
     - `INSERT` em `jobs` só na fila `nfse.resolve`, lane `fiscal`.
   - `fiscal_worker`: `SELECT` do pedido e `UPDATE` só da decisão.
   - Ninguém apaga pedidos.

## Limitações conhecidas
- **A assinatura da SEFIN sobre `infNFSe` não é verificada.** A cadeia de confiança do certificado do emissor nacional ainda não está definida. Por isso a conferência se apoia no XSD, no Id da DPS, no ambiente e na assinatura da nossa DPS. Rever quando o adapter da SEFIN existir.
- **A evidência de `NOT_ISSUED` fica com o operador.** Só o SHA-256 vai para o banco. Guardar o arquivo no bucket fica para quando houver armazenamento de documentos.
- **Os alertas são linhas de log.** A métrica (`fiscal_unknown_documents`, doc 12 §6) entra junto com a observabilidade do deploy.

## Alternativas consideradas
- **O operador muda o estado direto no banco.** Rejeitada: daria `UPDATE` em documento fiscal a um segundo papel, e a conferência do XML ficaria fora do processo que tem o catálogo de XSD.
- **`NOT_ISSUED` libera a referência externa (o cliente reemite).** Rejeitada: se a nota existir, nasce uma duplicata. Retransmitir o mesmo XML é seguro em qualquer caso.
- **Varredura periódica de `UNKNOWN`.** Rejeitada: exigiria leitura entre empresas pelo worker. Um job por nota segue o padrão dos avisos de certificado.
- **Política de leitura do operador em todas as empresas.** Rejeitada: o meta-teste de RLS barrou a política permissiva extra, que somaria (OR) à de isolamento. O operador lê por empresa.

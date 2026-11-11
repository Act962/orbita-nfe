# Runbook — Filas, workers e webhooks

Referências: [ADR-0030](../adr/0030-fila-propria-postgresql.md), ADR-0015, ADR-0021, [doc 07](../architecture/07-filas-processamento.md) e [doc 11 (Webhooks)](../architecture/11-api.md).

## 1. Processos e segredos
| Processo | Comando | Banco (papel) | Segredos (arquivo montado) | Filas |
|---|---|---|---|---|
| api | `node dist/main/api.js` | `DATABASE_URL` (fiscal_api) | pepper, KEK **pública**, chave **pública** de webhooks (`WEBHOOK_SECRET_KEY_PUBLIC_FILE`) | só enfileira |
| worker-fiscal | `node dist/main/worker-fiscal.js` | `WORKER_DATABASE_URL` (fiscal_worker) | KEK **privada**, bundle de ACs | `certificates.validate` |
| worker-general | `node dist/main/worker-general.js` | `GENERAL_DATABASE_URL` (fiscal_general) | chave **privada** de webhooks (`GENERAL_WEBHOOK_SECRET_KEY_PRIVATE_FILE`), credencial de ESCRITA do bucket de âncoras | `webhooks.fanout`, `webhooks.deliver`, `certificates.expiry-notice`, `audit.anchor-company`, `audit.anchor-platform` |

Regras de configuração:
- Em produção, cada container recusa subir com segredo de outro papel.
- `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` é recusado em produção.
- No desenvolvimento local, um único `.env` é tolerado.
- Encerramento: `SIGTERM` para de buscar jobs e espera os que estão em execução.

Gerar a chave de webhooks de produção: mesmo procedimento da KEK ([kek-certificados §2](kek-certificados.md)), em arquivos separados. A pública vai para a API e a privada só para o worker-general. Em desenvolvimento, `npm run dev:secrets` gera as duas.

## 2. Comandos do operador (`npm run ops`, papel fiscal_admin, tudo auditado)
| Comando | Efeito |
|---|---|
| `npm run ops -- queues` | Pendentes, em execução, mortos, pausa e idade do mais antigo, por fila |
| `npm run ops -- pause <fila> --reason "<motivo>"` | Workers param de pegar jobs da fila. Nenhum job nem documento muda |
| `npm run ops -- resume <fila>` | Retoma |
| `npm run ops -- dead [--limit 50]` | Lista os mortos (id, fila, tentativas, código de erro) |
| `npm run ops -- retry <jobId>` | Devolve um job morto à fila com as tentativas zeradas |
| `npm run ops -- discard <jobId> --reason "<justificativa>"` | Descarta job pendente ou morto (nunca o documento) |

`--operator <nome>` registra quem fez; o padrão é o usuário do sistema.

## 3. Situações
| Sintoma | Verificar | Ação |
|---|---|---|
| Fila crescendo, nada sai | `ops queues`: está pausada? O worker da lane está rodando (log `worker iniciado`)? | Retomar a fila ou subir o worker. Um job ativo com concessão vencida volta sozinho para a fila (log `jobs com concessão vencida devolvidos à fila`) |
| Mortos em `certificates.validate` | `ops dead`: código `JOB_PAYLOAD_INVALID` (bug) ou erro de banco | Corrigir a causa e rodar `ops retry`. A CLI `npm run certificates -- validate` continua disponível para revalidar uma empresa |
| Cliente diz que não recebe webhook | Pela API do cliente: `GET /v1/webhook-deliveries?subscriptionId=…` (`status`, `lastHttpStatus`, `lastErrorCode`) | `TARGET_FORBIDDEN`: URL resolve para endereço privado. `TIMEOUT`/`CONNECTION_FAILED`: destino fora. `HTTP_STATUS`: o destino respondeu erro. O cliente pode usar `/redeliver` e `/test` |
| Mortos em `audit.anchor-company` ou `audit.anchor-platform` | `ops dead`: erro do bucket (credencial, Object Lock desligado, provedor fora) | Corrigir e rodar `ops retry` **sempre**. O job de amanhã já foi agendado, mas a âncora de hoje fica faltando até o retry (ADR-0031) |
| Log `âncora da auditoria não configurada` | Variáveis `AUDIT_ANCHOR_S3_*` | Em produção o worker nem sobe sem elas; fora de produção, as filas de âncora ficam paradas |
| Muitos `429 RATE_LIMITED` | Limite por credencial ou por endereço | Ajustar `RATE_LIMIT_*`. Os baldes ficam em memória por réplica da API: com N réplicas, o limite efetivo é N × o configurado |

## 4. Garantias que a operação não pode quebrar
- Job carrega só ids. Nunca edite `payload`: o banco recusa, por grant e por trigger.
- Pausar ou descartar não altera documento fiscal.
- O outbox (`outbox_events`) é append-only para todos os papéis.
- A entrega de webhook é "pelo menos uma vez": o cliente deduplica pelo `webhook-id`.

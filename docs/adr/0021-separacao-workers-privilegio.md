# ADR-0021 — Workers separados por privilégio

- Status: **Aceito** · Data: 2026-11-09

## Decisão
| Container | Filas | Segredos |
|---|---|---|
| `worker-fiscal` | `nfse.*`, `nfe.*`, `nfce.*`, validação/rotação de certificados | KEK privada, CSC, credenciais municipais |
| `worker-general` | `webhook.deliver`, outbox dispatcher, alertas, stuck-scan, verificação de integridade | segredos de webhook (HMAC) apenas |

Cada um usa papel de banco próprio (`fiscal_worker`, `fiscal_general`) com grants mínimos.

## Motivo
O `worker-general` faz requisições a URLs de terceiros (webhooks) e é a superfície mais exposta; ele nunca deve ter material de certificados em memória.

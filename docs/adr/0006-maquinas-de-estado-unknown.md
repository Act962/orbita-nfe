# ADR-0006 — Máquinas de estado por modalidade e estado UNKNOWN

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
Cada modalidade define sua máquina de estados no domínio, usando o vocabulário comum (PENDING, PROCESSING, AUTHORIZED, REJECTED, CANCELLED, FAILED, UNKNOWN) e acrescentando apenas estados fiscais reais (DENIED na NF-e/NFC-e, SUBSTITUTED na NFS-e, CONTINGENCY_PENDING_SYNC). Eventos fiscais (cancelamento, CC-e) têm estado próprio.

Regras invioláveis:
1. `FAILED` só quando é certo que nada foi transmitido.
2. Falha após possível entrega → `UNKNOWN`.
3. A única saída automática de `UNKNOWN` é uma consulta ao autorizador.
4. Retransmissão só após a consulta provar inexistência, reutilizando o mesmo XML/identificador.
5. Resolução manual de `UNKNOWN` exige operador, justificativa e auditoria.

## Consequências
Elimina a principal causa de duplicidade; exige gateways com consulta confiável e classificação de falhas por fase de transporte.

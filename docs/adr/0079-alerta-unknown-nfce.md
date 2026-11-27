# ADR-0079 — Alerta de NFC-e em UNKNOWN pela idade

- Status: **Aceito** · Data: 2026-11-27
- Relacionados:
  - ADR-0034 item 5 e [doc 12 §6](../architecture/12-recuperacao-unknown.md) (alertas da NFS-e, o molde);
  - ADR-0072 (reconciliação da NFC-e pela chave).

## Contexto
O reconciliador da NFC-e consulta pela chave até ter prova, e nunca reenvia às cegas. Uma nota pode ficar em `UNKNOWN` muito tempo: o autorizador fora do ar, ou a consulta sempre com erro. A NFS-e alerta pela idade, e a NFC-e não alertava. Numa venda de balcão, o consumidor pode ter saído sem o documento.

## Decisão
1. **Mesma regra da NFS-e:**
   - WARNING depois de 15 min;
   - CRITICAL depois de 2 h;
   - INCIDENT depois de 24 h, repetido a cada 24 h.

   A idade conta do envio da tentativa. A regra foi para `shared/domain/unknown-escalation.ts`; a NFS-e reexporta.
2. **Fila `nfce.escalate` (lane fiscal):**
   - a primeira verificação é agendada na mesma transação em que a nota entra em `UNKNOWN`: resposta incerta, duplicidade ou queda com a tentativa em `SENDING`;
   - cada execução alerta, se for a hora, e agenda a próxima;
   - para sozinha quando a nota sai de `UNKNOWN`;
   - a chave do job leva a tentativa e o horário, para que duas cadeias convirjam.
3. **O alerta não muda a nota nem consulta o autorizador:** a saída de `UNKNOWN` continua sendo a consulta pela chave.
4. **Saída:** log estruturado `nfce.unknown_age` no worker-fiscal (WARNING → warn; CRITICAL e INCIDENT → error). Só identificadores e contagens: empresa, nota, ambiente, idade, tentativa e consultas.

## Fora deste ADR
- **Resolução manual de `UNKNOWN` na NFC-e** (o equivalente do ADR-0034): na NFS-e, o operador traz o XML oficial. Na NFC-e, o caminho natural é a consulta pela chave, que já roda sozinha. Só vale definir uma resolução manual depois de ver casos reais com o SVRS.
- **Métrica** `fiscal_unknown_documents`: entra com a observabilidade do deploy, como na NFS-e.

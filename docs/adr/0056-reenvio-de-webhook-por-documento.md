# ADR-0056 — Reenvio de webhook por documento

- Status: **Aceito** · Data: 2026-11-24
- Relacionados:
  - ADR-0015 (webhooks e outbox);
  - ADR-0026 item 7 e doc 16 A10 (reenvio manual por documento);
  - ADR-0027 B6 (reenvio por entrega).

## Contexto
O reenvio que já existia é por entrega (`POST /v1/webhook-deliveries/{id}/redeliver`): o cliente precisa saber o id da entrega ou do evento. Na prática, quem perdeu uma notificação sabe só o documento: "a nota X mudou e o meu sistema não ficou sabendo". O A10 do doc 16 pedia o reenvio por documento.

A distribuição dos eventos (fanout) é por empresa: toda assinatura ativa da empresa que assina o tipo do evento recebe, de qualquer aplicação com acesso a ela. Um reenvio por documento não pode passar por cima disso, nem alcançar assinatura de outra aplicação.

## Decisão
1. **`POST /v1/webhook-deliveries/redeliveries`** com `{ "subjectId": "<id do documento>" }`, escopo `webhooks:manage` (o mesmo do reenvio por entrega).
2. **O que é reenviado:** para cada assinatura **ativa da aplicação que pede**, a entrega original do **evento mais recente do documento que essa assinatura já recebeu**.
   - É o mesmo evento, com o mesmo `webhook-id`: o cliente deduplica como sempre.
   - Nenhum evento novo é criado, e nenhuma assinatura recebe algo que não recebeu antes.
   - Assinatura de outra aplicação nunca é alcançada.
   - Sem entrega a reenviar, a resposta é `404 WEBHOOK_DELIVERY_NOT_FOUND`.
3. **O mais recente, não todos:** quem perdeu notificações quer o estado atual do documento. Os anteriores continuam disponíveis no reenvio por entrega.
4. **Filtro novo na lista de entregas:** `GET /v1/webhook-deliveries?subjectId=…`, para ver tudo o que foi entregue sobre um documento.
5. **Auditoria:** cada reenvio é auditado como `webhook_delivery.redelivered`, com a entrega original, o evento e o documento.
6. O caminho fica no recurso de entregas, e não em `/v1/service-invoices/{id}/notifications` como sugeria o doc 16. Assim vale para qualquer documento que gere evento (nota, cancelamento, certificado), com o escopo de webhooks.

## Consequências
- O reenvio segue o calendário normal de tentativas, a partir do zero.
- Uma assinatura criada depois do evento não recebe o reenvio: ela nunca recebeu o evento, e o reenvio não muda a regra de distribuição.

---
title: Webhooks
status: current
last_updated: 2026-11-11
---

# Webhooks

A plataforma avisa a sua aplicação por HTTP quando algo muda. Exemplos: um certificado foi validado, está para vencer ou venceu. As entregas seguem o padrão [Standard Webhooks](https://www.standardwebhooks.com/).

## Catálogo de eventos

`GET /v1/webhook-event-types` lista os tipos de evento e o calendário de reentrega. Hoje:

| Tipo | Quando |
|---|---|
| `certificate.activated` | O certificado foi validado e está ativo; o anterior, se houver, foi substituído |
| `certificate.rejected` | O certificado foi recusado na validação; `data.reason` traz o motivo |
| `certificate.revoked` | O certificado foi revogado pela aplicação |
| `certificate.expiring` | Faltam 30, 15, 7 ou 1 dia para o vencimento (`data.thresholdDays`, `data.daysRemaining`) |
| `certificate.expired` | O certificado ativo venceu: a emissão falha antes do envio até um novo ser validado |

Os eventos carregam só identificadores e status, nunca XML, dados pessoais ou segredos. Use os ids para consultar o recurso na API.

## Assinatura

`POST /v1/webhook-subscriptions` recebe `url` (https, endereço público) e `eventTypes`.

- A resposta traz o segredo `whsec_…` **uma única vez**. Guarde-o.
- Cada aplicação pode ter até 10 assinaturas por empresa.
- O segredo pode ser trocado em `POST /v1/webhook-subscriptions/{id}/secret-rotation`.
- `POST /v1/webhook-subscriptions/{id}/test` dispara um evento `webhook.test` para você conferir a assinatura.

## Verificação da assinatura (obrigatória)

Cada entrega traz três headers:

- `webhook-id`: id do evento. É igual em todas as tentativas e reenvios: **deduplique por ele**.
- `webhook-timestamp`: segundos Unix.
- `webhook-signature`: `v1,<base64>`.

Para verificar:

1. Recuse `webhook-timestamp` com mais de 5 minutos de diferença do seu relógio.
2. Monte o conteúdo assinado: `<webhook-id>.<webhook-timestamp>.<corpo exatamente como recebido>`.
3. Calcule o HMAC-SHA256 com a chave igual aos **bytes** do base64 que vem depois de `whsec_`.
4. Compare em tempo constante com o valor depois de `v1,`.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, rawBody) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const signed = `${headers['webhook-id']}.${headers['webhook-timestamp']}.${rawBody}`;
  const expected = Buffer.from(`v1,${createHmac('sha256', key).update(signed).digest('base64')}`);
  const received = Buffer.from(String(headers['webhook-signature']));
  return expected.length === received.length && timingSafeEqual(expected, received);
}
```

## Entrega e reentrega

- Sucesso é uma resposta `2xx` em até 10 segundos. Redirecionamentos não são seguidos.
- Se a entrega falhar, novas tentativas acontecem depois de 1 min, 5 min, 15 min, 1 h, 3 h, 6 h e 12 h. São 8 tentativas em cerca de 22 horas.
- Esgotadas as tentativas, a entrega fica `FAILED`. Consulte em `GET /v1/webhook-deliveries` e reenvie em `POST /v1/webhook-deliveries/{id}/redeliver`. O reenvio usa o mesmo `webhook-id`.
- Responda rápido e processe depois: grave o evento e devolva `2xx`.

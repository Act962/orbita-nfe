# ADR-0022 — Protocolo de tentativa com registro prévio (write-ahead) e reconciliação

- Status: **Aceito** · Data: 2026-11-09

## Decisão
1. Toda transmissão é precedida de duas transações: `PREPARED` (XML assinado gravado, hash registrado) e `SENDING` (commit **antes** da chamada de rede).
2. Recuperação após queda: attempt `PREPARED` → certeza de não envio → `PENDING`; attempt `SENDING` → `UNKNOWN`.
3. Classificação de falha pela fase do transporte; dúvida = `UNKNOWN`.
4. Saída de `UNKNOWN` só por consulta; retransmissão só após duas respostas "não encontrado" espaçadas, com o mesmo XML.
5. Adapters declaram capacidades de consulta; sem consulta confiável → resolução manual antecipada.
6. Escalonamento por idade (15 min / 2 h / 24 h) e resolução manual auditada com evidência.

Detalhes: [12-recuperacao-unknown.md](../architecture/12-recuperacao-unknown.md).

## Resultado do spike 02 (2026-11-09)
Classificação por fase implementada com undici + `diagnostics_channel` (`NOT_SENT` só se `sendHeaders` não disparou; sem correlação → `UNKNOWN`). Nenhum cenário gerou envio duplicado e o undici não retenta POST automaticamente. **Achado**: com TLS 1.3, certificado do cliente recusado pelo servidor resulta em `UNKNOWN` (a requisição já saiu antes do alerta), o que torna **obrigatória a validação local do certificado antes de cada envio**. Detalhes: [resultados dos spikes](../spikes/resultados-fase1.md).

## Implementação definitiva do transporte (2026-11-11)
`src/shared/infrastructure/transport/mtls-transport.ts` (`createMtlsAgent`, `sendOnce`), promovido do spike 02:
- **Correção:** o código do spike classificava como `NOT_SENT` uma requisição que não tivesse sido correlacionada ao trace. Agora a falta de correlação dá `UNKNOWN`, como esta decisão exige.
- `GET`, `HEAD` e `POST`, cabeçalhos de resposta e limite de tamanho da resposta. Acima do limite, o resultado é `UNKNOWN/response-read` (`RESPONSE_TOO_LARGE`).
- A confiança no certificado do servidor é configurável (`serverTrustPem`) e nunca é desligada.
- O resultado leva só o código do erro, nunca a mensagem.
- Os testes (`mtls-transport.test.ts`) repetem os cenários do spike contra um servidor HTTPS local com mTLS.

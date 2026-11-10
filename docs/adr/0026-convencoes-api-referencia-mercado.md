# ADR-0026 — Convenções de API inspiradas em referência de mercado (Focus NFe)

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Contexto
A pedido do responsável, a API pública da Focus NFe foi analisada como referência ([doc 16](../architecture/16-referencia-focus-nfe.md)). Ela resolve bem problemas de integração do dia a dia (referência do cliente, 201/202, dry run, rate limit, reenvio de notificações), mas não documenta o caso de resultado desconhecido nem assina webhooks — pontos em que o nosso desenho já é mais rigoroso.

## Decisão
Adotar, sem alterar ADRs 0006, 0007, 0012 e 0015:
1. `externalReference` única por (empresa, aplicação, modalidade), com consulta por referência e reuso só após falha definitiva (409 `DOCUMENT_IN_PROGRESS` / `DOCUMENT_ALREADY_AUTHORIZED` com link).
2. 201 (resultado final dentro do `Prefer: wait`) × 202 + `Location`.
3. Ambiente fiscal derivado da credencial (`test` → homologação, `live` → produção).
4. `dryRun=true` em cadastros e endpoint de validação de documento sem efeitos.
5. `hint` opcional nos problemas e nas rejeições; `authorizerStatus` com código e mensagem do autorizador.
6. Rate limit por credencial (429 + `Retry-After` + `RateLimit-*`).
7. Política de webhooks publicada (calendário de retentativas) e reenvio de notificações por documento.
8. Links de arquivos com 302 para URL pré-assinada; `include=` para detalhes de depuração.
9. Changelog e política de descontinuação (`Deprecation`/`Sunset`).

## Consequências
- Mais itens nas semanas 6–7 da Fase 1 e na Fase 2a (detalhados no roadmap).
- Valores fiscais vistos na Focus (prazos, tamanhos, códigos) **não** são fonte: entram só após confirmação oficial.

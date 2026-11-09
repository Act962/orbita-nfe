# Spikes técnicos da Fase 1

**Finalidade**: código experimental para validar decisões técnicas antes de implementar os
adapters definitivos (docs/roadmap.md, Fase 1, semana 1). Não é importado por `src/` e não vai
para produção. Cada spike registra o resultado em `docs/spikes/` e atualiza o ADR correspondente.

**Remoção**: o código de cada spike é apagado (ou promovido a adapter em `src/`, com testes
definitivos) ao fim da Fase 1. Registrado em `docs/ACOMPANHAMENTO.md` → "Código temporário".

| Spike | Pergunta | ADR |
|---|---|---|
| 01-pkcs12-xmldsig | Conseguimos abrir PFX A1 (inclusive com criptografia legada) sem disco/processo externo e produzir XMLDSig verificável por implementação independente (`xmlsec1`)? | 0009, 0014 |
| 02-mtls-falhas | Conseguimos mTLS com certificado A1 e classificar a fase da falha (NOT_SENT × UNKNOWN) com segurança? | 0022 |
| 03-xsd | Conseguimos validar XML contra XSDs com `include`/`import` sem binding nativo? | 0014 |
| 04-pgboss | O enqueue do pg-boss participa da transação da aplicação (commit/rollback)? | 0005 |

Executar: `npm run spikes` (requer Docker; alguns testes usam `openssl` se disponível).

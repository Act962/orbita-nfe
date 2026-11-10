# ADR-0015 — Webhooks assinados com retentativas e deduplicação

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
Eventos via outbox; entrega com `Webhook-Id`, `Webhook-Timestamp` e `Webhook-Signature` (HMAC-SHA256 de `id.timestamp.body`, segredo por assinatura), retries exponenciais por até ~24h, DLQ e reenvio manual. Payload mínimo (ids/status), sem XML. Proteção contra SSRF no cadastro e na entrega.

## Implementação (2026-11-10, semana 6)
- **Assinatura no formato Standard Webhooks:**
  - headers `webhook-id` (id do evento, igual em retentativas e reenvios), `webhook-timestamp` e `webhook-signature: v1,<base64>`;
  - HMAC-SHA256 de `<id>.<timestamp>.<corpo>`, com chave = bytes do base64 depois de `whsec_`;
  - confere com o vetor de teste oficial da especificação.
  - Isso substitui a forma `v1=<hmac>` escrita antes: o formato padrão tem bibliotecas prontas para o cliente verificar.
- **Segredo** gerado pela API e exibido só na criação ou na rotação:
  - cifrado com RSA-OAEP/SHA-256 usando a chave PÚBLICA da plataforma, com rótulo OAEP amarrando empresa, assinatura e versão;
  - a API não tem grant para ler o ciphertext; só o worker-general tem a chave privada (ADR-0021).
- **Entrega:**
  - no máximo uma entrega original por (assinatura, evento) e reenvio como nova linha;
  - calendário publicado: imediata, depois 1 min, 5 min, 15 min, 1 h, 3 h, 6 h e 12 h, ou seja, 8 tentativas em cerca de 22 h;
  - sucesso = 2xx em até 10 s, sem seguir redirecionamentos.
- **SSRF:**
  - URL só https e sem credenciais;
  - nome ou IP privado, loopback, link-local, metadados de nuvem, CGNAT ou ULA são recusados no cadastro;
  - na entrega, a resolução de DNS recusa endereços não públicos (proteção contra DNS rebinding).
- **Escopo e acesso:** cada aplicação só vê as próprias assinaturas. Assinatura nova não recebe evento antigo. Se a concessão da aplicação à empresa for revogada, as entregas pendentes falham sem chamar o destino.

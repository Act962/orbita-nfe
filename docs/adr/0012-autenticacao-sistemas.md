# ADR-0012 — Autenticação de sistemas por API key com escopos (evolução para OAuth2)

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
Fase 1: API keys de alta entropia, armazenadas como HMAC-SHA256 com pepper, com escopos e concessões por tenant e rotação com sobreposição. Fase 5: OAuth2 Client Credentials (JWT de curta duração) e/ou mTLS.

## Consequências
Simples para Orbita/NERP agora; caminho claro para o padrão de mercado.

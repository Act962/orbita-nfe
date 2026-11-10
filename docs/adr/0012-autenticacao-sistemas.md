# ADR-0012 — Autenticação de sistemas por API key com escopos (evolução para OAuth2)

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
Fase 1: API keys de alta entropia, armazenadas como HMAC-SHA256 com pepper, com escopos e concessões por empresa e rotação com sobreposição. Fase 5: OAuth2 Client Credentials (JWT de curta duração) e/ou mTLS.

## Consequências
Simples para Orbita/NERP agora; caminho claro para o padrão de mercado.

## Implementação (2026-11-09)
- Token `fk_<live|test>_<keyId 16 hex>_<segredo 256 bits base64url>`; tabela `credentials` com `HMAC-SHA256(pepper, segredo)`; pepper em arquivo (`API_KEY_PEPPER_FILE`).
- Comparação em tempo constante e hash fictício quando o keyId não existe; a mesma resposta 401 para qualquer falha.
- Catálogo fechado de escopos (`src/modules/iam/domain/scope.ts`); escopo desconhecido numa rota impede a subida.
- Concessões em `company_grants` (RLS forçado), consultadas a cada requisição, sem cache.
- Escrita de IAM só pelo papel `fiscal_admin`, via CLI; a API apenas lê credenciais.
- Runbook: [credenciais-api.md](../runbooks/credenciais-api.md).
- 2026-11-10: escopo `certificates:read` adicionado ao catálogo (listar e consultar metadados de certificados); `certificates:manage` o implica. Toda escrita do operador passa a ser auditada (cadeia da plataforma para aplicações e credenciais; cadeia da empresa para concessões).

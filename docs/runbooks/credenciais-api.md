# Runbook — Aplicações cliente, API keys e concessões

Referências: ADR-0012, docs/architecture/09 §1 e 14 §B3. Código: `src/modules/iam`, CLI `src/main/iam-admin-cli.ts`.

## Modelo
- **Aplicação cliente** (`client_applications`): Orbita, NERP...
- **Credencial** (`credentials`): API key `fk_<live|test>_<keyId>_<segredo>`, com escopos. O banco guarda só `HMAC-SHA256(pepper, segredo)`.
- **Concessão** (`company_grants`): a aplicação X pode operar a empresa Y. Toda rota de empresa exige `X-Company-Id` e confere a concessão **no servidor, a cada requisição, sem cache**.
- Quem cria uma empresa (`POST /v1/companies`, escopo `companies:create`) recebe a concessão para ela na mesma transação.

Escopos: `companies:create`, `companies:read`, `companies:manage`, `fiscal-settings:read`, `fiscal-settings:manage`, `certificates:manage`, `webhooks:manage`, `nfse:issue`, `nfse:read`, `nfse:cancel`. `:manage` implica `:read`.

## Pepper (segredo)
- Arquivo com ≥ 32 bytes, montado **só** no container da API e no job da CLI. Variável: `API_KEY_PEPPER_FILE` (caminho, nunca o valor).
- Produção: gerar com `openssl rand -base64 48` e cadastrar como arquivo/secret no Coolify. Desenvolvimento: `npm run dev:secrets` (cria `secrets/api-key-pepper`, ignorado pelo git).
- **Trocar o pepper invalida todas as API keys.** Rotação = emitir chaves novas com o pepper novo (suporte a pepper versionado fica para quando for necessário).

## Papel de banco do operador
`app_admin` (membro de `fiscal_admin`): escreve aplicações, credenciais e concessões; não lê dados fiscais; sem DELETE. Criar uma vez, como superusuário:
```sql
CREATE ROLE app_admin LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD '<gerada>' IN ROLE fiscal_admin;
```
A URL dele (`ADMIN_DATABASE_URL`) **não** vai para o container da API.

## Operações (`npm run iam -- <comando>`; em produção `node dist/main/iam-admin-cli.js`)
| Tarefa | Comando |
|---|---|
| Cadastrar aplicação | `create-app --name Orbita` |
| Emitir chave | `issue-key --app <uuid> --env live --scopes companies:create,companies:manage,fiscal-settings:manage [--expires-days 365]` |
| Revogar chave | `revoke-key --key-id <16 hex>` (efeito imediato) |
| Conceder empresa a outra aplicação | `grant --app <uuid> --company <uuid>` |
| Revogar concessão | `revoke-grant --app <uuid> --company <uuid>` (efeito na requisição seguinte) |

A chave é impressa **uma única vez**. Entregue-a pelo cofre de segredos da aplicação cliente; não cole em chat, ticket ou e-mail.

## Rotação de chave sem indisponibilidade
1. `issue-key` com os mesmos escopos (duas chaves ativas ao mesmo tempo).
2. Atualizar o segredo na aplicação cliente e confirmar o tráfego com a chave nova.
3. `revoke-key` da antiga.

## Incidente: chave vazada
1. `revoke-key` imediatamente. 2. Emitir nova chave. 3. Levantar o que a chave acessou pelos logs (`clientApplicationId`, `companyId`, `correlationId`) e, quando existir, pelo audit log. 4. Registrar o incidente.

## Pendências
- Auditoria das operações do operador no audit log encadeado (Fase 1, semana 5).
- Rate limit por credencial (antes da produção).
- `test` vs `live` ainda não restringe o ambiente fiscal da emissão: será aplicado na Fase 2a (chave `test` só emite em homologação).

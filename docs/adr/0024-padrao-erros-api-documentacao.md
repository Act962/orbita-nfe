# ADR-0024 — Padrão de erros da API e documentação com Scalar

- Status: **Aceito** · Data: 2026-11-09 · Pedido do responsável: "validação de erro para não usar erros genéricos, nem erros do Drizzle; Fastify + Zod; documentação com Scalar"

## Contexto
Os sistemas clientes (Orbita, NERP) precisam tratar erros de forma programática e estável. Erros genéricos ("Internal Server Error") não permitem isso, e erros de ORM/driver vazam detalhes internos: o `DrizzleQueryError` coloca **query e parâmetros** na mensagem, e o PostgreSQL coloca valores das linhas em `detail`.

## Decisão
1. **Validação de entrada com Fastify + Zod** (`fastify-type-provider-zod`): body, params, querystring e headers declarados em Zod em cada rota. Falha → `400 VALIDATION_FAILED` com `issues[]` (campo, código estável derivado do Zod, mensagem em pt-BR).
2. **Validação de saída**: toda resposta é serializada pelo schema Zod declarado. Resposta fora do contrato → `500 INTERNAL_ERROR` (nunca dados fora do contrato).
3. **Hierarquia de erros de aplicação** (`src/shared/application/errors.ts`): `ValidationFailedError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `BusinessRuleError`, `ServiceUnavailableError`, `InternalError`. Cada uma tem `code` estável; a categoria define o status HTTP.
4. **Erros de banco nunca sobem crus**: `translateDatabaseError` converte SQLSTATE/rede em erros de aplicação. Constraints esperadas são mapeadas pelo repository para códigos de negócio (ex.: `uq_establishments_cnpj` → `ESTABLISHMENT_ALREADY_REGISTERED`); as **não mapeadas são tratadas como bug** (`500`, código interno só no log), e não como `409` genérico.
5. **Defesa em profundidade**: o handler global converte qualquer erro desconhecido em `500 INTERNAL_ERROR` sem detalhes, e a sanitização dos logs remove mensagem, `detail`, query e parâmetros de erros do Drizzle/PostgreSQL (achado do teste canário).
6. **Formato**: RFC 9457 (`application/problem+json`), schema `Problem` publicado no OpenAPI.
7. **Documentação**: OpenAPI 3.1 gerado dos mesmos schemas Zod (`@fastify/swagger` + `jsonSchemaTransform`), interface **Scalar** em `/docs/`, documento em `/docs/openapi.json` e `/docs/openapi.yaml`. Assets servidos pelo próprio processo (sem CDN); recursos de nuvem da Scalar desligados (`showDeveloperTools: 'never'`, agente de IA desligado, telemetria desligada). Liga e desliga por `API_DOCS_ENABLED`.

## Catálogo
Mantido em [docs/architecture/11-api.md](../architecture/11-api.md#catálogo-de-códigos-de-erro). Código novo exige entrada no catálogo e teste.

## Consequências
Cada rota declara schemas Zod de entrada e saída (mais código, mas o contrato e a documentação nunca divergem). Cada repository declara o mapa de constraints que conhece.

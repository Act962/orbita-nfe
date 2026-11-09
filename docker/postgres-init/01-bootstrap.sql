-- Bootstrap do banco LOCAL de desenvolvimento (executado uma vez, na criação do volume).
-- Mesma topologia de produção (docs/runbooks/bootstrap-banco.md):
--   superusuário (postgres) → só bootstrap
--   fiscal_owner            → dono das tabelas, roda migrations, SEM superuser (FORCE RLS vale para ele)
--   app_*                   → usuários de login da aplicação (criados após as migrations: ver 02)
-- Senhas apenas para desenvolvimento local.

CREATE ROLE fiscal_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD 'dev-only-password';
ALTER DATABASE orbita_nfe OWNER TO fiscal_owner;
ALTER SCHEMA public OWNER TO fiscal_owner;

-- Papéis de grupo (a migration 0001 também os cria de forma idempotente).
CREATE ROLE fiscal_api NOLOGIN NOBYPASSRLS;
CREATE ROLE fiscal_worker NOLOGIN NOBYPASSRLS;
CREATE ROLE fiscal_general NOLOGIN NOBYPASSRLS;
CREATE ROLE fiscal_system NOLOGIN NOBYPASSRLS;

CREATE ROLE app_api LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD 'dev-only-password' IN ROLE fiscal_api;
CREATE ROLE app_worker LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD 'dev-only-password' IN ROLE fiscal_worker;
CREATE ROLE app_general LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD 'dev-only-password' IN ROLE fiscal_general;

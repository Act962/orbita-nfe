# Runbook — Deploy na VPS com Coolify

Arquitetura: ADR-0020, ADR-0021, doc 15. Compose de produção: `docker/coolify/docker-compose.yml`.

> **Status (2026-11-11):** o compose está validado, as imagens compilam no CI e os containers foram testados localmente em modo produção. **Nenhum deploy real foi feito ainda.** Faltam a VPS, os buckets e o domínio (§1). Os passos que dependem da interface do Coolify estão marcados com *(conferir no Coolify)*, porque não foram executados num painel real.

## 1. Pré-requisitos do responsável
- VPS Hostinger com Coolify instalado:
  - painel com 2FA e acessível só por IP ou VPN;
  - SSH só por chave;
  - firewall liberando só 443 e o SSH restrito (doc 15 §4).
- Domínio da API (ex.: `api.<domínio>`) apontando para a VPS.
- Provedor S3 escolhido (R-10, LGPD), com **três buckets separados**:

  | Bucket | Configuração | Credenciais |
  |---|---|---|
  | `backups` | Sem Object Lock | Leitura e escrita para o WAL-G |
  | `audit-anchors` | **Object Lock habilitado na criação** | Escrita para o worker-general, leitura para o operador |
  | `fiscal-archive` | Versionamento + Object Lock | Fase 2a (ADR-0010) |

- Imagens no GHCR: `ghcr.io/act962/orbita-nfe` e `ghcr.io/act962/orbita-nfe-postgres`, publicadas pelo CI a cada push na `main`, com a tag `sha-<12 caracteres do commit>`.
  - Se o pacote do GHCR estiver privado, o Coolify precisa de um token de leitura de pacotes *(conferir no Coolify)*.
  - O repositório está público; decida se as imagens também ficam públicas.

## 2. Segredos no host
Cada segredo é um arquivo em `/srv/orbita-nfe/secrets/<serviço>/`, montado somente leitura em `/run/secrets` **só no serviço que precisa dele**. Não use variável de ambiente para chaves.

```bash
sudo install -d -m 0750 /srv/orbita-nfe/secrets/{api,worker-fiscal,worker-general,postgres}
# Arquivos 0400. Dono 1000 (usuário node da imagem) nos serviços da aplicação e 999 (postgres) no banco.
```

| Serviço | Arquivos | Origem |
|---|---|---|
| `api` | `api-key-pepper`, `certificate-kek-public.pem`, `webhook-secret-key-public.pem` | runbooks credenciais-api e kek-certificados |
| `worker-fiscal` | `certificate-kek-private.pem`, `trust-bundle.pem` | kek-certificados (ACs ICP-Brasil do ITI) |
| `worker-general` | `webhook-secret-key-private.pem`, `anchor-s3-access-key-id`, `anchor-s3-secret-access-key` | filas-e-webhooks; bucket `audit-anchors` (ESCRITA) |
| `postgres` | `postgres-superuser-password`, `backup-s3-access-key-id`, `backup-s3-secret-access-key`, `backup-encryption-key` | backup-restauracao §2 |

**Nunca** coloque a KEK privada fora do `worker-fiscal`, nem a chave privada de webhooks fora do `worker-general`. Os processos recusam subir em produção se receberem a chave de outro papel (ADR-0021).

## 3. Variáveis no Coolify (secrets do recurso)
| Variável | Exemplo | Observação |
|---|---|---|
| `IMAGE_TAG`, `POSTGRES_IMAGE_TAG` | `sha-1600cb11c69b` | Sempre uma tag imutável, nunca `main` |
| `MIGRATION_DATABASE_URL` | `postgres://fiscal_owner:…@postgres:5432/orbita_nfe` | Só no `migrate` |
| `API_DATABASE_URL` | `postgres://app_api:…@postgres:5432/orbita_nfe` | Login membro de `fiscal_api` |
| `WORKER_DATABASE_URL` | `postgres://app_worker:…@postgres:5432/orbita_nfe` | Login membro de `fiscal_worker` |
| `GENERAL_DATABASE_URL` | `postgres://app_general:…@postgres:5432/orbita_nfe` | Login membro de `fiscal_general` |
| `WALG_S3_PREFIX`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION` | `s3://orbita-backups/orbita-nfe` | Bucket de backups |
| `AUDIT_ANCHOR_S3_ENDPOINT`, `AUDIT_ANCHOR_S3_BUCKET`, `AUDIT_ANCHOR_S3_REGION` | | Bucket com Object Lock (ADR-0031) |
| `AUDIT_ANCHOR_RETENTION_DAYS` | `1830` | Retenção COMPLIANCE: não dá para encurtar depois |

## 4. Primeiro deploy
1. No Coolify, crie o recurso *Docker Compose* apontando para o repositório e para o arquivo `docker/coolify/docker-compose.yml` *(conferir no Coolify)*. Cadastre as variáveis do §3.
2. Suba **só o `postgres`** e faça o bootstrap dos papéis e logins (runbook bootstrap-banco). A senha do superusuário fica no arquivo do §2.
3. Faça o deploy completo:
   - o `migrate` roda e termina;
   - `api`, `worker-fiscal` e `worker-general` só sobem depois do `migrate` terminar com sucesso.
4. No Coolify, ligue o domínio ao serviço `api`, porta 3000, com TLS automático *(conferir no Coolify)*. Só a `api` recebe tráfego.
5. Configure as tarefas agendadas de backup (backup-restauracao §3).
6. Confira:
   - `GET https://<domínio>/health/ready` responde `ready`;
   - `/llms.txt` e `/openapi.json` respondem;
   - no log do `worker-general` aparecem as filas `audit.anchor-*`;
   - no dia seguinte, `npm run audit -- verify --platform --anchor` (credencial de LEITURA do bucket).

## 5. Deploys seguintes
- Troque `IMAGE_TAG` pela tag do commit aprovado (CI verde) e faça o deploy.
- O `migrate` roda primeiro. Migrations são só aditivas na Fase 1. Uma migration destrutiva exige plano próprio de duas etapas.
- **Rollback:** volte `IMAGE_TAG` para a tag anterior. Migrations não são revertidas: a versão anterior precisa continuar compatível com o schema novo, e isso é conferido na revisão.

## 6. Limites conhecidos
- **Uma réplica da API:** o rate limit é em memória (ADR-0020). Mais de uma réplica exige rate limit compartilhado.
- **One-shot no Coolify:** a forma como o Coolify trata o `migrate` (container que termina) não foi confirmada num painel real. Se ele marcar o deploy como falho por isso, a alternativa é rodar a migration como comando de pré-deploy *(conferir no Coolify)*.

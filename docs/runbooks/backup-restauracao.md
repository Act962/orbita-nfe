# Runbook — Backup contínuo e restauração do PostgreSQL (WAL-G)

Metas (doc 15 §3, ADR-0020): **RPO ≤ 5 min, RTO ≤ 4 h.** Risco coberto: R-17 (VPS única).

## 1. Como funciona
- A imagem `docker/postgres/Dockerfile` é o PostgreSQL 17 (Debian) com o **WAL-G v3.0.9**. O binário é conferido pelo sha256 publicado no release oficial.
- **WAL contínuo:**
  - `archive_mode=on` e `archive_command=walg wal-push %p`;
  - `archive_timeout=60`: um segmento sai no máximo a cada 60 s, mesmo com pouco movimento, o que garante o RPO.
- **Backup base diário:** `walg backup-push`, por tarefa agendada (§3).
- **Cifra no cliente:** libsodium, com a chave em `WALG_LIBSODIUM_KEY_PATH`. O provedor do bucket só vê dados cifrados.
- **Credenciais do bucket:** vêm de arquivos (`walg.sh`) e existem só no ambiente do processo do WAL-G.
- **Bucket próprio de backups:** separado do de XML e do de âncoras, com credencial própria (ADR-0010).

## 2. Segredos (no host, `/srv/orbita-nfe/secrets/postgres/`, dono 999:999, modo 0400)
| Arquivo | Conteúdo |
|---|---|
| `postgres-superuser-password` | Senha do superusuário (só bootstrap e restauração) |
| `backup-s3-access-key-id`, `backup-s3-secret-access-key` | Chave do bucket de backups (ler e gravar; sem apagar, se o provedor permitir) |
| `backup-encryption-key` | `head -c 32 /dev/urandom \| base64` |

**Sem a `backup-encryption-key`, os backups não podem ser restaurados.** Guarde duas cópias offline, cifradas, em lugares diferentes, junto com as KEKs (runbook kek-certificados §1).

## 3. Backup base diário e retenção
Tarefas agendadas no serviço `postgres` (no Coolify, *Scheduled Tasks*; ou no cron do host com `docker exec`):

```bash
# todo dia às 04:00 (America/Sao_Paulo)
su postgres -c "walg backup-push /var/lib/postgresql/data"
```

```bash
# todo domingo às 05:00: mantém os 7 backups base mais recentes e o WAL necessário para eles
su postgres -c "walg delete retain FULL 7 --confirm"
```

Conferência diária:
- `walg backup-list` mostra o backup do dia;
- `select * from pg_stat_archiver` mostra `failed_count` estável e `last_archived_time` com no máximo poucos minutos de atraso.

## 4. Restauração (desastre ou teste)
1. Pare `api`, `worker-fiscal` e `worker-general`. Ninguém pode escrever.
2. Crie um volume **vazio** para os dados. Nunca restaure por cima do volume atual: guarde-o para perícia.
3. Busque o backup base, como `postgres`, com as mesmas variáveis e segredos do serviço:
   ```bash
   walg backup-fetch /var/lib/postgresql/data LATEST
   touch /var/lib/postgresql/data/recovery.signal
   ```
4. Suba o PostgreSQL com:
   ```bash
   -c restore_command='walg wal-fetch %f %p' -c recovery_target_action=promote
   ```
   - Sem alvo, ele reaplica todo o WAL arquivado e promove.
   - Para voltar a um instante, use `-c recovery_target_time='2026-11-11 10:00:00-03'`.
5. Confira:
   - `select pg_is_in_recovery()` devolve `f`;
   - `npm run audit -- verify --platform --anchor` e `verify --company <id> --anchor` para as empresas ativas. A âncora externa (ADR-0031) mostra se o banco restaurado é o verdadeiro.
6. Suba `migrate`, depois `api` e os workers. Os documentos `UNKNOWN` são reconciliados pelo fluxo normal (doc 12), nunca reenviados às cegas.

## 5. Exercício de restauração
```bash
npm run drill:backup
```

O exercício (`scripts/backup-drill.sh`):
- sobe o banco de produção com um S3 local;
- grava dados, faz o backup base e grava mais dados, que só existem no WAL;
- destrói o banco e o volume, restaura num volume vazio e confere se **tudo** voltou.

Quando rodar:
- a cada atualização da imagem do banco (tag do PostgreSQL ou do WAL-G);
- **todo mês**.

Registre a data e o resultado no ACOMPANHAMENTO.

| Data | Resultado |
|---|---|
| 2026-11-11 | OK: 1000 linhas do backup base + 250 linhas só do WAL restauradas (PostgreSQL 17.10, WAL-G 3.0.9) |

A restauração **no provedor real** fica pendente até o bucket de produção existir (R-10).

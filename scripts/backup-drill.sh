#!/usr/bin/env bash
# Exercício de backup e restauração (risco R-17, runbook docs/runbooks/backup-restauracao.md).
#
# Reproduz a perda total do banco, só com containers locais e dados fictícios:
#   1. PostgreSQL de produção (docker/postgres) com archive de WAL para um S3 local (SeaweedFS);
#   2. grava dados, faz o backup base, grava MAIS dados (só no WAL) e força a troca de segmento;
#   3. destrói o banco e o volume;
#   4. restaura num volume vazio (backup base + WAL) e confere se TUDO voltou.
#
# Uso: scripts/backup-drill.sh   (requer Docker; ~2 min)
# Saída 0 = restauração conferida. Rodar a cada atualização da imagem do banco e todo mês.
set -euo pipefail
export MSYS_NO_PATHCONV=1

RUN="drill-$(date +%s)"
NET="$RUN-net"
IMAGE="${IMAGE:-orbita-nfe-postgres:drill}"
S3_IMAGE="chrislusf/seaweedfs:4.50"
PG_ENV=(
  -e POSTGRES_PASSWORD=drill-only
  -e WALG_S3_PREFIX="s3://backups/$RUN"
  -e AWS_ENDPOINT="http://$RUN-s3:8333"
  -e AWS_REGION=us-east-1
  -e AWS_S3_FORCE_PATH_STYLE=true
  -e WALG_S3_ACCESS_KEY_ID_FILE=/run/secrets/backup-key-id
  -e WALG_S3_SECRET_ACCESS_KEY_FILE=/run/secrets/backup-secret
  -e WALG_LIBSODIUM_KEY_PATH=/run/secrets/backup-encryption-key
)

cleanup() {
  docker rm -f "$RUN-pg" "$RUN-restored" "$RUN-s3" >/dev/null 2>&1 || true
  docker volume rm "$RUN-data" "$RUN-restore" "$RUN-secrets" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
psql_in() { docker exec "$1" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAc "$2"; }
wait_ready() {
  for _ in $(seq 1 60); do
    if docker exec "$1" pg_isready -U postgres -q 2>/dev/null && psql_in "$1" 'select 1' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  docker logs "$1" | tail -30
  return 1
}

step "rede, S3 local e segredos de exercício"
docker network create "$NET" >/dev/null
docker run -d --name "$RUN-s3" --network "$NET" "$S3_IMAGE" server -s3 -dir=/data -ip.bind=0.0.0.0 >/dev/null
docker volume create "$RUN-secrets" >/dev/null
docker run --rm -v "$RUN-secrets:/s" "$IMAGE" sh -c '
  printf drill-key > /s/backup-key-id && printf drill-secret > /s/backup-secret &&
  head -c 32 /dev/urandom | base64 > /s/backup-encryption-key &&
  chown postgres:postgres /s/* && chmod 0400 /s/*'
# Bucket de backup (o gateway S3 leva alguns segundos para aceitar).
for _ in $(seq 1 60); do
  # PUT anônimo (o S3 local de exercício não tem autenticação); a imagem não tem curl.
  if docker run --rm --network "$NET" "$IMAGE" bash -c \
    "exec 3<>/dev/tcp/$RUN-s3/8333 && printf 'PUT /backups HTTP/1.1\r\nHost: $RUN-s3\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' >&3 && head -1 <&3" 2>/dev/null | grep -q ' 200 '; then
    break
  fi
  sleep 1
done

step "PostgreSQL com archive de WAL"
docker volume create "$RUN-data" >/dev/null
docker run -d --name "$RUN-pg" --network "$NET" "${PG_ENV[@]}" \
  -v "$RUN-data:/var/lib/postgresql/data" -v "$RUN-secrets:/run/secrets:ro" "$IMAGE" \
  postgres -c wal_level=replica -c archive_mode=on -c 'archive_command=walg wal-push %p' -c archive_timeout=60 >/dev/null
wait_ready "$RUN-pg"

step "dados antes do backup base"
psql_in "$RUN-pg" "create table exercicio (id serial primary key, fase text not null, criado timestamptz default now());
                   insert into exercicio (fase) select 'antes-do-backup' from generate_series(1, 1000);" >/dev/null

step "backup base"
docker exec -u postgres "$RUN-pg" walg backup-push /var/lib/postgresql/data 2>&1 | tail -2

step "dados DEPOIS do backup base (só existem no WAL arquivado)"
psql_in "$RUN-pg" "insert into exercicio (fase) select 'depois-do-backup' from generate_series(1, 250);" >/dev/null
SEGMENT="$(psql_in "$RUN-pg" "select pg_walfile_name(pg_switch_wal())")"
for _ in $(seq 1 60); do
  ARCHIVED="$(psql_in "$RUN-pg" "select coalesce(last_archived_wal, '') from pg_stat_archiver")"
  FAILED="$(psql_in "$RUN-pg" "select failed_count from pg_stat_archiver")"
  [ "$FAILED" != "0" ] && { echo "archive_command falhou ($FAILED)"; docker logs "$RUN-pg" | tail -20; exit 1; }
  [[ "$ARCHIVED" > "$SEGMENT" || "$ARCHIVED" == "$SEGMENT" ]] && break
  sleep 1
done
echo "segmento $SEGMENT arquivado (último: $ARCHIVED)"
EXPECTED="$(psql_in "$RUN-pg" "select fase || ':' || count(*) from exercicio group by fase order by fase" | tr '\n' ' ')"
echo "esperado: $EXPECTED"

step "desastre: banco e volume destruídos"
docker rm -f "$RUN-pg" >/dev/null
docker volume rm "$RUN-data" >/dev/null

step "restauração num volume vazio: backup base + WAL"
docker volume create "$RUN-restore" >/dev/null
docker run --rm "${PG_ENV[@]}" --network "$NET" -v "$RUN-restore:/var/lib/postgresql/data" -v "$RUN-secrets:/run/secrets:ro" "$IMAGE" \
  sh -c 'chown postgres:postgres /var/lib/postgresql/data && chmod 0700 /var/lib/postgresql/data &&
         su postgres -s /bin/sh -c "walg backup-fetch /var/lib/postgresql/data LATEST" &&
         touch /var/lib/postgresql/data/recovery.signal && chown postgres:postgres /var/lib/postgresql/data/recovery.signal' 2>&1 | tail -2
docker run -d --name "$RUN-restored" --network "$NET" "${PG_ENV[@]}" \
  -v "$RUN-restore:/var/lib/postgresql/data" -v "$RUN-secrets:/run/secrets:ro" "$IMAGE" \
  postgres -c wal_level=replica -c 'restore_command=walg wal-fetch %f %p' -c recovery_target_action=promote >/dev/null
for _ in $(seq 1 90); do
  if wait_ready "$RUN-restored" 2>/dev/null && [ "$(psql_in "$RUN-restored" 'select pg_is_in_recovery()')" = "f" ]; then break; fi
  sleep 1
done

RESTORED="$(psql_in "$RUN-restored" "select fase || ':' || count(*) from exercicio group by fase order by fase" | tr '\n' ' ')"
echo "restaurado: $RESTORED"
if [ "$RESTORED" != "$EXPECTED" ]; then
  echo "FALHA: a restauração não trouxe todos os dados" >&2
  exit 1
fi
step "OK: backup base + WAL restaurados por completo (inclusive os dados posteriores ao backup)"

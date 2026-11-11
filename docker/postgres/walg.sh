#!/bin/sh
# Wrapper do WAL-G (docs/runbooks/backup-restauracao.md).
#
# As credenciais do bucket de BACKUP vêm de arquivos montados (0400) e só existem no ambiente
# deste processo. A cifra dos backups é do próprio WAL-G (libsodium), com a chave em arquivo
# (WALG_LIBSODIUM_KEY_PATH): o provedor do bucket só vê dados cifrados.
#
# Variáveis esperadas (definidas no serviço postgres):
#   WALG_S3_PREFIX                   s3://<bucket-de-backup>/<prefixo>
#   AWS_ENDPOINT, AWS_REGION, AWS_S3_FORCE_PATH_STYLE
#   WALG_S3_ACCESS_KEY_ID_FILE, WALG_S3_SECRET_ACCESS_KEY_FILE
#   WALG_LIBSODIUM_KEY_PATH          chave de 32 bytes em base64 (WALG_LIBSODIUM_KEY_TRANSFORM=base64)
set -eu

secret() {
  if [ ! -r "$1" ]; then
    echo "walg: arquivo de credencial ilegível: $1" >&2
    exit 1
  fi
  tr -d '\r\n' < "$1"
}

AWS_ACCESS_KEY_ID="$(secret "${WALG_S3_ACCESS_KEY_ID_FILE:?defina WALG_S3_ACCESS_KEY_ID_FILE}")"
AWS_SECRET_ACCESS_KEY="$(secret "${WALG_S3_SECRET_ACCESS_KEY_FILE:?defina WALG_S3_SECRET_ACCESS_KEY_FILE}")"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
: "${WALG_LIBSODIUM_KEY_PATH:?defina WALG_LIBSODIUM_KEY_PATH (backups sempre cifrados)}"
export WALG_LIBSODIUM_KEY_TRANSFORM="${WALG_LIBSODIUM_KEY_TRANSFORM:-base64}"

exec /usr/local/bin/wal-g "$@"

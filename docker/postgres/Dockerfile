# syntax=docker/dockerfile:1.7
# PostgreSQL de produção com WAL-G (backup contínuo de WAL + base diária, ADR-0020, doc 15 §3).
# Debian (glibc): o binário oficial do WAL-G não roda em Alpine.
# Atualizar: trocar a tag do PostgreSQL (mesma major) e/ou WALG_VERSION + checksum, rodar
# scripts/backup-drill.sh e registrar no ACOMPANHAMENTO.

FROM postgres:17.10-bookworm

# WAL-G v3.0.9 (2026-08-20), build Ubuntu 22.04 (glibc 2.35, compatível com o bookworm).
# Checksum publicado no release oficial: wal-g-pg-22.04-amd64.tar.gz.sha256
ADD --checksum=sha256:4f03ee4679db7f660bfd1b2b8291ac5df247cd2ec48074b60c112f4897299f24 \
    https://github.com/wal-g/wal-g/releases/download/v3.0.9/wal-g-pg-22.04-amd64.tar.gz /tmp/wal-g.tar.gz
RUN tar -xzf /tmp/wal-g.tar.gz -C /tmp \
 && install -m 0755 /tmp/wal-g-pg-22.04-amd64 /usr/local/bin/wal-g \
 && rm -f /tmp/wal-g.tar.gz /tmp/wal-g-pg-22.04-amd64 \
 && wal-g --version

# Wrapper: lê as credenciais do bucket de ARQUIVOS montados (nunca do valor em variável).
COPY --chmod=0755 docker/postgres/walg.sh /usr/local/bin/walg

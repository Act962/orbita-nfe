# ADR-0020 — Infraestrutura inicial: VPS Hostinger + Coolify

- Status: **Aceito** · Data: 2026-11-09

## Decisão
- VPS Hostinger gerenciada pelo Coolify, com containers separados: `api`, `worker-fiscal`, `worker-general`, `postgres` (rede interna).
- Imagem única construída no GitHub Actions; Coolify só faz deploy.
- **Redis adiado**: não há necessidade comprovada na Fase 1 (fila e locks no PostgreSQL, rate limit em memória com uma instância de API).
- Object storage externo (ADR-0010) e backup contínuo do PostgreSQL (WAL) em bucket separado. RPO ≤ 5 min, RTO ≤ 4 h.
- Firewall só 443 (+ SSH restrito); painel Coolify com 2FA e acesso restrito; NTP monitorado; bundle ICP-Brasil para TLS com órgãos públicos, sem desativar verificação.

## Consequências
Custo baixo e operação simples; VPS única é ponto único de falha (aceito na fase inicial, reavaliar com crescimento de empresas). Detalhes: [15-infraestrutura.md](../architecture/15-infraestrutura.md).

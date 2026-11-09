# ADR-0010 — Artefatos fiscais em object storage S3-compatível externo à VPS

- Status: Proposto (provedor a confirmar) · Data: 2026-11-09

## Contexto
Infra inicial é uma VPS única. Guardar XMLs só nela significa perder tudo se a VPS falhar. MinIO community deixou de ter imagens oficiais e foi arquivado (2025–2026), então não é base segura para produção.

## Decisão
- Artefatos (XMLs enviados/assinados/autorizados, eventos, respostas brutas, PDFs) em **S3 externo**: recomendação **Backblaze B2** com Object Lock; alternativas AWS S3 sa-east-1 (dados no Brasil) ou provedor nacional, a decidir considerando LGPD.
- Chave `company/{companyId}/{kind}/{yyyy}/{mm}/{documentId}/{artifact}-{sha256}`; metadados e SHA-256 no PostgreSQL.
- Versionamento + Object Lock no bucket de artefatos autorizados; bucket separado para backups do banco; credenciais distintas e mínimas.
- Retenção ≥ prazo legal de guarda (confirmar com contador; mínimo de trabalho 5 anos + margem).
- Download por URL pré-assinada de curta duração após checagem de posse.
- Dev/CI: SeaweedFS ou Garage em container (escolha no spike).

## Pendências
Confirmar Object Lock e preços na documentação oficial do provedor escolhido; parecer sobre transferência internacional (LGPD) se o provedor for fora do Brasil.

Detalhes: [15-infraestrutura.md](../architecture/15-infraestrutura.md).

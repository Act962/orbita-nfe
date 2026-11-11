# 09 — Estratégia de segurança

## 1. Autenticação entre sistemas
- **Fase 1**: API keys de alta entropia (≥ 256 bits) por aplicação cliente, formato `fk_live_<id>_<secret>`; armazenamos apenas HMAC-SHA256 do segredo com pepper em secret manager. Rotação com duas chaves ativas simultâneas. Ambiente (live/test) explícito no prefixo.
- **Evolução**: OAuth2 Client Credentials com JWT de curta duração (e/ou mTLS entre sistemas) quando houver mais de um punhado de clientes.
- **Autorização**: escopos por credencial + `company_grants` (app X pode operar empresas A, B). Toda requisição de empresa informa a empresa (`X-Company-Id` ou path) e o servidor **verifica a concessão**. O CNPJ do emitente no payload precisa pertencer a um estabelecimento daquela empresa.

## 2. Certificados A1
> **Atualizado**: a versão aprovada usa KEK **assimétrica** e separação de privilégios por container. O desenho detalhado e vigente está em [13-seguranca-certificados.md](13-seguranca-certificados.md); o texto abaixo é o resumo original.

**Envelope encryption**:
1. Para cada certificado, gerar DEK aleatória (AES-256-GCM).
2. Criptografar PFX e senha com a DEK (AAD = companyId + certificateId, impede troca de blobs entre empresas).
3. "Embrulhar" a DEK com a KEK via porta `KeyManagementService` (dev: KEK de arquivo/variável local; produção: AWS KMS / GCP KMS / Azure Key Vault / HashiCorp Vault Transit — a escolher conforme hospedagem).
4. Banco guarda apenas ciphertext + DEK embrulhada + `kek_id`.

Uso: somente o worker tem permissão de `unwrap`. A chave privada é carregada em memória
no escopo de `withCertificate`, com cache curto (minutos) por processo para não chamar
o KMS por nota; nunca é escrita em disco, log, tracing ou mensagem de erro. Cada uso
gera registro de auditoria agregado (`certificate_usage`: cert, finalidade, documento).

Rotação: rotação de KEK = re-wrap das DEKs (sem re-criptografar blobs). Substituição de
certificado (renovação anual) mantém histórico; documentos guardam o thumbprint usado.

Monitoramento: alertas de vencimento; bloqueio de emissão com certificado vencido (vira
`FAILED` antes do envio, com mensagem clara).

## 3. Outros segredos
CSC da NFC-e, credenciais municipais, segredos de webhook: mesma estratégia de envelope.
Configuração do sistema: variáveis de ambiente injetadas por secret manager; `.env` só em dev.

## 4. Proteções de aplicação
- **XML**: parser de respostas com DTD/entidades externas **desabilitados** (anti-XXE) e limites de tamanho/profundidade.
- Limites de tamanho de corpo, rate limiting por credencial (Redis), timeouts.
- Logs com redaction via pino (`password`, `pfx`, `csc`, `authorization`, `secret`, dados pessoais do tomador conforme LGPD).
- **LGPD**: CPF/endereço de consumidores são dados pessoais. Minimizar em logs, controle de acesso a XMLs, política de retenção = obrigação legal fiscal.
- Webhooks: só URLs HTTPS; bloqueio de SSRF (rejeitar IPs privados/loopback/metadata no registro e na resolução DNS).
- Dependências: `npm audit`/Dependabot, lockfile, imagem mínima, usuário não-root, SBOM no CI.
- Banco: TLS, papéis mínimos, RLS, backups criptografados.
- S3: bucket privado, criptografia server-side, URLs pré-assinadas de curta duração para download, Object Lock (modo compliance) para artefatos autorizados.

## 5. Auditoria
`audit_log` append-only com hash encadeado: criação/alteração de empresa, credenciais,
certificados (upload, uso, substituição), emissão, cancelamento, ações manuais de operador
(ex.: resolução forçada de `UNKNOWN`, que exige justificativa).

Implementado em 2026-11-10 (módulo `audit`, migration 0003):
- Uma cadeia por empresa (`audit_log`, RLS) e uma da plataforma (`platform_audit_log`) para aplicações e credenciais.
- Cálculo do hash: `hash = SHA-256(prev_hash ‖ JSON canônico do registro)`. O registro hasheado inclui a empresa e a sequência.
- Gravação na mesma transação da mudança.
- Append-only por trigger para todos os papéis, inclusive o dono das tabelas.
- O trigger de inserção recusa um registro que não continue a cabeça da cadeia.
- A aplicação só tem INSERT. Ler e verificar a cadeia é tarefa do operador (`npm run audit -- verify`, runbook [kek-certificados](../runbooks/kek-certificados.md)).
- Catálogo fechado de ações:
  - empresa: `company.registered`, `establishment.registered`, `document_series.created`, `company_grant.granted`, `company_grant.revoked`, `certificate.uploaded`, `certificate.activated`, `certificate.rejected`, `certificate.replaced`, `certificate.revoked`;
  - empresa (webhooks): `webhook_subscription.created`, `webhook_subscription.updated`, `webhook_subscription.secret_rotated`, `webhook_delivery.redelivered` (só o host da URL, nunca a URL inteira nem o segredo);
  - empresa (habilitação de produção): `production_enablement.granted`, `production_enablement.revoked` (modalidade e estabelecimento; o motivo da revogação fica no registro da habilitação);
  - plataforma: `client_application.created`, `credential.issued`, `credential.revoked`, `queue.paused`, `queue.resumed`, `job.retried`, `job.discarded`.
- Os detalhes aceitam só valores escalares. Chave com nome sensível é recusada.
- Âncora externa diária (semana 7, [ADR-0031](../adr/0031-ancora-externa-auditoria.md)): a cabeça de cada cadeia vai para um bucket com Object Lock COMPLIANCE; `npm run audit -- verify --anchor` confere a cadeia contra ela.
- Pendência: uso do certificado por documento (Fase 2a).

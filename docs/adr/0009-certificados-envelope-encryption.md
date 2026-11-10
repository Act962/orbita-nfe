# ADR-0009 — Certificados A1: envelope com KEK assimétrica e separação de privilégios

- Status: **Aceito** · Data: 2026-11-09 · Revisado após aprovação do responsável

## Contexto
Requisito: certificados e senhas nunca expostos em logs e **não acessíveis indiscriminadamente pelos processos**. Hospedagem inicial em VPS com Coolify (sem KMS gerenciado no primeiro momento).

## Decisão
1. PFX e senha cifrados com DEK AES-256-GCM própria de cada certificado; AAD = empresa + certificado + finalidade.
2. DEK embrulhada por uma **KEK assimétrica**: a `api` tem só a chave **pública** (cifra no upload, não consegue decifrar); só o `worker-fiscal` tem a chave privada.
3. Validação do certificado (cadeia ICP-Brasil, validade, CNPJ) feita no `worker-fiscal`, de forma assíncrona; status `PENDING_VALIDATION → ACTIVE | REJECTED`.
4. Grants de coluna no PostgreSQL: `api` e `worker-general` não leem o ciphertext.
5. Chave privada do certificado só em memória no `worker-fiscal`, como `KeyObject`, cache curto, nunca em logs/disco; teste canário de logs no CI.
6. Porta `KeyManagementService` com adapter local (Fase 1–2) e adapter KMS gerenciado/Vault (evolução) sem mudança no domínio.
7. Backup offline da KEK; rotação por re-wrap das DEKs.
8. O PFX cifrado fica em coluna `bytea` (poucos KB), fora do S3, para reduzir dependências no caminho de assinatura.

## Resultado do spike 01 (2026-11-09)
PKCS#12 aberto em memória com node-forge, inclusive no formato legado (RC2/3DES) que o OpenSSL 3 do Node recusa. Uso no TLS sempre como `key` + `cert`. A chave passa brevemente por string PEM antes de virar `KeyObject`; limitação aceita porque só ocorre no `worker-fiscal`.

## Alternativas
- KEK simétrica compartilhada por API e worker: a API passaria a conseguir decifrar — rejeitado.
- Chave única em variável de ambiente: rotação difícil, raio de impacto total.
- HSM/A3: fora do escopo inicial.

## Riscos residuais
Quem administra a VPS/Coolify é a raiz de confiança até a adoção de KMS gerenciado. Mitigado por 2FA, acesso restrito e auditoria. Detalhes: [13-seguranca-certificados.md](../architecture/13-seguranca-certificados.md).

## Implementação (2026-11-10)
- Módulo `src/modules/certificates`. A API usa `CertificateService` + `RsaEnvelopeSealer`, só com a KEK pública. O worker-fiscal usa `CertificateVault` + `RsaEnvelopeOpener`, com a KEK privada.
- Envelope v1: DEK de 256 bits por certificado. PFX e senha são cifrados separadamente com AES-256-GCM (IV de 96 bits, tag de 128 bits). A AAD é `orbita-nfe/certificate/v1|empresa|certificado|finalidade`. A DEK é embrulhada com RSA-OAEP-SHA256 e KEK RSA de 4096 bits. O `kek_id` é o SHA-256 do SPKI, nos 16 primeiros hexadecimais.
- Configuração: a API exige `CERTIFICATE_KEK_PUBLIC_FILE` e **não sobe** com `CERTIFICATE_KEK_PRIVATE_FILE` configurada. O loader recusa chave privada no lugar da pública.
- Banco (migration 0003):
  - grants por coluna: a API insere o envelope e lê só metadados; o worker-general lê só id, vencimento e status;
  - a revogação apaga `wrapped_dek` (destruição criptográfica);
  - o trigger `certificates_guard` impõe as transições de status e a imutabilidade do conteúdo cifrado, inclusive para o dono das tabelas.
- Validação conforme a regra [CERT-001](../fiscal/regras/CERT-001.md). O CNPJ do titular vem do OID 2.16.76.1.3.3 (DOC-ICP-04). A troca de certificado tem sobreposição: o anterior só vira `REPLACED` quando o novo é validado, na mesma transação.
- Upload em JSON (`pfx` em base64 + `password`), e não em multipart: mantém validação Zod, limite de corpo por rota e documentação no Scalar. O corpo nunca é logado. Isso é garantido pelo `redact` + `sanitize` e pelo teste canário `test/integration/certificates.test.ts`.
- Pendências registradas no ACOMPANHAMENTO:
  - bundle oficial ICP-Brasil (ITI);
  - LCR/OCSP;
  - cache com TTL em `withCertificate`;
  - comando de re-embrulho (rotação);
  - disparo da validação pela fila (semana 6).

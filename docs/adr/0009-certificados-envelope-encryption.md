# ADR-0009 — Certificados A1: envelope com KEK assimétrica e separação de privilégios

- Status: **Aceito** · Data: 2026-11-09 · Revisado após aprovação do responsável

## Contexto
Requisito: certificados e senhas nunca expostos em logs e **não acessíveis indiscriminadamente pelos processos**. Hospedagem inicial em VPS com Coolify (sem KMS gerenciado no primeiro momento).

## Decisão
1. PFX e senha cifrados com DEK AES-256-GCM própria de cada certificado; AAD = tenant + certificado + finalidade.
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

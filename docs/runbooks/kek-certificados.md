# Runbook — KEK dos certificados, ACs confiáveis e trilha de auditoria

Referências: ADR-0009, ADR-0021, [doc 13](../architecture/13-seguranca-certificados.md) e [doc 14 §A4](../architecture/14-integridade-isolamento.md).

## 1. Onde cada segredo fica
| Arquivo | api | worker-fiscal | worker-general | CLI do operador |
|---|---|---|---|---|
| KEK **pública** (`CERTIFICATE_KEK_PUBLIC_FILE`) | sim | não precisa | não | não |
| KEK **privada** (`WORKER_CERTIFICATE_KEK_PRIVATE_FILE`) | **nunca**. A API não sobe com `CERTIFICATE_KEK_PRIVATE_FILE` definida e recusa um arquivo "público" que contenha chave privada | sim | **nunca** | só a CLI `certificates` (papel do worker) |
| Bundle de ACs (`CERTIFICATE_TRUST_BUNDLE_FILE`) | não | sim | não | `certificates` |

Cada segredo é montado como arquivo somente leitura (0400) no serviço do Coolify. Nunca use variável de ambiente genérica.

## 2. Gerar a KEK de produção (offline)
1. Use uma máquina confiável, sem rede, se possível.
2. Gere a chave privada:
   `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out kek-private.pem`
3. Extraia a chave pública:
   `openssl pkey -in kek-private.pem -pubout -out kek-public.pem`
4. A aplicação exige RSA de 4096 bits. Uma chave menor ou que não seja RSA impede a subida (`KEK_TOO_SMALL`, `KEK_NOT_RSA`).
5. Faça o backup: duas cópias offline de `kek-private.pem`, cifradas com uma senha forte e guardadas em lugares diferentes. **Sem a KEK privada, os certificados enviados ficam ilegíveis.** A recuperação, nesse caso, é cada cliente reenviar o certificado.
6. Cadastre `kek-public.pem` como secret do serviço `api` e `kek-private.pem` só no serviço `worker-fiscal`.
7. Apague as cópias de trabalho da máquina de geração.

Em desenvolvimento, `npm run dev:secrets` gera os dois arquivos em `secrets/`, que está fora do git.

## 3. Rotação da KEK
1. Gere a KEK nova (§2) e monte a pública nova na API. Os envelopes novos passam a usar o novo `kek_id`.
2. Monte no worker-fiscal a KEK privada nova **e** a antiga: o opener aceita várias.
3. Rode o re-embrulho das DEKs. O comando ainda não foi implementado e está registrado como dívida. O trigger do banco só aceita trocar `wrapped_dek` junto com um `kek_id` novo.
4. Quando nenhum certificado usar mais o `kek_id` antigo, retire a KEK antiga do worker.

## 4. Bundle de ACs raiz confiáveis
- Em produção, o bundle é o das ACs raiz da ICP-Brasil publicadas pelo ITI. Ao carregar, registre em [fontes-oficiais](../fiscal/fontes-oficiais.md) a URL, a versão, a data e o SHA-256 de cada certificado. **Ainda pendente.**
- Em desenvolvimento, `node --import tsx scripts/dev-test-certificate.ts <cnpj> <senha>` gera um e-CNPJ **fictício** e um `secrets/trust-bundle.pem` com a AC de teste. Isso nunca vai para produção.

## 5. Validação de certificados
O caminho normal é automático: o upload enfileira `certificates.validate` no mesmo commit, e o worker-fiscal valida ([runbook de filas](filas-e-webhooks.md)).

A CLI continua disponível para revalidar manualmente:
`npm run certificates -- validate --company <uuid> [--certificate <uuid>]`

O comando usa `WORKER_DATABASE_URL`, que precisa ser um login membro de `fiscal_worker`, além da KEK privada e do bundle. A saída mostra só ids, status e motivos.

## 6. Verificação da trilha de auditoria
- `npm run audit -- verify --company <uuid>`
- `npm run audit -- verify --platform`

O comando usa `ADMIN_DATABASE_URL`, com o papel `fiscal_admin`.

| Saída | Significado | Ação |
|---|---|---|
| 0 `cadeia íntegra` | Os hashes conferem do início até a cabeça | Com `--anchor`, a cadeia também confere com a âncora mais recente do bucket com Object Lock (ADR-0031). A saída 3 indica que não há âncora para a cadeia |
| 2 `ADULTERAÇÃO DETECTADA: <motivo>` | `HASH_MISMATCH` (registro alterado), `SEQUENCE_GAP`/`BROKEN_LINK` (removido ou reescrito), `HEAD_MISMATCH` (registros apagados do fim) ou `ANCHOR_MISMATCH` (cadeia reescrita com hashes recalculados ou encurtada antes da âncora) | **Incidente de segurança.** Congelar o acesso administrativo, preservar o banco e os backups, comparar com a última âncora e investigar quem tinha acesso de superusuário |

A trilha é append-only para todos os papéis, inclusive o dono das tabelas. Só um superusuário que desligue os triggers consegue alterá-la, e o verificador detecta a alteração.

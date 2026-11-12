---
last_updated: 2026-11-12
---

# Runbook — NFS-e em UNKNOWN ("em verificação")

Decisão: [ADR-0034](../adr/0034-resolucao-manual-unknown.md). Contexto: [doc 12](../architecture/12-recuperacao-unknown.md).

`UNKNOWN` quer dizer que a DPS **pode** ter chegado ao autorizador e não houve resposta confiável. Timeout **não** prova que a nota não existe.

## 1. Regras que não mudam
- **Nunca** reemita com outra `Idempotency-Key`, nem oriente o cliente a fazer isso.
- **Nunca** mude o estado no banco. O trigger recusa `UNKNOWN → FAILED`, e o operador não tem `UPDATE` na nota.
- Toda resolução é um **pedido auditado**. Quem confere e aplica é o worker-fiscal.

## 2. Alertas (log do worker-fiscal, `event: nfse.unknown_age`)
| Nível | Idade | O que fazer |
|---|---|---|
| `WARNING` (warn) | > 15 min | Acompanhar. A reconciliação automática costuma resolver |
| `CRITICAL` (error) | > 2 h | Abrir o painel (§3) e verificar se o autorizador está fora (jobs `nfse.reconcile` com erro) |
| `INCIDENT` (error) | > 24 h, repetido a cada 24 h | Análise manual obrigatória: consultar o portal oficial e pedir a resolução (§4) |

O alerta traz só identificadores: `invoiceId`, `companyId`, ambiente, idade, tentativa e consultas. **Os comandos abaixo pedem `--company`**: use o `companyId` do alerta ou do painel.

## 3. Painel de pendências
```bash
npm run ops -- nfse-unknown --older-than 120
```
- Sem `--company`, o painel percorre as empresas que têm reconciliação de NFS-e na fila, uma de cada vez e no contexto de cada uma.
- Com `--company <uuid>`, olha só essa empresa.

Cada linha traz:
- id da nota, empresa e ambiente;
- idade, tentativa, consultas e erros de consulta seguidos;
- o pedido aberto, se houver.

## 4. Pedir a resolução
Consulte a nota no **portal oficial** da NFS-e, no ambiente certo e pelo Id da DPS.

**A nota existe:** baixe o XML oficial da NFS-e e peça:
```bash
npm run ops -- nfse-resolve <notaId> --company <empresaId> --outcome AUTHORIZED --nfse-xml nfse.xml --reason "Encontrada no portal em 12/11 às 15h, consulta automática fora do ar"
```

**A nota não existe:** guarde a evidência (print ou PDF do portal) em local seguro e peça:
```bash
npm run ops -- nfse-resolve <notaId> --company <empresaId> --outcome NOT_ISSUED --evidence print-portal.png --reason "Consulta no portal sem resultado para o Id da DPS em 12/11 às 15h"
```
- O banco guarda só o SHA-256 da evidência; **o arquivo fica com você**.
- A nota será retransmitida com o **mesmo XML e o mesmo número**. Se ela existir, o autorizador responde duplicidade e a consulta resolve.

Para acompanhar o pedido:
```bash
npm run ops -- nfse-resolution <pedidoId> --company <empresaId>
```
- `APPLIED`: aplicado.
- `REFUSED`: recusado. A nota continua `UNKNOWN`, e você pode fazer novo pedido.

## 5. Códigos de recusa
| Código | Significado | Ação |
|---|---|---|
| `SERVICE_INVOICE_NOT_UNKNOWN` | A nota saiu de `UNKNOWN` antes, por exemplo resolvida pela consulta | Nada a fazer |
| `AUTHORIZER_REPORTED_EXISTING` | O autorizador respondeu duplicidade: a nota existe | Peça `AUTHORIZED` com o XML |
| `NFSE_SCHEMA_INVALID` | O XML não passa no XSD oficial | Baixe de novo o XML **da NFS-e**, não o da DPS nem o PDF |
| `NFSE_XML_NOT_NFSE` | A raiz não é `NFSe` | Idem |
| `NFSE_DPS_MISMATCH` | O XML é de outra DPS (outro número ou série) | Confira a nota no portal |
| `NFSE_DPS_SIGNATURE_MISMATCH` | Mesmo Id de DPS, mas a DPS não é a que o motor assinou: outro sistema emitiu com a mesma série e número | **Incidente**: escale para o responsável e o contador |
| `NFSE_ENVIRONMENT_MISMATCH` | XML de homologação para nota de produção, ou o contrário | Consulte o ambiente certo |
| `NFSE_LAYOUT_UNKNOWN` / `SIGNED_DPS_MISSING` | Estado inesperado do documento | Escale (bug) |
| `EVIDENCE_HASH_MISMATCH` | O XML gravado não confere com o hash do pedido | Escale (bug ou adulteração) |
| `NFSE_XML_MALFORMED` / `NFSE_XML_DOCTYPE_FORBIDDEN` / `NFSE_XML_TOO_LARGE` | Arquivo inválido | Baixe de novo |

## 6. Limitação atual
A assinatura da SEFIN sobre o XML da NFS-e ainda não é verificada (ADR-0034, limitações). Baixe o XML **somente do portal oficial**.

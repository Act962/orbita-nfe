# ADR-0014 — Geração, validação e assinatura de XML

- Status: **Aceito** (bibliotecas) · Data: 2026-11-09 · Decidido após os spikes 01–03 ([resultados](../spikes/resultados-fase1.md))

## Decisão
| Função | Biblioteca | Licença | Evidência |
|---|---|---|---|
| Abrir PKCS#12 (A1) em memória | `node-forge` (opção BSD-3 da licença dupla) | BSD-3-Clause | PFX 3DES, AES-256 e legado RC2 abertos sem disco/processo |
| XMLDSig enveloped | `xml-crypto` | MIT | assinaturas verificadas por `xmlsec1` (implementação independente) |
| Validação XSD | `xmllint-wasm` (libxml2 em WebAssembly) | MIT | include/import em memória, sem binding nativo, portátil |
| Parse de XML não confiável | `@xmldom/xmldom` + bloqueio de `DOCTYPE`/`ENTITY` e limite de tamanho | MIT | XXE e billion laughs recusados |
| Geração de XML | builder próprio, determinístico, a partir do modelo de domínio | — | a implementar na Fase 2a |

Regras derivadas:
1. TLS com certificado do cliente: **sempre `key` + `cert`** extraídos pelo node-forge, nunca `pfx` direto (o OpenSSL 3 do Node recusa PFX legado).
2. Perfil de assinatura (algoritmo de assinatura, digest, transforms, canonicalização) é **configuração por leiaute**, definida pelo manual oficial vigente, sem valor padrão no código.
3. XSDs oficiais versionados com SHA-256 (ADR-0013); validação usa o pacote da versão gravada no documento.

## Pendências
- Ler no manual NFS-e Nacional vigente os algoritmos exigidos e validar contra os XSDs oficiais (Fase 2a).
- Otimizar o xmllint-wasm (instância persistente ou worker threads) se a vazão exigir (~88 ms/documento hoje).

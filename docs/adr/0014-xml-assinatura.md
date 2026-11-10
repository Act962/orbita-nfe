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

## Complemento (2026-11-10): perfil de assinatura da DPS
- **Documentado para Teresina** (Guia API THE V7, DSF/SEMF, 20/08/2026, §4):
  - XMLDSig enveloped, com `Signature` sem prefixo (`xmlns="http://www.w3.org/2000/09/xmldsig#"`), irmã de `infDPS`;
  - `Reference URI="#<Id do infDPS>"`;
  - Transforms: `enveloped-signature` + C14N `http://www.w3.org/TR/2001/REC-xml-c14n-20010315`;
  - CanonicalizationMethod: C14N;
  - SignatureMethod `http://www.w3.org/2000/09/xmldsig#rsa-sha1`;
  - DigestMethod `http://www.w3.org/2000/09/xmldsig#sha1`.
- **SEFIN Nacional:** o Anexo I exige assinatura válida com o certificado do emitente, com KeyUsage "Assinatura Digital" e "Não Recusa" (E0714–E0718), mas **não especifica algoritmos**. O perfil DSF, que é compartilhado e validado pelo ADN, indica o mesmo padrão. Status: **provável**.
- Decisão: o perfil `nfse-nacional-dps` é criado com esses valores, marcado como **provisório para a SEFIN** até um teste bem-sucedido na produção restrita, que ficará registrado em fontes-oficiais.
- Mesmo com a recomendação do Guia, o `xml-crypto` precisa gerar a assinatura sem prefixo `ds:`. Isso é um item de teste da Fase 2a.
- Observação de segurança: SHA-1 é exigência do autorizador, não escolha do motor. A verificação de assinaturas **recebidas** deve aceitar só os algoritmos do perfil.

## Pendências
- ~~Ler no manual NFS-e Nacional vigente os algoritmos exigidos~~: o manual nacional não os traz. Confirmar em produção restrita (ver complemento).
- Otimizar o xmllint-wasm (instância persistente ou worker threads) se a vazão exigir (~88 ms/documento hoje).

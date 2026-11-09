# ADR-0014 — Geração, validação e assinatura de XML (decisão após spike)

- Status: Proposto (pendente de spike) · Data: 2026-11-09

## Decisão provisória
- Geração determinística a partir do modelo de domínio (builder próprio ou `xmlbuilder2`), sem templates de string.
- Validação XSD com libxml2 (binding nativo ou wasm) contra os schemas oficiais.
- XMLDSig com `xml-crypto`; algoritmos de canonicalização/assinatura/digest **conforme o manual vigente de cada leiaute** (confirmar; não assumir de tutoriais).
- Leitura de PKCS#12 com `node-forge` ou `openssl` controlado; mTLS com `pfx` ou `key`+`cert` no `undici`.
- Parser de respostas com proteção contra XXE.

## Critério de aceite do spike
Assinaturas verificadas por `xmlsec1` e aceitas em homologação oficial.

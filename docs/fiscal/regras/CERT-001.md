# CERT-001 — Certificado A1 aceito para uma empresa

- Implementação: `src/modules/certificates/domain/certificate.ts` (`evaluateCertificate`), `infrastructure/crypto/pkcs12.ts` (`extractIcpBrasilCnpj`), `infrastructure/crypto/trust-store.ts`
- Testes: `certificate.test.ts`, `pkcs12.test.ts`, `test/integration/certificates.test.ts`
- Status: implementada. O bundle oficial de ACs raiz ICP-Brasil ainda não foi carregado (ver Pendências).

## Regra
O worker fiscal confere o certificado enviado nesta ordem. A primeira falha decide o motivo da rejeição:

| # | Verificação | Motivo da rejeição |
|---|---|---|
| 1 | O PKCS#12 abre com a senha e contém uma chave RSA e o certificado correspondente | `PKCS12_INVALID_PASSWORD`, `PKCS12_MALFORMED`, `PKCS12_NO_KEY`, `PKCS12_UNSUPPORTED_KEY`, `PKCS12_KEY_CERT_MISMATCH` |
| 2 | A cadeia chega a uma AC raiz do bundle confiável, com assinaturas válidas, ACs dentro da validade e `CA:TRUE` nos intermediários | `CERTIFICATE_CHAIN_UNTRUSTED` |
| 3 | O certificado está dentro da validade (`notBefore` ≤ agora ≤ `notAfter`) | `CERTIFICATE_NOT_YET_VALID`, `CERTIFICATE_EXPIRED` |
| 4 | Há CNPJ do titular no otherName **2.16.76.1.3.3** do SubjectAltName, e esse CNPJ é válido | `CERTIFICATE_NOT_LEGAL_ENTITY` |
| 5 | A raiz desse CNPJ é a mesma da empresa | `CERTIFICATE_CNPJ_MISMATCH` |
| 6 | O `keyUsage` inclui `digitalSignature` | `CERTIFICATE_KEY_USAGE_INVALID` |

Só são aceitos e-CNPJ A1, enviados como arquivo PKCS#12. Certificados de pessoa física e A3 ficam de fora.

## Origem
- **OID 2.16.76.1.3.3:** o campo otherName do certificado de pessoa jurídica traz o CNPJ do titular em 14 posições. Fonte: ITI, DOC-ICP-04.01 (atribuição de OID na ICP-Brasil) e DOC-ICP-04, com a alteração da Resolução CG ICP-Brasil nº 196/2021. Consulta em 2026-11-10 (ver [fontes-oficiais](../fontes-oficiais.md)).
- **O CN não serve como fonte do CNPJ.** O formato "NOME:CNPJ" do CN é texto livre da AC, então o motor nunca extrai o CNPJ dele.
- **Mesma raiz = mesma empresa.** Isso é decisão de modelagem do motor ([COMPANY-001](COMPANY-001.md)): o certificado da matriz atende as filiais. Se uma modalidade exigir o CNPJ exato do estabelecimento, isso vira regra própria, com a fonte dessa modalidade.
- **`digitalSignature`:** é requisito técnico da assinatura XML (ADR-0014), não uma regra fiscal. A presença desse bit nos certificados A1 da ICP-Brasil está prevista no DOC-ICP-04, mas a conferência do texto vigente está pendente.
- **Só e-CNPJ A1:** decisão do ADR-0027. Ainda falta confirmar quais tipos de certificado cada autorizador aceita (doc 17, §6).

## Exigências dos autorizadores de NFS-e (consulta de 2026-11-10)
Fonte: Anexo I da NFS-e Nacional, v1.01, nas versões de produção e de produção restrita (hashes em [fontes-oficiais](../fontes-oficiais.md)).

| Regra | Certificado | Exigência | Situação no CERT-001 |
|---|---|---|---|
| E1200 | da **transmissão** (TLS) | X.509 v3, não pode ser de AC, KeyUsage com "Autenticação Cliente" | Hoje não é conferido. "Autenticação Cliente" corresponde ao uso estendido `clientAuth`. Fase 2a: conferir num e-CNPJ A1 real e então adicionar a verificação |
| E0716 | da **assinatura** | v3, não pode ser de AC, KeyUsage com "Assinatura Digital" **e "Não Recusa"**, OtherName 2.16.76.1.3.3 ou .1, raiz ICP-Brasil | Hoje só `digitalSignature` é conferido. Fase 2a: avaliar a exigência de `nonRepudiation` com um certificado real antes de endurecer a regra, para não rejeitar certificados válidos |
| E1205–E1208 / E0715 | ambos | cadeia, validade, LCR, raiz ICP-Brasil | cadeia e validade já conferidas; LCR pendente (abaixo) |

A API de Teresina (Guia THE V7) exige um certificado com o mesmo CNPJ raiz do contribuinte. Isso é compatível com o passo 5.

## Pendências
- Verificações de E1200 e E0716 da tabela acima (Fase 2a).
- Carregar o bundle oficial de ACs raiz da ICP-Brasil publicado pelo ITI, com versão e hash registrados (runbook [kek-certificados](../../runbooks/kek-certificados.md)). Até lá, só os testes usam ACs fictícias.
- Fazer a consulta de revogação (LCR/OCSP). Por enquanto é dívida registrada no ACOMPANHAMENTO.
- Verificar a mudança de OIDs no SubjectAltName prevista para 31/12/2028 (risco R-28). A informação vem de fonte secundária e não foi confirmada.

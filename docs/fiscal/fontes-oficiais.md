# Registro de fontes oficiais

Regra do projeto: nenhuma regra, endpoint, schema ou código fiscal entra no código sem
uma linha aqui (ou em `regras/<id>.md`) com **fonte oficial, versão, data de consulta e
hash do arquivo** quando houver download.

## Fontes a consultar (início de cada fase)
| Tema | Fonte oficial | Status |
|---|---|---|
| NFS-e Nacional — manuais, leiautes, APIs, ambientes | Portal NFS-e (gov.br/nfse) — documentação técnica do Sistema Nacional NFS-e | consultado em 2026-11-10 ([diagnóstico](nfse-teresina-api-municipal-x-nacional.md)). Pendente: Swagger com certificado |
| Adesão do município-piloto ao padrão nacional | Portal NFS-e (planilha de municípios aderentes) + prefeitura | consultado em 2026-11-10: Teresina é conveniada e aderente ao ADN, não ao Emissor Nacional |
| API municipal de Teresina (DPS) | SEMF — Carta de Serviços `/dps` + Guia API THE V7 (DSF) | consultado em 2026-11-10 |
| NF-e / NFC-e — MOC, leiaute 4.00, NTs, XSDs, webservices por UF | Portal Nacional da NF-e (nfe.fazenda.gov.br) | a consultar nas Fases 3/4 |
| Reforma Tributária nos DF-e (IBS/CBS/IS) | NTs da RTC no Portal NF-e; LC 214/2025; documentação NFS-e | a consultar |
| CNPJ alfanumérico | IN RFB nº 2.229/2024 + NT DF-e correspondente | a consultar |
| NFC-e da UF de operação (contingência, QR Code, CSC) | Portal da SEFAZ da UF | a consultar |
| Prazo de guarda de documentos | CTN (decadência/prescrição) + orientação do contador | a confirmar |
| ICP-Brasil (cadeia de certificados) | ITI — repositório de ACs | **bundle de ACs raiz a carregar** (runbook kek-certificados) |
| ICP-Brasil (campos do certificado de PJ) | ITI — DOC-ICP-04 e DOC-ICP-04.01 (atribuição de OID) | consultado em 2026-11-10 (CERT-001) |

## Registro de consultas
| Data | Fonte | Versão/documento | Hash | Usado em |
|---|---|---|---|---|
| 2026-11-09 | Receita Federal — notícia "NFS-e de padrão nacional será obrigatória para optantes do Simples Nacional" (abr/2026) | Res. CGSN 189/2026; data alterada pela 191/2026 | — | ADR-0017, nfse-teresina.md (T1) — **ler texto integral das resoluções** |
| 2026-11-09 | gov.br/nfse — Manual Contribuintes Emissor Público API Sistema Nacional NFS-e | v1.2, out/2025 | pendente (baixar) | doc 12 (consulta por id da DPS) — **leitura integral pendente** |
| 2026-11-09 | gov.br/nfse — NT 004 SE/CGNFS-e (leiaute RTC v2.00) e NT 007 SE/CGNFS-e | 10/12/2025; v1.0 | pendente | Fase 2a |
| 2026-11-09 | Portaria SEMF Teresina nº 20/2026 (via fonte secundária) | — | — | nfse-teresina.md (T4) — **obter texto oficial** |
| 2026-11-09 | Comunicado CGNFS-e 20/10/2026 (release 1 da NT 009), NT 009 v1.01 e pacote XSD de produção restrita `NFSe-ESQUEMAS_XSD-PRODREST-v1.01-20261020.zip` — **citados pelo repositório kursku/emissor-nfse (ADR 0007)** | NT 009 v1.01 | hashes publicados pelo terceiro; **recalcular a partir do download oficial** | R-24, Fase 2a — **confirmar data de 01/12/2026 no portal** |

| 2026-11-09 | Leiaute NF-e (Ato COTEPE/ICMS 72/2005 via normasbrasil) e documentações de integração (Senior, NFE.io) — **secundárias** | — | — | SERIES-001 — **conferir no MOC/XSD oficial** |
| 2026-11-09 | Tipos `TSSerieDPS`/`TSNumDPS` via buscadorncm (reprodução do XSD) — **secundária** | — | — | SERIES-002 (provisória) — **conferir no XSD oficial** |

> Nesta Fase 0 nenhuma regra fiscal foi implementada. Afirmações fiscais nos documentos
> de arquitetura estão marcadas como "a confirmar" quando dependem de verificação.
| 2026-11-10 | ITI — DOC-ICP-04.01 (atribuição de OID na ICP-Brasil) e DOC-ICP-04 (requisitos dos certificados), alteração pela Resolução CG ICP-Brasil nº 196/2021 | DOC-ICP-04.01 v3.x/v4.0 (repositório ITI) | — | CERT-001 (OID 2.16.76.1.3.3 = CNPJ do titular, 14 posições) — **baixar a versão vigente e registrar o hash** |

### Consultas de 2026-11-10 — NFS-e Teresina × Nacional
Detalhes, links e status de cada item: [diagnóstico](nfse-teresina-api-municipal-x-nacional.md) §5 e §6. Pacotes XSD em `resources/fiscal/schemas/nfse-nacional/` com `MANIFEST.json`, conferidos por teste.

| Data | Fonte | Versão/documento | SHA-256 | Usado em |
|---|---|---|---|---|
| 2026-11-10 | Res. CGSN nº 191/2026 (normas.receita.fazenda.gov.br, idAto=152781) | 04/08/2026, DOU 10/08/2026; efeitos a partir de 01/11/2026; revoga a Res. 189/2026 | — | ADR-0017, ADR-0028 (substitui a linha de 2026-11-09 baseada em notícia) |
| 2026-11-10 | Portal NFS-e — notícia "diretrizes sobre a obrigatoriedade… Simples Nacional" | 29/10/2026 | — | ADR-0028 (critério = data de competência) |
| 2026-11-10 | Portal NFS-e — municípios aderentes | planilha de 28/09/2026 | `53620c40387aefcc4ff48c26667dca16513550a1f036999b0208a51066ea912a` | ADR-0017 |
| 2026-11-10 | XSD NFS-e Nacional, produção | `nfse-esquemas_xsd-v1-01-20260209.zip` | `e7935cbd9470527c6cc32984c1b2263e614183bf0139ce2733eaaed2de9a8072` | `resources/…/1.01-20260209`, ADR-0013 |
| 2026-11-10 | XSD NFS-e Nacional, produção restrita | `esquemas_prod_restrita_20261020.zip` | `25fdcecc651a67a216496ab10d7566631e6ed10f721e37d62c7845dadb0ea267` | `resources/…/1.01-20261020-prodrest`, ADR-0013 |
| 2026-11-10 | Anexo I (regras DPS/NFS-e), produção | v1.01, 09/02/2026 | `de5bc492959eadc8bfa7540e16939995924f2188f743648eaf84d3b31e9eeb7c` | E0014, E0039, E0714–E0718, E1200–E1209 (ADR-0029) |
| 2026-11-10 | Anexo I, produção restrita | v1.01, 20/10/2026 | `72b05981c8882cdd807f3acf901b669465360f9cf1b9d9e235ac4363dacfb2d8` | E0039 com exceção ME/EPP, E0855 |
| 2026-11-10 | Anexo II (eventos) | v1.01, 22/01/2026 | `5abe83d7e51023ffa979cc466c628399f3e4bbf03c293b5b1a0817e873eb428e` | e101101, e105102 |
| 2026-11-10 | Manual Contribuintes — Emissor Público API (lido; substitui a pendência de 2026-11-09) | "v1.2 out/2025" | `ac2f36e34ff565cc36d67c5d67415c33cc09f27b2dea006e8da9bcd2ddce5581` | ADR-0029 (endpoints, GET/HEAD /dps) |
| 2026-11-10 | Manual Contribuintes — APIs ADN | v1.0, 12/02/2026 | `9ffc97d8b1be4c80a440b3569b0027df61265b9e75ef69437f21f9481a9a1d6d` | distinção SEFIN × ADN |
| 2026-11-10 | NT 004 v2.00 / NT 007 v1.0 / NT 008 v1.02 / NT 009 v1.01 | 10/12/2025 / 07/02/2026 / 14/07/2026 / 11/09/2026 | `707524b2…` / `24e46b39…` / `1265f403…` / `cc86c940…` | RTC, DANFSe (NT 008), Simples na NT 009 |
| 2026-11-10 | SEMF — Carta de Serviços `/dps` | atualização de 20/08/2026 | — | ADR-0017 (credenciamento, hosts) |
| 2026-11-10 | SEMF/DSF — Guia de Utilização da API THE | V7, 20/08/2026 | `5a75fca07c0779a4c9d14100ea84bb12f1ce4120b125455f876a27caca5742ff` | ADR-0014 (perfil de assinatura), ADR-0029 |
| 2026-11-10 | SEMF/DSF — Guia do Emissor Municipal Web | V1, 01/07/2026 | `ec0957c4529ce1a3f0986c2e62c2ff96c619071f446988c23e9805ed02c510f8` | contexto |
| 2026-11-10 | Portarias SEMF 20/2026 e 25/2026 (DOM 4.182 e 4.191) | 22/01/2026 e 04/02/2026 | `2cbaa636…66a7` / `9b98e888…026a` | ADR-0028 (substitui a linha de 2026-11-09 via fonte secundária) |
| 2026-11-13 | Anexo I, produção e produção restrita (baixados de novo; hash igual ao registrado em 2026-11-10) | v1.01, 09/02/2026 e 20/10/2026 | `de5bc492…eeb7c` / `72b05981…2dd8` | ADR-0036: E0042–E0078 (substituição); E0059–E0064 da produção restrita (matriz dos campos travados). ADR-0037: catálogo [NFSE-DPS](regras/NFSE-DPS.md) |

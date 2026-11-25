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
| 2026-11-13 | SEFIN Nacional — Swagger 2.0 "API NFS-e - Sefin Nacional", produção restrita (lido com mTLS e o A1 da empresa de teste; `npm run sefin:docs`) | `…/SefinNacional/swagger/docs/v1`, versão "v1" | `ea7a720fa8dc03350ad80c40d55c315a7458b5538bf00f4be9b8b6fada663217` (página `docs/index`: `a8dd42e6…1806`) | ADR-0029 (complemento de 2026-11-13): `basePath`, envelopes, respostas e consulta de evento por `numSeqEvento` |
| 2026-11-13 | Anexo II (eventos), produção (baixado de novo; hash igual ao de 2026-11-10) e produção restrita | v1.01, 22/01/2026 e 20/10/2026 | `5abe83d7…428e` / `6e0660d18def5dc674923f0e2f3731ada5bdbfac966f1dc615c090104d28688d` | ADR-0038: `nSeqEvento` = 001 no cancelamento; E0802 e E0840 (evento já existente) |
| 2026-11-25 | NT 008 SE/CGNFS-e — Especificações Técnicas do DANFSe (baixada de novo e lida inteira; hash igual ao registrado em 2026-11-10) | v1.02, 14/07/2026, 26 páginas | `1265f403aedcdc5f08b3049dcc18a15c2bc155f51afccf3d12690fef2f4fb0ff` | ADR-0057: leiaute do DANFSe v2.0 (item 2.4.5), QR Code, marcas d'água; API de DANFSe do ADN suspensa em 03/08/2026 |
| 2026-11-25 | gov.br/nfse — logomarca da NFS-e, horizontal (PNG citado no item 2.4.3 da NT 008) | 1920×389 | `ab57fa34887929a10ee3b9b4d666084ec9b9465e62bbcc3523b99b23ccac1063` | `resources/fiscal/danfse/`, ADR-0057 |
| 2026-11-25 | MOC 7.0 — NF-e e NFC-e (Portal NF-e, Manuais) | 7.0 | `f664dcf94b77cabb32311620d85a7eb02cdf86adb2d4632ce178af2572dd2ad1` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | MOC 7.0 — Anexo I, Leiaute e Regras de Validação NF-e e NFC-e | 7.0 | `5eb4cf2010b10b0b62f78197c4eb64025f24535d4c6e61158bc7806dd008f55d` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | MOC 7.0 — Anexo IV, Manual de Contingência NFC-e | 7.0 | `0b5ae1e88ae60b57d4f1d752316289ff55f7e10c7e1d405905325e9de2666b0e` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | Manual de Especificações Técnicas do DANFE NFC-e e QR Code | 6.0, março de 2025 | `bf906cc212f1edd19b1df7d1cdf4fbf5e73c3fec77567b6e69fa74453c95db5e` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | Manual de Especificações da Contingência Off-line da NFC-e | 2.0 | `5ff5c8fdc8a55ae91f2f6e7c29566a45ca7e3867c7b76877deb48911071cf06c` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | Manual de Boas Práticas do emissor de NFC-e, BP 2018.001 | 1.0 | `2c67883620011685c8de0e34100c8f0b5e731cad8c7cc6ad02a383aad6873333` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | NT 2025.002 — RTC (IBS, CBS e IS) na NF-e e NFC-e | v1.53, 30/10/2026 | `d62445d7429806b0403b44818e252fea16107794319a029ac7025017e5f4e34c` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | NT 2023.002 — emitente CPF, fim do lote, da denegação, da autorização assíncrona e da inutilização (AC, BA, SP) | v1.02, out. 2026 | `e375b487fdb38c0f114dbc9fd4a0b109151d0a21e1770d738f5c5f9597758202` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | NT 2023.002 — emitente CPF na NFC-e | v1.01, 18/11/2025 | `b0cb9528bfaa6e0b5ac2986c879898eebcbb9457e97fcf0af985a00659649031` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | NT 2026.004 — schema da NF-e/NFC-e para CNPJ alfanumérico | v1.01, 08/06/2026 | `5f24a25351e790692754b07bbefac42ac67e70167a62a7806395d880f56675be` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | NT Conjunta 2025.001 — CNPJ alfanumérico nos DF-e | v1.00, 08/05/2025 | `671d546b24ad4682e267fc76a9eeca8f14ad15ead2be20721ee2aec5438cf964` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | NT 2026.005 — Simples Nacional na NF-e e NFC-e (RTC) | v1.00, 30/10/2026 | `5219882256663336301c0daa36e9d4bcece49b15f100025b39c9cf913055b85e` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | NT 2026.007 — LCC-RFB e CCC (emissão sem IE) | v1.11, 30/10/2026 | `b13006ce48488111ac077356e137817545957db6748cdf41a3eeea21818dd4e8` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | NT 2026.008 — valor líquido do produto (RTC) | v1.01, 30/10/2026 | `8134a3f1f460650262ce359566b7993ac3503037f24b223a4c8c53b237b50090` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | Schemas XML NF-e — Pacote de Liberação PL_010h (leiauteNFe_v4.00 e eventos RTC) | v1.03, 13/11/2026 | `bcbf6b277f79a6983d69016dfe0430f09b8a191997a4706a24938acddc18dc81` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | Schemas XML NF-e/NFC-e — Pacote de Liberação PL_010e (leiaute) | v1.02, 10/07/2026 | `d44ae5aa6a0d1cabf6235d2d2d47b75be5dd87bc6b90a7ec3dcec99c3d41bda1` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | Schemas XML NF-e/NFC-e — Pacote de Liberação PL_010d (CNPJ alfanumérico: consulta de situação, inutilização, eventos, consulta de cadastro) | v1.03, 10/07/2026 | `45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | Schemas XML NF-e/NFC-e — Pacote de Liberação PL_009q (pacote completo dos serviços: enviNFe, retEnviNFe, consStatServ, consReciNFe, inutNFe e outros) | v1.00 (NT 2025.001), 19/05/2025 | `82a26d04a778fc214bf8c6c6e5c65ea577721e32ed5efa9a11a80098b8f9802f` | [ADR-0062](../adr/0062-schemas-e-regras-da-nfce.md) |
| 2026-11-25 | Schemas XML NF-e/NFC-e — Pacote de Liberação PL_010b (só leiaute; consultado e não usado) | v1.30 (NT 2025.002), 07/10/2025 | `2deaa8d430d0acb47deae06b9b6d1202dbb436baf3d2d3aa834a534a3d6fa1b8` | [ADR-0062](../adr/0062-schemas-e-regras-da-nfce.md) |
| 2026-11-25 | NT 2014.001 — Evento EPEC (Portal NF-e) | v1.41 | `fa9218ddadcb35ca1233434a4dfd040243360d983c0d3f6b85e7756284a6fd19` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2014.002 — Distribuição de DF-e, CNPJ alfanumérico (Portal NF-e) | v1.40 | `156dcb170e205c076a6da86aedf56a04afcec3aef8e373dd7fbf7ccb068da029` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2019.001 — Regras de validação (Portal NF-e) | v1.70 | `8c03e1d53893f211b4967a5f6da0a1a5f9c46b0862e23ee5b63816657e79ff00` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2020.001 — Manifestação do destinatário (Portal NF-e) | v1.60 | `f610878ad54708086aaa20dc668d714adf89cf109b8afbea687f69ef733efe46` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2020.002 — IPI (Portal NF-e) | v1.01 | `1b9f7d65e64df8f99c2f3636caf912943cb27c64f4f954ec2076a249bb71bc3e` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2020.004 — DANFE simplificado (Portal NF-e) | v1.10 | `f2c422ed3490793d674475a7edee7cfc34bd3819c4b880f2d3ae39c16a409f8a` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2020.005 — Regras de validação (Portal NF-e) | v1.21 | `3ce019a6ea73083d65a86123faa5ecb5ec4e76a32dd143e732079862682d7468` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2020.006 — Intermediador e marketplace (Portal NF-e) | v1.31 | `449c1816a67555082891be24f509c57b8e71096f3f8efaf9a71fcb79c2640600` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2020.007 — Evento ator interessado (transportador) (Portal NF-e) | v1.40 | `9394c3d8cef55c1a2e6e05b7811bc05cc1f4e66f5190308a1bc6f9c92792bf1f` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2021.001 — Evento comprovante de entrega (Portal NF-e) | v1.01 | `7a179b6af37e2cde32156ed30edf6d387447182daac2d06fe11687bc9b29be9b` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2021.002 — Nota Fiscal Fácil (Portal NF-e) | v1.12 | `a67d9e70cff61bdf6a0913bb5c7ca6b30d82332c0204d443e4671a8dd293d64e` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2021.003 — Validação do GTIN (Portal NF-e) | v1.50 | `28b7e26b1a515cdd8180084a71c6b8bf4eb6fa7745ecafba878fbeb75547b363` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2021.004 — Novos campos e regras (Portal NF-e) | v1.35 | `e33f067c25a024e3cddd99162baa337eaa7c090f4476c44af394059de3e3ae16` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2022.001 — Consulta GTIN (Portal NF-e) | v1.00 | `de3174af7330d510f8fa4ec6b9f44047086be761f978029c6fbb660376fb1a22` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2022.002 — Equiparação à exportação e outras alterações (Portal NF-e) | v1.30a | `45b96f11d192afafba1d061b4f08eb1047c2609a60b940217a8a37921348b54f` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2022.003 — Referenciamento (Portal NF-e) | v1.11 | `5eda1dbc0be00922e46972836fc81fa605772298ca6f80a96bac5210ba134e31` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2022.004 — Regras de validação do ISSQN (Portal NF-e) | v1.10 | `58c4bfdbb0878a8240024317f376df57da595aa6cf726ef175ee4f4a097ea05d` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2022.005 — DIFAL (Portal NF-e) | v1.11 | `e6f12d52ceafb77d366769db9b59fbb15b1600c1b2ed58face5d6fa16a3295db` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2023.001 — Tributação monofásica dos combustíveis (Portal NF-e) | v1.60 | `2b18d99fdb4989a12044cd491c176a2199ab19bb2462406a6ac03376b7701fe5` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2023.003 — CFOP na NFC-e (Portal NF-e) | v1.40 | `18b8ce0d3f5fdf46b32bce5588f9f7bef88e123b07ac3bb1adf855339971f7f8` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2023.004 — Campos e regras (Portal NF-e) | v1.20 | `1c6db64a5c32b176f8e60baf2ebbfed24632169ddfcd80632c1b5cc65b9ac71d` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2023.005 — Evento insucesso na entrega (Portal NF-e) | v1.02 | `ada7c7e3b7bd5e8d7ee5e2fdc4f5b8adb9f11b6d0fe449b6f97dbb366ac72a92` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2024.001 — Campos e regras (Portal NF-e) | v1.20 | `fc5e648cac11ed84e1107f273893776af2b9cfa748a0a5332748100e82e05b86` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2024.002 — IBS, CBS e Imposto Seletivo (Portal NF-e) | v1.10 | `48b7b5de92482866d6898ee4842218c436f123af16e78869021aa48f91f15c89` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2024.003 — Produtos agropecuários (Portal NF-e) | v1.10 | `d7609f48772db2ccbff6784b3e51a138433733ddff3deba84640622f82397966` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2026.001 — PAA (Portal NF-e) | v1.02b | `703310f95bff855aad9a4a7004515ce29ffff343334c53f0c45e9b32390296cd` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2026.002 — DANFE Simplificado Tipo 2, emissão off-line e autorização com alerta (Portal NF-e) | v1.11 | `72c033b2c7490710f61488a14d0bb3d7bb54e5345aa8d33d6ff2c270c228f046` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2026.003 — DANFE Simplificado Tipo 2 (Portal NF-e) | v1.00 | `2ef826027e0e8423ba9dc2f53ee7197f8bfdcc399a30459b72da977528600f13` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2026.006 — RTC: vinculação do pagamento (Portal NF-e) | v1.01 | `2c5770b54d19b66ff61200fad20d1a4373b71a48d42f0ee5e005e808ce0eb206` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2026.009 — Alteração da regra de CFOP I08-140 (só modelo 55) (Portal NF-e) | v1.00 | `50b7dec40bba8928b4d544feb4fdbd8c8bac16e37c99d926ddb2834cf246f15d` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | NT 2026.010 — DANFE RTC (Portal NF-e) | v1.00 | `eadc5246235f37a55f8140ddcf84595c8ce77f2d760f111f7b85ddf389b8f484` | [inventário NFC-e](regras/NFCE-ANEXO-I.md) |
| 2026-11-25 | Código de referência: ReceitaFederal/calculadora-rtc-regime-regular (GitHub, MIT; organização não verificada, provável oficial) | commit `def97056b799` (v1.7.2) | — | [doc 18](../architecture/18-referencia-receita-federal-rtc.md) |
| 2026-11-25 | Código de referência: ReceitaFederal/calculadora-rtc-simples-nacional (GitHub, MIT; provável oficial) | commit `a926d5a76095` | — | [doc 18](../architecture/18-referencia-receita-federal-rtc.md) |
| 2026-11-25 | Código de referência: ReceitaFederal/calculadora-rtc-gerador-danfse (GitHub, MIT; provável oficial) | commit `8d79e6b2f7fa` | — | [doc 18](../architecture/18-referencia-receita-federal-rtc.md) |
| 2026-11-25 | Portal Nacional da NFC-e (ENCAT) — URL por UF utilizada no QR Code (página) | consultada em 25/11/2026 | `0072a0c2bed372082ef7e4271c007e034f1206f3a9898318618043dea1273fe5` | Fase 3, [diagnóstico NFC-e PI](nfce-piaui-diagnostico.md) |
| 2026-11-25 | Portal da NFS-e — ANEXO_A-MUNICIPIO_IBGE-PAISES_ISO2-SNNFSe (Documentação Atual; a produção restrita não publica outro) | v1.00, 10/12/2025; 5.570 municípios, 250 países, 1 localidade geral | planilha: `238b715ab2dcc2c9e0857c44d69048e0af806b45ec8499568342de4a37f4419d`; tabela gerada: `b63167d29b9310c39d9e4bdaa8f455129a718f6557cb9e82c289f09ebf0edd69` | `resources/fiscal/nfse-anexo-a/`, ADR-0060 (E0246, E0299, E0302, E0304). Sem o 5101837 e com 17 nomes antigos em relação ao IBGE |
| 2026-11-25 | IBGE — API de localidades, `servicodados.ibge.gov.br/api/v1/localidades/municipios` | 5.571 municípios | resposta: `cf005d0277172793bc3c3409a926aeae307dff6a3468d75c7edf8ffb7b49cf7a`; tabela gerada: `6dfec29b829d7711d1474a1d0734a37b1514f0a4050c033df64dc1e2b6d7acc1` | `resources/fiscal/ibge/`, ADR-0057 (nome e UF do município no DANFSe; base para o A15) |
| 2026-11-16 | Prefeitura de Teresina/SEMF — "Relatório Atividade" (tabela CNAE × código de tributação), botão "Consultar PDF" do portal (`/notafiscal-ws/servico/notafiscal/tabelaatividade`) | emitido em 16/11/2026, 178 páginas | `976d6c8d879cc857789aef07c16bead93d85839356a9a128ca7493a224e9865d` | ADR-0039: o "código de tributação" de 9 dígitos é cTribNac (6) + cTribMun (3); pares de teste da DSF |

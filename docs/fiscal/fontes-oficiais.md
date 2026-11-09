# Registro de fontes oficiais

Regra do projeto: nenhuma regra, endpoint, schema ou código fiscal entra no código sem
uma linha aqui (ou em `regras/<id>.md`) com **fonte oficial, versão, data de consulta e
hash do arquivo** quando houver download.

## Fontes a consultar (início de cada fase)
| Tema | Fonte oficial | Status |
|---|---|---|
| NFS-e Nacional — manuais, leiautes, APIs, ambientes | Portal NFS-e (gov.br/nfse) — documentação técnica do Sistema Nacional NFS-e | **a consultar na Fase 2** |
| Adesão do município-piloto ao padrão nacional | Portal NFS-e (painel de municípios aderentes) + prefeitura | a consultar |
| NF-e / NFC-e — MOC, leiaute 4.00, NTs, XSDs, webservices por UF | Portal Nacional da NF-e (nfe.fazenda.gov.br) | a consultar nas Fases 3/4 |
| Reforma Tributária nos DF-e (IBS/CBS/IS) | NTs da RTC no Portal NF-e; LC 214/2025; documentação NFS-e | a consultar |
| CNPJ alfanumérico | IN RFB nº 2.229/2024 + NT DF-e correspondente | a consultar |
| NFC-e da UF de operação (contingência, QR Code, CSC) | Portal da SEFAZ da UF | a consultar |
| Prazo de guarda de documentos | CTN (decadência/prescrição) + orientação do contador | a confirmar |
| ICP-Brasil (cadeia de certificados) | ITI — repositório de ACs | a consultar |

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

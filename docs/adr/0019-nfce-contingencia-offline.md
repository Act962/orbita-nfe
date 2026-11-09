# ADR-0019 — NFC-e Piauí: motor central primeiro, contingência local (NERP/Tauri) preparada

- Status: **Aceito** (direção) · Data: 2026-11-09

## Contexto
Primeira UF da NFC-e: Piauí. O NERP terá versão desktop/offline com Tauri. Contingência offline exige emissão no próprio PDV quando não há conexão.

## Decisão
1. Fase 3 implementa e valida **somente o motor central** para NFC-e na SEFAZ-PI (regras, autorizador e contingência conforme MOC/NT e normas da SEFAZ-PI vigentes — a confirmar).
2. A arquitetura fica **preparada** para a contingência local:
   - `shared/domain`, `dfe-sefaz/domain` e `nfce/domain` sem dependências de Node, banco ou rede (código portável);
   - séries de contingência dedicadas por PDV previstas no modelo de `DocumentSeries`;
   - contrato de sincronização (PDV → motor) desenhado na Fase 3, implementado só na Fase 3b.
3. **Fase 3b** (após validação do motor central em produção): agente local. Como o Tauri usa Rust no backend, o agente pode ser um *sidecar* Node empacotado ou uma reimplementação — decidir com o time do NERP. A proteção do certificado/CSC no desktop exige ADR próprio.

## Consequências
Sem trabalho de contingência local antes de o motor central estar validado, sem impedir sua implementação depois.

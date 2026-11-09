# ADR-0017 — NFS-e: piloto Teresina/PI, API Nacional primeiro, roteamento por regime

- Status: **Aceito** (direção) · Data: 2026-11-09 · Município definido pelo responsável: Teresina/PI

## Contexto
- ME/EPP do Simples Nacional devem emitir pelo Emissor Nacional (web ou API) desde 01/11/2026 (Res. CGSN 189/2026 e 191/2026 — texto a ler na íntegra).
- Teresina mantém emissor municipal próprio para os demais casos (art. 62 da LC 214/2025, segundo fontes secundárias), com locação de bens temporariamente no ambiente nacional (Portaria SEMF 20/2026 — ler na íntegra).
- Investigação completa: [docs/fiscal/nfse-teresina.md](../fiscal/nfse-teresina.md).

## Decisão
1. O domínio NFS-e modela o **padrão nacional** (DPS → NFS-e, eventos).
2. **Regra de roteamento versionada** (município + regime + tipo de serviço + vigência + fonte) decide o adapter na aceitação do documento e fica gravada nele.
3. **Fase 2a**: adapter Sefin Nacional (API DPS) para ME/EPP do Simples em Teresina.
4. **Fase 2b**: adapter do emissor municipal de Teresina, somente depois de obter o manual oficial do webservice junto à SEMF.
5. Desenvolvimento com dados fictícios; validação oficial em produção restrita exige CNPJ e certificado ICP-Brasil reais (conteúdo das notas continua fictício).

## Consequências
A mudança de Teresina (adesão, IBS/CBS no emissor local) vira alteração de dados de roteamento, não de código de domínio.

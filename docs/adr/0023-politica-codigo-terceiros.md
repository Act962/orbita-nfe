# ADR-0023 — Política de uso de código e bibliotecas de terceiros

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Contexto
Existem projetos abertos de NF-e/NFS-e (avaliação em [fiscal/avaliacao-repositorios.md](../fiscal/avaliacao-repositorios.md)). O motor é de uso comercial e terá um componente distribuído (agente NERP/Tauri, Fase 3b).

## Decisão
1. **Licenças**: GPL/AGPL nunca como dependência nem com código copiado. LGPL: somente como referência de leitura (sem copiar trechos). MIT/Apache-2.0/BSD/ISC: permitidas com atribuição em `THIRD_PARTY_NOTICES.md`.
2. **Licença ambígua ou conflitante** = tratada como a mais restritiva.
3. **Revisão de segurança obrigatória** antes de adotar qualquer dependência no caminho fiscal: sem `rejectUnauthorized: false`, sem certificado/XML em disco temporário, sem execução de binários externos com segredos, mantida ativamente.
4. **Fatos fiscais** (URLs, códigos, leiautes, comportamentos) aprendidos com terceiros só entram depois de confirmados em fonte oficial e registrados em `fontes-oficiais.md`.
5. Verificação automática de licenças no CI (ex.: `license-checker` com allowlist).

## Consequências
Mais código próprio no núcleo fiscal (geração, assinatura, transporte), em troca de controle total, segurança e liberdade de distribuição.

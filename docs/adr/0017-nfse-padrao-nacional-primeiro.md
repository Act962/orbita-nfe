# ADR-0017 — NFS-e: piloto em Teresina/PI pela SEFIN Nacional

- Status: **Aceito**
- Data: 2026-11-09, revisado em 2026-11-10 após o [diagnóstico das APIs](../fiscal/nfse-teresina-api-municipal-x-nacional.md)
- Aprovação: responsável, em 2026-11-10
- Município definido pelo responsável: Teresina/PI (IBGE 2211001)

## Contexto
- A **Res. CGSN nº 191/2026** alterou o art. 59 da Res. CGSN 140/2018: a ME/EPP optante pelo Simples "utilizará, obrigatoriamente, a NFS-e de padrão nacional, emitida pelo Emissor Nacional da NFS-e" (web ou API). A regra vale a partir de **01/11/2026**.
- A notícia do Portal NFS-e de 29/10/2026 define que o critério é a **data de competência**:
  - competência a partir de 01/11/2026: somente o Emissor Nacional, mesmo em município com emissor próprio, e o município deve bloquear a emissão;
  - competência anterior: o emissor municipal continua autorizando, e o Emissor Nacional barra as retroativas.
- Situação de Teresina na planilha oficial de 28/09/2026: **conveniado ativo**, aderente ao Ambiente de Dados Nacional (ADN) e **não** aderente ao Emissor Nacional.
- Teresina tem emissor próprio, operado pela DSF, que segue o leiaute e o contrato de API do padrão nacional: Guia de Utilização da API THE V7, de 20/08/2026.
- A carteira de clientes do responsável hoje está toda em Teresina.

## Decisão
1. O domínio de NFS-e modela o **padrão nacional**: DPS → NFS-e, mais eventos.
2. **Fase 2a:** um único canal de integração, a **API da SEFIN Nacional**. Ela atende MEI e ME/EPP do Simples de Teresina e de qualquer outro município.
3. O canal é decidido na aceitação do documento pela **regra de roteamento por competência** ([ADR-0028](0028-roteamento-nfse-por-competencia.md)) e fica gravado nele.
4. **Fase 2b**, condicionada à demanda: adapter da API municipal de Teresina (DSF), para clientes de Lucro Presumido ou Real e para competências anteriores a 11/2026. O contrato oficial já existe (Guia V7), e o adapter reaproveita o cliente do padrão nacional ([ADR-0029](0029-transmissao-reconciliacao-padrao-nacional.md)). A prioridade da 2b depende do perfil de regime dos clientes, que o responsável vai levantar.
5. Desenvolvimento com dados fictícios. A validação oficial na produção restrita exige CNPJ e certificado ICP-Brasil reais, com conteúdo de nota fictício.

## Alternativas consideradas
- **Começar pela API municipal de Teresina.** Rejeitada: é proibida para a ME/EPP do Simples em competências novas, e a documentação é mais rasa.
- **Começar por outro município ou documento** (NFC-e). Rejeitada: Teresina continua válida (a nota é de Teresina, só o autorizador é nacional), e a NFC-e é mais complexa.
- **Implementar os dois canais desde já.** Rejeitada: não há caso de uso agora, e dobraria a superfície de teste.

## Consequências
- O primeiro adapter serve ao país inteiro para MEI e ME/EPP do Simples.
- Mudanças em Teresina (adesão ao Emissor Nacional, por exemplo) viram alteração de dados de roteamento, não de código de domínio.
- Notas com competência anterior a 11/2026 não são emitidas pelo motor enquanto a Fase 2b não existir. Elas recebem rejeição de negócio explicada.

## Fontes
- Diagnóstico: [nfse-teresina-api-municipal-x-nacional.md](../fiscal/nfse-teresina-api-municipal-x-nacional.md), com links, versões e hashes.
- Registro das consultas: [fontes-oficiais](../fiscal/fontes-oficiais.md).

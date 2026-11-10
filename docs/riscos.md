# Riscos e dificuldades

Escala: Impacto (A/M/B) × Probabilidade (A/M/B).

| ID | Risco | I | P | Mitigação |
|---|---|---|---|---|
| R-01 | **Emissão duplicada** após falha de comunicação | A | A | estado `UNKNOWN`, consulta antes de retransmitir, XML/chave reutilizados, constraints únicas, testes de falha pós-envio |
| R-02 | **Determinação tributária** entrar no escopo sem estrutura (CST, alíquotas, benefícios por UF/município) | A | A | ADR-0018: motor valida e emite; quem determina é o cliente/contador. Contexto "Tax Determination" só com projeto próprio |
| R-03 | **Reforma Tributária** (IBS/CBS/IS): leiautes e regras mudando durante 2026–2033 | A | A | versionamento de regras/leiautes por documento; acompanhar NTs da RTC; campos IBS/CBS desde o primeiro leiaute de cada modalidade; nunca reprocessar documento histórico com regra nova |
| R-04 | **Heterogeneidade municipal da NFS-e** e grau real de adesão ao padrão nacional | A | M | piloto em um município confirmado oficialmente; adapters municipais só sob demanda |
| R-05 | **Vazamento de certificado A1** = possibilidade de emissão fraudulenta em nome do cliente | A | B | envelope encryption + KMS, acesso só do worker, auditoria, redaction, revisão de segurança antes da produção |
| R-06 | Diferenças de comportamento entre SEFAZ (URLs, síncrono/assíncrono, limites, contingência) | M | A | registry versionado por UF, suíte de contrato por UF, começar por uma única UF |
| R-07 | **NFC-e offline**: PDV sem internet não alcança motor em nuvem | A | A | decisão na Fase 3 (ADR-0019): agente local no NERP reutilizando o domínio NFC-e portável; certificado na borda tem implicações de segurança |
| R-08 | Assinatura XML (canonicalização, referência, algoritmos exigidos) e PKCS#12 em Node | M | M | spike na Fase 1 com verificação independente (`xmlsec1`) e XMLs oficiais |
| R-09 | Mudança frequente de NTs/XSDs e prazos de entrada em produção | M | A | rotina de acompanhamento (responsável + checklist mensal), schemas versionados, testes de regressão |
| R-10 | **CNPJ alfanumérico** (IN RFB 2.229/2024, a partir de jul/2026) afetando validações, chave de acesso e leiautes | M | A | VO `Cnpj` suporta os dois formatos desde o dia 1; verificar NT específica de DF-e |
| R-11 | Obrigação de guarda (prazo decadencial/prescricional) e perda de XMLs | A | B | S3 versionado + Object Lock + replicação/backup, hash no banco, testes de restauração |
| R-12 | Mocks divergindo do comportamento real | M | M | suíte de contrato contra homologação, fake ajustado a partir de capturas reais |
| R-13 | Consumo indevido/bloqueio pela SEFAZ por consultas repetidas | M | M | rate limit no reconciliador, backoff, circuit breaker |
| R-14 | Responsabilidade legal: erros de emissão afetam clientes reais | A | M | homologação extensa, piloto com uma empresa, checklist de go-live com contador, feature flags por empresa |
| R-15 | Escopo grande para equipe pequena | A | A | roadmap faseado, uma modalidade/UF/município por vez, critérios de saída claros |
| R-16 | Relógio do servidor fora de sincronia → rejeições | B | M | NTP monitorado, alerta de drift |
| R-17 | **VPS única** (ponto único de falha) | A | M | backup WAL contínuo externo, RPO ≤ 5 min / RTO ≤ 4 h, teste mensal de restauração, artefatos fora da VPS |
| R-18 | Administrador da VPS/Coolify é a raiz de confiança dos certificados | A | B | 2FA, acesso restrito, KEK só no worker-fiscal, evolução para KMS gerenciado |
| R-19 | Teresina com dois caminhos (nacional × municipal) e regras em transição | M | A | roteamento versionado por regime/serviço/vigência; Fase 2b só com manual oficial |
| R-20 | Produção restrita exige CNPJ e certificado reais | M | A | usar CNPJ próprio com dados de nota fictícios; planejar com antecedência |
| R-21 | Empresas Simples já obrigadas desde 01/11/2026 antes do motor ficar pronto | A | A | manter Emissor Nacional web/solução atual até o go-live |
| R-22 | Transferência internacional de dados (S3 fora do Brasil) — LGPD | M | M | parecer jurídico; alternativa com região Brasil |
| R-23 | Desenvolvedor único (conhecimento concentrado, disponibilidade) | A | M | ADRs, runbooks, testes como documentação, gates com especialista |
| R-24 | **Novo leiaute da DPS (NT 009)**: segundo comunicado CGNFS-e de 20/10/2026 citado por terceiro, entra em produção em 01/12/2026 (anterior válido até 30/11/2026) | A | A | **confirmar no portal oficial**; implementar a Fase 2a já no leiaute novo; XSDs com hash; versionamento de leiaute por documento (ADR-0013) |
| R-25 | Dependência de bibliotecas fiscais de terceiros com licença GPL ou práticas inseguras | A | M | ADR-0023: núcleo fiscal próprio, allowlist de licenças no CI |
| R-26 | Limites de série/número confirmados só em fontes secundárias (SERIES-001: faixas reservadas 890–999 conflitantes; SERIES-002 provisória) | M | A | conferir XSD/MOC oficiais antes das Fases 2a e 3; regras marcadas como provisórias |
| R-28 | Mudança dos OIDs do SubjectAltName dos certificados ICP-Brasil (fonte secundária cita eliminação de OIDs em 31/12/2028) quebraria a leitura do CNPJ do titular | M | B | **confirmar no DOC-ICP-04 vigente**; leitura do CNPJ isolada em `extractIcpBrasilCnpj` com testes |
| R-29 | Bundle oficial de ACs raiz ICP-Brasil ainda não carregado; sem LCR/OCSP, certificado revogado pela AC continua aceito | A | M | carregar bundle do ITI com hash antes da produção restrita (Fase 2a); revogação por LCR/OCSP como item da Fase 2a |
| R-27 | Pepper das API keys perdido ou vazado (perda invalida todas as chaves; vazamento + dump do banco permite ataque offline) | B | A | arquivo só nos containers que precisam; backup no cofre do Coolify; runbook credenciais-api.md |

## Dúvidas fiscais/técnicas abertas (precisam de documentação oficial)
1. ~~Município-piloto~~ → Teresina/PI definido. Pendente: confirmações oficiais listadas em [fiscal/nfse-teresina.md](fiscal/nfse-teresina.md) §6.
2. Composição exata do identificador da DPS, regras de numeração de DPS e tratamento de lacunas na NFS-e Nacional — manual do contribuinte/desenvolvedor NFS-e Nacional vigente.
3. Prazos e condições de cancelamento/substituição de NFS-e no padrão nacional e no município-piloto.
4. NT vigente da Reforma Tributária para NF-e/NFC-e (grupos IBS/CBS/IS) e para NFS-e, e o que é obrigatório em 2026/2027.
5. NT sobre CNPJ alfanumérico em DF-e (impacto na chave de acesso).
6. Regras de contingência NFC-e da UF de operação (Piauí? confirmar), prazo de transmissão posterior, versão de QR Code vigente.
7. Algoritmos de assinatura exigidos atualmente por cada leiaute (confirmar no MOC/manual vigente, não em tutoriais).

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
| R-17 | **VPS única** (ponto único de falha) | A | M | backup WAL contínuo externo (WAL-G cifrado), RPO ≤ 5 min / RTO ≤ 4 h, teste mensal de restauração (`npm run drill:backup`, primeiro OK local em 2026-11-11), artefatos fora da VPS. **Pendente:** exercício no provedor real |
| R-18 | Administrador da VPS/Coolify é a raiz de confiança dos certificados | A | B | 2FA, acesso restrito, KEK só no worker-fiscal, evolução para KMS gerenciado |
| R-19 | Teresina com dois caminhos (nacional × municipal) e regras em transição | M | A | roteamento versionado por regime/serviço/vigência; Fase 2b só com manual oficial |
| R-20 | Produção restrita exige CNPJ e certificado reais | M | A | usar CNPJ próprio com dados de nota fictícios; planejar com antecedência |
| R-21 | Empresas Simples já obrigadas desde 01/11/2026 antes do motor ficar pronto | A | A | manter Emissor Nacional web/solução atual até o go-live |
| R-22 | Transferência internacional de dados (S3 fora do Brasil) — LGPD | M | M | parecer jurídico; alternativa com região Brasil |
| R-23 | Desenvolvedor único (conhecimento concentrado, disponibilidade) | A | M | ADRs, runbooks, testes como documentação, gates com especialista |
| R-24 | **Leiaute da DPS em transição (NT 009)**. Atualização de 2026-11-10: a produção restrita já usa o pacote XSD de 20/10/2026, diferente do de produção (09/02/2026), e os itens da NT 009 para o Simples ainda não estão em nenhum XSD. A data de entrada em produção (01/12/2026, segundo terceiro) **segue não confirmada** | A | A | os dois pacotes estão versionados com hash e manifesto (ADR-0013, complemento); seleção de schema por ambiente e data; acompanhar a página de comunicados de implantação do gov.br/nfse |
| R-25 | Dependência de bibliotecas fiscais de terceiros com licença GPL ou práticas inseguras | A | M | ADR-0023: núcleo fiscal próprio, allowlist de licenças no CI |
| R-26 | Limites de série/número confirmados só em fontes secundárias (SERIES-001: faixas reservadas 890–999 conflitantes; SERIES-002 provisória) | M | A | conferir XSD/MOC oficiais antes das Fases 2a e 3; regras marcadas como provisórias |
| R-28 | Mudança dos OIDs do SubjectAltName dos certificados ICP-Brasil (fonte secundária cita eliminação de OIDs em 31/12/2028) quebraria a leitura do CNPJ do titular | M | B | **confirmar no DOC-ICP-04 vigente**; leitura do CNPJ isolada em `extractIcpBrasilCnpj` com testes |
| R-29 | Bundle oficial de ACs raiz ICP-Brasil ainda não carregado; sem LCR/OCSP, certificado revogado pela AC continua aceito | A | M | carregar bundle do ITI com hash antes da produção restrita (Fase 2a); revogação por LCR/OCSP como item da Fase 2a |
| R-27 | Pepper das API keys perdido ou vazado (perda invalida todas as chaves; vazamento + dump do banco permite ataque offline) | B | A | arquivo só nos containers que precisam; backup no cofre do Coolify; runbook credenciais-api.md |
| R-30 | ME/EPP de Teresina com `regApTribSN` 2 ou 3 (sublimite ultrapassado) não tem exceção textual na regra E0039. Pela Res. CGSN 191 ela também é obrigada ao Emissor Nacional, mas o autorizador poderia rejeitar | M | A | contador confirma o enquadramento da empresa-piloto; a linha fica "a confirmar" na tabela do ADR-0028; testar em produção restrita |
| R-31 | Algoritmos da assinatura da DPS (RSA-SHA1, C14N) documentados só pela DSF/Teresina, não pela SEFIN | M | M | perfil de assinatura provisório (ADR-0014, complemento); confirmar na primeira DPS em produção restrita |
| R-32 | Conflito normativo: a Portaria SEMF 20/2026 diz que o emissor municipal é "obrigatório e exclusivo" para o ISSQN, e a Res. CGSN 191/2026 manda ME/EPP do Simples para o Emissor Nacional | M | M | o motor segue a Res. 191 e o Portal NFS-e (ADR-0028); pedir posição escrita da SEMF; decisão jurídica fica com o contador |
| R-33 | Swagger da SEFIN acessível só com certificado de cliente: prefixo de caminho, nome do campo do envelope e schema de erro ainda não confirmados | A | M | valores só no perfil de endpoint e no simulador, marcados como provisórios (ADR-0029); ler o Swagger com o A1 real antes de implementar o adapter |
| R-34 | Corrente diária de âncora de uma empresa para se o job morrer dois dias seguidos (falha prolongada do bucket) | B | M | Agendamento do dia seguinte antes de gravar, 24 tentativas por job, runbook manda reprocessar mortos `audit.anchor-*` (ADR-0031). Evoluir: alerta de fila morta |
| R-36 | XSD oficial de produção da NFS-e (1.01-20260209) recusa qualquer série na libxml2 (`^`/`$` em `TSSerieDPS`); a errata XSD-ERRATA-001 pode divergir do validador do autorizador | B | M | Errata mínima, presa ao hash e com teste do defeito (ADR-0013); o pacote de produção restrita já corrigiu; confirmar no primeiro envio aceito e retirar quando o pacote de produção mudar |
| R-37 | ~~Resolução manual de `UNKNOWN` e alertas por idade~~ **mitigado em 2026-11-12** (ADR-0034). Resta: a assinatura da SEFIN no XML trazido pelo operador não é verificada, e os alertas são log, sem métrica | B | B | XSD, Id da DPS, ambiente e assinatura da nossa DPS conferidos; XML só do portal oficial (runbook nfse-unknown). Verificar a assinatura da SEFIN junto com o adapter |
| R-39 | MEI em Teresina com competência anterior a 11/2026: a tabela do ADR-0028 tem duas linhas com canais diferentes (nacional e municipal) e não define precedência | B | M | O motor recusa com `ROUTE_AMBIGUOUS` em vez de escolher. Confirmar com a SEMF e o contador e ajustar a tabela |
| R-38 | `dhEmi` enviado em horário de Brasília (UTC−03:00) para todo emitente; o fuso esperado pela SEFIN para outros fusos não está documentado | B | M | Piloto em Teresina (UTC−03:00); confirmar na produção restrita (ADR-0033 item 4) antes de clientes em outros fusos |
| R-35 | Comportamento do Coolify com o container one-shot `migrate` e com o login no GHCR não confirmados num painel real | M | B | Runbook deploy-coolify marca os passos "(conferir no Coolify)"; alternativa de comando de pré-deploy documentada |

## Dúvidas fiscais/técnicas abertas (precisam de documentação oficial)
1. ~~Município-piloto~~ → Teresina/PI definido. Pendente: confirmações oficiais listadas em [fiscal/nfse-teresina.md](fiscal/nfse-teresina.md) §6.
2. Composição exata do identificador da DPS, regras de numeração de DPS e tratamento de lacunas na NFS-e Nacional — manual do contribuinte/desenvolvedor NFS-e Nacional vigente.
3. Prazos e condições de cancelamento/substituição de NFS-e no padrão nacional e no município-piloto.
4. NT vigente da Reforma Tributária para NF-e/NFC-e (grupos IBS/CBS/IS) e para NFS-e, e o que é obrigatório em 2026/2027.
5. NT sobre CNPJ alfanumérico em DF-e (impacto na chave de acesso).
6. Regras de contingência NFC-e da UF de operação (Piauí? confirmar), prazo de transmissão posterior, versão de QR Code vigente.
7. Algoritmos de assinatura exigidos atualmente por cada leiaute (confirmar no MOC/manual vigente, não em tutoriais).

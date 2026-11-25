# ADR-0068 — Raiz ICP-Brasil v10 versionada para o TLS do SVRS (NFC-e)

- Status: **Aceito** · Data: 2026-11-25
- Relacionados:
  - ADR-0063 (status do serviço; corrige a afirmação sobre a cadeia TLS);
  - ADR-0064 (consulta pela chave);
  - ADR-0022 (transporte mTLS, `serverTrustPem`);
  - [infraestrutura](../architecture/15-infraestrutura.md) ("bundle de ACs ICP-Brasil versionado por endpoint; nunca `rejectUnauthorized: false`");
  - risco R-29.

## Contexto
O primeiro teste real do status do serviço no terminal do responsável (25/11/2026) terminou em `TRANSPORT / NOT_SENT / UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, já na leitura do WSDL. Nenhum dado saiu.

O que o diagnóstico mostrou:
- **A cadeia do SVRS:** o servidor apresenta `*.svrs.rs.gov.br` → AC SERPRO SSLv1 → **AC Raiz Brasileira v10** (ICP-Brasil). A mesma cadeia aparece em homologação e em produção.
- **A raiz v10 não está no repositório padrão do Node,** que vem da Mozilla. Ela está, porém, no repositório de raízes do Windows.
- **Por que o ADR-0063 se enganou:** o ambiente em que ele foi escrito tinha `NODE_USE_SYSTEM_CA` ligado, e com isso o Node usava as raízes do Windows. Esse ambiente não é o do responsável, nem o da VPS.

## Decisão
1. **A raiz fica versionada** em `resources/fiscal/trust/icp-brasil/ac-raiz-icp-brasil-v10.pem`. O `MANIFEST.json` guarda:
   - o SHA-256 do arquivo;
   - a impressão digital SHA-256 do certificado;
   - o titular, a validade e a origem;
   - o endereço oficial do ITI.
2. **Conferência na carga** (`loadServerTrust`). O arquivo é recusado se:
   - o hash for diferente do MANIFEST;
   - não for uma AC raiz autoassinada;
   - a data estiver fora da validade.
3. **Âncora única para o SVRS:** o agente mTLS da NFC-e recebe essa raiz em `serverTrustPem`, que vira o `ca` do TLS. Com isso, **só** a cadeia ICP-Brasil v10 é aceita para esse endpoint. A verificação continua ligada.
4. **A SEFIN Nacional não muda.** A cadeia dela já é aceita pelo repositório padrão do Node, como mostraram os envios de 13/11 e 16/11.

## Origem do certificado
- **De onde veio:** exportado sem alteração do repositório de raízes do Windows (Microsoft Trusted Root Program), com impressão digital SHA-256 `6E:0B:FF:06:…:74:89:F6`.
- **O que diz o ITI:** a página oficial (repositório AC-Raiz) lista o arquivo `ICP-Brasilv10.crt`, mas não publica a impressão digital no texto.
- **Pendente:** comparar com o arquivo oficial do ITI. O download espera a autorização do responsável.

## Resultado
Os dois testes rodaram no terminal do responsável, em 25/11/2026, com o A1 da empresa de teste, em homologação.

| Teste | Resposta | O que confirma |
|---|---|---|
| Status do serviço (`cUF=22`) | **cStat 107** "Servico em Operacao", `verAplic` SVRSnfce202401251654 | O SVRS atende o PI (regra K02: senão viria 289). Funcionam o mTLS com o A1, a leitura do WSDL e a validação da resposta no XSD. |
| Consulta de uma chave válida e inexistente | **cStat 217** "NF-e nao consta na base de dados da SEFAZ", lida como `NOT_FOUND` | Funcionam a consulta pela chave (ADR-0064) e a leitura da situação. |

## Consequências
- O ADR-0063 fica corrigido na frase sobre a cadeia TLS.
- **Quando trocar a raiz:** se o SVRS mudar de cadeia ou a raiz v10 vencer (01/07/2032), a conexão falha antes de enviar qualquer coisa (`NOT_SENT`). A correção é um arquivo novo no MANIFEST, nunca desligar a verificação.
- **R-29 andou:** o bundle da ICP-Brasil começa por esta raiz, usada só no TLS do servidor. A validação da cadeia do certificado **do cliente** (ADR-0009) continua pendente.

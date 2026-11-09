# Avaliação de repositórios de terceiros

Data: 2026-11-09 · Método: metadados via GitHub API + clone raso e leitura de código (nada executado).

## Resumo

| Repositório | Linguagem | Licença | Última atividade | Escopo | Veredito |
|---|---|---|---|---|---|
| [nfephp-org/sped-nfe](https://github.com/nfephp-org/sped-nfe) | PHP | LGPL-3.0 no arquivo; composer lista LGPL-3.0 / GPL-3.0 / MIT | 05/11/2026 · ~1,6 mil estrelas | NF-e/NFC-e completa | **Referência principal para as Fases 3/4** (consulta e oráculo de testes, sem copiar código) |
| [kursku/emissor-nfse](https://github.com/kursku/emissor-nfse) | TypeScript | MIT (mas depende de lib GPL-3.0) | 26/10/2026 | NFS-e Nacional, uso individual | **Referência valiosa para a Fase 2a** |
| [kalmonv/node-sped-nfe](https://github.com/kalmonv/node-sped-nfe) | TypeScript | **conflito**: LICENSE = LGPL-3.0, package.json = MIT | 04/05/2026 | port de sped-nfe para Node | **Não usar como dependência**; consulta pontual |
| [mazinsw/nfe-api](https://github.com/mazinsw/nfe-api) | PHP | MIT | 28/08/2024 | NF-e/NFC-e | Baixo valor (anterior à Reforma Tributária) |
| [LukasMeine/emissor-nota-fiscal](https://github.com/LukasMeine/emissor-nota-fiscal) | PHP (Phalcon) | MIT | 03/10/2019 | wrapper HTTP sobre sped-nfe | Sem valor para o projeto |

**Conclusão**: nenhum deles serve como base ou dependência do motor (linguagem, licença, arquitetura de usuário único ou problemas de segurança). Dois são **muito úteis como referência**: `emissor-nfse` agora e `sped-nfe` nas fases SEFAZ. Nada substitui a fonte oficial: o que aprendermos com eles entra no projeto **somente depois de confirmado** na documentação oficial (regra do projeto).

## 1. nfephp-org/sped-nfe
**O que tem de útil**
- Projeto maduro e ativo, mantido pela comunidade há anos, já com pacotes de schema `PL_010` (incluindo versões da Reforma Tributária) em `schemes/`.
- Dados prontos para **conferência cruzada**: `storage/autorizadores.json` (UF → autorizador por modelo; ex.: NFC-e do PI aparece como SVRS), `wsnfe_4.00_mod55.xml` / `mod65.xml` (URLs de webservices), `cstat.json` (códigos de retorno), `uri_consulta_nfce.json` (URLs de consulta do QR Code).
- Pasta `fake/` com respostas simuladas da SEFAZ (cancelamento, cancelamento por substituição, CC-e, etc.): excelente fonte de **casos de teste** para o nosso simulador.
- Testes PHPUnit cobrindo montagem, assinatura, IBS/CBS.

**Limites**
- PHP: não dá para usar como biblioteca no nosso motor Node.
- Licença: tratar como LGPL-3.0 por precaução. Ler e aprender é livre; **copiar trechos** para o nosso código tornaria parte dele obra derivada. Usaremos como referência e oráculo, reimplementando a partir da documentação oficial.
- Dados (URLs, autorizadores): úteis para conferir os nossos, mas a fonte da verdade continua sendo o Portal Nacional da NF-e.

**Uso proposto**: na Fase 3 (NFC-e PI), comparar URLs, autorizador e comportamentos com o sped-nfe; transformar os cenários de `fake/` em casos do nosso simulador.

## 2. kursku/emissor-nfse
**O que tem de útil** (o mais próximo da nossa Fase 2a)
- Emissor de NFS-e pelo **padrão nacional (Sefin)**, em TypeScript, com testes (`node --test`) e ADRs.
- ADR `0007` documenta, com links oficiais e **hashes SHA-256 dos XSDs**, a mudança de leiaute da DPS da **NT 009**: segundo o comunicado CGNFS-e de 20/10/2026 citado ali, o novo leiaute está em produção restrita desde 20/10/2026 e **entra em produção em 01/12/2026**, com o anterior válido até 30/11/2026. Isso afeta diretamente a nossa Fase 2a (ver R-24).
- Pontos práticos já descobertos: chave de acesso da NFS-e com **50 dígitos**, códigos de erro no formato `E0000`, reordenação de campos exigida pelo XSD novo, `finNFSe` em `infDPS`.
- Estado `a_verificar` com conciliação manual: a mesma ideia do nosso `UNKNOWN` (confirma a necessidade).
- `certs/ca_bundle.crt` para TLS com os servidores oficiais (confirma a decisão do doc 15 de usar bundle próprio).
- `NOTICE.md` com aviso de responsabilidade fiscal — bom modelo para o nosso.

**Limites**
- Ferramenta de **usuário único** (SQLite local, CLI, painel), sem multiempresa, sem fila persistente de servidor, sem separação de privilégios.
- Depende de `@nfewizard/nfse` e `@nfewizard/shared`, ambos **GPL-3.0**, aplicando *patches* manuais neles. Para nós, dependência GPL é inaceitável: o agente local NERP/Tauri (Fase 3b) seria distribuído e obrigaria abrir todo o código. A `@nfewizard/shared` ainda puxa dependências como `soap`, `axios`, `pem` (OpenSSL por linha de comando) e `sha1`.
- Código MIT do próprio repositório pode ser adaptado com atribuição, mas a parte que importa (montagem/assinatura da DPS) está na lib GPL.

**Uso proposto**: na Fase 2a, ler as ADRs e os testes como mapa de armadilhas reais; conferir cada ponto no portal gov.br/nfse; nunca depender do `@nfewizard`.

## 3. kalmonv/node-sped-nfe
**O que tem de útil**: port do sped-nfe para Node, cobre NF-e e NFC-e (eventos, inutilização, distribuição), traz PL_010b v1.30 e a NT 2025.002 v1.30 (RTC). Pode servir para ver o formato de envelopes SOAP em Node.

**Por que não usar** (problemas encontrados no código):
- `rejectUnauthorized: false` em várias chamadas à SEFAZ (`src/utils/tools.ts`): **desliga a verificação TLS**, expondo a ataques de interceptação. Viola diretamente o doc 15.
- Grava XML em arquivo temporário (`tmp.fileSync`, modo 0644) e usa `pem` (OpenSSL por linha de comando) para abrir o PFX: o certificado passa por disco/processo externo. Viola o doc 13.
- Sem testes automatizados.
- Licença ambígua (LGPL no arquivo × MIT no package.json).
- Arquivos muito grandes (`extras.ts` com mais de 6 mil linhas) e dependência `crypto` do npm (pacote obsoleto, não é o módulo nativo).

## 4. mazinsw/nfe-api
PHP, MIT, sem atividade desde 08/2024: anterior às NTs da Reforma Tributária. Só como leitura histórica.

## 5. LukasMeine/emissor-nota-fiscal
Wrapper HTTP de 2019 sobre o sped-nfe em Phalcon. Nenhum valor para o projeto.

## Política adotada (ADR-0023)
Licenças GPL/AGPL não entram como dependência; LGPL só como referência; MIT/Apache/BSD podem ser usadas com atribuição, desde que passem pela revisão de segurança; qualquer fato fiscal aprendido com terceiros só vale depois de confirmado em fonte oficial.

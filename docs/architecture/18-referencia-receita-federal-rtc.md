---
title: Repositórios da Receita Federal (Calculadora RTC e gerador de DANFSe) como referência
status: current
last_updated: 2026-11-25
---

# Repositórios da Receita Federal como referência

Lidos em 25/11/2026, por indicação do responsável, sem executar nada. Código de referência, não norma: quando divergem da NT ou da lei, vale a norma.

| Repositório | Commit lido | Linguagem | Licença |
|---|---|---|---|
| [calculadora-rtc-regime-regular](https://github.com/ReceitaFederal/calculadora-rtc-regime-regular) | `def97056b799` (25/11/2026), versão 1.7.2 | Java 25, Spring Boot 4.1, SQLite | MIT |
| [calculadora-rtc-simples-nacional](https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional) | `a926d5a76095` (20/11/2026) | Java 25, Spring Boot 4.1, SQLite | MIT |
| [calculadora-rtc-gerador-danfse](https://github.com/ReceitaFederal/calculadora-rtc-gerador-danfse) | `8d79e6b2f7fa` (22/10/2026) | Go, PDF com Folio | MIT |

**Origem.** A organização "Receita Federal do Brasil" no GitHub não tem o selo de verificada. O código Java usa o pacote `br.gov.serpro.rtc`, e os roadmaps falam da Release 15 da Calculadora de Tributos. Tratamos como **provável oficial**, e falta achar o link para esses repositórios num site gov.br.

## 1. Gerador de DANFSe

Um serviço HTTP (`POST /api/danfse`, com XML na entrada e PDF na saída) e uma versão WebAssembly. Traz a NT 008 v1.02 em `docs/`, a mesma que usamos (ADR-0057).

**O que confirma no nosso DANFSe:**
- **Fonte Helvetica** do PDF, a mesma escolha que fizemos no lugar da Arial.
- **Tamanhos:** títulos de campo em 6 pt e conteúdo em 7 pt.
- **Campos vazios com traço** (nota 12).
- **Formatos:** "R$ 1.234,56", percentual "5,00%" e CEP "64.000-010".
- **Avisos de bloco ausente:** "DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e" e "O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO".
- **"Total do IBS/CBS" e "Valor Líquido + IBS/CBS"** saem com traço quando não há IBS/CBS ou quando o valor é zero.

**Onde difere de nós (e quem segue a NT):**

| Ponto | Gerador da Receita | DANFSe do emissor nacional (nota de produção) | Nós | NT 008 |
|---|---|---|---|---|
| Ambiente no cabeçalho | Descrição. Mapeia `ambGer` 1/2 como "Ambiente de Produção/Homologação", o que não bate com o XSD (`TSAmbGeradorNFSe`: 1 = Prefeitura, 2 = Sistema Nacional) | Código: "Ambiente Gerador: 2" | Código, desde 25/11/2026 | Tamanho 1 (código) |
| Município no cabeçalho | "Teresina - PI" | "Teresina - PI" | "Teresina / PI" | Exemplo "Município: CCCC / CC" |
| Canhoto | Impresso por padrão (`canhoto=false` esconde) | Impresso | Não impresso | Opcional (nota 11) |
| PIS/COFINS com `tpRetPisCofins=1` | PIS/COFINS próprios "R$ 0,00" e retenções somadas | — | Igual | Item 2.4.5 |
| PIS/COFINS depois de 2026 | Some quando `dCompet` > 31/12/2026 | — | Igual | Nota 6 |
| Tributação municipal sem dados | "TRIBUTAÇÃO MUNICIPAL (ISSQN) - OPERAÇÃO NÃO SUJEITA AO ISSQN" | — | Bloco com traços | Não achado na NT |

### Comparação feita em 25/11/2026 (com autorização do responsável)
O gerador foi compilado com o Dockerfile do próprio repositório (imagem `danfse-rfb:8d79e6b`). Ele rodou só em `127.0.0.1`, com sistema de arquivos somente leitura e sem privilégios, e o container foi removido no fim.

Os dois geradores receberam os mesmos seis XMLs fictícios:
- caso base;
- produção sem tomador;
- PIS/COFINS não retido;
- com IBS/CBS;
- competência em 2027;
- sem tributação municipal.

O texto de cada PDF foi comparado linha a linha.

**Corrigido no nosso DANFSe (ADR-0057):**
1. **Exclusões e Reduções da Base de Cálculo:** passa a somar `vDescIncond + vCalcReeRepRes + vISSQN + vPIS + vCOFINS` mesmo sem o grupo IBSCBS, como manda o Anexo I da NT ("somatório de todos estes campos"). Antes saía traço.
2. **Telefone:** com DDD, em 10 ou 11 dígitos, sai "(86) 99999-0000", como no emissor nacional e no gerador da Receita.
3. **Texto do QR Code:** a área tinha 0,68 cm, onde só cabiam duas linhas de 6 pt, e a frase oficial era cortada. Passou a ter 0,80 cm, e a frase sai inteira em três linhas.

**Mantido, porque seguimos a NT ou o XSD e o gerador da Receita não:**
- **Cabeçalho:** "Ambiente Gerador: 2" pelo código, quando o gerador imprime a descrição com mapeamento trocado.
- **Situação:** "NFS-e Gerada" (`TStat` 100), igual ao emissor nacional; o gerador imprime "NFS-e Regular".
- **Simples Nacional:** a descrição do XSD sem o código; o gerador imprime "3 - Optante - ME/EPP".
- **`indDest=0`:** "O DESTINATÁRIO É O PRÓPRIO TOMADOR" (`TSRTCIndDest`); o gerador só olha o grupo `dest`.
- **Percentual zero informado:** sai "0,00%"; o gerador imprime traço. A nota 12 reserva o traço para campo sem informação.
- **Município no cabeçalho:** "Teresina / PI", pelo exemplo da NT.
- **Totais aproximados:** sem ";" no fim, como no texto da NT.
- **Alíquota aplicada:** com "%", um desvio consciente já registrado no ADR-0057.

O gerador fica como oráculo para as próximas mudanças no DANFSe. Para repetir a comparação:
1. `docker build -t danfse-rfb <clone do repositório>`;
2. `docker run --read-only --cap-drop ALL -p 127.0.0.1:18080:8080 danfse-rfb`;
3. enviar cada XML em `POST /api/danfse?canhoto=false`;
4. comparar o texto do PDF com o do `GET /v1/service-invoices/{id}/danfse`.

## 2. Calculadora RTC — regime regular

API REST que calcula CBS, IBS e IS (LC 214/2025), com tabelas oficiais embarcadas (SQLite gerado por Flyway em `flyway/sql`) e validação de grupos XML pelos XSD.

**O que interessa ao motor:**
- **Tabelas oficiais versionadas:** CST e `cClassTrib` (com vigência e data de atualização), fundamentação legal, NCM e NBS por anexo da LC 214, classificação NBS × indicador de operação × LC 116 (NFS-e), alíquotas de referência por União, UF e município e redutores. Hoje o motor não tem essas tabelas, e elas são o que falta para conferir o grupo IBS/CBS da DPS e da NFC-e (existe o código? vale na data?). Conferir não é escolher: a escolha do CST e do `cClassTrib` continua do contribuinte.
- **Regras de arredondamento documentadas** (1.7.2): cada valor publicado é arredondado uma vez, e o total é a soma dos itens exibidos, por causa da rejeição 1091. É a mesma conta que o motor terá de conferir.
- **Base de cálculo unificada da NFS-e** e o tratamento do indicador e do local da operação.
- XSD por documento em `src/main/resources/xml/*` (NF-e, NFC-e, NFS-e, CT-e, BP-e e outros), com os originais e um `grupo.xsd` só do grupo de tributação.

**Como usar:** como **fonte das tabelas** e das regras de arredondamento, com o commit e o hash registrados, como fazemos com os XSD. Executar a calculadora como serviço auxiliar (Java 25 com SQLite) é possível, mas é uma peça a mais em produção. Fica para decidir quando o IBS/CBS entrar.

## 3. Calculadora RTC — Simples Nacional

Calcula CBS e IBS para optantes do Simples (`POST /calculadora/observabilidade/simples-nacional`) e consulta as atividades do Simples vigentes numa data, por anexo, tipo de documento e `cClassTrib`. Usa o mesmo banco da calculadora do regime regular.

**Relevância:** a empresa-piloto da NFS-e é ME/EPP optante. Quando a NFS-e passar a levar IBS/CBS, esta é a referência para o cálculo e para a lista de atividades. A NT 2026.005 (Simples na NF-e/NFC-e) aponta na mesma direção.

## 4. Também vale para nós
- O gerador recusa o `X-Request-ID` do cliente e nunca registra XML, PDF ou identificadores fiscais em log, a mesma linha do nosso ADR de logs.
- Os dois projetos Java usam banco embarcado **somente leitura** com migrations versionadas. É o padrão que já seguimos para as tabelas IBGE e ANEXO_A (arquivo com hash conferido na subida).

## 5. Decisões que ficam para o responsável
1. Compilar o gerador de DANFSe localmente para a comparação. Baixa dependências Go ou a imagem base Docker.
2. Quando o IBS/CBS entrar na DPS: importar as tabelas da calculadora (CST, `cClassTrib`, NBS × indicador de operação) como recurso versionado, ou chamar a calculadora como serviço auxiliar.

# ADR-0051 — Conferência periódica dos XML arquivados no bucket

- Status: **Aceito** · Data: 2026-11-24
- Relacionados:
  - ADR-0010 (artefatos em object storage);
  - ADR-0021 (separação de segredos por processo);
  - ADR-0031 (âncora diária da auditoria, o mesmo padrão de job recorrente);
  - ADR-0048 e ADR-0049 (hash e arquivamento dos XML);
  - ADR-0050 (download conferindo o hash).

## Contexto
O arquivamento (ADR-0048, ADR-0049) confere o objeto uma única vez, logo depois de gravar. Depois disso, ninguém olhava de novo. Ficavam sem detecção:
- um objeto perdido ou trocado no provedor (erro operacional, bucket recriado sem Object Lock, migração de provedor malfeita);
- um objeto cuja trava acabou antes do prazo gravado no banco;
- o XML do banco alterado por fora das travas, numa nota que ninguém baixou (o download do ADR-0050 só confere quando alguém pede).

Nenhuma dessas falhas aparece sozinha. Ela só seria descoberta no dia em que a cópia fosse necessária: numa fiscalização ou depois da perda da VPS.

## Decisão
1. **Uma conferência diária por empresa**, na fila `nfse.verify-archives` do worker-fiscal, o único processo com a credencial do bucket de artefatos.
   - Nasce no primeiro arquivamento da empresa, na mesma transação que marca o XML como arquivado. A chave singleton `<empresa>:<dia>` garante no máximo um job por dia.
   - Cada execução agenda a do dia seguinte (06:00 UTC, como a âncora da auditoria) **antes** de conferir: a corrente não para se a execução falhar até o job morrer.
   - Não há varredura entre empresas: nenhum papel lista empresas sob RLS (como no ADR-0031).
2. **O que é conferido, por objeto** (XML autorizado e XML do evento de cancelamento):
   - o XML do banco contra o hash gravado junto com ele (`DB_XML_HASH_MISMATCH`);
   - o objeto existe no bucket (`ARCHIVE_OBJECT_MISSING`);
   - os bytes do objeto contra o hash (`ARCHIVE_OBJECT_HASH_MISMATCH`);
   - a trava é COMPLIANCE e vai pelo menos até a retenção gravada no banco (`ARCHIVE_OBJECT_NOT_LOCKED`).
3. **Cadência.**
   - Cada objeto é conferido de novo 30 dias depois da última conferência boa. A releitura do arquivamento conta como a primeira.
   - Até 200 objetos por execução, os mais atrasados primeiro. Lote cheio agenda a continuação um minuto depois.
   - Objeto com a retenção vencida sai da conferência: depois do prazo legal, o provedor pode apagá-lo.
   - Esses números são parâmetros operacionais, não regra fiscal, e ficam em constantes do código.
4. **Falha não para a varredura.** Cada falha:
   - vira linha em `archived_xml_checks` (data e código);
   - é auditada (`service_invoice.archived_xml_check_failed`, com o tipo, o documento, a chave do objeto e o código);
   - gera um log de erro `nfse.archive_integrity`, só com identificadores e o código, nunca o conteúdo do XML;
   - volta a ser conferida, e alertada, uma vez por dia até voltar a bater.
   O motor não corrige nada sozinho: com Object Lock COMPLIANCE, regravar seria esconder o incidente. A análise é manual (runbook de filas).
5. **Erro de rede ou do provedor não é falha de integridade.** Ele sobe, e o job tenta de novo com backoff. O que já foi conferido fica gravado.
6. **Situação numa tabela própria (`archived_xml_checks`, migrations 0028 e 0029).**
   - Uma linha por objeto: última conferência boa, última falha e código. Nenhum XML, nenhum dado pessoal.
   - Fica fora das tabelas do documento para não mexer no `updated_at` da nota (que a API devolve) nem nas travas de gravação única.
   - RLS forçado por empresa. Só o worker-fiscal grava; o operador lê para acompanhar o alerta; a API não vê.

## Consequências
- O deploy não depende de nada novo: a conferência usa o mesmo bucket e a mesma credencial do arquivamento.
- Cada objeto é lido uma vez a cada 30 dias. Com XML de poucos KB, o custo de leitura no provedor é pequeno, mas cresce com o volume; o intervalo pode ser revisto quando houver números reais.
- A consulta dos objetos na vez lê as tabelas da empresa sem índice próprio. Basta para o volume do piloto; um índice parcial entra se a medição pedir.
- **Ainda fora desta etapa:** um painel do operador para as falhas (hoje: log, auditoria e a tabela) e a recuperação a partir do bucket depois de perder o banco.

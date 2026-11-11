# ADR-0031 — Âncora externa da cadeia de auditoria (S3 com Object Lock)

- Status: **Aceito**
- Data: 2026-11-11
- Decisão técnica tomada na implementação da semana 7, dentro do doc 14 §A4 e do ADR-0010

## Contexto
A trilha de auditoria é encadeada por hash (semana 5): alterar, remover ou reordenar um registro quebra a cadeia. Essa verificação interna tem um limite. Quem tiver acesso de superusuário ao banco pode reescrever a cadeia inteira e recalcular todos os hashes e a cabeça. Nesse caso a verificação interna aprova o resultado. O teste `audit-anchor.test.ts` reproduz exatamente esse ataque.

O doc 14 já previa a defesa: exportar diariamente a cabeça de cada cadeia para fora do banco, num armazenamento que nem o administrador da VPS consiga reescrever.

Ao implementar, surgiu uma restrição. **Nenhum papel consegue listar todas as empresas:** o RLS forçado vale até para o dono das tabelas (ADR-0011), e o meta-teste de RLS recusa políticas extras de leitura entre empresas. Uma varredura diária "de todas as empresas" exigiria abrir esse isolamento.

## Decisão
1. **Uma âncora por cadeia e por dia**, como objeto JSON imutável num bucket S3 com **Object Lock em modo COMPLIANCE**:
   - o objeto fica em `audit-anchors/v1/company/<empresa>/<instante>-<sequência>.json` ou `audit-anchors/v1/platform/…`;
   - o conteúdo é só o formato, a cadeia, a sequência, o hash e o instante. Nenhum dado de auditoria sai do banco;
   - cada PUT pede retenção explícita (padrão de 1830 dias, cerca de 5 anos, configurável) com `Content-MD5`. Um bucket sem Object Lock faz a gravação falhar, em vez de gravar uma âncora apagável sem avisar.
2. **Agendamento por empresa, sem varredura:**
   - o cadastro da empresa enfileira o primeiro job `audit.anchor-company`, na mesma transação;
   - cada execução agenda a do dia seguinte (06:00 UTC, chave singleton `<empresa>:<dia>`) **antes** de gravar. Assim a corrente não para se a gravação de um dia falhar até o job morrer;
   - a cadeia da plataforma tem o job `audit.anchor-platform`, garantido na inicialização do worker-general.
3. **Quem grava: o worker-general**, com credencial S3 de escrita. Ele continua sem nenhum privilégio nas tabelas de auditoria. Lê só a cabeça (sequência, hash) por duas funções `SECURITY DEFINER` (migration 0010). A da empresa usa a empresa do **contexto** da transação.
4. **Quem verifica: o operador**, com credencial S3 de leitura:
   - o comando é `npm run audit -- verify --company <id> --anchor`;
   - o registro da sequência ancorada precisa ter exatamente o hash ancorado. Se não tiver, ou se a cadeia tiver ficado mais curta que a âncora, o resultado é `ANCHOR_MISMATCH`.
5. **Configuração:**
   - obrigatória em produção no worker-general;
   - fora de produção é opcional: sem ela, as filas de âncora ficam paradas e há um aviso no log;
   - configurada pela metade é erro.
6. **Desenvolvimento e testes:** SeaweedFS (já no docker-compose e por Testcontainers), que suporta Object Lock COMPLIANCE e recusa apagar uma versão travada. Isso foi conferido em 2026-11-11.

## Consequências
- A adulteração completa do banco passa a ser detectável, desde que a âncora tenha sido gravada antes dela.
- **Janela de exposição:** o que for alterado entre a âncora mais recente e a adulteração não é coberto. Por isso a âncora é diária.
- **Corrente por empresa:** se o job de uma empresa morrer **e** o do dia seguinte também falhar, a corrente para. Mitigações:
  - o agendamento antecipado do item 2;
  - 24 tentativas por job;
  - o runbook de filas manda reprocessar `audit.anchor-*` mortos (`ops retry`).
- Empresas cadastradas antes da migration 0010 não têm o primeiro job. Não há nenhuma em produção, e não existe como enumerá-las (item de contexto).
- **Credenciais separadas:** escrita no worker-general e leitura no operador. O bucket é separado dos backups e dos XML (ADR-0010). Com Object Lock COMPLIANCE, nem o dono da conta apaga uma âncora antes do vencimento. Isso inclui âncoras gravadas por engano, então a retenção deve ser escolhida com cuidado.
- O provedor S3 de produção ainda é uma decisão pendente do responsável (R-10, LGPD). O Backblaze B2 recomendado (doc 15) oferece Object Lock pela API S3, mas isso precisa ser conferido no provedor escolhido antes do deploy.

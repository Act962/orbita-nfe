# ADR-0018 — O motor não decide a política tributária, mas valida rigorosamente

- Status: **Aceito** · Data: 2026-11-09 · Ajustado conforme definição do responsável

## Decisão
**O motor não decide** a política tributária da empresa (escolha de CST/CSOSN, alíquotas, benefícios, enquadramentos). Isso é responsabilidade do sistema cliente e do contador.

**O motor valida obrigatoriamente**, antes de transmitir:
1. Dados recebidos (contrato, tipos, formatos, tamanhos).
2. Campos obrigatórios, inclusive obrigatoriedade condicional prevista nos manuais.
3. Consistência fiscal entre campos (combinações permitidas pelo leiaute/manual, códigos existentes nas tabelas oficiais vigentes).
4. Regras matemáticas (totais, bases, valores de tributos informados × alíquotas informadas, com as tolerâncias/arredondamentos oficiais).
5. Compatibilidade com o leiaute oficial (XSD da versão gravada no documento).

Cada regra tem ID, fonte oficial, vigência, teste e documento em `docs/fiscal/regras/`. Camadas L1–L6 em [14-integridade-isolamento.md](../architecture/14-integridade-isolamento.md).

## Consequências
Rejeições previsíveis são barradas localmente com mensagem clara; validade fiscal continua dependendo exclusivamente da autorização oficial.

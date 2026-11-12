# ADR-0013 — Versionamento de regras fiscais, leiautes e schemas

- Status: **Aceito** · Data: 2026-11-09 · Aprovado pelo responsável em 2026-11-09

## Decisão
- XSDs oficiais versionados em `resources/fiscal/schemas/<doc>/<versão>` com origem e SHA-256.
- Regras fiscais agrupadas em *rule sets* versionados com vigência (`validFrom`/`validTo`), cada regra com documento de origem em `docs/fiscal/regras/`.
- O documento grava `layoutVersion` e `ruleSetVersion` na aceitação; reprocessamentos (consulta, cancelamento, PDF) usam a versão original.
- Tabelas oficiais (municípios, códigos de serviço, cStat) como dados versionados.

## Consequências
Atualizações fiscais (NTs, Reforma Tributária) não alteram documentos históricos.

## Complemento (2026-11-10): schemas por ambiente
Constatação: desde 20/10/2026, a produção e a produção restrita da NFS-e Nacional usam **pacotes XSD diferentes**:
- produção: `nfse-esquemas_xsd-v1-01-20260209.zip`;
- produção restrita: `esquemas_prod_restrita_20261020.zip`, com CNPJ alfanumérico, `finNFSe` em `infDPS` e `vAjusteBC`.

Os dois declaram `versao="1.01"`. A versão do leiaute sozinha não identifica o schema.

Decisão:
- O pacote é identificado por `<versão>-<data de publicação>`: `resources/fiscal/schemas/nfse-nacional/1.01-20260209/` e `.../1.01-20261020-prodrest/`.
- Cada pacote tem um `MANIFEST.json` com a URL oficial, a data de consulta, o SHA-256 do zip e de cada arquivo e os ambientes em que vale. Um teste recalcula os hashes no CI.
- A seleção do schema é **por ambiente e por data**, e o identificador do pacote usado fica gravado no documento.
- Arquivos oficiais são marcados como binários no git (`-text`), para não mudar o fim de linha e preservar o hash.

## Complemento (2026-11-11): catálogo de schemas e erratas
Implementado em `src/shared/infrastructure/xml/fiscal-schema-catalog.ts`:
- Na carga, o catálogo confere o SHA-256 de cada XSD contra o `MANIFEST.json` e recusa arquivo alterado, faltando ou a mais. Um XSD adulterado não valida nada.
- `forEnvironment(documento, ambiente)` devolve o pacote do ambiente. Enquanto a vigência por data não estiver no manifesto, dois pacotes para o mesmo ambiente são erro (`SCHEMA_PACKAGE_AMBIGUOUS`), e não escolha.

**Achado:** o pacote de produção `1.01-20260209` tem `TSSerieDPS` com o padrão `^0{0,4}\d{1,5}$`. No XML Schema, `^` e `$` não são âncoras, e a libxml2 recusa **qualquer** série com esse padrão. O pacote de produção restrita de 20/10/2026 já corrigiu.

Decisão: **erratas explícitas**, aplicadas em memória.
- Ficam em `ERRATA.json`, ao lado do manifesto, com id, motivo, evidência e status.
- Cada errata é presa ao hash do arquivo oficial e a uma única ocorrência do trecho original. Se o pacote mudar, a carga falha até a errata ser revista.
- O pacote registra os ids das erratas aplicadas, para gravar junto com o documento validado.
- Errata só corrige defeito técnico demonstrado por teste (como a semântica de expressão regular). **Nunca** muda faixa de valor, obrigatoriedade ou regra fiscal.
- Primeira errata: XSD-ERRATA-001 remove `^` e `$`. Ela é provisória até o primeiro envio aceito e sai quando o pacote de produção for substituído.

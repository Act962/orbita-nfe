# Motor Fiscal — Documentação

Fase atual: **Fase 1 — Fundação** (arquitetura aprovada em 2026-11-09; spikes técnicos concluídos).

| # | Documento |
|---|---|
| ★ | [Arquitetura consolidada (para aprovação)](ARQUITETURA-CONSOLIDADA.md) |
| 1 | [Proposta de arquitetura](architecture/01-arquitetura.md) |
| 2 | [Bounded contexts](architecture/02-bounded-contexts.md) |
| 3 | [Estrutura de diretórios](architecture/03-estrutura-diretorios.md) |
| 4 | [Modelo de domínio e máquinas de estado](architecture/04-modelo-dominio.md) |
| 5 | [Fluxos de negócio](architecture/05-fluxos.md) |
| 6 | [Integração com órgãos fiscais](architecture/06-integracao-fiscal.md) |
| 7 | [Filas e processamento](architecture/07-filas-processamento.md) |
| 8 | [Persistência](architecture/08-persistencia.md) |
| 9 | [Segurança](architecture/09-seguranca.md) |
| 10 | [Testes](architecture/10-testes.md) |
| 11 | [API pública interna](architecture/11-api.md) |
| 12 | [Recuperação de UNKNOWN](architecture/12-recuperacao-unknown.md) |
| 13 | [Segurança dos certificados A1](architecture/13-seguranca-certificados.md) |
| 14 | [Integridade fiscal e isolamento multiempresa](architecture/14-integridade-isolamento.md) |
| 15 | [Infraestrutura (VPS + Coolify + S3)](architecture/15-infraestrutura.md) |
| 16 | [Focus NFe como referência de mercado](architecture/16-referencia-focus-nfe.md) |
| 17 | [NFE.io como referência de mercado](architecture/17-referencia-nfe-io.md) |
| — | [NFS-e Teresina — investigação](fiscal/nfse-teresina.md) |
| — | [NFS-e — diagnóstico das APIs Teresina × SEFIN Nacional](fiscal/nfse-teresina-api-municipal-x-nacional.md) |
| — | [Fontes oficiais](fiscal/fontes-oficiais.md) |
| — | [Avaliação de repositórios de terceiros](fiscal/avaliacao-repositorios.md) |
| — | [Resultados dos spikes da Fase 1](spikes/resultados-fase1.md) |
| — | [Runbook: bootstrap e migrations do banco](runbooks/bootstrap-banco.md) |
| — | [Runbook: aplicações, API keys e concessões](runbooks/credenciais-api.md) |
| — | [Runbook: KEK dos certificados, ACs confiáveis e auditoria](runbooks/kek-certificados.md) |
| — | [Runbook: filas, workers e webhooks](runbooks/filas-e-webhooks.md) |
| — | [Runbook: deploy na VPS com Coolify](runbooks/deploy-coolify.md) |
| — | [Runbook: backup contínuo e restauração (WAL-G)](runbooks/backup-restauracao.md) |
| — | Guias da API (servidos em `/guides/`): [guia rápido](api/guia-rapido.md), [webhooks](api/webhooks.md), [versionamento](api/versionamento.md), [changelog](api/changelog.md) |
| — | Regras implementadas: [CNPJ-001](fiscal/regras/CNPJ-001.md), [COMPANY-001](fiscal/regras/COMPANY-001.md), [SERIES-001](fiscal/regras/SERIES-001.md), [SERIES-002](fiscal/regras/SERIES-002.md) (conferida no XSD oficial), [CERT-001](fiscal/regras/CERT-001.md), [PROD-001](fiscal/regras/PROD-001.md) (regra de cadastro) |
| — | [Riscos e dúvidas abertas](riscos.md) |
| — | [Roadmap](roadmap.md) |
| — | [ADRs](adr/) (0001–0037) |
| — | [Acompanhamento do projeto](ACOMPANHAMENTO.md) |

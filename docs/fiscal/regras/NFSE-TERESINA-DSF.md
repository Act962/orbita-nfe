# NFSE-TERESINA-DSF — Regras do emissor municipal de Teresina (DSF)

- Implementação: `src/modules/nfse/domain/channel-rules.ts` (`checkChannelRules`)
- Testes: `test/integration/nfse-api.test.ts` (roteamento para a DSF)
- Decisão: [ADR-0039](../../adr/0039-adapter-emissor-municipal-teresina.md)
- Status: conferida contra o portal e o diagnóstico de 2026-11-10. A confirmar no primeiro envio à homologação da DSF.

As notas do canal `MUNICIPAL_TERESINA_DSF` passam também pelas regras do Anexo I nacional ([NFSE-DPS](NFSE-DPS.md)), na versão de 09/02/2026, que é a que a SEMF linka.

| Código | Regra | Campo | Fonte |
|---|---|---|---|
| THE-002 | Por API, a série da DPS deve estar entre **10001 e 49999**. As séries de 00001 a 10000 são do sistema municipal | `seriesId` | Rejeição `L0022` da própria homologação da DSF ao envio do motor, em 2026-11-16 (ADR-0039): "A série informada na DPS deve estar dentro da faixa reservada para esse fim (de 10001 a 49999). As séries de 00001 a 10000 são de uso exclusivo do sistema municipal gerador de NFS-e." |
| THE-001 | `cTribMun` é obrigatório | `service.municipalTaxCode` | Portal da NFS-e de Teresina, aba "Documentação da API": o código é obtido na tabela cTribNac × CNAE do portal (`…/portal/#/tabela`). Consultado em 2026-11-10 ([diagnóstico](../nfse-teresina-api-municipal-x-nacional.md) §1.5, CONFIRMADO) |

O código é escolha do contribuinte: o motor confere só a presença, nunca o valor.

## Pendências
- **Códigos confirmados em 2026-11-16:** a DSF usa códigos locais `Lxxxx` (`L0022`), além dos nacionais. Os de duplicidade ainda não foram vistos.
- **THE-002 na criação da série (pendência):** hoje a série fora da faixa é recusada só quando a nota vai para a DSF. Avaliar se a criação de série para estabelecimentos de Teresina deve avisar.

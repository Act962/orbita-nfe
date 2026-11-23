# ADR-0046 — Substituição pela DSF, E0065 nos dois canais e cancelamento na DSF em espera

- Status: **Aceito** · Data: 2026-11-23
- Relacionados:
  - ADR-0035 (cancelamento);
  - ADR-0036 (substituição);
  - ADR-0039 (adapter da DSF, item 6).

## Contexto
O ADR-0039 deixou o cancelamento e a substituição só no canal da SEFIN. Ao revisar os dois fluxos para a DSF, apareceram três pontos.

1. **A substituição na DSF tem o mesmo caminho da emissão.** O Guia API THE V7 (§3.1) diz que a substituição "é uma DPS com a chave a substituir", e que a DSF gera o evento de cancelamento por substituição. A emissão já tem consulta pela DPS (`/nfse/dps/{id}`), então a substituta em `UNKNOWN` é reconciliada como qualquer nota.
2. **Faltava a E0065** (Anexo I, nível 1, os dois ambientes): "Não poderá ocorrer a substituição de NFS-e que tenha sido gerada em ambientes geradores diferentes."
   - O canal da substituta é recalculado pelo roteamento a partir da DPS dela.
   - Se a substituta mudasse o enquadramento (por exemplo, de ME/EPP para não optante em Teresina), ela iria para a DSF com a chave de uma nota da SEFIN. Nem a aplicação nem o banco conferiam isso. O banco só aceitava original do canal nacional.
3. **O cancelamento pela DSF não tem reconciliação segura.** A DSF não tem consulta de evento. Sem ela, a única forma de resolver um cancelamento em `UNKNOWN` seria reenviar os mesmos bytes e interpretar a resposta:
   - **E0802** (Anexo II: "já existe um documento … com este id") prova que o **nosso** evento existe, porque o Id do pedido é determinístico.
   - **E0840** ("o evento de … já está vinculado à NFS-e") **não prova**: pode ser o nosso cancelamento ou uma substituição feita no sistema municipal.
   - Uma **rejeição** no reenvio, depois de um envio duvidoso, não prova que o cancelamento falhou. Uma falha depois do envio não é prova de que nada foi registrado.
   - Ainda não há confirmação de quais códigos de duplicidade a DSF usa (ADR-0039 item 1).

## Decisão
1. **A substituição passa a valer para as notas da DSF.** A original pode ser de qualquer canal suportado.
2. **E0065 no aceite:** depois do roteamento da substituta, se o canal for diferente do da original, a resposta é `422 NFSE_RULES_VIOLATED` com `E0065` (`ruleId: "NFSE-DPS"`), antes de numerar. Vale também para a SEFIN.
3. **E0065 no banco (migration 0021):** o gatilho de aceite da substituta (0020) troca a exigência de "original do canal nacional" por "original e substituta no **mesmo** canal". Nota sem canal gravado conta como canal nacional, como na aplicação.
4. **O cancelamento pela DSF continua fechado** (`NFSE_CHANNEL_NOT_AVAILABLE`). Ele depende de uma destas condições:
   - a DSF oferecer a consulta de evento;
   - a SEMF/DSF confirmar os códigos de duplicidade e o que a resposta ao reenvio significa;
   - uma decisão sua de aceitar um desenho conservador.

   O desenho conservador: no `UNKNOWN`, reenviar os mesmos bytes.
   - REGISTERED ou E0802 → registrado.
   - Qualquer outra resposta → continua `UNKNOWN`, com resolução manual.

   A pergunta vai para a lista da SEMF (diagnóstico §10).

## Consequências
- Notas da DSF podem ser substituídas pela API. O teste de integração mostra a substituta pela DSF autorizada e fechando a original. O envio real depende do R-44.
- **Correção:** a substituta que o roteamento mandaria para outro canal é recusada, inclusive na SEFIN. Antes, ela seria aceita e iria para o autorizador errado.
- O cancelamento de nota da DSF continua sendo feito no emissor municipal, fora do motor, até a decisão do item 4.

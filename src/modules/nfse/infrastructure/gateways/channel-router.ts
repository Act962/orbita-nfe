import type { EventLookupOutcome, EventOutcome, GatewayContext, LookupOutcome, NfseGateway, SubmissionOutcome } from '../../application/ports.js';

/**
 * Escolhe o autorizador pelo canal gravado na nota (ADR-0028 item 3, ADR-0039): a emissão, a
 * consulta e os eventos de uma nota vão sempre para o sistema que a gerou.
 *
 * Canal sem autorizador configurado: nada sai (NOT_SENT / ERROR com código estável). Uma nota
 * nunca é mandada para "o outro" autorizador.
 */
export class ChannelRoutedGateway implements NfseGateway {
  constructor(private readonly byChannel: Readonly<Record<string, NfseGateway>>) {}

  submit(signedDps: string, context: GatewayContext): Promise<SubmissionOutcome> {
    const gateway = this.byChannel[context.channel];
    return gateway === undefined ? Promise.resolve({ kind: 'NOT_SENT', errorCode: 'NFSE_CHANNEL_NOT_CONFIGURED' }) : gateway.submit(signedDps, context);
  }

  findByDpsId(dpsId: string, context: GatewayContext): Promise<LookupOutcome> {
    const gateway = this.byChannel[context.channel];
    return gateway === undefined ? Promise.resolve({ kind: 'ERROR', errorCode: 'NFSE_CHANNEL_NOT_CONFIGURED' }) : gateway.findByDpsId(dpsId, context);
  }

  registerEvent(accessKey: string, signedEvent: string, context: GatewayContext): Promise<EventOutcome> {
    const gateway = this.byChannel[context.channel];
    return gateway === undefined ? Promise.resolve({ kind: 'NOT_SENT', errorCode: 'NFSE_CHANNEL_NOT_CONFIGURED' }) : gateway.registerEvent(accessKey, signedEvent, context);
  }

  findEvent(accessKey: string, eventType: string, sequence: number, context: GatewayContext): Promise<EventLookupOutcome> {
    const gateway = this.byChannel[context.channel];
    return gateway === undefined ? Promise.resolve({ kind: 'ERROR', errorCode: 'NFSE_CHANNEL_NOT_CONFIGURED' }) : gateway.findEvent(accessKey, eventType, sequence, context);
  }
}

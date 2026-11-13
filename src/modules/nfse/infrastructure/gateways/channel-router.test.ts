import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GatewayContext } from '../../application/ports.js';
import { ChannelRoutedGateway } from './channel-router.js';
import { SimulatedNfseGateway } from './simulated-gateway.js';

const DPS = '<DPS><infDPS Id="DPS221100120103431100013400900000000000000001"/></DPS>';
const context = (channel: string): GatewayContext => ({
  environment: 'HOMOLOGATION',
  channel,
  credential: { privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, certificatePem: '' },
});

describe('ChannelRoutedGateway (ADR-0039)', () => {
  it('cada nota vai para o autorizador do seu canal, e só para ele', async () => {
    const sefin = new SimulatedNfseGateway();
    const dsf = new SimulatedNfseGateway();
    const router = new ChannelRoutedGateway({ NATIONAL_SEFIN: sefin, MUNICIPAL_TERESINA_DSF: dsf });
    expect((await router.submit(DPS, context('MUNICIPAL_TERESINA_DSF'))).kind).toBe('AUTHORIZED');
    expect(dsf.submits).toBe(1);
    expect(sefin.submits).toBe(0);
    expect((await router.findByDpsId('DPS221100120103431100013400900000000000000001', context('NATIONAL_SEFIN'))).kind).toBe('NOT_FOUND');
    expect(sefin.lookups).toBe(1);
  });

  it('canal sem autorizador: nada sai (NOT_SENT no envio, ERROR na consulta)', async () => {
    const router = new ChannelRoutedGateway({});
    expect(await router.submit(DPS, context('NATIONAL_SEFIN'))).toEqual({ kind: 'NOT_SENT', errorCode: 'NFSE_CHANNEL_NOT_CONFIGURED' });
    expect(await router.findByDpsId('x', context('NATIONAL_SEFIN'))).toEqual({ kind: 'ERROR', errorCode: 'NFSE_CHANNEL_NOT_CONFIGURED' });
    expect(await router.registerEvent('k', '<p/>', context('X'))).toEqual({ kind: 'NOT_SENT', errorCode: 'NFSE_CHANNEL_NOT_CONFIGURED' });
    expect(await router.findEvent('k', '101101', 1, context('X'))).toEqual({ kind: 'ERROR', errorCode: 'NFSE_CHANNEL_NOT_CONFIGURED' });
  });
});

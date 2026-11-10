import { describe, expect, it } from 'vitest';
import { nextRetryDelaySeconds, MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_SECONDS } from './retry-schedule.js';
import { checkWebhookUrl, isPublicIpAddress } from './target-policy.js';

describe('endereços IP (proteção contra SSRF)', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '2001:db8::1',
    '[::1]',
  ])('%s não é público', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2001:4860:4860::8888'])('%s é público', (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it('texto que não é IP → undefined', () => {
    expect(isPublicIpAddress('exemplo.com.br')).toBeUndefined();
    expect(isPublicIpAddress('1.2.3')).toBeUndefined();
    expect(isPublicIpAddress('1:2:3:4:5:6:7:8:9')).toBeUndefined();
  });
});

describe('URL de destino do webhook', () => {
  const strict = { allowPrivateTargets: false };
  const check = (url: string) => {
    const r = checkWebhookUrl(url, strict);
    return r.ok ? 'OK' : r.issue;
  };

  it('aceita https para host público', () => {
    expect(check('https://erp.cliente.com.br/webhooks/fiscal?token=abc')).toBe('OK');
    expect(check('https://8.8.8.8/hook')).toBe('OK');
  });

  it('recusa http, credenciais, fragmento, URL inválida e longa', () => {
    expect(check('http://erp.cliente.com.br/hook')).toBe('URL_NOT_HTTPS');
    expect(check('ftp://erp.cliente.com.br/hook')).toBe('URL_NOT_HTTPS');
    expect(check('https://user:pass@erp.cliente.com.br/hook')).toBe('URL_HAS_CREDENTIALS');
    expect(check('https://erp.cliente.com.br/hook#x')).toBe('URL_HAS_FRAGMENT');
    expect(check('não é url')).toBe('URL_INVALID');
    expect(check(`https://erp.cliente.com.br/${'a'.repeat(2100)}`)).toBe('URL_TOO_LONG');
  });

  it('recusa loopback, rede privada, metadados de nuvem e nomes locais', () => {
    for (const url of [
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/hook',
      'https://localhost/hook',
      'https://api.localhost/hook',
      'https://servico.internal/hook',
      'https://intranet/hook',
      'https://[::ffff:192.168.0.1]/hook',
    ]) {
      expect(check(url), url).toBe('URL_PRIVATE_ADDRESS');
    }
  });

  it('modo de desenvolvimento aceita http e localhost, mas nunca outros protocolos', () => {
    expect(checkWebhookUrl('http://127.0.0.1:4000/hook', { allowPrivateTargets: true }).ok).toBe(true);
    expect(checkWebhookUrl('file:///etc/passwd', { allowPrivateTargets: true }).ok).toBe(false);
  });
});

describe('calendário de reentrega', () => {
  it('8 tentativas em cerca de 22 horas', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(8);
    const total = RETRY_DELAYS_SECONDS.reduce((a, b) => a + b, 0);
    expect(total).toBe(80_460);
    expect(total / 3600).toBeLessThan(24);
  });

  it('próxima espera por tentativas feitas; esgotou → null', () => {
    expect(nextRetryDelaySeconds(1)).toBe(60);
    expect(nextRetryDelaySeconds(7)).toBe(43_200);
    expect(nextRetryDelaySeconds(8)).toBeNull();
    expect(() => nextRetryDelaySeconds(0)).toThrow(RangeError);
  });
});

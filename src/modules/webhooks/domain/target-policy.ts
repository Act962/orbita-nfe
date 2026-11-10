/**
 * Proteção contra SSRF no destino dos webhooks (docs/architecture/09 §4). O worker-general faz
 * requisições a URLs escolhidas pelo cliente: nunca pode alcançar a rede interna, o loopback ou
 * serviços de metadados de nuvem. A política vale no cadastro (URL) e de novo na entrega,
 * sobre cada endereço resolvido pelo DNS (contra DNS rebinding).
 */

export const MAX_URL_LENGTH = 2048;

export type TargetIssue = 'URL_INVALID' | 'URL_NOT_HTTPS' | 'URL_HAS_CREDENTIALS' | 'URL_HAS_FRAGMENT' | 'URL_TOO_LONG' | 'URL_PRIVATE_ADDRESS';

function parseIpv4(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : undefined;
}

function isPrivateIpv4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return true;
  return (
    a === 0 || // "esta rede"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / metadados de nuvem
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) || // documentação
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast e reservados
  );
}

/** Expande um IPv6 textual em 8 grupos de 16 bits; `undefined` se não for IPv6. */
function parseIpv6(host: string): number[] | undefined {
  let text = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(':')) return undefined;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = parseIpv4(text.slice(lastColon + 1));
  if (maybeV4 !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = maybeV4;
    tail = [(a << 8) | b, (c << 8) | d];
    text = text.slice(0, lastColon + 1) + '0';
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const toGroups = (s: string): number[] | undefined => {
    if (s === '') return [];
    const groups = s.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN));
    return groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
  };
  const head = toGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (head === undefined || rest === undefined) return undefined;
  if (tail.length > 0) {
    // O último grupo "0" colocado no lugar do IPv4 é trocado pelos dois grupos do IPv4.
    if (rest.length > 0) rest.splice(-1, 1, ...tail);
    else head.splice(-1, 1, ...tail);
  }
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  return [...head, ...Array<number>(Math.max(0, missing)).fill(0), ...rest];
}

function isPrivateIpv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = groups;
  const allZeroUntil = (n: number): boolean => groups.slice(0, n).every((g) => g === 0);
  if (allZeroUntil(7) && (g7 === 0 || g7 === 1)) return true; // :: e ::1
  if (allZeroUntil(5) && g5 === 0xffff) return isPrivateIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]); // IPv4 mapeado
  if (g0 === 0x64 && g1 === 0xff9b) return true; // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentação
  return false;
}

/**
 * O endereço IP é público (alcançável na internet)? Texto que não é IP → `undefined`.
 * Loopback, redes privadas, link-local (inclui 169.254.169.254), CGNAT, ULA e reservados → `false`.
 */
export function isPublicIpAddress(address: string): boolean | undefined {
  const v4 = parseIpv4(address);
  if (v4 !== undefined) return !isPrivateIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6 !== undefined) return !isPrivateIpv6(v6);
  return undefined;
}

const LOCAL_HOSTNAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/**
 * Confere a URL de destino no cadastro. `allowPrivateTargets` existe só para desenvolvimento e
 * testes (a configuração recusa ligá-lo em produção).
 */
export function checkWebhookUrl(raw: string, options: { allowPrivateTargets: boolean }): { ok: true; url: URL } | { ok: false; issue: TargetIssue } {
  if (raw.length > MAX_URL_LENGTH) return { ok: false, issue: 'URL_TOO_LONG' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, issue: 'URL_INVALID' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, issue: 'URL_HAS_CREDENTIALS' };
  if (url.hash !== '') return { ok: false, issue: 'URL_HAS_FRAGMENT' };
  if (options.allowPrivateTargets) {
    return url.protocol === 'https:' || url.protocol === 'http:' ? { ok: true, url } : { ok: false, issue: 'URL_NOT_HTTPS' };
  }
  if (url.protocol !== 'https:') return { ok: false, issue: 'URL_NOT_HTTPS' };
  const host = url.hostname;
  const ip = isPublicIpAddress(host);
  if (ip === false || (ip === undefined && (LOCAL_HOSTNAMES.test(host) || !host.includes('.')))) {
    return { ok: false, issue: 'URL_PRIVATE_ADDRESS' };
  }
  return { ok: true, url };
}

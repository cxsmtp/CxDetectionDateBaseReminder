/**
 * Addresses this server calls out to (Checkmarx One, GitHub, a git host, a container
 * registry, a build attestation): https only, with plain http just for a test double on
 * this machine; never a link-local or cloud instance-metadata address (169.254.169.254 and
 * friends), where a request could read the host's own cloud credentials; and never with a
 * user name or password inside the address.
 *
 * Private networks (10.x, 192.168.x, …) stay allowed: on-premises Checkmarx One, GitLab
 * or GitHub Enterprise servers live there.
 */
import net from 'node:net';

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1)$/i;
// Names the clouds give their metadata services.
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal']);
// Metadata addresses outside 169.254/16: Alibaba Cloud, Azure's wire server, AWS over IPv6.
const METADATA_ADDRESSES = new Set(['100.100.100.200', '168.63.129.16', 'fd00:ec2::254']);

/** An IPv4 address an IPv6 one carries (::ffff:a.b.c.d, or its hex form ::ffff:a9fe:a9fe). */
function mappedIpv4(address) {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return '';
  const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** A host name (as `new URL().hostname` gives it) the server must never call. */
export function blockedHost(hostname) {
  let host = String(hostname ?? '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!host) return true;
  if (METADATA_NAMES.has(host) || METADATA_ADDRESSES.has(host)) return true;
  host = mappedIpv4(host) || host;
  if (METADATA_ADDRESSES.has(host)) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || (a === 169 && b === 254);
  }
  if (net.isIPv6(host)) return host === '::' || /^fe[89ab][0-9a-f]?:/i.test(host);
  return false;
}

/** Why the server must not call `value` ('' when it may). `allowLoopbackHttp`: plain http to this machine (a local test double). */
export function outboundUrlProblem(value, { allowLoopbackHttp = true } = {}) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return 'is not a web address';
  }
  if (url.username || url.password) return 'must not carry a user name or password';
  const local = LOOPBACK.test(url.hostname.replace(/^\[(.*)\]$/, '$1'));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopbackHttp && local)) return 'must be an https address';
  if (blockedHost(url.hostname)) return 'points at a link-local or cloud metadata address, which the server never calls';
  return '';
}

/** `value` when the server may call it; otherwise an Error (status 400) that says why. */
export function checkOutboundUrl(value, { label = 'address', allowLoopbackHttp = true, status = 400 } = {}) {
  const problem = outboundUrlProblem(value, { allowLoopbackHttp });
  if (problem) throw Object.assign(new Error(`The ${label} ${problem}.`), { status });
  return String(value).trim();
}

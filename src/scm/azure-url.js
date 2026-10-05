/**
 * Azure DevOps organisation addresses. The same organisation is written many ways: "acme",
 * https://dev.azure.com/acme, https://dev.azure.com/acme/Project/_git/repo (what a browser
 * shows), https://user@dev.azure.com/acme/…, or the older https://acme.visualstudio.com.
 * They all mean https://dev.azure.com/acme, and a token made for that organisation works for
 * every one of them. Azure DevOps Server keeps its own address (its collection URL).
 */

const ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;

/** The organisation's address, from whatever was pasted; '' when nothing was. */
export function normalizeAzureOrgUrl(value) {
  const text = String(value ?? '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (ORG_NAME.test(text)) return `https://dev.azure.com/${text}`;
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return text; // left for the address check to refuse
  }
  // https only: a plain http address is left as typed, for the address check to refuse.
  if (url.protocol !== 'https:') return text;
  const host = url.host.toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);
  if (host === 'dev.azure.com' || host === 'vssps.dev.azure.com') return path[0] ? `https://dev.azure.com/${path[0]}` : 'https://dev.azure.com';
  const old = /^([a-z0-9][a-z0-9-]*)\.(?:vssps\.)?visualstudio\.com$/.exec(host);
  if (old) return `https://dev.azure.com/${old[1]}`;
  // Azure DevOps Server: the collection, without a project, repository or API path after it.
  // …/Collection/Project/_git/repo drops the project too; …/Collection/_apis/… only what follows.
  const cut = path.findIndex((part) => part.startsWith('_'));
  const kept = cut === -1 ? path : path.slice(0, path[cut].toLowerCase() === '_git' && cut > 1 ? cut - 1 : cut);
  return `${url.protocol}//${url.host}${kept.length ? `/${kept.join('/')}` : ''}`;
}

/** Which organisation an address (an organisation's or a repository's) belongs to: "dev.azure.com/acme", or host/path on Server. */
export function azureOrgKey(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return '';
  }
  const host = url.host.toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);
  if (host === 'dev.azure.com' || host === 'vssps.dev.azure.com') return path[0] ? `dev.azure.com/${path[0].toLowerCase()}` : '';
  const old = /^([a-z0-9][a-z0-9-]*)\.(?:vssps\.)?visualstudio\.com$/.exec(host);
  if (old) return `dev.azure.com/${old[1]}`;
  return host;
}

/** The organisation's name on Azure DevOps Services ("acme"), or '' on Server. */
export const azureOrgName = (value) => (azureOrgKey(normalizeAzureOrgUrl(value)).match(/^dev\.azure\.com\/(.+)$/)?.[1] ?? '');

/**
 * Search findings by what the vulnerability is ("SQL injection", "SSRF", "CWE-89"): the Workbench
 * keeps only the findings whose name matches, so reminders, triage, remediation and credits act on
 * those alone. Checkmarx One names a finding by its query or rule ("SQL_Injection",
 * "Server_Side_Request_Forgery", a CVE for a package); the search ignores case, underscores and
 * dashes, and knows the usual short forms.
 */

const MAX_TEXT = 200;
const MAX_TERMS = 10;

/** Short forms people type, and the words Checkmarx One's names use for them. */
const SHORT_FORMS = {
  ssrf: ['server side request forgery', 'ssrf'],
  sqli: ['sql injection'],
  xss: ['xss', 'cross site scripting'],
  csrf: ['csrf', 'cross site request forgery', 'xsrf'],
  xsrf: ['csrf', 'cross site request forgery', 'xsrf'],
  xxe: ['xxe', 'xml external entit'],
  rce: ['code injection', 'command injection', 'remote code execution'],
  lfi: ['path traversal', 'file inclusion'],
  rfi: ['file inclusion'],
  idor: ['idor', 'insecure direct object', 'authorization'],
  ssti: ['template injection'],
  redos: ['regex', 'redos'],
};

/** Lower case, words only: "Reflected_XSS-All Clients" → "reflected xss all clients". */
export const words = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[_\-./\\:]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * What was typed, as a query: terms separated by commas (any one matches), each a few words that
 * must all appear in the finding's name (a short form may stand for its long one). Null when empty.
 */
export function vulnerabilityQuery(text) {
  const raw = String(text ?? '').slice(0, MAX_TEXT).trim();
  if (!raw) return null;
  const terms = raw
    .split(/[,;|]/)
    .map((part) => words(part))
    .filter(Boolean)
    .slice(0, MAX_TERMS)
    .map((term) => {
      // "CWE-89" / "cwe 89" stays one token; a known short form becomes its alternatives.
      const cwe = term.match(/^cwe ?(\d+)$/);
      if (cwe) return { alternatives: [[`cwe ${cwe[1]}`]], cwe: cwe[1] };
      if (SHORT_FORMS[term]) return { alternatives: SHORT_FORMS[term].map((form) => form.split(' ')) };
      return { alternatives: [term.split(' ')] };
    });
  if (!terms.length) return null;
  return { text: raw, terms };
}

/** Does this finding match the query? Its name (title), and its CWE where Checkmarx One gives one. */
export function matchesVulnerability(query, risk) {
  if (!query) return true;
  const name = ` ${words(risk?.title)} `;
  const cwe = String(risk?.cweId ?? risk?.cwe ?? '').replace(/\D/g, '');
  return query.terms.some((term) => {
    if (term.cwe) return cwe === term.cwe || name.includes(` cwe ${term.cwe} `);
    // Every word of one alternative appears in the name, each as the start of a word ("inject" finds "injection").
    return term.alternatives.some((alternative) => alternative.every((word) => name.includes(` ${word}`)));
  });
}

/** The most frequent finding names, for suggestions as people type: [{ name, count }]. */
export function topNames(counts, limit = 300) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

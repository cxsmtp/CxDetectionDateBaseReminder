/**
 * Fusion — new customer, Count from git (public/calculator/page.js): a customer's repositories counted
 * the way cloc counts them, straight from git, with no cloc installed. Each repository's default branch
 * is fetched at its latest commit only (no history) into a folder of its own under the temporary folder,
 * its files read where git keeps them (no checkout), counted by language without blank and comment lines,
 * and the folder deleted at once, also when the count fails or takes too long.
 *
 * Where the code is: one of the Admin's git connections (src/scm/, by id: its token never leaves the
 * server), or a token typed for one count. Either way the token goes to its own host only, as an
 * Authorization header (git gets it through the environment, never on a command line, in an address or
 * on disk), and is in no answer, log line or error. Used by CxMissionZero (src/server.js) and by the
 * standalone calculator's launcher (src/calculator-launcher.js), so only Node.js and relative imports.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { ScmClient } from './scm/client.js';
import { azureOrgKey, normalizeAzureOrgUrl } from './scm/azure-url.js';
import { blockedHost, outboundUrlProblem } from './outbound-url.js';

export const GIT_COUNT_LIMITS = Object.freeze({
  repositories: 50,
  repoBytes: 2 * 1024 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  timeoutMs: 10 * 60_000,
  concurrency: 2,
  listed: 1000,
});
export const GIT_PROVIDERS = ['github', 'gitlab', 'azure', 'bitbucket'];
const LABELS = { github: 'GitHub', gitlab: 'GitLab', azure: 'Azure DevOps', bitbucket: 'Bitbucket' };
const TEMP_PREFIX = 'mz-git-count-';

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---- Languages, as cloc names them, and how each writes comments ---------------------------------

// Comment syntax by family: line comments, block comments ([open, close]), quotes (a comment marker
// inside a string is not one), and quotes that run over several lines.
const C = { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"] };
const C_TICK = { ...C, quotes: ['"', "'", '`'], multi: ['`'] };
const HASH = { line: ['#'], quotes: ['"', "'"] };
const MARKUP = { block: [['<!--', '-->']] };
const NONE = {};

const SYNTAX = {
  C, 'C++': C, 'C/C++ Header': C, 'C#': C, Java: C, Kotlin: C, Scala: C, Groovy: C, Gradle: C, Dart: C, 'Objective-C': C, 'Objective-C++': C,
  Solidity: C, 'Protocol Buffers': C, 'Apex Class': C, 'Apex Trigger': C, Zig: { line: ['//'], quotes: ['"', "'"] }, ActionScript: C,
  JavaScript: C_TICK, TypeScript: C_TICK, JSX: C_TICK, Go: { ...C, quotes: ['"', "'", '`'], multi: ['`'], raw: ['`'] },
  Rust: { ...C, quotes: ['"'] }, Swift: { ...C, quotes: ['"'] }, 'Verilog-SystemVerilog': C,
  PHP: { line: ['//', '#'], block: [['/*', '*/']], quotes: ['"', "'"] },
  CSS: { block: [['/*', '*/']], quotes: ['"', "'"] }, SCSS: C, LESS: C, Sass: C,
  Python: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]], quotes: ['"', "'"] }, Cython: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]], quotes: ['"', "'"] },
  Ruby: { ...HASH, atStart: [['=begin', '=end']] }, Perl: { ...HASH, atStart: [['=pod', '=cut'], ['=head1', '=cut'], ['=head2', '=cut'], ['=begin', '=cut'], ['=over', '=cut']] },
  'Bourne Shell': HASH, 'Bourne Again Shell': HASH, zsh: HASH, 'Fish Shell': HASH, make: HASH, Dockerfile: HASH, YAML: HASH, TOML: HASH, R: HASH,
  Elixir: HASH, Properties: { line: ['#', '!'] }, Starlark: HASH, GraphQL: HASH, Nim: HASH, CMake: { ...HASH, block: [['#[[', ']]']] },
  Julia: { ...HASH, block: [['#=', '=#']] }, CoffeeScript: { ...HASH, block: [['###', '###']] }, PowerShell: { ...HASH, block: [['<#', '#>']] },
  HCL: { line: ['#', '//'], block: [['/*', '*/']], quotes: ['"'] }, INI: { line: [';', '#'] },
  SQL: { line: ['--'], block: [['/*', '*/']], quotes: ["'", '"'], raw: ["'"] }, Lua: { line: ['--'], block: [['--[[', ']]']], quotes: ['"', "'"] },
  Haskell: { line: ['--'], block: [['{-', '-}']], quotes: ['"'] }, Elm: { line: ['--'], block: [['{-', '-}']], quotes: ['"'] }, VHDL: { line: ['--'], quotes: ['"'] },
  Erlang: { line: ['%'], quotes: ['"'] }, Clojure: { line: [';'], quotes: ['"'] }, ClojureScript: { line: [';'], quotes: ['"'] }, ClojureC: { line: [';'], quotes: ['"'] },
  'F#': { line: ['//'], block: [['(*', '*)']], quotes: ['"'] }, 'F# Script': { line: ['//'], block: [['(*', '*)']], quotes: ['"'] }, OCaml: { block: [['(*', '*)']], quotes: ['"'] },
  Pascal: { line: ['//'], block: [['{', '}'], ['(*', '*)']], quotes: ["'"], raw: ["'"] },
  'Visual Basic .NET': { line: ["'"], quotes: ['"'], raw: ['"'], lineStart: /^rem(\s|$)/i }, 'Visual Basic Script': { line: ["'"], quotes: ['"'], raw: ['"'], lineStart: /^rem(\s|$)/i },
  'DOS Batch': { lineStart: /^(@?rem(\s|$)|::)/i },
  'Fortran 77': { line: ['!'], columnOne: /^[cC*!]/ }, 'Fortran 90': { line: ['!'] }, 'Fortran 95': { line: ['!'] },
  COBOL: { line: ['*>'], columnOne: /^.{6}[*/]/ }, Assembly: { line: [';', '//'], block: [['/*', '*/']], lineStart: /^[#@]/ }, ABAP: { line: ['"'], columnOne: /^\*/ },
  HTML: MARKUP, XML: MARKUP, SVG: MARKUP, XAML: MARKUP, XSD: MARKUP, XSLT: MARKUP, Maven: MARKUP, 'MSBuild script': MARKUP, Markdown: MARKUP,
  'Vuejs Component': { line: ['//'], block: [['<!--', '-->'], ['/*', '*/']] }, Svelte: { line: ['//'], block: [['<!--', '-->'], ['/*', '*/']] },
  Razor: { line: ['//'], block: [['@*', '*@'], ['<!--', '-->'], ['/*', '*/']] }, JSP: { line: ['//'], block: [['<%--', '--%>'], ['<!--', '-->'], ['/*', '*/']] },
  'ASP.NET': { block: [['<%--', '--%>'], ['<!--', '-->']] }, Handlebars: { block: [['{{!--', '--}}'], ['{{!', '}}'], ['<!--', '-->']] }, Mustache: { block: [['{{!', '}}'], ['<!--', '-->']] },
  Twig: { block: [['{#', '#}'], ['<!--', '-->']] }, ERB: { block: [['<%#', '%>'], ['<!--', '-->']] }, EJS: { block: [['<%#', '%>'], ['<!--', '-->']] },
  JSON: NONE, CSV: NONE, Text: NONE,
};

const EXTENSIONS = {
  c: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', 'c++': 'C++', h: 'C/C++ Header', hpp: 'C/C++ Header', hh: 'C/C++ Header', hxx: 'C/C++ Header', cs: 'C#',
  java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', sc: 'Scala', groovy: 'Groovy', gvy: 'Groovy', gradle: 'Gradle', 'gradle.kts': 'Gradle', dart: 'Dart',
  m: 'Objective-C', mm: 'Objective-C++', sol: 'Solidity', proto: 'Protocol Buffers', cls: 'Apex Class', trigger: 'Apex Trigger', zig: 'Zig', as: 'ActionScript',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', jsx: 'JSX', go: 'Go', rs: 'Rust', swift: 'Swift',
  v: 'Verilog-SystemVerilog', sv: 'Verilog-SystemVerilog', svh: 'Verilog-SystemVerilog', vhd: 'VHDL', vhdl: 'VHDL',
  php: 'PHP', css: 'CSS', scss: 'SCSS', less: 'LESS', sass: 'Sass', py: 'Python', pyw: 'Python', pyx: 'Cython', rb: 'Ruby', pl: 'Perl', pm: 'Perl',
  sh: 'Bourne Shell', bash: 'Bourne Again Shell', zsh: 'zsh', fish: 'Fish Shell', mk: 'make', dockerfile: 'Dockerfile', yml: 'YAML', yaml: 'YAML', toml: 'TOML', r: 'R',
  ex: 'Elixir', exs: 'Elixir', properties: 'Properties', bzl: 'Starlark', graphql: 'GraphQL', gql: 'GraphQL', nim: 'Nim', cmake: 'CMake', jl: 'Julia', coffee: 'CoffeeScript',
  ps1: 'PowerShell', psm1: 'PowerShell', psd1: 'PowerShell', tf: 'HCL', tfvars: 'HCL', hcl: 'HCL', ini: 'INI', sql: 'SQL', lua: 'Lua', hs: 'Haskell', elm: 'Elm',
  erl: 'Erlang', hrl: 'Erlang', clj: 'Clojure', cljs: 'ClojureScript', cljc: 'ClojureC', fs: 'F#', fsi: 'F#', fsx: 'F# Script', ml: 'OCaml', mli: 'OCaml', pas: 'Pascal', dpr: 'Pascal',
  vb: 'Visual Basic .NET', vbs: 'Visual Basic Script', bat: 'DOS Batch', cmd: 'DOS Batch', f: 'Fortran 77', for: 'Fortran 77', f77: 'Fortran 77', f90: 'Fortran 90', f95: 'Fortran 95',
  cbl: 'COBOL', cob: 'COBOL', cpy: 'COBOL', asm: 'Assembly', s: 'Assembly', abap: 'ABAP',
  html: 'HTML', htm: 'HTML', xhtml: 'HTML', xml: 'XML', svg: 'SVG', xaml: 'XAML', xsd: 'XSD', xsl: 'XSLT', xslt: 'XSLT', csproj: 'MSBuild script', vbproj: 'MSBuild script', props: 'MSBuild script', targets: 'MSBuild script',
  md: 'Markdown', markdown: 'Markdown', vue: 'Vuejs Component', svelte: 'Svelte', cshtml: 'Razor', razor: 'Razor', jsp: 'JSP', jspf: 'JSP', aspx: 'ASP.NET', ascx: 'ASP.NET', asax: 'ASP.NET', asmx: 'ASP.NET', master: 'ASP.NET',
  hbs: 'Handlebars', handlebars: 'Handlebars', mustache: 'Mustache', twig: 'Twig', erb: 'ERB', ejs: 'EJS', json: 'JSON', csv: 'CSV', txt: 'Text',
};
const FILE_NAMES = {
  dockerfile: 'Dockerfile', makefile: 'make', gnumakefile: 'make', 'cmakelists.txt': 'CMake', 'pom.xml': 'Maven', jenkinsfile: 'Groovy',
  rakefile: 'Ruby', gemfile: 'Ruby', podfile: 'Ruby', vagrantfile: 'Ruby',
};
// Bazel's files, by their exact names (a "build" script is not one).
const EXACT_NAMES = { BUILD: 'Starlark', 'BUILD.bazel': 'Starlark', WORKSPACE: 'Starlark', 'WORKSPACE.bazel': 'Starlark' };
const SHEBANG = [[/python/, 'Python'], [/node|deno/, 'JavaScript'], [/bash/, 'Bourne Again Shell'], [/zsh/, 'zsh'], [/perl/, 'Perl'], [/ruby/, 'Ruby'], [/\bsh\b/, 'Bourne Shell']];

const own = (table, key) => Object.hasOwn(table, key);

/** The languages this counter knows, as cloc names them. */
export const KNOWN_LANGUAGES = Object.freeze(Object.keys(SYNTAX).sort());

/**
 * A file's language by its name, as cloc names it ('' when not a language counted). `firstLine`: a
 * file with no extension is read by its #! line (#!/usr/bin/env python …).
 */
export function languageOf(filePath, firstLine = '') {
  const name = String(filePath ?? '').split('/').pop();
  if (own(EXACT_NAMES, name)) return EXACT_NAMES[name];
  const base = name.toLowerCase();
  if (own(FILE_NAMES, base)) return FILE_NAMES[base];
  if (base.startsWith('dockerfile.')) return 'Dockerfile';
  const parts = base.split('.');
  if (parts.length > 2 && own(EXTENSIONS, parts.slice(-2).join('.'))) return EXTENSIONS[parts.slice(-2).join('.')];
  if (parts.length > 1 && parts[0] !== '') return own(EXTENSIONS, parts.at(-1)) ? EXTENSIONS[parts.at(-1)] : '';
  if (parts.length === 1 && String(firstLine).startsWith('#!')) return SHEBANG.find(([re]) => re.test(firstLine))?.[1] ?? '';
  return '';
}

/** Binary as git decides it: a NUL byte in the first 8,000 bytes. */
export const isBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

const SPECIALS = new Map();
/** The characters at which something may start (a comment or a string) in this syntax. */
function specialsOf(spec) {
  if (!SPECIALS.has(spec)) {
    const marks = [...(spec.line ?? []), ...(spec.block ?? []).map(([open]) => open), ...(spec.quotes ?? [])];
    const chars = [...new Set(marks.map((m) => m[0]))].map((ch) => ch.replace(/[\\\]^-]/g, '\\$&')).join('');
    SPECIALS.set(spec, chars ? new RegExp(`[${chars}]`, 'g') : null);
  }
  return SPECIALS.get(spec);
}

/**
 * One file's lines, as cloc counts them: blank (only white space, also inside a comment), comment
 * (nothing but comments) and code (anything else). A comment marker inside a string is not one.
 */
export function countLines(text, language) {
  const spec = own(SYNTAX, language) ? SYNTAX[language] : NONE;
  const lines = String(text ?? '').split(/\r\n|\n|\r/);
  if (lines.length && lines.at(-1) === '') lines.pop();
  const special = specialsOf(spec);
  const out = { code: 0, comment: 0, blank: 0 };
  let block = null;
  let quote = null;
  for (const raw of lines) {
    if (!raw.trim()) {
      out.blank += 1;
      continue;
    }
    if (!block && !quote) {
      if ((spec.columnOne && spec.columnOne.test(raw)) || (spec.lineStart && spec.lineStart.test(raw.trim()))) {
        out.comment += 1;
        continue;
      }
      const start = spec.atStart?.find(([open]) => raw.startsWith(open));
      if (start) {
        block = start[1];
        out.comment += 1;
        continue;
      }
    } else if (block && spec.atStart?.some(([, close]) => close === block) && raw.startsWith(block)) {
      block = null;
      out.comment += 1;
      continue;
    }
    let code = false;
    let comment = false;
    let i = 0;
    while (i < raw.length) {
      if (block) {
        comment = true;
        // Ruby's =begin … =end and Perl's POD close at the start of a line only.
        const end = spec.atStart?.some(([, close]) => close === block) ? -1 : raw.indexOf(block, i);
        if (end < 0) break;
        i = end + block.length;
        block = null;
        continue;
      }
      if (quote) {
        code = true;
        const escapes = !(spec.raw ?? []).includes(quote);
        let j = i;
        while (j < raw.length && !raw.startsWith(quote, j)) j += escapes && raw[j] === '\\' ? 2 : 1;
        if (j >= raw.length) {
          i = raw.length;
          break;
        }
        i = j + quote.length;
        quote = null;
        continue;
      }
      if (!special) {
        code = true;
        break;
      }
      special.lastIndex = i;
      const hit = special.exec(raw);
      const at = hit ? hit.index : raw.length;
      if (at > i && raw.slice(i, at).trim()) code = true;
      if (!hit) break;
      i = at;
      const open = spec.block?.find(([o]) => raw.startsWith(o, i));
      if (open) {
        block = open[1];
        comment = true;
        i += open[0].length;
        continue;
      }
      if (spec.line?.some((m) => raw.startsWith(m, i))) {
        comment = true;
        break;
      }
      const q = spec.quotes?.find((m) => raw.startsWith(m, i));
      if (q) {
        quote = q;
        code = true;
        i += q.length;
        continue;
      }
      code = true;
      i += 1;
    }
    // A string that is not closed ends with its line, unless its quotes may run on.
    if (quote && !(spec.multi ?? []).includes(quote)) quote = null;
    if (code) out.code += 1;
    else if (comment) out.comment += 1;
    else out.code += 1;
  }
  return out;
}

/** Counts files as they come, the way cloc adds them up: by language, each file's content once. */
function tally() {
  const languages = {};
  const seen = new Set();
  const skipped = { binary: 0, large: 0, duplicate: 0 };
  let files = 0;
  return {
    languages,
    skipped,
    get files() {
      return files;
    },
    /** `key`: what makes two files the same content (git's object id, or a hash). */
    add(filePath, buffer, key = '') {
      if (key && seen.has(key)) return (skipped.duplicate += 1);
      if (key) seen.add(key);
      if (isBinary(buffer)) return (skipped.binary += 1);
      const text = buffer.toString('utf8');
      const language = languageOf(filePath, text.slice(0, 200).split('\n')[0]);
      if (!language) return 0;
      const { code } = countLines(text, language);
      const entry = (languages[language] ??= { files: 0, code: 0 });
      entry.files += 1;
      entry.code += code;
      files += 1;
      return 1;
    },
    result() {
      const sorted = Object.fromEntries(Object.entries(languages).sort((a, b) => b[1].code - a[1].code));
      return { lines: Object.values(languages).reduce((n, l) => n + l.code, 0), languages: sorted, files, skipped };
    },
  };
}

/** A file worth reading: a language this counter knows by its name, or none yet (a #! line may say). */
const candidate = (filePath) => {
  const base = filePath.split('/').pop();
  return Boolean(languageOf(filePath)) || !base.includes('.');
};

/**
 * A folder's code lines, as a repository's are counted (for a folder on this computer, and the tests):
 * {lines, languages: {Language: {files, code}}, files, skipped}. .git and symbolic links are left out.
 */
export async function countDirectory(dir, { fileBytes = GIT_COUNT_LIMITS.fileBytes, onProgress = () => {} } = {}) {
  const found = [];
  const walk = (folder, rel) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), relPath);
      else if (entry.isFile() && candidate(relPath)) found.push(relPath);
    }
  };
  walk(dir, '');
  const count = tally();
  for (const [index, relPath] of found.entries()) {
    const file = path.join(dir, relPath);
    if (fs.statSync(file).size > fileBytes) count.skipped.large += 1;
    else {
      const content = fs.readFileSync(file);
      count.add(relPath, content, createHash('sha1').update(content).digest('hex'));
    }
    onProgress(index + 1, found.length);
  }
  return count.result();
}

// ---- git ---------------------------------------------------------------------------------------

/** Run git; resolves its output. `signal` stops it (time limit, size limit). */
function git(args, { env, signal, maxBuffer = 64 * 1024 * 1024, bin = 'git' } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, signal, maxBuffer, encoding: 'buffer', windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stderr: stderr?.toString('utf8') ?? '' }));
      resolve(stdout);
    });
  });
}

/** The tree at HEAD: each file's object id, size and path (symbolic links and submodules left out). */
async function listTree(dir, opts) {
  const out = (await git(['-C', dir, 'ls-tree', '-r', '-z', '-l', '--full-tree', 'HEAD'], { ...opts, maxBuffer: 512 * 1024 * 1024 })).toString('utf8');
  const entries = [];
  for (const item of out.split('\0')) {
    const tab = item.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid, size] = item.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' || mode === '120000') continue;
    entries.push({ oid, size: Number(size), path: item.slice(tab + 1) });
  }
  return entries;
}

/** Each object's content, read from git's own store as git hands them over (git cat-file --batch). */
function readBlobs(dir, oids, onBlob, { env, signal, bin = 'git' } = {}) {
  return new Promise((resolve, reject) => {
    if (!oids.length) return resolve();
    const child = spawn(bin, ['-C', dir, 'cat-file', '--batch'], { env, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = Buffer.alloc(0);
    let want = null;
    let stderr = '';
    let failed = null;
    child.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        for (;;) {
          if (!want) {
            const nl = buf.indexOf(10);
            if (nl < 0) break;
            const head = buf.subarray(0, nl).toString('utf8').split(' ');
            buf = buf.subarray(nl + 1);
            if (head[1] === 'missing' || head.length < 3) continue;
            want = { oid: head[0], size: Number(head[2]) };
          }
          if (buf.length < want.size + 1) break;
          const body = buf.subarray(0, want.size);
          buf = buf.subarray(want.size + 1);
          const { oid } = want;
          want = null;
          onBlob(oid, body);
        }
      } catch (error) {
        failed = error;
        child.kill();
      }
    });
    child.stderr.on('data', (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (failed) return reject(failed);
      if (code !== 0) return reject(Object.assign(new Error(`git cat-file stopped (${code})`), { stderr }));
      resolve();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${oids.join('\n')}\n`);
  });
}

/** A folder's size on disk, in bytes (a clone being made: its pack files grow). */
function folderBytes(dir) {
  let total = 0;
  const walk = (folder) => {
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

/** git's environment for one fetch: the Authorization header (when there is one) through config variables only. */
function gitEnv(authHeader, { http = false } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: http ? 'https:http' : 'https', GIT_LFS_SKIP_SMUDGE: '1' };
  // Nothing that would write the header out (git's traces), and no other settings passed down.
  for (const name of Object.keys(env)) if (/^GIT_(TRACE|CURL_VERBOSE|CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS))/.test(name)) delete env[name];
  const config = [['credential.helper', ''], ['http.followRedirects', 'false'], ['core.askPass', '']];
  if (authHeader) config.push(['http.extraHeader', `Authorization: ${authHeader}`]);
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], i) => Object.assign(env, { [`GIT_CONFIG_KEY_${i}`]: key, [`GIT_CONFIG_VALUE_${i}`]: value }));
  return env;
}

/** Is git there? '' when it is, else what to say. */
export async function gitMissing(bin = 'git') {
  try {
    await git(['--version'], { bin });
    return '';
  } catch (error) {
    return error.code === 'ENOENT' ? 'Git is not installed on this computer: install it from https://git-scm.com, then count again.' : `Git could not be started: ${String(error.message).split('\n')[0]}`;
  }
}

// ---- Addresses and tokens -----------------------------------------------------------------------

/** Every form a secret takes in a request: hidden wherever it could appear in a message. */
export function redact(text, secrets = []) {
  let out = String(text ?? '').replace(/\/\/[^/@\s]*@/g, '//');
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('[hidden]');
  return out;
}

const SEGMENT = /^[\w.~%@+-]+$/;
/**
 * A repository's clone address, checked: https (plain http only to this computer, for a test double),
 * never a link-local or cloud metadata address, and without a password. A user name some hosts put in
 * their own addresses (https://acme@dev.azure.com/…) is dropped. {url, host, hostname, path, name}.
 */
export function repoAddress(value) {
  const text = String(value ?? '').trim();
  if (/^(git@|ssh:\/\/)/i.test(text)) throw fail(400, 'Use the repository’s https address: the token goes over https only.');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw fail(400, `Not a repository address: ${text.slice(0, 80).replace(/\/\/[^/@\s]*@/, '//')}`);
  }
  if (url.password) throw fail(400, 'A clone address must not carry a password: give the token in step 1.');
  url.username = '';
  const problem = outboundUrlProblem(url.href);
  if (problem) throw fail(400, `The address ${url.host} ${problem}.`);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p === '..' || p === '.' || !SEGMENT.test(p))) throw fail(400, `Not a repository address: ${url.host}${url.pathname.slice(0, 80)}`);
  const name = decodeURIComponent(parts.at(-1)).replace(/\.git$/i, '') || 'Project';
  return { url: `${url.protocol}//${url.host}/${parts.join('/')}`, host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1'), path: parts.join('/').replace(/\.git$/i, ''), name };
}

/** Never a host whose name leads to a link-local or cloud metadata address. */
async function checkResolved(hostname) {
  if (net.isIP(hostname)) return;
  let addresses = [];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw fail(400, `${hostname} could not be found.`);
  }
  if (addresses.some((a) => blockedHost(a.address))) throw fail(400, `${hostname} points at a link-local or cloud metadata address, which is never called.`);
}

const TOKEN = /^[\x21-\x7e]{4,4096}$/;
const b64 = (text) => Buffer.from(text).toString('base64');

/**
 * Where the code is, from a host, its address and a token: the API to list repositories with, the git
 * host the token belongs to, and the Authorization header for each. `token` may be "user:password"
 * for Bitbucket (an app password). The token itself stays inside the object returned (in `secrets`,
 * for redaction): nothing here writes it anywhere.
 */
export function gitSource({ provider, address = '', token = '' } = {}) {
  if (!GIT_PROVIDERS.includes(provider)) throw fail(400, 'Choose the git host: GitHub, GitLab, Azure DevOps or Bitbucket.');
  const secret = String(token ?? '').trim();
  if (!TOKEN.test(secret)) throw fail(400, secret ? 'That token has spaces or characters a token does not have: paste it again.' : 'Paste the token.');
  const defaults = { github: 'https://github.com', gitlab: 'https://gitlab.com', bitbucket: 'https://bitbucket.org', azure: '' };
  let typed = String(address ?? '').trim() || defaults[provider];
  if (provider === 'azure') typed = normalizeAzureOrgUrl(typed);
  if (!typed) throw fail(400, 'Give the Azure DevOps organisation, for example https://dev.azure.com/acme.');
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    throw fail(400, 'That address is not a web address.');
  }
  const problem = outboundUrlProblem(url.href);
  if (problem) throw fail(400, `The address ${problem}.`);
  const host = url.host.toLowerCase();
  const origin = `${url.protocol}//${url.host}`;
  const base = url.pathname.replace(/\/+$/, '');
  let source;
  if (provider === 'github') {
    const cloud = host === 'github.com' || host === 'api.github.com';
    source = { apiUrl: cloud ? 'https://api.github.com' : `${origin}${base.replace(/\/api\/v3$/, '')}/api/v3`, gitHost: cloud ? 'github.com' : host, apiAuth: `Bearer ${secret}`, cloneAuth: `Basic ${b64(`x-access-token:${secret}`)}` };
  } else if (provider === 'gitlab') {
    source = { apiUrl: `${origin}${base.replace(/\/api\/v4$/, '')}/api/v4`, gitHost: host, apiAuth: `Bearer ${secret}`, cloneAuth: `Basic ${b64(`oauth2:${secret}`)}` };
  } else if (provider === 'azure') {
    const auth = `Basic ${b64(`:${secret}`)}`;
    source = { apiUrl: `${origin}${base}`, gitHost: host, apiAuth: auth, cloneAuth: auth, org: azureOrgKey(`${origin}${base}`) };
  } else {
    const cloud = host === 'bitbucket.org' || host === 'api.bitbucket.org';
    const pair = secret.includes(':') ? `Basic ${b64(secret)}` : '';
    source = {
      apiUrl: cloud ? 'https://api.bitbucket.org/2.0' : `${origin}${base.replace(/\/rest\/api\/1\.0$/, '')}`,
      gitHost: cloud ? 'bitbucket.org' : host,
      apiAuth: pair || `Bearer ${secret}`,
      cloneAuth: pair || (cloud ? `Basic ${b64(`x-token-auth:${secret}`)}` : `Bearer ${secret}`),
      cloud,
    };
  }
  const secrets = [secret, source.apiAuth, source.cloneAuth, ...[source.apiAuth, source.cloneAuth].map((a) => a.replace(/^\w+ /, ''))];
  return {
    provider,
    label: LABELS[provider],
    ...source,
    secrets,
    /** The header for cloning `repo` ({host, url}): only on the token's own host (an Azure DevOps token: its own organisation). */
    authFor(repo) {
      if (repo.host !== source.gitHost) return '';
      if (provider === 'azure' && source.org.startsWith('dev.azure.com/') && azureOrgKey(repo.url) !== source.org) return '';
      return source.cloneAuth;
    },
  };
}

/** The same from one of the Admin's connections (src/scm/providers.js scmConfigs, src/server.js githubConfig). */
export function connectionSource(provider, cfg = {}) {
  if (provider === 'github') return gitSource({ provider, address: cfg.apiUrl, token: cfg.token });
  if (provider === 'gitlab') return gitSource({ provider, address: cfg.apiUrl, token: cfg.token });
  if (provider === 'azure') return gitSource({ provider, address: cfg.orgUrl, token: cfg.token });
  const cloud = cfg.kind !== 'server';
  return gitSource({ provider, address: cloud ? 'https://bitbucket.org' : cfg.apiUrl, token: cfg.username ? `${cfg.username}:${cfg.token}` : cfg.token });
}

// ---- Listing an organisation's repositories -------------------------------------------------------

/** One repository as listed: its path, clone address (no credentials), default branch, size and whether archived. */
function listed(pathName, cloneUrl, branch, sizeBytes, archived) {
  let address;
  try {
    address = repoAddress(cloneUrl);
  } catch {
    return null;
  }
  return { name: address.name, path: String(pathName), url: address.url, branch: safeBranch(branch) ? branch : '', sizeBytes: Number.isFinite(Number(sizeBytes)) && sizeBytes !== null ? Number(sizeBytes) : null, archived: archived === true };
}

/**
 * An organisation's (GitHub), group's (GitLab, with its subgroups), project's or whole organisation's
 * (Azure DevOps) or workspace's / project's (Bitbucket) repositories, up to 1,000, by path:
 * {repositories: [{name, path, url, branch, sizeBytes, archived}], more}.
 */
export async function listRepositories(source, owner, { fetchImpl = fetch, max = GIT_COUNT_LIMITS.listed } = {}) {
  const who = String(owner ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (who && !/^[\w.~ -]+(\/[\w.~ -]+)*$/.test(who)) throw fail(400, 'That organisation or group name has characters a name does not have.');
  if (!who && source.provider !== 'azure') throw fail(400, source.provider === 'bitbucket' ? 'Give the workspace (or the project key on Bitbucket Data Center).' : 'Give the organisation or group.');
  const client = new ScmClient({ name: source.label, baseUrl: source.apiUrl, auth: source.apiAuth, fetchImpl });
  const out = [];
  let more = false;
  const enc = encodeURIComponent;
  const pages = async (first, next) => {
    for (let page = 1; out.length < max; page += 1) {
      const items = await (page === 1 ? first() : next(page));
      if (!items) break;
      out.push(...items.list.filter(Boolean));
      if (!items.more) return;
    }
    more = true;
  };
  try {
    if (source.provider === 'github') {
      let base = `/orgs/${enc(who)}/repos`;
      const get = (page) => client.get(base, { per_page: 100, page, type: 'all' });
      const map = (body) => ({ list: (body ?? []).map((r) => listed(r.full_name, r.clone_url, r.default_branch, Number(r.size) * 1024, r.archived)), more: (body ?? []).length === 100 });
      await pages(async () => {
        try {
          return map(await get(1));
        } catch (error) {
          if (error.status !== 404) throw error;
          base = `/users/${enc(who)}/repos`;
          return map(await client.get(base, { per_page: 100, page: 1, type: 'owner' }));
        }
      }, async (page) => map(await client.get(base, { per_page: 100, page, ...(base.startsWith('/users') ? { type: 'owner' } : { type: 'all' }) })));
    } else if (source.provider === 'gitlab') {
      let base = `/groups/${enc(who)}/projects`;
      const query = (page) => ({ per_page: 100, page, include_subgroups: base.startsWith('/groups') ? 'true' : undefined, order_by: 'path', sort: 'asc', statistics: 'true' });
      const map = (body) => ({ list: (body ?? []).map((r) => listed(r.path_with_namespace, r.http_url_to_repo, r.default_branch, r.statistics?.repository_size ?? null, r.archived)), more: (body ?? []).length === 100 });
      await pages(async () => {
        try {
          return map(await client.get(base, query(1)));
        } catch (error) {
          if (error.status !== 404) throw error;
          base = `/users/${enc(who)}/projects`;
          return map(await client.get(base, query(1)));
        }
      }, async (page) => map(await client.get(base, query(page))));
    } else if (source.provider === 'azure') {
      const body = await client.get(`${who ? `/${enc(who)}` : ''}/_apis/git/repositories`, { 'api-version': '7.1' });
      out.push(...(body?.value ?? []).map((r) => listed(`${r.project?.name ?? who}/${r.name}`, r.remoteUrl, String(r.defaultBranch ?? '').replace(/^refs\/heads\//, ''), r.size ?? null, r.isDisabled === true)).filter(Boolean));
    } else if (source.cloud) {
      const map = (body) => ({ list: (body?.values ?? []).map((r) => listed(r.full_name, (r.links?.clone ?? []).find((l) => l.name === 'https')?.href, r.mainbranch?.name, r.size ?? null, false)), more: Boolean(body?.next) });
      await pages(async () => map(await client.get(`/repositories/${enc(who)}`, { pagelen: 100, page: 1 })), async (page) => map(await client.get(`/repositories/${enc(who)}`, { pagelen: 100, page })));
    } else {
      let start = 0;
      const get = async () => {
        const body = await client.get(`/rest/api/1.0/projects/${enc(who)}/repos`, { limit: 100, start });
        start = body?.nextPageStart ?? 0;
        return { list: (body?.values ?? []).map((r) => listed(`${r.project?.key ?? who}/${r.slug}`, (r.links?.clone ?? []).find((l) => l.name === 'http')?.href, '', null, r.archived === true)), more: body?.isLastPage === false };
      };
      await pages(get, get);
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw fail(400, `${source.label} refused the token: check it may read ${who || 'the organisation'}'s repositories.`);
    if (error.status === 404) throw fail(404, `${source.label} has no ${who || 'organisation'} that this token may read.`);
    throw fail(502, `${source.label} could not be read: ${redact(error.message, source.secrets).slice(0, 200)}`);
  }
  const unique = [...new Map(out.map((r) => [r.url, r])).values()].sort((a, b) => a.path.localeCompare(b.path));
  return { repositories: unique.slice(0, max), more: more || unique.length > max };
}

// ---- Counting one repository --------------------------------------------------------------------

const safeBranch = (b) => typeof b === 'string' && b.length > 0 && b.length <= 200 && /^[\w./@+-]+$/.test(b) && !b.startsWith('-') && !b.includes('..') && !b.endsWith('.lock');

/** What git said, in words: never the token, never more than a line. */
function gitProblem(error, repo, secrets, limits) {
  if (error.tooBig) return `Over ${Math.round(limits.repoBytes / 1024 ** 3)} GB: not counted. Count it with cloc where the code is, and upload the result.`;
  if (error.timedOut) return `Took longer than ${Math.round(limits.timeoutMs / 60_000)} minutes: not counted.`;
  if (error.code === 'ENOENT') return 'Git is not installed on this computer: install it from https://git-scm.com, then count again.';
  const said = redact(`${error.stderr ?? ''}\n${error.message ?? ''}`, secrets);
  if (/authentication failed|could not read username|401|403|access denied|not authorized|permission/i.test(said)) return `${repo.host} refused: check the token may read this repository.`;
  if (/remote branch .* not found/i.test(said)) return 'That branch is not in the repository.';
  if (/not found|does not exist|404/i.test(said)) return `Not found on ${repo.host}, or the token may not read it.`;
  if (/could not resolve host|failed to connect|timed out|connection refused/i.test(said)) return `${repo.host} could not be reached.`;
  if (/redirect/i.test(said)) return `${repo.host} sent the request elsewhere (the repository may have moved): give its new address.`;
  const line = said.split('\n').map((l) => l.replace(/^(fatal|error):\s*/i, '').trim()).find(Boolean) ?? 'Git stopped.';
  return line.slice(0, 200);
}

/**
 * One repository's code lines: its default branch (or `branch`) at its latest commit, fetched into a
 * folder of its own and deleted as soon as it is counted. `source` gives the header for its host
 * (none for another host: a public repository still counts). `allowHost(hostname)`: may it be called.
 */
export async function countRepository(repo, { source = null, allowHost = () => true, tmpRoot = os.tmpdir(), limits = GIT_COUNT_LIMITS, onProgress = () => {}, bin = 'git' } = {}) {
  const address = repoAddress(repo.url);
  if (!allowHost(address.hostname)) throw fail(400, `Repositories on ${address.hostname} are not counted: connect that host on the Beta page, or add it to SCM_ALLOWED_HOSTS.`);
  await checkResolved(address.hostname);
  const secrets = source?.secrets ?? [];
  const env = gitEnv(source?.authFor(address) ?? '', { http: address.url.startsWith('http:') });
  const dir = fs.mkdtempSync(path.join(tmpRoot, TEMP_PREFIX));
  fs.chmodSync(dir, 0o700);
  const stop = new AbortController();
  const reason = {};
  const timer = setTimeout(() => {
    reason.timedOut = true;
    stop.abort();
  }, limits.timeoutMs);
  const watch = setInterval(() => {
    if (folderBytes(dir) > limits.repoBytes) {
      reason.tooBig = true;
      stop.abort();
    }
  }, 1000);
  const opts = { env, signal: stop.signal, bin };
  try {
    onProgress({ state: 'fetching' });
    const branch = safeBranch(repo.branch) ? repo.branch : '';
    const bare = path.join(dir, 'repo.git');
    await git(['clone', '--quiet', '--bare', '--depth', '1', '--single-branch', '--no-tags', ...(branch ? ['--branch', branch] : []), '--', address.url, bare], opts);
    clearInterval(watch);
    if (folderBytes(dir) > limits.repoBytes) throw Object.assign(new Error('too big'), { tooBig: true });
    const commit = (await git(['-C', bare, 'rev-parse', 'HEAD'], opts)).toString('utf8').trim();
    const head = branch || (await git(['-C', bare, 'symbolic-ref', '--short', 'HEAD'], opts).then((b) => b.toString('utf8').trim()).catch(() => ''));
    const entries = (await listTree(bare, opts)).filter((e) => candidate(e.path));
    const count = tally();
    const wanted = [];
    const paths = new Map();
    for (const entry of entries) {
      if (entry.size > limits.fileBytes) count.skipped.large += 1;
      else if (paths.has(entry.oid)) count.skipped.duplicate += 1;
      else {
        paths.set(entry.oid, entry.path);
        wanted.push(entry.oid);
      }
    }
    let done = 0;
    let said = 0;
    onProgress({ state: 'counting', done, total: wanted.length });
    await readBlobs(bare, wanted, (oid, body) => {
      count.add(paths.get(oid), body);
      done += 1;
      if (Date.now() - said > 250) {
        said = Date.now();
        onProgress({ state: 'counting', done, total: wanted.length });
      }
    }, opts);
    onProgress({ state: 'counting', done, total: wanted.length });
    return { name: address.name, url: address.url, host: address.host, path: address.path, branch: head, commit: commit.slice(0, 7), ...count.result() };
  } catch (error) {
    if (error.status) throw error;
    throw fail(502, gitProblem(Object.assign(error, reason), address, secrets, limits));
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Folders a count left behind when the process stopped mid-way (a crash, a restart): removed. */
export function sweepLeftovers(tmpRoot = os.tmpdir(), { olderThanMs = 60 * 60_000 } = {}) {
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
      const dir = path.join(tmpRoot, entry.name);
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs < olderThanMs) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch {}
    }
  } catch {}
  return removed;
}

// ---- Counts, followed by the page --------------------------------------------------------------

/** The repositories asked for: up to 50 clone addresses (each once), with a name and branch when listed. */
export function cleanRepositories(list, limits = GIT_COUNT_LIMITS) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) throw fail(400, 'Tick or paste at least one repository.');
  const out = new Map();
  for (const item of items.slice(0, 1000)) {
    const address = repoAddress(typeof item === 'string' ? item : item?.url);
    if (!out.has(address.url)) out.set(address.url, { url: address.url, name: address.name, branch: safeBranch(item?.branch) ? item.branch : '' });
  }
  if (out.size > limits.repositories) throw fail(400, `At most ${limits.repositories} repositories a count: tick fewer, and count the rest after.`);
  return [...out.values()];
}

/**
 * The counts running and just finished, each one person's: started, then followed (view) until done.
 * The source (and its token) is held by the count while it runs and let go when it ends; a view never
 * has it. `maxRunning`: counts at once on this server.
 */
export function createGitCounter({ allowHost = () => true, tmpRoot = os.tmpdir(), limits = GIT_COUNT_LIMITS, maxRunning = 2, keepMs = 30 * 60_000, log = () => {}, bin = 'git' } = {}) {
  const jobs = new Map();
  const prune = () => {
    for (const [id, job] of jobs) if (job.state !== 'running' && Date.now() - Date.parse(job.finishedAt) > keepMs) jobs.delete(id);
  };
  const view = (job) => ({
    id: job.id,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    host: job.host,
    repositories: job.repositories.map((r) => ({ ...r })),
  });
  return {
    get running() {
      return [...jobs.values()].filter((j) => j.state === 'running').length;
    },
    /** Start counting `repositories` for `owner` (who asked) with `source`; resolves the count as the page sees it. */
    async start(owner, { source, repositories }) {
      prune();
      const list = cleanRepositories(repositories, limits);
      if ([...jobs.values()].some((j) => j.owner === owner && j.state === 'running')) throw fail(409, 'A count is already running: wait for it to end.');
      if (this.running >= maxRunning) throw fail(409, 'Other counts are running on this server: try again in a few minutes.');
      const missing = await gitMissing(bin);
      if (missing) throw fail(409, missing);
      const job = {
        id: randomUUID(),
        owner,
        state: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        host: source?.gitHost ?? '',
        repositories: list.map((r) => ({ name: r.name, url: r.url, branch: r.branch, state: 'waiting', done: 0, total: 0, commit: '', lines: null, languages: null, error: '' })),
      };
      jobs.set(job.id, job);
      let held = source;
      let next = 0;
      const worker = async () => {
        while (next < list.length) {
          const index = next;
          next += 1;
          const row = job.repositories[index];
          try {
            const result = await countRepository(list[index], { source: held, allowHost, tmpRoot, limits, bin, onProgress: (p) => Object.assign(row, p) });
            Object.assign(row, { state: 'done', name: result.name, host: result.host, path: result.path, branch: result.branch, commit: result.commit, lines: result.lines, languages: result.languages, files: result.files, skipped: result.skipped, countedAt: new Date().toISOString() });
          } catch (error) {
            Object.assign(row, { state: 'failed', error: error.status ? redact(error.message, held?.secrets) : 'Not counted: something went wrong.' });
            if (!error.status) log(`[calculator] Counting ${row.url} from git failed: ${redact(error.stack ?? error.message, held?.secrets)}`);
          }
        }
      };
      Promise.all(Array.from({ length: Math.min(limits.concurrency, list.length) }, worker)).finally(() => {
        held = null;
        Object.assign(job, { state: 'done', finishedAt: new Date().toISOString() });
      });
      return view(job);
    },
    /** A count as the page follows it: only its owner's. */
    view(owner, id) {
      prune();
      const job = jobs.get(String(id ?? ''));
      if (!job || job.owner !== owner) throw fail(404, 'That count is no longer here: count again.');
      return view(job);
    },
  };
}

// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Languages by file extension or name: their category (what counts toward Fusion lines of code by
// default) and comment syntax, for counting code, comment and blank lines like cloc does.
//
// Categories: code (programming languages), markup (HTML/templates), iac (infrastructure as code),
// data (JSON/YAML/XML/config), docs (Markdown, text).

const C = { line: ['//'], block: [['/*', '*/']] };
const HASH = { line: ['#'], block: [] };
const SQL = { line: ['--'], block: [['/*', '*/']] };
const XMLC = { line: [], block: [['<!--', '-->']] };
const NONE = { line: [], block: [] };

const L = (name, category, syntax, exts = [], files = []) => ({ name, category, ...syntax, exts, files });

const TABLE = [
  L('Java', 'code', C, ['java']),
  L('Kotlin', 'code', C, ['kt', 'kts']),
  L('Scala', 'code', C, ['scala', 'sc']),
  L('Groovy', 'code', C, ['groovy', 'gvy', 'gradle'], []),
  L('C', 'code', C, ['c']),
  L('C/C++ Header', 'code', C, ['h', 'hh', 'hpp', 'hxx']),
  L('C++', 'code', C, ['cpp', 'cc', 'cxx', 'c++', 'ino']),
  L('C#', 'code', C, ['cs', 'csx']),
  L('Objective-C', 'code', C, ['m', 'mm']),
  L('Swift', 'code', C, ['swift']),
  L('Go', 'code', C, ['go']),
  L('Rust', 'code', C, ['rs']),
  L('Dart', 'code', C, ['dart']),
  L('JavaScript', 'code', C, ['js', 'mjs', 'cjs', 'jsx']),
  L('TypeScript', 'code', C, ['ts', 'tsx', 'mts', 'cts']),
  L('Vue', 'markup', { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']] }, ['vue']),
  L('Svelte', 'markup', { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']] }, ['svelte']),
  L('PHP', 'code', { line: ['//', '#'], block: [['/*', '*/']] }, ['php', 'phtml', 'php3', 'php4', 'php5', 'phps']),
  L('Python', 'code', { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]] }, ['py', 'pyw', 'pyi']),
  L('Ruby', 'code', { line: ['#'], block: [['=begin', '=end']] }, ['rb', 'rake', 'gemspec'], ['Rakefile', 'Gemfile']),
  L('Perl', 'code', { line: ['#'], block: [['=pod', '=cut']] }, ['pl', 'pm', 't']),
  L('Shell', 'code', HASH, ['sh', 'bash', 'zsh', 'ksh', 'fish']),
  L('PowerShell', 'code', { line: ['#'], block: [['<#', '#>']] }, ['ps1', 'psm1', 'psd1']),
  L('Batch', 'code', { line: ['REM ', 'rem ', '::'], block: [] }, ['bat', 'cmd']),
  L('Lua', 'code', { line: ['--'], block: [['--[[', ']]']] }, ['lua']),
  L('R', 'code', HASH, ['r']),
  L('Julia', 'code', { line: ['#'], block: [['#=', '=#']] }, ['jl']),
  L('Elixir', 'code', HASH, ['ex', 'exs']),
  L('Erlang', 'code', { line: ['%'], block: [] }, ['erl', 'hrl']),
  L('Haskell', 'code', { line: ['--'], block: [['{-', '-}']] }, ['hs', 'lhs']),
  L('Clojure', 'code', { line: [';'], block: [] }, ['clj', 'cljs', 'cljc', 'edn']),
  L('F#', 'code', { line: ['//'], block: [['(*', '*)']] }, ['fs', 'fsi', 'fsx']),
  L('OCaml', 'code', { line: [], block: [['(*', '*)']] }, ['ml', 'mli']),
  L('Visual Basic', 'code', { line: ["'"], block: [] }, ['vb', 'vbs', 'bas', 'cls', 'frm']),
  L('VB.NET Razor', 'markup', { line: [], block: [['@*', '*@'], ['<!--', '-->']] }, ['vbhtml']),
  L('Razor', 'markup', { line: [], block: [['@*', '*@'], ['<!--', '-->']] }, ['cshtml', 'razor']),
  L('ASP.NET', 'markup', { line: [], block: [['<%--', '--%>'], ['<!--', '-->']] }, ['aspx', 'ascx', 'asax', 'ashx', 'asmx', 'master']),
  L('JSP', 'markup', { line: [], block: [['<%--', '--%>'], ['<!--', '-->']] }, ['jsp', 'jspx', 'tag']),
  L('Apex', 'code', C, ['apex', 'trigger']),
  L('Visualforce', 'markup', XMLC, ['page', 'component']),
  L('ABAP', 'code', { line: ['"', '*'], block: [] }, ['abap']),
  L('COBOL', 'code', { line: ['*>'], block: [] }, ['cbl', 'cob', 'cpy']),
  L('PL/SQL', 'code', SQL, ['pls', 'plsql', 'pkb', 'pks']),
  L('SQL', 'code', SQL, ['sql']),
  L('Solidity', 'code', C, ['sol']),
  L('Zig', 'code', { line: ['//'], block: [] }, ['zig']),
  L('Nim', 'code', { line: ['#'], block: [['#[', ']#']] }, ['nim']),
  L('Crystal', 'code', HASH, ['cr']),
  L('Fortran', 'code', { line: ['!'], block: [] }, ['f', 'f90', 'f95', 'f03', 'for']),
  L('Pascal', 'code', { line: ['//'], block: [['{', '}'], ['(*', '*)']] }, ['pas', 'dpr']),
  L('Assembly', 'code', { line: [';', '#'], block: [] }, ['asm', 's']),
  L('CoffeeScript', 'code', { line: ['#'], block: [['###', '###']] }, ['coffee']),
  L('Elm', 'code', { line: ['--'], block: [['{-', '-}']] }, ['elm']),
  L('HTML', 'markup', XMLC, ['html', 'htm', 'xhtml']),
  L('CSS', 'markup', { line: [], block: [['/*', '*/']] }, ['css']),
  L('SCSS', 'markup', C, ['scss', 'sass', 'less', 'styl']),
  L('Template', 'markup', { line: [], block: [['{{!--', '--}}'], ['{#', '#}'], ['<!--', '-->']] }, ['hbs', 'handlebars', 'mustache', 'ejs', 'erb', 'twig', 'j2', 'jinja', 'jinja2', 'njk', 'liquid', 'pug', 'jade', 'haml', 'slim']),
  L('Terraform', 'iac', { line: ['#', '//'], block: [['/*', '*/']] }, ['tf', 'tfvars', 'hcl']),
  L('Bicep', 'iac', C, ['bicep']),
  L('Dockerfile', 'iac', HASH, ['dockerfile'], ['Dockerfile', 'Containerfile']),
  L('Makefile', 'code', HASH, ['mk', 'mak'], ['Makefile', 'makefile', 'GNUmakefile']),
  L('CMake', 'code', HASH, ['cmake'], ['CMakeLists.txt']),
  L('YAML', 'data', HASH, ['yaml', 'yml']),
  L('JSON', 'data', NONE, ['json', 'jsonc', 'json5']),
  L('XML', 'data', XMLC, ['xml', 'xsd', 'xsl', 'xslt', 'wsdl', 'config', 'csproj', 'vbproj', 'fsproj', 'props', 'targets', 'plist', 'resx', 'xaml', 'svg']),
  L('TOML', 'data', HASH, ['toml']),
  L('INI', 'data', { line: [';', '#'], block: [] }, ['ini', 'cfg', 'conf', 'properties', 'env']),
  L('Protocol Buffers', 'code', C, ['proto']),
  L('GraphQL', 'code', HASH, ['graphql', 'gql']),
  L('Markdown', 'docs', XMLC, ['md', 'markdown', 'mdx', 'rst', 'adoc']),
  L('Text', 'docs', NONE, ['txt']),
];

const BY_EXT = new Map();
const BY_FILE = new Map();
for (const lang of TABLE) {
  for (const e of lang.exts) if (!BY_EXT.has(e)) BY_EXT.set(e, lang);
  for (const f of lang.files) BY_FILE.set(f, lang);
}

const BY_NAME = new Map(TABLE.map((l) => [l.name.toLowerCase(), l]));
// GitHub's language names (linguist) where they differ from this table's.
const ALIASES = { 'c++': 'C++', 'objective-c': 'Objective-C', hcl: 'Terraform', vue: 'Vue', svelte: 'Svelte', scss: 'SCSS', less: 'Less', dockerfile: 'Dockerfile', makefile: 'Makefile', 'vim script': 'Vim Script', batchfile: 'Batch', 'f#': 'F#', 'c#': 'C#' };

/** The language with this name (GitHub's names included), or null. */
export function languageByName(name) {
  const key = String(name || '').toLowerCase();
  return BY_NAME.get(key) ?? BY_NAME.get(String(ALIASES[key] || '').toLowerCase()) ?? null;
}

/** The language of a path, or null when it is not a source file this tool knows. */
export function languageOf(path) {
  const base = path.split('/').pop();
  if (BY_FILE.has(base)) return BY_FILE.get(base);
  if (/^Dockerfile\./.test(base)) return BY_FILE.get('Dockerfile');
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXT.get(base.slice(dot + 1).toLowerCase()) ?? null;
}

// Directories and files that are dependencies, build output or generated, never counted.
export const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'third_party', 'thirdparty', 'third-party',
  'dist', 'build', 'out', 'target', 'bin', 'obj', '.next', '.nuxt', '.output', '.svelte-kit', '.angular', 'coverage',
  '.gradle', '.mvn', '.idea', '.vscode', '.vs', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  'site-packages', 'Pods', 'Carthage', 'DerivedData', '.terraform', '.serverless', '_build',
]);

const GENERATED = [
  /\.min\.(js|css)$/i, /[.-]bundle\.js$/i, /\.map$/i, /(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)composer\.lock$/, /(^|\/)Gemfile\.lock$/, /(^|\/)poetry\.lock$/, /(^|\/)Cargo\.lock$/, /(^|\/)go\.sum$/,
  /\.pb\.go$/, /_pb2\.py$/, /\.g\.cs$/, /\.designer\.cs$/i, /\.generated\.\w+$/i,
];

export function isExcludedPath(path) {
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) if (DEFAULT_EXCLUDED_DIRS.has(parts[i])) return true;
  return GENERATED.some((re) => re.test(path));
}

/**
 * A glob (*, **, ?) as a RegExp matched against the whole path. A double star followed by a slash
 * matches whole folders only, which keeps matching close to linear even on long hostile paths.
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          re += '(?:[^/]*/)*';
          i++;
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

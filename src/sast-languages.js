/**
 * The languages (primary and secondary), frameworks and file extensions Checkmarx One's traditional SAST engine
 * supports (Engine Pack 9.7.7), as listed on
 * https://docs.checkmarx.com/en/34965-149060-sast-scanner---supported-languages-and-frameworks.html
 *
 * An AI-generated SAST result is Fusion's when its language (or framework) is one of these: the AI engine and the
 * traditional engine both cover it. One in any other language is LAST's (language-agnostic static testing): the
 * AI engine alone covers it.
 */

export const SAST_SUPPORT = [
  { language: 'Java', aliases: ['Java', 'J2SE', 'J2EE'], frameworks: ['ATG DSP Taglib', 'GWT', 'Hibernate', 'Google Guice', 'Java Server Faces (JSF)', 'JSP', 'JSTL FMT Taglib', 'OWASP ESAPI', 'MyBatis', 'PrimeFaces', 'Spring Boot', 'Spring MVC', 'Spring', 'Struts', 'Velocity'], extensions: ['java', 'jsp', 'jspf', 'jsf', 'tag', 'tld', 'mf', 'xhtml', 'vm', 'gradle', 'properties', 'jspdsbld', 'wod', 'xml', 'yml', 'yaml'] },
  { language: 'C#', aliases: ['C#', 'CSharp', 'CS', 'ASP.NET'], frameworks: ['ASP.NET Core', 'ASP.Net Core Razor', 'ASP.Net MVC', 'Enterprise Libraries', 'ComponentArt', 'Entity Framework', 'Hibernate.Net', 'Infragistics', 'iBatis', 'Telerik', 'Dapper', '.Net Core', '.Net Framework', '.NET', 'Razor'], extensions: ['cs', 'cshtml', 'xaml', 'vb', 'config', 'aspx', 'ascx', 'asax', 'tag', 'master', 'xml'] },
  { language: 'VB.NET', aliases: ['VB.NET', 'VbNet', 'VB'], frameworks: [], extensions: ['vb'] },
  { language: 'ASP', aliases: ['ASP'], frameworks: [], extensions: ['asp', 'inc'] },
  { language: 'VB6', aliases: ['VB6'], frameworks: [], extensions: ['bas', 'vbp', 'frm', 'cls', 'dsr', 'ctl'] },
  { language: 'C', aliases: ['C'], frameworks: ['C MISRA', 'Informix ESQL/C', 'MySQL', 'stdlib library'], extensions: ['cpp', 'c', 'cc', 'c++', 'cxx', 'hpp', 'hh', 'h++', 'hxx', 'h', 'ec', 'cmake', 'pc', 'pro', 'ac', 'am', 'txt', 'ph'] },
  { language: 'C++', aliases: ['C++', 'CPP', 'CPlusPlus'], frameworks: ['C++ MISRA', 'Boost library'], extensions: [] },
  { language: 'PHP', aliases: ['PHP'], frameworks: ['bWapp', 'CakePHP', 'Kohana', 'Symfony', 'Smarty', 'Zend'], extensions: ['php', 'php3', 'php4', 'php5', 'phtm', 'phtml', 'tpl', 'ctp', 'twig', 'inc', 'cgi', 'env', 'ini'] },
  { language: 'Apex', aliases: ['Apex'], frameworks: ['VisualForce', 'Lightning (Aura)', 'Lightning Web Components', 'Salesforce'], extensions: ['apex', 'apexp', 'apxc', 'page', 'component', 'cls', 'trigger', 'tgr', 'object', 'report', 'workflow', 'xml'] },
  { language: 'Ruby', aliases: ['Ruby'], frameworks: ['Ruby on Rails', 'Rails'], extensions: ['rb', 'rhtml', 'rxml', 'rjs', 'erb', 'cgi', 'lock'] },
  { language: 'JavaScript', aliases: ['JavaScript', 'JS'], frameworks: ['Ajax', 'Angular', 'AngularJS', 'Backbone', 'Cordova / PhoneGap', 'Handlebars', 'Hapi.JS', 'JQuery', 'Knockout', 'Kony Visualizer', 'Pug (Jade)', 'React Native', 'ReactJS', 'SAPUI5', 'VueJS', 'XS (SAP)', 'RequireJS', 'Node.js', 'Buffer', 'CryptoJS', 'ExpressJS', 'File System', 'Hapi', 'Mongodb', 'OracleDB', 'Sequelize'], extensions: ['js', 'jsx', 'htm', 'html', 'json', 'ts', 'tsx', 'aspx', 'ascx', 'xsjs', 'xsjslib', 'xsaccess', 'xsapp', 'app', 'evt', 'cmp', 'hbs', 'handlebars', 'jade', 'pug', 'vue', 'xml', 'apexp', 'page', 'component', 'cshtml', 'jsf', 'xhtml', 'jsp', 'jspf', 'asp', 'master', 'php'] },
  { language: 'TypeScript', aliases: ['TypeScript', 'TS'], frameworks: [], extensions: ['ts', 'tsx'] },
  { language: 'VBScript', aliases: ['VBScript', 'VB script'], frameworks: [], extensions: ['vbs', 'aspx', 'ascx', 'asp', 'cshtml', 'html', 'htm', 'master'] },
  { language: 'Perl', aliases: ['Perl'], frameworks: [], extensions: ['pl', 'pm', 'plx', 'psgi', 'cgi'] },
  { language: 'Android (Java)', aliases: ['Android'], frameworks: ['Volley'], extensions: ['java', 'kt'] },
  { language: 'Objective-C', aliases: ['Objective-C', 'ObjectiveC', 'Objc'], frameworks: [], extensions: ['m', 'h', 'swift', 'xib', 'plist'] },
  { language: 'Swift', aliases: ['Swift'], frameworks: [], extensions: [] },
  { language: 'HTML 5', aliases: ['HTML 5', 'HTML'], frameworks: [], extensions: ['html', 'htm'] },
  { language: 'PL/SQL', aliases: ['PL/SQL', 'PL\\SQL', 'PLSQL'], frameworks: [], extensions: ['pls', 'sql', 'pkh', 'pks', 'pkb', 'pck'] },
  { language: 'SQL', aliases: ['SQL', 'TSQL'], frameworks: [], extensions: ['sql', 'tsql'] },
  { language: 'Python', aliases: ['Python'], frameworks: ['Django', 'Flask', 'Jinja and DTL', 'Pandas library', 'Marshmallow'], extensions: ['py', 'gtl', 'csv', 'latex', 'tex', 'html', 'xml', 'txt'] },
  { language: 'Groovy', aliases: ['Groovy'], frameworks: [], extensions: ['groovy', 'gsh', 'gvy', 'gy', 'gsp', 'gradle'] },
  { language: 'Scala', aliases: ['Scala'], frameworks: ['Akka', 'Finagle', 'Finatra'], extensions: ['scala', 'conf'] },
  { language: 'Go', aliases: ['Go', 'GoLang', 'GO Language'], frameworks: ['Protobuf', 'gin-gonic/gin', 'gorilla-mux'], extensions: ['go', 'mod'] },
  { language: 'Kotlin', aliases: ['Kotlin'], frameworks: ['Ktor (Server Side)', 'Vert.x (Server Side)', 'Spring'], extensions: ['kt', 'kts', 'mustache', 'ftl', 'xml'] },
  { language: 'Cobol', aliases: ['Cobol'], frameworks: [], extensions: ['cbl', 'cob', 'eco', 'pco', 'sqb', 'cpy'] },
  { language: 'RPG', aliases: ['RPG'], frameworks: [], extensions: ['rpg', 'rpg38', 'sqlrpg', 'rpgle', 'sqlrpgle', 'dspf'] },
  { language: 'Dart', aliases: ['Dart'], frameworks: ['Flutter'], extensions: ['dart', 'yaml'] },
  { language: 'Lua', aliases: ['Lua'], frameworks: ['OpenResty'], extensions: ['lua', 'conf'] },
  { language: 'Rust', aliases: ['Rust'], frameworks: [], extensions: ['rs', 'toml'] },
];

/** C# → csharp, C++ → cpp, ASP.NET Core → aspnetcore, Node.js → nodejs: case, spaces and punctuation aside. */
export const norm = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/c#/g, 'csharp')
    .replace(/\+\+/g, 'pp')
    .replace(/[^a-z0-9]/g, '');

/** The names a framework goes by: "Pug (Jade)" → pug, jade; "Cordova / PhoneGap"; "ReactJS" → react too. */
function frameworkNames(name) {
  const parts = String(name).replace(/\b(library|server side)\b/gi, '').split(/\s*(?:\/|\(|\)|\band\b)\s*/i);
  const out = new Set([norm(name)]);
  for (const part of parts) {
    const n = norm(part);
    if (n.length < 3) continue;
    out.add(n);
    if (n.endsWith('js') && n.length > 4) out.add(n.slice(0, -2));
  }
  return [...out].filter((n) => n.length >= 3);
}

const BY_NAME = new Map();
const BY_EXTENSION = new Map();
for (const entry of SAST_SUPPORT) {
  for (const a of entry.aliases) BY_NAME.set(norm(a), { language: entry.language, via: 'language' });
  for (const f of entry.frameworks) for (const n of frameworkNames(f)) if (!BY_NAME.has(n)) BY_NAME.set(n, { language: entry.language, framework: f, via: 'framework' });
  for (const e of entry.extensions) if (!BY_EXTENSION.has(e)) BY_EXTENSION.set(e, { language: entry.language, via: 'extension' });
}

/**
 * Whether the traditional SAST engine covers a result: by its language (or a framework named as its language,
 * whole or in part, "JavaScript (React)"); without one, by its group ("TypeScript_CRITICAL") and then its file's
 * extension. Returns { language, framework?, via } when it does, null when it does not (a LAST result).
 */
export function sastCoverage({ language, group, file } = {}) {
  const lang = String(language ?? '').trim();
  if (lang) {
    const whole = BY_NAME.get(norm(lang));
    if (whole) return whole;
    for (const part of lang.split(/[\s/(),_]+/)) {
      const hit = BY_NAME.get(norm(part));
      if (hit) return hit;
    }
    return null;
  }
  const first = String(group ?? '').split('_')[0];
  if (first && BY_NAME.has(norm(first))) return BY_NAME.get(norm(first));
  const ext = /\.([A-Za-z0-9+]+)$/.exec(String(file ?? ''))?.[1]?.toLowerCase();
  return (ext && BY_EXTENSION.get(ext)) || null;
}

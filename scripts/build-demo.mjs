import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.argv[2] || '.runtime/demo');
for (const protectedPath of ['dist', 'backend', 'data', 'demo', 'scripts', 'tests', '.git']) {
  const base = resolve(root, protectedPath), path = relative(base, output);
  if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) throw new Error('Demo output overlaps protected source: ' + protectedPath);
}
if (output === root) throw new Error('Use a separate demo output directory.');
if (existsSync(output) && readdirSync(output).length) throw new Error('Demo output must be empty. Remove the old generated output or select a new path.');
mkdirSync(output, { recursive: true });
const files = ['index.html', 'app.js', 'model.mjs', 'settings.mjs', 'i18n.mjs', 'theme.mjs', 'password-field.mjs', 'style.css', 'themes.css', 'account.css', 'exercise.css', 'logo.svg', 'icon.svg'];
for (const file of files) copyFileSync(resolve(root, 'dist', file), resolve(output, file));
for (const [source, target] of [['auth.mjs', 'auth.mjs'], ['store.mjs', 'demo-store.mjs'], ['banner.mjs', 'demo-banner.mjs'], ['demo.css', 'demo.css']]) copyFileSync(resolve(root, 'demo', source), resolve(output, target));
const htmlPath = resolve(output, 'index.html');
writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace('</head>', '  <link rel="stylesheet" href="/demo.css">\n</head>'));
const appPath = resolve(output, 'app.js');
writeFileSync(appPath, readFileSync(appPath, 'utf8') + '\nwindow.addEventListener("exercise-demo-update", () => { if (authenticated) { void loadMonth(); void loadExercises(); } });\n');
// Pages serves unknown assets as the demo entrypoint; no login page is published.
writeFileSync(resolve(output, '_redirects'), '/login.html / 302\n/login / 302\n');
writeFileSync(resolve(output, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  Content-Security-Policy: default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'\n');
console.log(JSON.stringify({ output, files: readdirSync(output).sort(), apiNetworkAccess: false }, null, 2));

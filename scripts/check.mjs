import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const files = readdirSync(dist);
let checked = 0;
for (const file of files) {
  if (!/\.(mjs|js)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ['--check', resolve(dist, file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `${file}: syntax check failed`);
  for (const match of readFileSync(resolve(dist, file), 'utf8').matchAll(/from\s+['"]([.][^'"]+)['"]/g)) {
    if (!existsSync(resolve(dist, match[1]))) throw new Error(`${file}: missing import ${match[1]}`);
  }
  checked++;
}
for (const file of ['index.html', 'login.html']) {
  const html = readFileSync(resolve(dist, file), 'utf8');
  for (const match of html.matchAll(/(?:src|href)=["'](\/[^"'#?]+)(?:[?#][^"']*)?["']/g)) {
    if (match[1] === '/') continue;
    if (!existsSync(resolve(dist, '.' + match[1]))) throw new Error(`${file}: missing asset ${match[1]}`);
  }
}
console.log(`Passed: ${checked} JavaScript modules and both HTML asset references.`);

import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirectories = new Set(['.git', 'node_modules', 'data', '.wrangler', 'dist-pages']);
const secretPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m,
];
const problems = [];
let checked = 0;

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = resolve(directory, entry.name);
    const path = relative(root, fullPath).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) {
      problems.push(`${path}: symbolic links must not be published`);
    } else if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name) && !entry.name.startsWith('dist-pages-test-')) await scan(fullPath);
    } else if (entry.isFile()) {
      if (path === 'cloudflare/wrangler.jsonc') continue; // Local non-secret deployment IDs, git-ignored.
      if ((/^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') ||
          /^\.dev\.vars/.test(entry.name) || /\.(?:sqlite(?:-wal|-shm)?|db|pem|key|p12|pfx)$/.test(entry.name)) {
        problems.push(`${path}: private runtime or credential file`);
        continue;
      }
      const content = await readFile(fullPath, 'utf8');
      checked++;
      if (secretPatterns.some(pattern => pattern.test(content))) problems.push(`${path}: possible credential material`);
      if (entry.name === '.env.example' && /^\s*(?:ADMIN_KEY|[A-Z_]*TOKEN|[A-Z_]*PASSWORD)\s*=\s*\S+/m.test(content)) {
        problems.push(`${path}: secret-like values are not allowed in the environment template`);
      }
    }
  }
}

await scan(root);
if (problems.length) {
  console.error('Publication checks failed:\n' + problems.map(message => `- ${message}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Publication boundaries checked across ${checked} files. No recognized credential material found.`);
}

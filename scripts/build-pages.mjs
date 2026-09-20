import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateApiOrigin } from '../public/api-config.js';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = resolve(appDirectory, 'public');
export const PAGE_FILES = Object.freeze([
  'index.html', 'admin.html', 'styles.css', 'admin.css', 'app.js', 'admin.js',
  'drawing.js', 'api-config.js', 'favicon.svg',
]);

export async function buildPages({
  apiBaseUrl = process.env.PIXEL_WALL_API_BASE_URL || '',
  outputDirectory = resolve(appDirectory, 'dist-pages'),
} = {}) {
  // Validate before touching a previous build. The URL is public configuration.
  const apiOrigin = apiBaseUrl ? validateApiOrigin(apiBaseUrl) : '';
  const destination = resolve(outputDirectory);
  // Only purpose-specific build folders directly inside this app may be removed.
  if (dirname(destination) !== appDirectory || !/^dist-pages(?:-[A-Za-z0-9_-]+)?$/.test(basename(destination))) {
    throw new Error('The Pages output must be a dist-pages build directory inside this app.');
  }
  const sources = new Map();
  const digest = createHash('sha256').update(apiOrigin).update('\0');
  for (const file of PAGE_FILES) {
    const content = await readFile(resolve(publicDirectory, file), 'utf8');
    sources.set(file, content);
    digest.update(file).update('\0').update(content).update('\0');
  }
  // A backend setting change must invalidate cached modules as well as HTML assets.
  const version = digest.digest('hex').slice(0, 16);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const csp = [
    "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self'", "font-src 'self'", `connect-src ${apiOrigin || "'none'"}`,
    "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  const settings = JSON.stringify({ deployment: 'pages', apiBaseUrl: apiOrigin });
  for (const file of PAGE_FILES) {
    const target = resolve(destination, file);
    let content = sources.get(file);
    if (file.endsWith('.html')) {
      content = content.replace(/(<meta charset="utf-8">)/, `$1\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`)
        .replace(/((?:src|href)="\.\/[^"?#]+\.(?:js|css|svg|html))"/g, `$1?v=${version}"`);
    } else if (file === 'api-config.js') {
      const marker = /\/\* runtime-settings:start \*\/[\s\S]*?\/\* runtime-settings:end \*\//;
      if (!marker.test(content)) throw new Error('The public API settings marker is missing.');
      content = content.replace(marker, `/* runtime-settings:start */ ${settings} /* runtime-settings:end */`);
    }
    if (file.endsWith('.js')) content = content.replace(/(\bfrom\s*['"])(\.\/(?:api-config|drawing)\.js)(['"])/g, `$1$2?v=${version}$3`);
    await writeFile(target, content);
  }
  await writeFile(resolve(destination, '.nojekyll'), '');
  return { directory: destination, apiConfigured: Boolean(apiOrigin), version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await buildPages();
    console.log(result.apiConfigured
      ? 'Pages build ready. Submissions use the configured HTTPS API.'
      : 'Pages build ready. Submissions and organizer access are disabled until PIXEL_WALL_API_BASE_URL is configured.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

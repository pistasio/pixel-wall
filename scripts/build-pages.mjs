import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const csp = [
    "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self'", "font-src 'self'", `connect-src ${apiOrigin || "'none'"}`,
    "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  const settings = JSON.stringify({ deployment: 'pages', apiBaseUrl: apiOrigin });
  for (const file of PAGE_FILES) {
    const source = resolve(publicDirectory, file);
    const target = resolve(destination, file);
    if (file.endsWith('.html')) {
      const html = await readFile(source, 'utf8');
      await writeFile(target, html.replace(/(<meta charset="utf-8">)/, `$1\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`));
    } else if (file === 'api-config.js') {
      const sourceModule = await readFile(source, 'utf8');
      const marker = /\/\* runtime-settings:start \*\/[\s\S]*?\/\* runtime-settings:end \*\//;
      if (!marker.test(sourceModule)) throw new Error('The public API settings marker is missing.');
      await writeFile(target, sourceModule.replace(marker, `/* runtime-settings:start */ ${settings} /* runtime-settings:end */`));
    } else {
      await copyFile(source, target);
    }
  }
  await writeFile(resolve(destination, '.nojekyll'), '');
  return { directory: destination, apiConfigured: Boolean(apiOrigin) };
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

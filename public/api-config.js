// This contains public deployment settings only. Never put organizer keys here.
const runtimeSettings = /* runtime-settings:start */ { deployment: 'server', apiBaseUrl: '' } /* runtime-settings:end */;

export const UNAVAILABLE_MESSAGE = 'Submissions are not connected yet. You can keep creating, but artwork cannot be sent to the club right now.';

export function validateApiOrigin(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error('PIXEL_WALL_API_BASE_URL must be an HTTPS origin.');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('PIXEL_WALL_API_BASE_URL must be an HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || !/^https:\/\/(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]{1,5})?\/?$/.test(value)) {
    throw new Error('PIXEL_WALL_API_BASE_URL must be an HTTPS origin without credentials, paths, queries, or fragments.');
  }
  return url.origin;
}

export function resolveApiConfig(settings) {
  let baseUrl = '';
  let available = false;
  if (settings?.deployment === 'server' && settings.apiBaseUrl === '') {
    available = true;
  } else if (settings?.deployment === 'pages' && settings.apiBaseUrl) {
    try {
      baseUrl = validateApiOrigin(settings.apiBaseUrl);
      available = true;
    } catch { /* Invalid public configuration disables network requests. */ }
  }
  return Object.freeze({
    available,
    message: available ? '' : UNAVAILABLE_MESSAGE,
    url(path) {
      if (!available) throw new Error(UNAVAILABLE_MESSAGE);
      if (typeof path !== 'string' || !/^\/api\/[a-z][a-z0-9/-]*(?:\?[^#\\]*)?$/.test(path)) {
        throw new Error('Invalid API path.');
      }
      return `${baseUrl}${path}`;
    },
  });
}

export const api = resolveApiConfig(runtimeSettings);

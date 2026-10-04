#!/usr/bin/env node
// Zero-dependency static server for the static export in out/ (`npm run preview` after `npm run build`).
// Serves it the way Cloudflare does: headers from out/_headers (COOP/COEP → crossOriginIsolated),
// Cloudflare's default Cache-Control, /path → path.html, 404.html for misses, and correct MIME types.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Usage: node scripts/serve-out.mjs [--port <n>] [--host <host>] [--dir <path>] [--quiet]

Serves the static export like Cloudflare Pages / Workers static assets: headers from <dir>/_headers,
/path → path.html or path/index.html, <dir>/404.html (status 404) for misses.

  --port <n>    Port to listen on (default: $PORT or 3000)
  --host <h>    Interface to bind (default: localhost). Cross-origin isolation and the microphone
                need a secure context, i.e. http://localhost or HTTPS.
  --dir <path>  Directory to serve (default: out)
  --quiet       Do not log requests`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
/** Cloudflare's Cache-Control for static assets when _headers does not set one. */
const DEFAULT_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
/** Configuration files Cloudflare reads but never serves. */
const NOT_SERVED = new Set(['/_headers', '/_redirects', '/_routes.json', '/.assetsignore']);

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`serve-out: ${err.message}\n\n${HELP}`);
  process.exit(1);
}
if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const dir = resolve(ROOT, options.dir);
if (!existsSync(join(dir, 'index.html'))) {
  console.error(`serve-out: ${dir}${sep}index.html not found. Run \`npm run build\` first.`);
  process.exit(1);
}
const headerRules = loadHeaderRules(dir);
const notFoundPage = existsSync(join(dir, '404.html')) ? join(dir, '404.html') : null;

const server = createServer((req, res) => {
  const started = performance.now();
  if (!options.quiet) {
    res.on('finish', () => {
      console.log(`${res.statusCode} ${req.method} ${req.url} ${(performance.now() - started).toFixed(1)} ms`);
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    res.writeHead(400).end();
    return;
  }

  const found = NOT_SERVED.has(pathname) ? null : findFile(dir, pathname);
  const file = found ?? notFoundPage;
  const headers = responseHeaders(headerRules, pathname, req.headers.host ?? 'localhost');
  if (!file) {
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  const stat = statSync(file);
  const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  headers['Content-Type'] ??= MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  headers['Cache-Control'] ??= DEFAULT_CACHE_CONTROL;
  headers.ETag = etag;

  if (found && req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  headers['Content-Length'] = String(stat.size);
  res.writeHead(found ? 200 : 404, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file)
    .on('error', (err) => res.destroy(err))
    .pipe(res);
});

server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `serve-out: port ${options.port} is already in use. Pass --port <n> (or set PORT).`
      : `serve-out: ${err.message}`,
  );
  process.exit(1);
});

server.listen(options.port, options.host, () => {
  const shown = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host;
  console.log(`Serving ${dir} at http://${shown.includes(':') ? `[${shown}]` : shown}:${options.port}`);
  console.log(`  ${headerRules.length} header rule(s) from ${headerRules.source}`);
  console.log('  Press Ctrl+C to stop.');
});

// ---------------------------------------------------------------------------

function parseArgs(args) {
  const opts = { port: Number(process.env.PORT) || 3000, host: 'localhost', dir: 'out', quiet: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    const value = () => {
      const v = inline ?? args[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--port': {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer 0-65535');
        opts.port = port;
        break;
      }
      case '--host':
        opts.host = value();
        break;
      case '--dir':
        opts.dir = value();
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown option ${args[i]}`);
    }
  }
  return opts;
}

/** /a/b → a/b, a/b.html, a/b/index.html; /a/ → a/index.html. Never escapes the served directory. */
function findFile(base, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const candidates = decoded.endsWith('/') ? [`${decoded}index.html`] : [decoded, `${decoded}.html`, `${decoded}/index.html`];
  for (const candidate of candidates) {
    const file = resolve(base, `.${candidate}`);
    if (!file.startsWith(base + sep)) continue;
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// _headers (https://developers.cloudflare.com/workers/static-assets/headers/)
// ---------------------------------------------------------------------------

function loadHeaderRules(base) {
  for (const path of [join(base, '_headers'), join(ROOT, 'public', '_headers')]) {
    if (!existsSync(path)) continue;
    if (!path.startsWith(base)) console.warn(`serve-out: ${base}${sep}_headers missing; using ${path}`);
    const rules = parseHeaderRules(readFileSync(path, 'utf8'), path);
    rules.source = path;
    return rules;
  }
  console.warn('serve-out: no _headers file found; the page will not be cross-origin isolated.');
  return Object.assign([], { source: '(none)' });
}

function parseHeaderRules(text, path) {
  const rules = [];
  let current = null;
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (!/^\s/.test(line)) {
      current = { ...compilePattern(trimmed), set: [], detach: [] };
      rules.push(current);
      return;
    }
    if (!current) throw new Error(`${path}:${index + 1}: header line before any URL pattern`);
    if (trimmed.startsWith('!')) {
      current.detach.push(trimmed.slice(1).trim().toLowerCase());
      return;
    }
    const colon = trimmed.indexOf(':');
    if (colon <= 0) throw new Error(`${path}:${index + 1}: expected "Name: value", got "${trimmed}"`);
    current.set.push([trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim()]);
  });
  return rules;
}

/** `*` is a greedy splat (:splat), `:name` matches one segment; absolute https:// patterns match host + path. */
function compilePattern(pattern) {
  let source = '';
  let last = 0;
  for (const m of pattern.matchAll(/\*|:[A-Za-z]\w*/g)) {
    source += escapeRegExp(pattern.slice(last, m.index));
    source += m[0] === '*' ? '(?<splat>.*)' : `(?<${m[0].slice(1)}>[^/]+)`;
    last = m.index + m[0].length;
  }
  source += escapeRegExp(pattern.slice(last));
  return { absolute: !pattern.startsWith('/'), regex: new RegExp(`^${source}$`) };
}

/** Headers of every matching rule; a header set by several rules is joined with ", " (Cloudflare semantics). */
function responseHeaders(rules, pathname, host) {
  const merged = new Map();
  const detached = new Set();
  for (const rule of rules) {
    const match = rule.regex.exec(rule.absolute ? `https://${host}${pathname}` : pathname);
    if (!match) continue;
    for (const [name, rawValue] of rule.set) {
      const value = rawValue.replace(/:([A-Za-z]\w*)/g, (s, key) => match.groups?.[key] ?? s);
      const previous = merged.get(name.toLowerCase());
      merged.set(name.toLowerCase(), previous ? [previous[0], `${previous[1]}, ${value}`] : [name, value]);
    }
    for (const name of rule.detach) detached.add(name);
  }
  const headers = {};
  for (const [key, [name, value]] of merged) if (!detached.has(key)) headers[canonicalName(name)] = value;
  return headers;
}

/** Normalizes header names so the Content-Type / Cache-Control defaults above do not duplicate rule values. */
function canonicalName(name) {
  return name.toLowerCase().replace(/(^|-)([a-z])/g, (_, dash, letter) => dash + letter.toUpperCase());
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

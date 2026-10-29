#!/usr/bin/env node
'use strict';
/*
 * Shadow-OmniTrace — Multi-Platform Intelligence Toolkit
 * Made by: NullKat Development
 *
 * Single-file Node.js CLI (no runtime dependencies). Target: Android Termux.
 * Only public / officially documented lookup methods are used. Nothing here
 * bypasses logins, CAPTCHAs, rate limits or anti-bot protection.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const VERSION = '1.0.0';
const APP = 'Shadow-OmniTrace';
const UA = `Shadow-OmniTrace/${VERSION} (NullKat Development; public-profile lookup)`;

// ───────────────────────────── paths, env, config ─────────────────────────────

const HOME_DIR = process.env.SHADOW_HOME || path.join(os.homedir(), '.shadow-omnitrace');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
const HISTORY_FILE = path.join(HOME_DIR, 'history.json');
const ENV_FILE_USER = path.join(HOME_DIR, '.env');

const SECRET_KEYS = [
  { key: 'GITHUB_TOKEN', label: 'GitHub token', for: 'GitHub (optional, raises rate limit)' },
  { key: 'YOUTUBE_API_KEY', label: 'YouTube Data API key', for: 'YouTube' },
  { key: 'TWITCH_CLIENT_ID', label: 'Twitch client ID', for: 'Twitch' },
  { key: 'TWITCH_CLIENT_SECRET', label: 'Twitch client secret', for: 'Twitch' },
  { key: 'REDDIT_CLIENT_ID', label: 'Reddit app client ID', for: 'Reddit' },
  { key: 'REDDIT_CLIENT_SECRET', label: 'Reddit app client secret', for: 'Reddit' },
  { key: 'X_BEARER_TOKEN', label: 'X API bearer token', for: 'X' },
  { key: 'INSTAGRAM_ACCESS_TOKEN', label: 'Instagram Graph API token', for: 'Instagram' },
  { key: 'INSTAGRAM_BUSINESS_ID', label: 'Instagram business account ID', for: 'Instagram' },
  { key: 'THREADS_ACCESS_TOKEN', label: 'Threads API token', for: 'Threads' },
  { key: 'PUBG_API_KEY', label: 'PUBG developer API key', for: 'PUBG' },
];

function parseEnvText(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Loads .env files without overriding real environment variables. */
function loadEnvFiles() {
  const files = [path.join(process.cwd(), '.env'), ENV_FILE_USER];
  for (const f of files) {
    try {
      const vars = parseEnvText(fs.readFileSync(f, 'utf8'));
      for (const [k, v] of Object.entries(vars)) {
        if (SECRET_KEYS.some((s) => s.key === k) && process.env[k] === undefined && v) process.env[k] = v;
      }
    } catch (_) { /* file missing: fine */ }
  }
}

const DEFAULTS = {
  color: true,
  animation: true,
  timeoutMs: 10000,
  concurrency: 3,
  defaultPlatforms: ['github', 'telegram', 'medium', 'reddit', 'youtube', 'twitch'],
  persistHistory: true,
  historyLimit: 50,
  reportDir: path.join(os.homedir(), 'shadow-omnitrace', 'reports'),
  cacheTtlSec: 300,
  pubgShard: 'steam',
};

let config = { ...DEFAULTS };

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (saved[k] !== undefined && typeof saved[k] === typeof DEFAULTS[k]) config[k] = saved[k];
  } catch (_) { config = { ...DEFAULTS }; }
}

/** Atomic write: temp file + rename, so an interrupted save never corrupts data. */
function atomicWrite(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function saveConfig() {
  try { atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2)); return true; } catch (_) { return false; }
}

function hasSecret(key) { return Boolean(process.env[key] && String(process.env[key]).trim()); }

/** Removes any configured secret value from text (defence in depth for logs/reports). */
function redact(text) {
  let s = String(text == null ? '' : text);
  for (const { key } of SECRET_KEYS) {
    const v = process.env[key];
    if (v && v.length >= 6) s = s.split(v).join('[redacted]');
  }
  return s.replace(/([?&](?:access_token|api_key|key|client_secret)=)[^&\s]+/gi, '$1[redacted]');
}

// ───────────────────────────── terminal & colors ─────────────────────────────

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const stdout = process.stdout;
const isTTY = Boolean(stdout.isTTY && process.stdin.isTTY);

function colorLevel() {
  if (flag('--no-color') || process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb') return 0;
  if (!config.color) return 0;
  if (!stdout.isTTY && !process.env.FORCE_COLOR) return 0;
  const ct = String(process.env.COLORTERM || '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return 3;
  return 2;
}

function animationOn() {
  if (flag('--no-animation') || process.env.SHADOW_NO_ANIM || process.env.CI) return false;
  return Boolean(config.animation && isTTY && colorLevel() > 0);
}

function to256(r, g, b) {
  const q = (v) => Math.round(v / 255 * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Foreground color from RGB, adapting to the terminal's capability. */
function rgb(r, g, b, text) {
  const lv = colorLevel();
  if (lv === 0) return text;
  const code = lv === 3 ? `38;2;${r};${g};${b}` : `38;5;${to256(r, g, b)}`;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function sgr(code, text) { return colorLevel() === 0 ? text : `\x1b[${code}m${text}\x1b[0m`; }
const c = {
  red: (t) => rgb(255, 40, 60, t),
  neon: (t) => sgr('1;38;5;196', t),
  deep: (t) => sgr('38;5;124', t),
  ember: (t) => sgr('38;5;52', t),
  dim: (t) => sgr('2', t),
  bold: (t) => sgr('1', t),
  white: (t) => sgr('38;5;253', t),
  green: (t) => sgr('38;5;78', t),
  yellow: (t) => sgr('38;5;221', t),
  orange: (t) => sgr('38;5;208', t),
  blue: (t) => sgr('38;5;75', t),
  grey: (t) => sgr('38;5;245', t),
  violet: (t) => sgr('38;5;141', t),
};

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, '');
const vlen = (s) => stripAnsi(s).length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - vlen(s)));

function width() {
  const cols = stdout.columns || 60;
  return Math.max(32, Math.min(cols - 2, 62));
}

function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

function wrap(text, w) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if ((line + ' ' + word).trim().length > w) { if (line) out.push(line); line = word.length > w ? word.slice(0, w) : word; }
      else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out;
}

let lineCounter = 0;
function print(s = '') {
  const text = String(s);
  stdout.write(text + '\n');
  lineCounter += text.split('\n').length;
}
const rule = (ch = '─') => c.deep(ch.repeat(width()));
const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kv(label, value, labelWidth = 16) {
  const w = width();
  const valueWidth = Math.max(10, w - labelWidth - 2);
  const lines = wrap(String(value), valueWidth);
  print(`${c.grey(pad(label, labelWidth))}  ${lines[0] || ''}`);
  for (const l of lines.slice(1)) print(`${' '.repeat(labelWidth)}  ${l}`);
}

// ───────────────────────────── result states ─────────────────────────────

const STATES = {
  FOUND: { glyph: '●', paint: c.green, meaning: 'Account confirmed through a reliable source' },
  'NOT FOUND': { glyph: '○', paint: c.blue, meaning: 'Lookup method gives sufficient evidence the account does not exist' },
  UNVERIFIED: { glyph: '◐', paint: c.yellow, meaning: 'Evidence cannot confirm or deny existence' },
  UNAVAILABLE: { glyph: '⊘', paint: c.violet, meaning: 'No supported lookup method (or credentials missing)' },
  'RATE LIMITED': { glyph: '◔', paint: c.orange, meaning: 'Source asked us to slow down; nothing concluded' },
  ERROR: { glyph: '✖', paint: c.red, meaning: 'Genuine technical failure (network, timeout, API error)' },
  SKIPPED: { glyph: '–', paint: c.grey, meaning: 'Username invalid for this platform; no request sent' },
};
const stateTag = (s) => (STATES[s] || STATES.ERROR).paint(`${(STATES[s] || STATES.ERROR).glyph} ${s}`);

// ───────────────────────────── HTTP layer ─────────────────────────────
// One place for timeouts, cancellation, retry/backoff and rate-limit awareness.

const hostGate = new Map(); // host -> epoch ms before which we must not call again
const netStatus = { tested: false, ok: null, at: null, detail: null };

function retryAfterSeconds(h) {
  const ra = h.get('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return Math.min(Math.max(n, 1), 3600);
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return Math.min(Math.max(Math.ceil((d - Date.now()) / 1000), 1), 3600);
  }
  const reset = Number(h.get('x-ratelimit-reset') || h.get('x-rate-limit-reset'));
  if (Number.isFinite(reset) && reset > 1e9) return Math.min(Math.max(Math.ceil(reset - Date.now() / 1000), 1), 3600);
  return 30;
}

async function http(url, opts = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = config.timeoutMs, signal } = opts;
  const host = new URL(url).host;
  const empty = () => new Headers();
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = (hostGate.get(host) || 0) - Date.now();
    if (wait > 0) {
      if (wait <= 3000) await sleep(wait);
      else return { ok: false, status: 429, rateLimited: true, retryAfterSec: Math.ceil(wait / 1000), headers: empty(), body: '' };
    }
    if (signal && signal.aborted) return { ok: false, status: 0, headers: empty(), body: '', error: { type: 'cancelled', message: 'Cancelled by user' } };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs);
    const onAbort = () => ctl.abort('cancelled');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { method, headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, body, signal: ctl.signal, redirect: 'follow' });
      let text = await res.text();
      if (text.length > 2000000) text = text.slice(0, 2000000);
      const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
      if (limited) {
        const sec = retryAfterSeconds(res.headers);
        hostGate.set(host, Date.now() + sec * 1000);
        if (attempt === 0 && sec <= 2) continue;
        return { ok: false, status: res.status, headers: res.headers, body: text, rateLimited: true, retryAfterSec: sec };
      }
      if (res.status >= 500 && attempt === 0) { await sleep(600); continue; }
      return { ok: res.ok, status: res.status, headers: res.headers, body: text };
    } catch (e) {
      const reason = ctl.signal.aborted ? ctl.signal.reason : null;
      const type = reason === 'timeout' ? 'timeout' : reason === 'cancelled' ? 'cancelled' : 'network';
      if (type === 'network' && attempt === 0) { await sleep(600); continue; }
      const code = e && e.cause && e.cause.code ? ` (${e.cause.code})` : '';
      const message = type === 'timeout' ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : type === 'cancelled' ? 'Cancelled by user' : `${redact((e && e.message) || 'Network failure')}${code}`;
      return { ok: false, status: 0, headers: empty(), body: '', error: { type, message } };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  return { ok: false, status: 0, headers: empty(), body: '', error: { type: 'network', message: 'Request failed after retry' } };
}

const jsonOf = (r) => { try { return JSON.parse(r.body); } catch (_) { return null; } };

function decodeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '').trim();
}

// ───────────────────────────── result helpers ─────────────────────────────

const FIELD_ORDER = [
  ['displayName', 'Display name'], ['bio', 'Biography'], ['avatar', 'Profile picture'], ['verified', 'Verified'],
  ['followers', 'Followers'], ['following', 'Following'], ['posts', 'Posts / items'], ['created', 'Account created'], ['category', 'Category'],
];

function makeResult(p, query, state, x = {}) {
  return {
    platform: p.name, platformId: p.id, query, state,
    profileUrl: x.profileUrl || null,
    fields: x.fields || {},
    extra: x.extra || [],
    note: x.note || null,
    confidence: x.confidence || null,
    source: { name: p.sourceName, url: x.sourceUrl || p.sourceUrl || null },
    httpStatus: x.httpStatus === undefined ? null : x.httpStatus,
    retrievedAt: nowIso(),
    cached: false,
  };
}

/** Returns a RATE LIMITED / ERROR result if the HTTP layer reported a failure, else null. */
function failureResult(p, q, r, x = {}) {
  if (r.rateLimited) return makeResult(p, q, 'RATE LIMITED', { ...x, httpStatus: r.status, note: `Source asked to wait about ${r.retryAfterSec}s. Nothing was concluded about the account.` });
  if (r.error) return makeResult(p, q, 'ERROR', { ...x, note: `${r.error.type === 'timeout' ? 'Timeout' : r.error.type === 'cancelled' ? 'Cancelled' : 'Network failure'}: ${r.error.message}` });
  if (r.status >= 500) return makeResult(p, q, 'ERROR', { ...x, httpStatus: r.status, note: `Source returned HTTP ${r.status} (server error).` });
  return null;
}

const missingKeys = (p) => (p.needs || []).filter((k) => !hasSecret(k));
const isAvailable = (p) => p.kind !== 'unsupported' && missingKeys(p).length === 0;

function platformStatusLabel(p) {
  if (p.kind === 'unsupported') return { label: 'unavailable', paint: c.violet };
  const m = missingKeys(p);
  if (m.length) return { label: 'needs key', paint: c.yellow };
  return { label: p.kind === 'api' ? (p.needs && p.needs.length ? 'ready (api key)' : 'ready (api)') : 'ready (public)', paint: c.green };
}

// ───────────────────────────── token caches (OAuth app-only) ─────────────────────────────

const tokenCache = {};
async function getTwitchToken(signal) {
  const t = tokenCache.twitch;
  if (t && t.exp > Date.now() + 30000) return { token: t.token };
  const body = new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }).toString();
  const r = await http('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal });
  if (r.rateLimited || r.error || r.status >= 500) return { fail: r };
  const j = jsonOf(r);
  if (!r.ok || !j || !j.access_token) return { rejected: true, status: r.status };
  tokenCache.twitch = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return { token: j.access_token };
}

async function getRedditToken(signal) {
  const t = tokenCache.reddit;
  if (t && t.exp > Date.now() + 30000) return { token: t.token };
  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64');
  const r = await http('https://www.reddit.com/api/v1/access_token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal });
  if (r.rateLimited || r.error || r.status >= 500) return { fail: r };
  const j = jsonOf(r);
  if (!r.ok || !j || !j.access_token) return { rejected: true, status: r.status };
  tokenCache.reddit = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return { token: j.access_token };
}

// ───────────────────────────── platform adapters ─────────────────────────────

async function lookupGithub(p, u, ctx) {
  const url = `https://api.github.com/users/${encodeURIComponent(u)}`;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (hasSecret('GITHUB_TOKEN')) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await http(url, { headers, signal: ctx.signal });
  const bad = failureResult(p, u, r); if (bad) return bad;
  if (r.status === 404) return makeResult(p, u, 'NOT FOUND', { httpStatus: 404, confidence: 'High — official API returned 404 for this login', sourceUrl: url });
  if (r.status === 401) return makeResult(p, u, 'ERROR', { httpStatus: 401, note: 'GitHub rejected the configured token (HTTP 401). Remove or fix GITHUB_TOKEN.' });
  const j = jsonOf(r);
  if (!r.ok || !j || !j.login) return makeResult(p, u, 'ERROR', { httpStatus: r.status, note: `Unexpected GitHub response (HTTP ${r.status}).` });
  return makeResult(p, u, 'FOUND', {
    httpStatus: r.status, sourceUrl: url, confidence: 'High — confirmed by official GitHub REST API', profileUrl: j.html_url,
    fields: { displayName: j.name, bio: j.bio, avatar: j.avatar_url, followers: j.followers, following: j.following, posts: j.public_repos, created: j.created_at, category: j.type },
    extra: [['Public gists', j.public_gists]].filter((e) => typeof e[1] === 'number'),
  });
}

async function lookupTelegram(p, u, ctx) {
  const url = `https://t.me/${encodeURIComponent(u)}`;
  const r = await http(url, { signal: ctx.signal, headers: { Accept: 'text/html' } });
  const bad = failureResult(p, u, r); if (bad) return bad;
  if (r.status !== 200) return makeResult(p, u, 'UNVERIFIED', { httpStatus: r.status, sourceUrl: url, note: `t.me answered HTTP ${r.status}; this is not proof either way.` });
  const og = (name) => { const m = r.body.match(new RegExp(`<meta property="og:${name}" content="([^"]*)"`, 'i')); return m ? decodeHtml(m[1]) : null; };
  const ogTitle = og('title');
  const stub = !ogTitle || /^Telegram(: (Contact|Join|View))?\b/i.test(ogTitle) && /@/.test(ogTitle) || ogTitle === 'Telegram';
  if (stub) return makeResult(p, u, 'UNVERIFIED', { httpStatus: 200, sourceUrl: url, confidence: 'Low', note: 't.me returned only the generic contact page. Telegram does not document this as proof that the username is unregistered, so no conclusion is drawn.' });
  let desc = og('description');
  if (desc && /^(If you have Telegram, you can (contact|join|view)|You can (contact|join|view))/i.test(desc)) desc = null;
  const extraM = r.body.match(/<div class="tgme_page_extra">([\s\S]*?)<\/div>/i);
  const extraTxt = extraM ? decodeHtml(extraM[1]) : '';
  const cnt = extraTxt.match(/(\d[\d\s,.]*)\s+(subscribers|members)/i);
  const count = cnt ? Number(cnt[1].replace(/[^\d]/g, '')) : null;
  return makeResult(p, u, 'FOUND', {
    httpStatus: 200, sourceUrl: url, profileUrl: `https://t.me/${u}`, confidence: 'Medium — parsed from the public t.me preview page (not an official API)',
    fields: { displayName: ogTitle, bio: desc, avatar: og('image'), followers: count, category: cnt ? (/subscribers/i.test(cnt[2]) ? 'Channel' : 'Group') : null },
  });
}

async function lookupMedium(p, u, ctx) {
  const url = `https://medium.com/feed/@${encodeURIComponent(u)}`;
  const r = await http(url, { signal: ctx.signal, headers: { Accept: 'application/rss+xml, text/xml' } });
  const bad = failureResult(p, u, r); if (bad) return bad;
  if (r.status === 404) return makeResult(p, u, 'NOT FOUND', { httpStatus: 404, sourceUrl: url, confidence: 'Medium — documented public RSS feed returned 404', });
  if (r.status === 403 || r.status === 401) return makeResult(p, u, 'UNVERIFIED', { httpStatus: r.status, sourceUrl: url, note: 'Medium blocked the request (HTTP ' + r.status + '). Blocks are not treated as "not found" and no bypass is attempted.' });
  if (!r.ok || !/<rss|<feed/i.test(r.body)) return makeResult(p, u, 'UNVERIFIED', { httpStatus: r.status, sourceUrl: url, note: 'Response was not a Medium RSS feed; cannot confirm.' });
  const cdata = (tag) => { const m = r.body.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i')); return m ? decodeHtml(m[1]) : null; };
  let title = cdata('title');
  if (title) title = title.replace(/^Stories by\s+/i, '').replace(/\s+on Medium$/i, '');
  const img = r.body.match(/<image>[\s\S]*?<url>\s*(?:<!\[CDATA\[)?([^<\]]+)/i);
  return makeResult(p, u, 'FOUND', {
    httpStatus: r.status, sourceUrl: url, profileUrl: `https://medium.com/@${u}`, confidence: 'Medium — confirmed via documented public RSS feed',
    fields: { displayName: title, bio: cdata('description'), avatar: img ? img[1].trim() : null },
  });
}

async function lookupYoutube(p, u, ctx) {
  const base = 'https://www.googleapis.com/youtube/v3/channels';
  const url = `${base}?part=snippet,statistics&forHandle=${encodeURIComponent('@' + u)}`;
  const r = await http(url, { signal: ctx.signal, headers: { 'X-Goog-Api-Key': process.env.YOUTUBE_API_KEY } });
  const bad = failureResult(p, u, r, { sourceUrl: `${base}?part=snippet,statistics&forHandle=@${u}` }); if (bad) return bad;
  const j = jsonOf(r);
  if (r.status >= 400) {
    const reason = j && j.error && j.error.errors && j.error.errors[0] ? j.error.errors[0].reason : null;
    if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') return makeResult(p, u, 'RATE LIMITED', { httpStatus: r.status, note: 'YouTube API quota exhausted for this key.' });
    return makeResult(p, u, 'ERROR', { httpStatus: r.status, note: `YouTube API error HTTP ${r.status}${reason ? ` (${reason})` : ''}. Check YOUTUBE_API_KEY and that the YouTube Data API v3 is enabled.` });
  }
  const it = j && j.items && j.items[0];
  const src = `${base}?part=snippet,statistics&forHandle=@${u}`;
  if (!it) return makeResult(p, u, 'NOT FOUND', { httpStatus: 200, sourceUrl: src, confidence: 'High — official API returned no channel for this handle' });
  const s = it.snippet || {}, st = it.statistics || {};
  const th = s.thumbnails || {};
  return makeResult(p, u, 'FOUND', {
    httpStatus: 200, sourceUrl: src, profileUrl: `https://www.youtube.com/${s.customUrl || '@' + u}`, confidence: 'High — confirmed by official YouTube Data API',
    fields: { displayName: s.title, bio: s.description, avatar: (th.high || th.default || {}).url, followers: st.hiddenSubscriberCount ? null : Number(st.subscriberCount), posts: st.videoCount !== undefined ? Number(st.videoCount) : null, created: s.publishedAt },
    extra: [['Total views', st.viewCount !== undefined ? Number(st.viewCount) : null], ['Subscribers hidden', st.hiddenSubscriberCount ? 'yes (channel owner hides the count)' : null]].filter((e) => e[1] !== null),
  });
}

async function lookupTwitch(p, u, ctx) {
  const tk = await getTwitchToken(ctx.signal);
  if (tk.fail) return failureResult(p, u, tk.fail) || makeResult(p, u, 'ERROR', { note: 'Twitch token request failed.' });
  if (tk.rejected) return makeResult(p, u, 'ERROR', { httpStatus: tk.status, note: 'Twitch rejected the client credentials. Check TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET.' });
  const url = `https://api.twitch.tv/helix/users?login=${encodeURIComponent(u)}`;
  const r = await http(url, { signal: ctx.signal, headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${tk.token}` } });
  const bad = failureResult(p, u, r); if (bad) return bad;
  if (r.status === 401) { delete tokenCache.twitch; return makeResult(p, u, 'ERROR', { httpStatus: 401, note: 'Twitch rejected the app token; try again.' }); }
  const j = jsonOf(r);
  if (!r.ok || !j || !Array.isArray(j.data)) return makeResult(p, u, 'ERROR', { httpStatus: r.status, note: `Unexpected Twitch response (HTTP ${r.status}).` });
  if (!j.data.length) return makeResult(p, u, 'NOT FOUND', { httpStatus: 200, sourceUrl: url, confidence: 'High — official Helix API returned no user (banned logins are also omitted)' });
  const d = j.data[0];
  return makeResult(p, u, 'FOUND', {
    httpStatus: 200, sourceUrl: url, profileUrl: `https://www.twitch.tv/${d.login}`, confidence: 'High — confirmed by official Twitch Helix API',
    fields: { displayName: d.display_name, bio: d.description, avatar: d.profile_image_url, created: d.created_at, category: `Broadcaster type: ${d.broadcaster_type || 'none'}` },
  });
}

async function lookupReddit(p, u, ctx) {
  const tk = await getRedditToken(ctx.signal);
  if (tk.fail) return failureResult(p, u, tk.fail) || makeResult(p, u, 'ERROR', { note: 'Reddit token request failed.' });
  if (tk.rejected) return makeResult(p, u, 'ERROR', { httpStatus: tk.status, note: 'Reddit rejected the app credentials. Check REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET.' });
  const url = `https://oauth.reddit.com/user/${encodeURIComponent(u)}/about?raw_json=1`;
  const r = await http(url, { signal: ctx.signal, headers: { Authorization: `Bearer ${tk.token}` } });
  const bad = failureResult(p, u, r); if (bad) return bad;
  if (r.status === 404) return makeResult(p, u, 'NOT FOUND', { httpStatus: 404, sourceUrl: url, confidence: 'High — official Reddit API returned 404 for this user' });
  if (r.status === 401 || r.status === 403) return makeResult(p, u, 'ERROR', { httpStatus: r.status, note: `Reddit denied the request (HTTP ${r.status}).` });
  const j = jsonOf(r); const d = j && j.data;
  if (!r.ok || !d || !d.name) return makeResult(p, u, 'ERROR', { httpStatus: r.status, note: `Unexpected Reddit response (HTTP ${r.status}).` });
  const sub = d.subreddit || {};
  return makeResult(p, u, 'FOUND', {
    httpStatus: r.status, sourceUrl: url, profileUrl: `https://www.reddit.com/user/${d.name}`, confidence: 'High — confirmed by official Reddit OAuth API',
    note: d.is_suspended ? 'Account exists but is suspended; most fields are hidden by Reddit.' : null,
    fields: { displayName: sub.title || d.name, bio: sub.public_description, avatar: d.icon_img, followers: typeof sub.subscribers === 'number' ? sub.subscribers : null, created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null },
    extra: [['Total karma', d.total_karma]].filter((e) => typeof e[1] === 'number'),
  });
}

async function lookupX(p, u, ctx) {
  const url = `https://api.x.com/2/users/by/username/${encodeURIComponent(u)}?user.fields=created_at,description,profile_image_url,public_metrics,verified,verified_type,protected`;
  const r = await http(url, { signal: ctx.signal, headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });
  const bad = failureResult(p, u, r); if (bad) return bad;
  if (r.status === 401) return makeResult(p, u, 'ERROR', { httpStatus: 401, note: 'X rejected the bearer token (HTTP 401).' });
  if (r.status === 402) return makeResult(p, u, 'UNAVAILABLE', { httpStatus: 402, note: 'X API reports that credits / a paid plan are required for this call.' });
  if (r.status === 403) return makeResult(p, u, 'ERROR', { httpStatus: 403, note: 'X denied access (HTTP 403): your API plan/app may not include user lookup.' });
  const j = jsonOf(r);
  if (j && j.data && j.data.username) {
    const d = j.data, m = d.public_metrics || {};
    return makeResult(p, u, 'FOUND', {
      httpStatus: r.status, sourceUrl: url.split('?')[0], profileUrl: `https://x.com/${d.username}`, confidence: 'High — confirmed by official X API v2',
      fields: { displayName: d.name, bio: d.description, avatar: d.profile_image_url, verified: d.verified === undefined ? null : Boolean(d.verified), followers: m.followers_count, following: m.following_count, posts: m.tweet_count, created: d.created_at, category: d.verified_type && d.verified_type !== 'none' ? d.verified_type : null },
      extra: d.protected ? [['Protected account', 'yes']] : [],
    });
  }
  const err = j && j.errors && j.errors[0];
  if (err && /not found/i.test(err.title || '')) return makeResult(p, u, 'NOT FOUND', { httpStatus: r.status, sourceUrl: url.split('?')[0], confidence: 'High — official API reported "Not Found" for this username' });
  if (err && /suspend/i.test(err.detail || '')) return makeResult(p, u, 'UNVERIFIED', { httpStatus: r.status, note: 'X reports the account is suspended; profile data is not returned.' });
  return makeResult(p, u, 'ERROR', { httpStatus: r.status, note: `Unexpected X response (HTTP ${r.status})${err ? `: ${truncate(err.detail || err.title || '', 80)}` : ''}.` });
}

function graphErrorState(p, u, r, j, notFoundNote) {
  const e = j && j.error ? j.error : {};
  if ([4, 17, 32, 613].includes(e.code)) return makeResult(p, u, 'RATE LIMITED', { httpStatus: r.status, note: 'Meta Graph API rate limit reached for this app/token.' });
  if (e.code === 190 || r.status === 401) return makeResult(p, u, 'ERROR', { httpStatus: r.status, note: 'Meta rejected the access token (expired or invalid).' });
  if (r.status === 400 || r.status === 404 || e.code === 110 || e.code === 100) return makeResult(p, u, 'UNVERIFIED', { httpStatus: r.status, note: notFoundNote });
  return makeResult(p, u, 'ERROR', { httpStatus: r.status, note: `Meta API error HTTP ${r.status}${e.code ? ` (code ${e.code})` : ''}.` });
}

async function lookupInstagram(p, u, ctx) {
  const id = process.env.INSTAGRAM_BUSINESS_ID;
  const fields = `business_discovery.username(${u}){username,name,biography,profile_picture_url,followers_count,follows_count,media_count}`;
  const url = `https://graph.facebook.com/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`;
  const shown = 'https://graph.facebook.com/{ig-business-id}?fields=business_discovery.username(…)';
  const r = await http(url, { signal: ctx.signal, headers: { Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}` } });
  const bad = failureResult(p, u, r, { sourceUrl: shown }); if (bad) return bad;
  const j = jsonOf(r);
  const bd = j && j.business_discovery;
  if (r.ok && bd && bd.username) {
    return makeResult(p, u, 'FOUND', {
      httpStatus: r.status, sourceUrl: shown, profileUrl: `https://www.instagram.com/${bd.username}/`, confidence: 'High — confirmed by Instagram Graph API business_discovery',
      fields: { displayName: bd.name, bio: bd.biography, avatar: bd.profile_picture_url, followers: bd.followers_count, following: bd.follows_count, posts: bd.media_count, category: 'Business / Creator account' },
    });
  }
  return graphErrorState(p, u, r, j, 'Not returned by business_discovery. That method only sees Business/Creator accounts, so a personal or missing account cannot be told apart. No conclusion drawn.');
}

async function lookupThreads(p, u, ctx) {
  const url = `https://graph.threads.net/v1.0/profile_lookup?username=${encodeURIComponent(u)}`;
  const r = await http(url, { signal: ctx.signal, headers: { Authorization: `Bearer ${process.env.THREADS_ACCESS_TOKEN}` } });
  const bad = failureResult(p, u, r, { sourceUrl: 'https://graph.threads.net/v1.0/profile_lookup' }); if (bad) return bad;
  const j = jsonOf(r);
  if (r.ok && j && j.username) {
    const pick = (...ks) => { for (const k of ks) if (j[k] !== undefined && j[k] !== null) return j[k]; return null; };
    return makeResult(p, u, 'FOUND', {
      httpStatus: r.status, sourceUrl: 'https://graph.threads.net/v1.0/profile_lookup', profileUrl: `https://www.threads.net/@${j.username}`, confidence: 'High — confirmed by Threads Profile Discovery API',
      fields: { displayName: pick('name'), bio: pick('biography', 'threads_biography'), avatar: pick('profile_picture_url', 'threads_profile_picture_url'), verified: pick('is_verified'), followers: pick('follower_count', 'followers_count') },
    });
  }
  return graphErrorState(p, u, r, j, 'Profile Discovery returned nothing. It needs the threads_profile_discovery permission and only covers public accounts with 100+ followers (limited accounts before app review), so this is not proof of absence.');
}

const UNSUPPORTED = {
  tiktok: 'TikTok exposes profile data only for users who authorize your app (Login Kit / Display API); its Research API is limited to approved researchers. Public pages are bot-protected, so there is no legitimate anonymous username lookup.',
  facebook: 'Meta\'s Graph API has no username-to-profile lookup for ordinary profiles; Page data needs app review and Page permissions, and public profile pages sit behind login walls.',
  pinterest: 'Pinterest API v5 requires OAuth and returns account data only for the authorizing user; there is no public username lookup endpoint.',
  snapchat: 'Snapchat offers no public API to look up a profile by username (Snap Kit works only for users who log in to your app).',
  discord: 'Discord has no public endpoint to resolve a username to an account; lookups need a user ID and, for bots, a shared server.',
  linkedin: 'LinkedIn APIs expose profiles only to authorizing members or approved partners, and its terms prohibit scraping.',
};

const R = {
  github: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
};

const PLATFORMS = [
  { id: 'instagram', name: 'Instagram', kind: 'api', needs: ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_BUSINESS_ID'], rule: /^[A-Za-z0-9._]{1,30}$/, ruleText: '1-30 chars: letters, digits, period, underscore', profileUrl: (u) => `https://www.instagram.com/${u}/`, sourceName: 'Instagram Graph API (business_discovery)', sourceUrl: 'https://graph.facebook.com/', docs: 'developers.facebook.com/docs/instagram-platform', exposes: ['displayName', 'bio', 'avatar', 'followers', 'following', 'posts', 'category'], postsLabel: 'Media items', limitation: 'Only Business/Creator accounts are visible; personal accounts and missing accounts look identical, so absence is UNVERIFIED, never NOT FOUND. Needs a Facebook-login app with a linked business account. Implemented from documentation, not tested against a live token.', lookup: lookupInstagram },
  { id: 'tiktok', name: 'TikTok', kind: 'unsupported', rule: /^[A-Za-z0-9._]{2,24}$/, ruleText: '2-24 chars: letters, digits, period, underscore', profileUrl: (u) => `https://www.tiktok.com/@${u}`, sourceName: 'None', docs: 'developers.tiktok.com', exposes: [], limitation: UNSUPPORTED.tiktok },
  { id: 'youtube', name: 'YouTube', kind: 'api', needs: ['YOUTUBE_API_KEY'], rule: /^[A-Za-z0-9._-]{3,30}$/, ruleText: '3-30 chars: letters, digits, period, underscore, hyphen (handle)', profileUrl: (u) => `https://www.youtube.com/@${u}`, sourceName: 'YouTube Data API v3 (channels.list forHandle)', sourceUrl: 'https://www.googleapis.com/youtube/v3/channels', docs: 'developers.google.com/youtube/v3', exposes: ['displayName', 'bio', 'avatar', 'followers', 'posts', 'created'], postsLabel: 'Videos', limitation: 'Free API key required (daily quota applies). Verification badge is not exposed by the API. Subscriber counts may be hidden by owners. Implemented from documentation, not tested with a live key.', lookup: lookupYoutube },
  { id: 'facebook', name: 'Facebook', kind: 'unsupported', rule: /^[A-Za-z0-9.]{5,50}$/, ruleText: '5-50 chars: letters, digits, period', profileUrl: (u) => `https://www.facebook.com/${u}`, sourceName: 'None', docs: 'developers.facebook.com/docs/graph-api', exposes: [], limitation: UNSUPPORTED.facebook },
  { id: 'x', name: 'X', kind: 'api', needs: ['X_BEARER_TOKEN'], rule: /^[A-Za-z0-9_]{1,15}$/, ruleText: '1-15 chars: letters, digits, underscore', profileUrl: (u) => `https://x.com/${u}`, sourceName: 'X API v2 (users/by/username)', sourceUrl: 'https://api.x.com/2/users/by/username', docs: 'docs.x.com', exposes: ['displayName', 'bio', 'avatar', 'verified', 'followers', 'following', 'posts', 'created', 'category'], postsLabel: 'Posts', limitation: 'Requires a developer bearer token on a pay-per-use or paid plan; calls may consume credits. Implemented from documentation, not tested with a live token.', lookup: lookupX },
  { id: 'threads', name: 'Threads', kind: 'api', needs: ['THREADS_ACCESS_TOKEN'], rule: /^[A-Za-z0-9._]{1,30}$/, ruleText: '1-30 chars: letters, digits, period, underscore', profileUrl: (u) => `https://www.threads.net/@${u}`, sourceName: 'Threads Profile Discovery API', sourceUrl: 'https://graph.threads.net/v1.0/profile_lookup', docs: 'developers.facebook.com/docs/threads', exposes: ['displayName', 'bio', 'avatar', 'verified', 'followers'], postsLabel: 'Posts', limitation: 'Needs the threads_profile_discovery permission; only public accounts with 100+ followers are discoverable and unapproved apps see a handful of accounts. Absence is UNVERIFIED. Not tested against a live token.', lookup: lookupThreads },
  { id: 'reddit', name: 'Reddit', kind: 'api', needs: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'], rule: /^[A-Za-z0-9_-]{3,20}$/, ruleText: '3-20 chars: letters, digits, underscore, hyphen', profileUrl: (u) => `https://www.reddit.com/user/${u}`, sourceName: 'Reddit OAuth API (user about)', sourceUrl: 'https://oauth.reddit.com/user/{name}/about', docs: 'reddit.com/dev/api', exposes: ['displayName', 'bio', 'avatar', 'followers', 'created'], postsLabel: 'Posts', limitation: 'Unauthenticated .json access was reported discontinued in 2026, so a registered Reddit app (client ID/secret, app-only OAuth) is required. Not tested against live credentials.', lookup: lookupReddit },
  { id: 'twitch', name: 'Twitch', kind: 'api', needs: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'], rule: /^[A-Za-z0-9_]{4,25}$/, ruleText: '4-25 chars: letters, digits, underscore', profileUrl: (u) => `https://www.twitch.tv/${u}`, sourceName: 'Twitch Helix API (users)', sourceUrl: 'https://api.twitch.tv/helix/users', docs: 'dev.twitch.tv/docs/api', exposes: ['displayName', 'bio', 'avatar', 'created', 'category'], postsLabel: 'Videos', limitation: 'Free app credentials required (app token). Follower counts need a user token, so they are not shown. Not tested against live credentials.', lookup: lookupTwitch },
  { id: 'pinterest', name: 'Pinterest', kind: 'unsupported', rule: /^[A-Za-z0-9_]{3,30}$/, ruleText: '3-30 chars: letters, digits, underscore', profileUrl: (u) => `https://www.pinterest.com/${u}/`, sourceName: 'None', docs: 'developers.pinterest.com', exposes: [], limitation: UNSUPPORTED.pinterest },
  { id: 'snapchat', name: 'Snapchat', kind: 'unsupported', rule: /^[A-Za-z][A-Za-z0-9._-]{2,14}$/, ruleText: '3-15 chars, starts with a letter: letters, digits, . _ -', profileUrl: (u) => `https://www.snapchat.com/add/${u}`, sourceName: 'None', docs: 'developers.snap.com', exposes: [], limitation: UNSUPPORTED.snapchat },
  { id: 'telegram', name: 'Telegram', kind: 'public', needs: [], rule: /^[A-Za-z][A-Za-z0-9_]{4,31}$/, ruleText: '5-32 chars, starts with a letter: letters, digits, underscore', profileUrl: (u) => `https://t.me/${u}`, sourceName: 't.me public preview page', sourceUrl: 'https://t.me/{username}', docs: 'core.telegram.org/api/links', exposes: ['displayName', 'bio', 'avatar', 'followers', 'category'], postsLabel: 'Posts', limitation: 'No official lookup API; this reads the public t.me preview page. The generic stub page is UNVERIFIED rather than NOT FOUND. Page markup can change; not verified live from the build environment.', lookup: lookupTelegram },
  { id: 'github', name: 'GitHub', kind: 'api', needs: [], rule: R.github, ruleText: '1-39 chars: letters, digits, single hyphens (not at the ends)', profileUrl: (u) => `https://github.com/${u}`, sourceName: 'GitHub REST API (users)', sourceUrl: 'https://api.github.com/users/{login}', docs: 'docs.github.com/rest/users', exposes: ['displayName', 'bio', 'avatar', 'followers', 'following', 'posts', 'created', 'category'], postsLabel: 'Public repositories', limitation: 'Works without a key (60 requests/hour per IP); an optional GITHUB_TOKEN raises the limit. Verification badges are not part of the API.', lookup: lookupGithub },
  { id: 'discord', name: 'Discord', kind: 'unsupported', rule: /^[a-z0-9._]{2,32}$/, ruleText: '2-32 chars: lowercase letters, digits, period, underscore', profileUrl: () => null, sourceName: 'None', docs: 'discord.com/developers/docs', exposes: [], limitation: UNSUPPORTED.discord },
  { id: 'linkedin', name: 'LinkedIn', kind: 'unsupported', rule: /^[A-Za-z0-9-]{3,100}$/, ruleText: '3-100 chars: letters, digits, hyphen (public URL slug)', profileUrl: (u) => `https://www.linkedin.com/in/${u}`, sourceName: 'None', docs: 'learn.microsoft.com/linkedin', exposes: [], limitation: UNSUPPORTED.linkedin },
  { id: 'medium', name: 'Medium', kind: 'public', needs: [], rule: /^[A-Za-z0-9._-]{1,30}$/, ruleText: '1-30 chars: letters, digits, period, underscore, hyphen', profileUrl: (u) => `https://medium.com/@${u}`, sourceName: 'Medium public RSS feed', sourceUrl: 'https://medium.com/feed/@{username}', docs: 'help.medium.com (RSS feeds)', exposes: ['displayName', 'bio', 'avatar'], postsLabel: 'Stories', limitation: 'Uses the documented public RSS feed. Follower counts are not exposed. If Medium blocks the request the result is UNVERIFIED; no bypass is attempted. Not verified live from the build environment.', lookup: lookupMedium },
];
const PLATFORM_BY_ID = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));
const findPlatform = (s) => { const k = String(s).toLowerCase().trim(); return PLATFORM_BY_ID[k] || PLATFORMS.find((p) => p.name.toLowerCase() === k) || null; };

function normalizeUsername(p, raw) {
  let v = String(raw == null ? '' : raw).trim().replace(/^@+/, '');
  if (!v) return { ok: false, error: 'Username is empty' };
  if (/\s/.test(v)) return { ok: false, error: 'Usernames cannot contain spaces' };
  if (!p.rule.test(v)) return { ok: false, error: `Not valid for ${p.name}: ${p.ruleText}` };
  return { ok: true, value: v };
}

// ───────────────────────────── gaming lookups ─────────────────────────────

const ROBLOX = {
  id: 'roblox', name: 'Roblox', sourceName: 'Roblox Users / Friends / Thumbnails web APIs', sourceUrl: 'https://users.roblox.com/v1',
  rule: /^(?!_)(?!.*_.*_)(?!.*_$)[A-Za-z0-9_]{3,20}$/, ruleText: '3-20 chars: letters, digits, at most one underscore (not at the ends)',
};

async function lookupRoblox(username, signal) {
  const p = ROBLOX, u = username;
  const r1 = await http('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ usernames: [u], excludeBannedUsers: false }), signal });
  const bad = failureResult(p, u, r1); if (bad) return bad;
  const j1 = jsonOf(r1);
  if (!r1.ok || !j1 || !Array.isArray(j1.data)) return makeResult(p, u, 'ERROR', { httpStatus: r1.status, note: `Unexpected Roblox response (HTTP ${r1.status}).` });
  if (!j1.data.length) return makeResult(p, u, 'NOT FOUND', { httpStatus: 200, confidence: 'High — official username-resolution endpoint returned no user', sourceUrl: 'https://users.roblox.com/v1/usernames/users' });
  const hit = j1.data[0], id = hit.id;
  const [r2, rf, rg, rfr, rt] = await Promise.all([
    http(`https://users.roblox.com/v1/users/${id}`, { signal }),
    http(`https://friends.roblox.com/v1/users/${id}/followers/count`, { signal }),
    http(`https://friends.roblox.com/v1/users/${id}/followings/count`, { signal }),
    http(`https://friends.roblox.com/v1/users/${id}/friends/count`, { signal }),
    http(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`, { signal }),
  ]);
  const prof = r2.ok ? jsonOf(r2) : null;
  const cnt = (r) => { const j = r.ok ? jsonOf(r) : null; return j && typeof j.count === 'number' ? j.count : null; };
  const th = rt.ok ? jsonOf(rt) : null;
  const avatar = th && th.data && th.data[0] && th.data[0].state === 'Completed' ? th.data[0].imageUrl : null;
  const friends = cnt(rfr);
  return makeResult(p, u, 'FOUND', {
    httpStatus: 200, sourceUrl: 'https://users.roblox.com/v1/users/{userId}', profileUrl: `https://www.roblox.com/users/${id}/profile`, confidence: 'High — confirmed by official Roblox web APIs',
    note: prof ? (prof.isBanned ? 'Roblox marks this account as banned.' : null) : 'Profile details endpoint did not answer; only the ID resolution succeeded.',
    fields: { displayName: (prof && prof.displayName) || hit.displayName, bio: prof ? prof.description : null, avatar, verified: prof ? Boolean(prof.hasVerifiedBadge) : null, followers: cnt(rf), following: cnt(rg), created: prof ? prof.created : null },
    extra: [['User ID', id], ['Username', (prof && prof.name) || hit.name], ['Friends', friends]].filter((e) => e[1] !== null && e[1] !== undefined),
  });
}

const PUBG_SHARDS = ['steam', 'kakao', 'xbox', 'psn'];
const PUBG = { id: 'pubg', name: 'PUBG', sourceName: 'PUBG Developer API', sourceUrl: 'https://api.pubg.com/shards/{platform}/players', rule: /^[A-Za-z0-9_-]{3,16}$/, ruleText: '3-16 chars (console names may differ): letters, digits, underscore, hyphen. Names are case-sensitive.' };

async function lookupPubg(name, shard, signal) {
  const p = PUBG, u = name;
  if (!hasSecret('PUBG_API_KEY')) return makeResult(p, u, 'UNAVAILABLE', { note: 'PUBG API requires a free developer key (PUBG_API_KEY). No lookup was attempted.' });
  const headers = { Authorization: `Bearer ${process.env.PUBG_API_KEY}`, Accept: 'application/vnd.api+json' };
  const base = `https://api.pubg.com/shards/${shard}`;
  const r = await http(`${base}/players?filter[playerNames]=${encodeURIComponent(u)}`, { headers, signal });
  const bad = failureResult(p, u, r, { sourceUrl: `${base}/players` }); if (bad) return bad;
  if (r.status === 401) return makeResult(p, u, 'ERROR', { httpStatus: 401, note: 'PUBG rejected the API key (HTTP 401).' });
  if (r.status === 404) return makeResult(p, u, 'NOT FOUND', { httpStatus: 404, sourceUrl: `${base}/players`, confidence: `High — official API returned 404 on shard "${shard}" (names are case-sensitive)` });
  const j = jsonOf(r); const pl = j && Array.isArray(j.data) ? j.data[0] : null;
  if (!r.ok || !pl) return makeResult(p, u, 'ERROR', { httpStatus: r.status, note: `Unexpected PUBG response (HTTP ${r.status}).` });
  const extra = [['Player ID', pl.id], ['Shard', shard]];
  let note = null;
  const r2 = await http(`${base}/players/${pl.id}/seasons/lifetime`, { headers, signal });
  if (r2.rateLimited) note = `Lifetime stats skipped: key rate-limited (~${r2.retryAfterSec}s). Developer keys allow 10 calls/min.`;
  else if (r2.ok) {
    const modes = (((jsonOf(r2) || {}).data || {}).attributes || {}).gameModeStats || {};
    for (const [mode, s] of Object.entries(modes)) {
      if (s && s.roundsPlayed > 0) extra.push([mode, `${fmtNum(s.roundsPlayed)} rounds, ${fmtNum(s.wins)} wins, ${fmtNum(s.kills)} kills, ${fmtNum(s.top10s)} top10`]);
    }
    if (extra.length === 2) note = 'No lifetime mode stats reported for this player.';
  } else note = `Lifetime stats unavailable (HTTP ${r2.status || 'network'}).`;
  return makeResult(p, u, 'FOUND', { httpStatus: r.status, sourceUrl: `${base}/players`, confidence: 'High — confirmed by official PUBG API', note, fields: { displayName: (pl.attributes && pl.attributes.name) || u }, extra });
}

function mlbbInfo() {
  return [
    'Moonton does not publish an official public API for looking up Mobile Legends: Bang Bang players by ID, Zone ID or nickname.',
    'Community-run sites exist, but they are not authorized by Moonton, rely on unofficial endpoints, and may break or violate the game\'s terms. Shadow-OmniTrace does not use them.',
    'Player lookup is therefore marked UNAVAILABLE rather than faked. A lookup would need two identifiers (numeric User ID plus the 4-5 digit Zone/Server ID); check your own profile in-game.',
    'If Moonton ever publishes an official API, an adapter can be added here.',
  ];
}

// ───────────────────────────── cache, scan engine ─────────────────────────────

const cache = new Map();
const cacheKey = (pid, u) => `${pid}:${u.toLowerCase()}`;
function cacheGet(pid, u) {
  const e = cache.get(cacheKey(pid, u));
  if (!e) return null;
  if (Date.now() - e.at > config.cacheTtlSec * 1000) { cache.delete(cacheKey(pid, u)); return null; }
  return { ...e.result, cached: true };
}
/** Only definite outcomes are cached; transient states (errors, rate limits) never are. */
function cachePut(pid, u, result) {
  if (result.state === 'FOUND' || result.state === 'NOT FOUND' || result.state === 'UNVERIFIED') cache.set(cacheKey(pid, u), { at: Date.now(), result });
}

async function runPlatform(p, rawUser, ctx) {
  const n = normalizeUsername(p, rawUser);
  if (!n.ok) return makeResult(p, String(rawUser), 'SKIPPED', { note: n.error });
  const u = n.value;
  if (p.kind === 'unsupported') return makeResult(p, u, 'UNAVAILABLE', { profileUrl: p.profileUrl(u), note: p.limitation });
  const miss = missingKeys(p);
  if (miss.length) return makeResult(p, u, 'UNAVAILABLE', { profileUrl: p.profileUrl(u), note: `Credentials not configured (${miss.join(', ')}). No request was sent.` });
  if (!ctx.fresh) { const hit = cacheGet(p.id, u); if (hit) return hit; }
  let res;
  try { res = await p.lookup(p, u, ctx); } catch (e) { res = makeResult(p, u, 'ERROR', { note: `Internal adapter error: ${redact(e && e.message)}` }); }
  cachePut(p.id, u, res);
  return res;
}

/** Runs adapters with a small worker pool. Returns {results, cancelled}. */
async function runScan(username, platforms, opts = {}) {
  const { signal, onProgress, fresh } = opts;
  const results = new Array(platforms.length).fill(null);
  let next = 0, done = 0;
  const workers = Math.max(1, Math.min(config.concurrency, platforms.length));
  const worker = async () => {
    while (true) {
      if (signal && signal.aborted) return;
      const i = next++;
      if (i >= platforms.length) return;
      const r = await runPlatform(platforms[i], username, { signal, fresh });
      if (signal && signal.aborted && r.state === 'ERROR' && /Cancelled/.test(r.note || '')) return;
      results[i] = r; done++;
      if (onProgress) onProgress(done, platforms.length, results.filter(Boolean));
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return { results: results.filter(Boolean), cancelled: Boolean(signal && signal.aborted) };
}

function summarize(results) {
  const s = {};
  for (const r of results) s[r.state] = (s[r.state] || 0) + 1;
  return s;
}

// ───────────────────────────── history & reports ─────────────────────────────

function readHistory() {
  try { const j = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch (_) { return []; }
}
function toHistoryEntry(kind, query, platformIds, results) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    kind, query, platforms: platformIds, at: nowIso(),
    results: results.map((r) => ({ platform: r.platform, state: r.state, profileUrl: r.profileUrl, source: r.source, retrievedAt: r.retrievedAt })),
  };
}
/** Saves only summaries (no bios, avatars or counts) and never any secret. */
function saveHistory(entry) {
  if (!config.persistHistory) return false;
  try {
    const list = readHistory(); list.unshift(entry);
    atomicWrite(HISTORY_FILE, JSON.stringify(list.slice(0, config.historyLimit), null, 2), 0o600);
    return true;
  } catch (_) { return false; }
}
function clearHistory() { try { atomicWrite(HISTORY_FILE, '[]', 0o600); return true; } catch (_) { return false; } }

function safeName(s) { return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 40) || 'report'; }
function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}${ext}`), n = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base}-${n++}${ext}`);
  return p;
}

function reportObject(title, query, platformNames, results, extraMeta = {}) {
  return {
    tool: APP, version: VERSION, madeBy: 'NullKat Development', title, query, generatedAt: nowIso(),
    platforms: platformNames, summary: summarize(results),
    disclaimer: 'Results are independent per platform. A matching username on several platforms does not prove the accounts belong to the same person.',
    ...extraMeta,
    results: results.map((r) => ({
      platform: r.platform, query: r.query, state: r.state, profileUrl: r.profileUrl, confidence: r.confidence, note: r.note,
      fields: Object.fromEntries(FIELD_ORDER.map(([k]) => [k, r.fields[k] === undefined || r.fields[k] === null || r.fields[k] === '' ? null : r.fields[k]])),
      extra: Object.fromEntries(r.extra || []),
      source: r.source, httpStatus: r.httpStatus, retrievedAt: r.retrievedAt,
    })),
  };
}

function reportText(obj) {
  const L = [];
  L.push(`${APP} report — Made by: NullKat Development`, '='.repeat(60));
  L.push(`Title:     ${obj.title}`, `Query:     ${obj.query}`, `Generated: ${obj.generatedAt}`, `Platforms: ${obj.platforms.join(', ')}`);
  L.push(`Summary:   ${Object.entries(obj.summary).map(([k, v]) => `${k}=${v}`).join('  ')}`, '');
  L.push(obj.disclaimer, '');
  for (const r of obj.results) {
    L.push('-'.repeat(60), `${r.platform}  [${r.state}]`);
    if (r.profileUrl) L.push(`  URL:        ${r.profileUrl}`);
    if (r.confidence) L.push(`  Confidence: ${r.confidence}`);
    if (r.note) L.push(`  Note:       ${r.note}`);
    for (const [k, label] of FIELD_ORDER) if (r.fields[k] !== null) L.push(`  ${label}: ${String(r.fields[k]).replace(/\s+/g, ' ')}`);
    for (const [k, v] of Object.entries(r.extra)) L.push(`  ${k}: ${v}`);
    L.push(`  Source:     ${r.source && r.source.name}${r.source && r.source.url ? ` <${r.source.url}>` : ''}`);
    L.push(`  Retrieved:  ${r.retrievedAt}${r.httpStatus ? `  (HTTP ${r.httpStatus})` : ''}`);
  }
  return redact(L.join('\n')) + '\n';
}

function writeReports(obj, formats) {
  const dir = config.reportDir;
  fs.mkdirSync(dir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-').slice(0, 19);
  const base = `omnitrace_${safeName(obj.query)}_${stamp}`;
  const written = [];
  if (formats.includes('json')) { const f = uniquePath(dir, base, '.json'); fs.writeFileSync(f, redact(JSON.stringify(obj, null, 2)) + '\n', { flag: 'wx' }); written.push(f); }
  if (formats.includes('txt')) { const f = uniquePath(dir, base, '.txt'); fs.writeFileSync(f, reportText(obj), { flag: 'wx' }); written.push(f); }
  return written;
}

// ───────────────────────────── branding & animation ─────────────────────────────

const rainbow = (t) => { const h = ((t % 360) + 360) % 360; const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)))); }; return [f(5), f(3), f(1)]; };

function nullkatText(phase) {
  if (colorLevel() === 0) return 'NullKat';
  const word = 'NULLKAT';
  return [...word].map((ch, i) => { const [r, g, b] = rainbow(phase + i * 38); return rgb(r, g, b, `\x1b[1m${ch}`); }).join('');
}
const madeByLine = (phase) => `${c.grey('Made by:')} ${nullkatText(phase)} ${c.grey('Development')}`;
const madeByPlain = () => 'Made by: NullKat Development';

// Compact block lettering (5 rows, 3-4 cols per letter) keeps the banner narrow for phones.
const GLYPH = {
  S: ['███', '█  ', '███', '  █', '███'], H: ['█ █', '█ █', '███', '█ █', '█ █'], A: ['███', '█ █', '███', '█ █', '█ █'],
  D: ['██ ', '█ █', '█ █', '█ █', '██ '], O: ['███', '█ █', '█ █', '█ █', '███' ], W: ['█   █', '█   █', '█ █ █', '██ ██', '█   █'],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'], N: ['█  █', '██ █', '█ ██', '█  █', '█  █'], I: ['███', ' █ ', ' █ ', ' █ ', '███'],
  T: ['███', ' █ ', ' █ ', ' █ ', ' █ '], R: ['██ ', '█ █', '██ ', '█ █', '█ █'], C: ['███', '█  ', '█  ', '█  ', '███'], E: ['███', '█  ', '██ ', '█  ', '███'],
};
function bigWord(word) {
  const rows = ['', '', '', '', ''];
  for (const ch of word) { const g = GLYPH[ch]; for (let i = 0; i < 5; i++) rows[i] += g[i] + ' '; }
  return rows.map((r) => r.replace(/\s+$/, ''));
}

// Large 5x7 lettering. Fits 38+ columns (Termux portrait is ~44); doubled horizontally on wide terminals.
const BIG = {
  S: [' ████', '█    ', '█    ', ' ███ ', '    █', '    █', '████ '],
  H: ['█   █', '█   █', '█   █', '█████', '█   █', '█   █', '█   █'],
  A: [' ███ ', '█   █', '█   █', '█████', '█   █', '█   █', '█   █'],
  D: ['████ ', '█   █', '█   █', '█   █', '█   █', '█   █', '████ '],
  O: [' ███ ', '█   █', '█   █', '█   █', '█   █', '█   █', ' ███ '],
  W: ['█   █', '█   █', '█   █', '█ █ █', '█ █ █', '██ ██', '█   █'],
};
function shadowBanner() {
  const cols = stdout.columns || 60;
  const word = 'SHADOW';
  const wide = cols >= 76;                       // 2x horizontal on desktop-size terminals
  const need = word.length * 6 * (wide ? 2 : 1) + 1;
  if (colorLevel() === 0 && cols < need + 1) return ['S H A D O W'];
  if (cols < need + 1) {                         // very narrow: old compact 5-row logo
    const rows = bigWord(word);
    return rows.map((r, i) => [c.neon, c.neon, c.red, c.deep, c.deep][i](r));
  }
  const rows = [];
  for (let r = 0; r < 7; r++) {
    let line = '';
    for (const ch of word) line += BIG[ch][r].split('').map((x) => (wide ? x + x : x)).join('') + (wide ? '  ' : ' ');
    rows.push(line.replace(/\s+$/, ''));
  }
  const w = Math.max(...rows.map((r) => r.length)) + 1;
  const padL = ' '.repeat(Math.max(0, Math.floor((Math.min(cols, 80) - 1 - w) / 2)));
  // vertical neon gradient, bright top to deep red bottom, plus a drop shadow to the right and below
  const grad = [[255, 90, 100], [255, 50, 70], [255, 30, 50], [235, 15, 35], [200, 8, 28], [160, 5, 22], [120, 0, 16]];
  const out = rows.map((r, i) => {
    const lit = colorLevel() === 0 ? r : rgb(grad[i][0], grad[i][1], grad[i][2], `\x1b[1m${r}`);
    return padL + lit + c.ember('░');
  });
  out.push(padL + ' ' + c.ember(rows[6].replace(/█/g, '▀')));
  return out;
}

function brandHeader(phase = 0) {
  const lines = shadowBanner();
  for (const l of lines) print(l);
  const mid = (t) => ' '.repeat(Math.max(0, Math.floor((Math.min(stdout.columns || 60, 80) - 1 - t.length) / 2)));
  const sub = 'O M N I T R A C E', tag = truncate('MULTI-PLATFORM INTELLIGENCE TOOLKIT', width());
  print(mid(sub) + c.deep(c.bold(sub)));
  print(mid(tag) + c.grey(tag));
  return madeByLine(phase);
}

// live NULLKAT line: rewritten in place with cursor save/restore; only while waiting for input
let ticker = null; let brandMark = null; let phase = 0;
function printLiveBrand() {
  brandMark = lineCounter;
  print(madeByLine(phase));
}
function startTicker() {
  stopTicker();
  if (!animationOn() || brandMark === null) return;
  ticker = setInterval(() => {
    const up = lineCounter - brandMark;
    if (up < 1 || up >= (stdout.rows || 24) - 1) return; // line scrolled out of view: leave it alone
    phase = (phase + 9) % 360;
    stdout.write(`\x1b7\x1b[${up}A\r${madeByLine(phase)}\x1b8`);
  }, 110);
  ticker.unref();
}
function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

async function splash() {
  const anim = animationOn();
  print();
  const made = brandHeader(0);
  brandMark = lineCounter; print(made);
  print(rule());
  const stage = async (label, fn) => {
    if (!anim) { const r = await fn(); print(c.green('✓') + ' ' + truncate(label + (r ? '  ' + r : ''), width() - 2)); return; }
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0; const t = setInterval(() => stdout.write(`\r${c.red(frames[i++ % frames.length])} ${label}\x1b[K`), 70);
    const started = Date.now(); const r = await fn();
    await sleep(Math.max(0, 240 - (Date.now() - started)));
    clearInterval(t); stdout.write(`\r\x1b[K`); print(`${c.green('✓')} ${label}${r ? c.grey('  ' + r) : ''}`);
  };
  await stage('Loading configuration', async () => `${Object.keys(DEFAULTS).length} settings`);
  await stage('Registering platform adapters', async () => `${PLATFORMS.filter(isAvailable).length}/${PLATFORMS.length} usable now`);
  await stage('Checking credentials', async () => `${SECRET_KEYS.filter((s) => hasSecret(s.key)).length}/${SECRET_KEYS.length} configured`);
  await stage('Testing network (api.github.com)', async () => { await testNetwork(); return netStatus.ok ? 'online' : 'unreachable'; });
  print(rule());
}

async function testNetwork() {
  const r = await http('https://api.github.com/zen', { timeoutMs: Math.min(config.timeoutMs, 5000) });
  netStatus.tested = true; netStatus.at = nowIso();
  netStatus.ok = !r.error && r.status > 0;
  netStatus.detail = r.error ? r.error.message : `HTTP ${r.status}`;
  return netStatus;
}

function statusSummary() {
  const usable = PLATFORMS.filter(isAvailable).length;
  const keys = SECRET_KEYS.filter((s) => hasSecret(s.key)).length;
  const net = !netStatus.tested ? c.grey('not tested') : netStatus.ok ? c.green('reachable') : c.red(`unreachable (${netStatus.detail})`);
  const row = (a, b) => print(`${c.grey(pad(a, 10))} ${b}`);
  row('Runtime', `Node ${process.versions.node} · ${process.platform}${process.env.TERMUX_VERSION ? ' · Termux' : ''}`);
  row('Adapters', `${usable}/${PLATFORMS.length} social usable now · Roblox ${c.green('ready')} · PUBG ${hasSecret('PUBG_API_KEY') ? c.green('key set') : c.yellow('needs key')}`);
  row('API keys', `${keys}/${SECRET_KEYS.length} configured`);
  row('Network', net);
  row('Version', VERSION);
}

// ───────────────────────────── prompts ─────────────────────────────

let rl = null; const inputQueue = []; let inputWaiter = null; let inputClosed = false; let exiting = false;
let activeAbort = null;

function initInput() {
  rl = readline.createInterface({ input: process.stdin, output: stdout, terminal: isTTY, historySize: 0 });
  rl.on('line', (l) => { if (inputWaiter) { const w = inputWaiter; inputWaiter = null; w(l); } else inputQueue.push(l); });
  rl.on('close', () => { inputClosed = true; if (inputWaiter) { const w = inputWaiter; inputWaiter = null; w(null); } });
  rl.on('SIGINT', onInterrupt);
}

function onInterrupt() {
  if (activeAbort && !activeAbort.signal.aborted) { activeAbort.abort('cancelled'); stdout.write('\n' + c.yellow('Cancelling… finishing in-flight requests.\n')); return; }
  gracefulExit(130);
}

function gracefulExit(code = 0) {
  if (exiting) return; exiting = true;
  stopTicker();
  try { stdout.write('\x1b[?25h'); } catch (_) { /* ignore */ }
  print(); print(c.grey('Interrupted. Nothing was left half-written.') );
  print(`${c.deep('Shadow')}${c.grey('·')}${c.deep('OmniTrace')} ${c.grey('— see you next time.')}`);
  try { rl && rl.close(); } catch (_) { /* ignore */ }
  process.exit(code);
}

/** Returns the typed line, or null at end of input (treated as "back/exit"). */
function ask(prompt) {
  return new Promise((resolve) => {
    if (inputQueue.length) { const l = inputQueue.shift(); if (!isTTY) print(`${prompt}${l}`); return resolve(l); }
    if (inputClosed) return resolve(null);
    if (isTTY && rl) { rl.setPrompt(prompt); rl.prompt(); } else stdout.write(prompt);
    startTicker();
    inputWaiter = (l) => { stopTicker(); lineCounter += 1; resolve(l); };
  });
}
const promptStr = (label) => `${c.red('›')} ${c.white(label)} ${c.red('›')} `;
async function askText(label) { const v = await ask(promptStr(label)); return v === null ? null : v.trim(); }
async function askYesNo(label, def = false) {
  const v = await askText(`${label} ${def ? '[Y/n]' : '[y/N]'}`);
  if (v === null || v === '') return def && v !== null;
  return /^y(es)?$/i.test(v);
}
async function pause() { if (isTTY) await ask(c.grey('  press Enter to continue ')); }

function screen(title, subtitle) {
  if (isTTY && !flag('--no-clear')) { stdout.write('\x1b[2J\x1b[H'); lineCounter = 0; brandMark = null; }
  if (title === 'main menu') {
    print();
    brandHeader(0);
    printLiveBrand();            // live NULLKAT line sits right under the logo
  } else {
    print(`${c.neon('▌')}${c.red(' SHADOW')}${c.grey('·')}${c.deep('OMNITRACE')}  ${c.grey(truncate(title, Math.max(8, width() - 22)))}`);
    printLiveBrand();
  }
  print(rule());
  if (subtitle) print(c.grey(subtitle));
}

function box(lines, paint = c.deep) {
  const w = width() - 4;
  print(paint('┌' + '─'.repeat(w + 2) + '┐'));
  for (const l of lines) for (const seg of wrap(l, w)) print(paint('│ ') + pad(seg, w) + paint(' │'));
  print(paint('└' + '─'.repeat(w + 2) + '┘'));
}

const errorLine = (m) => print(`${c.red('✖')} ${c.white(m)}`);
const infoLine = (m) => print(`${c.blue('ℹ')} ${c.grey(m)}`);
const okLine = (m) => print(`${c.green('✓')} ${c.white(m)}`);

// ───────────────────────────── shared views ─────────────────────────────

let lastScan = null; // { query, platformNames, results, at }

function platformList(selected = []) {
  PLATFORMS.forEach((p, i) => {
    const st = platformStatusLabel(p);
    const mark = selected.includes(p.id) ? c.red('◆') : c.grey('◇');
    print(`${mark} ${c.white(pad(String(i + 1), 2))} ${pad(p.name, 10)} ${st.paint(st.label)}`);
  });
}

/** Parses "1,3,5", "github medium", "all", "ready", "default". Returns platform list or {error}. */
function parseSelection(input) {
  const s = String(input).trim().toLowerCase();
  if (!s || s === 'd' || s === 'default') {
    const l = config.defaultPlatforms.map((id) => PLATFORM_BY_ID[id]).filter(Boolean);
    return l.length ? { list: l } : { error: 'No default platforms are configured (Settings → default platforms).' };
  }
  if (s === 'a' || s === 'all') return { list: PLATFORMS.slice() };
  if (s === 'r' || s === 'ready') { const l = PLATFORMS.filter(isAvailable); return l.length ? { list: l } : { error: 'No adapter is ready right now.' }; }
  const out = [];
  for (const tok of s.split(/[\s,]+/).filter(Boolean)) {
    let p = /^\d+$/.test(tok) ? PLATFORMS[Number(tok) - 1] : findPlatform(tok);
    if (!p) return { error: `Unknown platform "${tok}". Use numbers 1-${PLATFORMS.length} or names.` };
    if (!out.includes(p)) out.push(p);
  }
  return out.length ? { list: out } : { error: 'No platform selected.' };
}

async function choosePlatforms(title = 'Select platforms') {
  print(c.bold(title));
  platformList(config.defaultPlatforms);
  print(c.grey('  numbers/names (1,3 github)  ·  d default  ·  r ready only  ·  a all  ·  0 cancel'));
  while (true) {
    const v = await askText('platforms');
    if (v === null || v === '0') return null;
    const sel = parseSelection(v);
    if (sel.error) { errorLine(sel.error); continue; }
    return sel.list;
  }
}

function resultsTable(results) {
  const nameW = 10, w = width();
  for (const r of results) {
    const detail = r.state === 'FOUND' ? truncate(r.fields.displayName || r.profileUrl || '', Math.max(6, w - nameW - 18)) : truncate(r.note || (r.confidence || ''), Math.max(6, w - nameW - 18));
    print(`${pad(r.platform, nameW)} ${pad(stateTag(r.state), 14 + (colorLevel() ? 0 : 0))} ${c.grey(r.cached ? '(cached) ' : '')}${c.grey(detail)}`);
  }
}

function summaryLine(results) {
  const s = summarize(results);
  return Object.keys(STATES).filter((k) => s[k]).map((k) => `${STATES[k].paint(STATES[k].glyph)} ${s[k]} ${k.toLowerCase()}`).join('  ');
}

function fieldValue(k, v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (k === 'created' && /^\d{4}-\d\d-\d\d/.test(v)) return String(v).replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  return String(v);
}

/** Detailed per-platform view with field-by-field availability. */
function showDetail(r) {
  const p = PLATFORM_BY_ID[r.platformId];
  print();
  print(`${c.bold(c.white(r.platform))}  ${stateTag(r.state)}`);
  print(rule('·'));
  kv('Queried', `@${r.query}`);
  if (r.profileUrl) kv('Profile URL', r.profileUrl);
  if (r.confidence) kv('Confidence', r.confidence);
  if (r.note) kv('Note', r.note);
  if (r.state === 'FOUND' || (r.state === 'UNAVAILABLE' && p && p.kind === 'unsupported')) {
    print(c.grey('Fields'));
    for (const [k, label] of FIELD_ORDER) {
      const exposed = p && p.exposes && p.exposes.includes(k);
      const val = r.state === 'FOUND' ? fieldValue(k, r.fields[k]) : null;
      let shown = val;
      let lab = label;
      if (k === 'posts' && p && p.postsLabel) lab = p.postsLabel;
      if (shown === null) shown = r.state !== 'FOUND' ? c.grey('Not exposed by platform') : exposed ? c.grey('Not available for this account') : c.grey('Not exposed by platform');
      if (r.state === 'FOUND') kv(`  ${lab}`, shown);
      else if (p && p.kind === 'unsupported') kv(`  ${lab}`, shown);
    }
    for (const [k, v] of r.extra || []) kv(`  ${k}`, fieldValue(k, v) || String(v));
  }
  kv('Source', `${r.source.name}${r.source.url ? ` — ${r.source.url}` : ''}`);
  kv('Retrieved', `${r.retrievedAt}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}${r.cached ? ' · from cache' : ''}`);
  if (p && p.limitation && r.state !== 'UNAVAILABLE') kv('Limitation', p.limitation);
  print(c.grey('Independent result: not evidence that accounts elsewhere belong to the same person.'));
}

async function inspectLoop(results) {
  while (true) {
    const v = await askText('inspect # (Enter to skip)');
    if (v === null || v === '') return;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > results.length) { errorLine(`Enter a number from 1 to ${results.length}, or press Enter.`); continue; }
    showDetail(results[n - 1]);
  }
}

function numberedResults(results) {
  results.forEach((r, i) => print(`${c.grey(pad(String(i + 1), 2))} ${pad(r.platform, 10)} ${stateTag(r.state)}`));
}

function progressPainter(total) {
  let last = 0;
  return (done, _t, results) => {
    if (!isTTY) return;
    const now = Date.now(); if (done < total && now - last < 90) return; last = now;
    const s = summarize(results);
    const bar = Math.round((done / total) * 16);
    stdout.write(`\r\x1b[K${c.red('█'.repeat(bar))}${c.ember('░'.repeat(16 - bar))} ${done}/${total}  ${c.green('●' + (s.FOUND || 0))} ${c.blue('○' + (s['NOT FOUND'] || 0))} ${c.yellow('◐' + (s.UNVERIFIED || 0))} ${c.violet('⊘' + (s.UNAVAILABLE || 0))} ${c.orange('◔' + (s['RATE LIMITED'] || 0))} ${c.red('✖' + (s.ERROR || 0))}`);
  };
}

/** Runs one scan with progress and Ctrl+C cancellation. Returns {results, cancelled}. */
async function scanWithUi(query, platforms, fresh = false) {
  const ctl = new AbortController(); activeAbort = ctl;
  if (isTTY) infoLine('Ctrl+C cancels the scan; completed results are kept on screen.');
  const out = await runScan(query, platforms, { signal: ctl.signal, onProgress: progressPainter(platforms.length), fresh });
  activeAbort = null;
  if (isTTY) stdout.write('\r\x1b[K');
  return out;
}

async function afterScan(kind, query, platforms, out) {
  const { results, cancelled } = out;
  print(rule('·'));
  resultsTable(results);
  print(rule('·'));
  print(summaryLine(results));
  const confirmed = results.filter((r) => r.state === 'FOUND').length;
  print(c.white(`${confirmed} confirmed of ${platforms.length} selected`) + c.grey(' — each platform is judged independently.'));
  if (cancelled) { print(c.yellow('Scan cancelled: partial results only, not saved to history.')); }
  lastScan = { kind, query, platformNames: results.map((r) => r.platform), results, at: nowIso(), partial: cancelled };
  if (!cancelled) {
    const saved = saveHistory(toHistoryEntry(kind, query, platforms.map((p) => p.id), results));
    if (saved) infoLine(`Saved a summary to history (${HISTORY_FILE}). No bios or keys are stored.`);
    else if (!config.persistHistory) infoLine('History persistence is off (Settings).');
  }
  if (!results.length) return;
  numberedResults(results);
  await inspectLoop(results);
  if (await askYesNo('Export these results?', false)) await exportFlow(lastScan);
}

// ───────────────────────────── export ─────────────────────────────

async function exportFlow(scan) {
  if (!scan) { errorLine('Nothing to export yet. Run a scan first.'); return; }
  print(c.grey(`Reports are written to: ${config.reportDir}`));
  const f = await askText('format  json / txt / both  (Enter = both)');
  if (f === null) return;
  const fl = f.toLowerCase();
  const formats = fl === 'json' ? ['json'] : fl === 'txt' ? ['txt'] : fl === '' || fl === 'both' ? ['json', 'txt'] : null;
  if (!formats) { errorLine('Choose json, txt or both.'); return; }
  try {
    const obj = scan.reportObj || reportObject(scan.kind || 'Scan', scan.query, scan.platformNames, scan.results);
    const files = writeReports(obj, formats);
    okLine('Export saved:'); files.forEach((x) => print('  ' + c.white(x)));
  } catch (e) { errorLine(`Could not write the report: ${redact(e.message)}. Change the folder in Settings.`); }
}

// ───────────────────────────── menu 1 / 2 / 12 ─────────────────────────────

async function readUsername(label = 'username') {
  const v = await askText(label);
  return v === null ? null : v;
}

async function menuSocial() {
  screen('1 · Social Media Intelligence', 'Pick one platform, look up one username. Official or documented sources only.');
  platformList();
  print(c.grey('  0 back'));
  const sel = await askText('platform #');
  if (sel === null || sel === '0' || sel === '') return;
  const p = /^\d+$/.test(sel) ? PLATFORMS[Number(sel) - 1] : findPlatform(sel);
  if (!p) { errorLine('Unknown platform.'); return pause(); }
  const st = platformStatusLabel(p);
  print(`${c.white(p.name)} ${st.paint(st.label)}  ${c.grey('username rules: ' + p.ruleText)}`);
  if (p.kind === 'unsupported') { box([p.limitation], c.violet); }
  const u = await readUsername();
  if (u === null || u === '') return;
  const n = normalizeUsername(p, u);
  if (!n.ok) { errorLine(n.error); return pause(); }
  const out = await scanWithUi(n.value, [p]);
  if (out.results[0]) { showDetail(out.results[0]); lastScan = { kind: 'Social lookup', query: n.value, platformNames: [p.name], results: out.results, at: nowIso() }; if (!out.cancelled) saveHistory(toHistoryEntry('social', n.value, [p.id], out.results)); if (await askYesNo('Export this result?', false)) await exportFlow(lastScan); }
  await pause();
}

async function menuScanner() {
  screen('2 · Username Scanner', 'Check one username across selected platforms.');
  const u = await readUsername();
  if (u === null || u === '') return;
  const clean = u.trim().replace(/^@+/, '');
  if (!clean || /\s/.test(clean)) { errorLine('Enter a single username without spaces.'); return pause(); }
  const platforms = await choosePlatforms();
  if (!platforms) return;
  print(); print(c.bold(`Scanning @${clean} on ${platforms.length} platform(s):`));
  print(c.grey(platforms.map((p) => p.name).join(', ')));
  const bad = platforms.filter((p) => !normalizeUsername(p, clean).ok);
  if (bad.length) print(c.yellow(`Invalid for: ${bad.map((p) => p.name).join(', ')} (skipped, no request sent)`));
  if (!(await askYesNo('Start scan?', true))) return;
  const out = await scanWithUi(clean, platforms);
  await afterScan('Username scan', clean, platforms, out);
  await pause();
}

async function menuBatch() {
  screen('12 · Batch Username Check', 'Up to 10 usernames, checked one after another on selected platforms.');
  const v = await askText('usernames (comma/space separated)');
  if (v === null || v === '') return;
  const names = [...new Set(v.split(/[\s,]+/).map((s) => s.replace(/^@+/, '')).filter(Boolean))];
  if (!names.length) { errorLine('No usernames entered.'); return pause(); }
  if (names.length > 10) { errorLine(`Too many usernames (${names.length}). The limit is 10 per batch to stay polite to the sources.`); return pause(); }
  const platforms = await choosePlatforms();
  if (!platforms) return;
  print(c.bold(`${names.length} username(s) × ${platforms.length} platform(s) = ${names.length * platforms.length} checks`));
  if (!(await askYesNo('Start batch?', true))) return;
  const all = []; let cancelled = false; const ctl = new AbortController(); activeAbort = ctl;
  for (let i = 0; i < names.length && !ctl.signal.aborted; i++) {
    print(c.grey(`[${i + 1}/${names.length}] @${names[i]}`));
    const out = await runScan(names[i], platforms, { signal: ctl.signal, onProgress: progressPainter(platforms.length) });
    if (isTTY) stdout.write('\r\x1b[K');
    all.push(...out.results);
    print(`  ${summaryLine(out.results)}`);
    if (out.cancelled) cancelled = true;
  }
  activeAbort = null;
  print(rule('·'));
  print(c.bold('Matrix (● found  ○ not found  ◐ unverified  ⊘ unavailable  ◔ limited  ✖ error  – skipped)'));
  const head = pad('', 14) + platforms.map((p) => pad(p.name.slice(0, 3), 4)).join('');
  print(c.grey(head));
  for (const nm of names) {
    const cells = platforms.map((p) => { const r = all.find((x) => x.platformId === p.id && x.query.toLowerCase() === nm.toLowerCase()) || all.find((x) => x.platformId === p.id && x.query === nm); return pad(r ? STATES[r.state].paint(STATES[r.state].glyph) : c.grey('·'), 4); });
    print(pad(truncate('@' + nm, 13), 14) + cells.join(''));
  }
  print(summaryLine(all));
  if (cancelled) print(c.yellow('Batch cancelled: partial results, not saved to history.'));
  lastScan = { kind: 'Batch check', query: names.join('+'), platformNames: platforms.map((p) => p.name), results: all, at: nowIso(), partial: cancelled };
  if (!cancelled && all.length) saveHistory(toHistoryEntry('batch', names.join(', '), platforms.map((p) => p.id), all));
  if (all.length) { numberedResults(all.slice(0, 60)); await inspectLoop(all); if (await askYesNo('Export these results?', false)) await exportFlow(lastScan); }
  await pause();
}

// ───────────────────────────── menu 3 · profile analysis ─────────────────────────────

async function menuProfile() {
  screen('3 · Profile Analysis', 'Detailed view of confirmed public profiles from your latest scan.');
  if (!lastScan || !lastScan.results.length) { infoLine('No scan results in this session yet. Run a lookup first (menu 1, 2 or 12).'); return pause(); }
  const found = lastScan.results.filter((r) => r.state === 'FOUND');
  print(c.white(`Latest: ${lastScan.kind} for @${lastScan.query}`) + c.grey(` (${lastScan.at})`));
  if (!found.length) {
    infoLine('No confirmed profiles in the latest scan. Showing why each platform could not be analysed:');
    for (const r of lastScan.results) print(`${pad(r.platform, 10)} ${stateTag(r.state)} ${c.grey(truncate(r.note || r.confidence || '', Math.max(8, width() - 30)))}`);
    infoLine('Open any result for the exact reason, e.g. choose a number below.');
    numberedResults(lastScan.results); await inspectLoop(lastScan.results); return pause();
  }
  found.forEach((r, i) => print(`${c.grey(pad(String(i + 1), 2))} ${pad(r.platform, 10)} ${c.grey('@' + r.query)}`));
  while (true) {
    const v = await askText('profile # (Enter = back)');
    if (v === null || v === '') break;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > found.length) { errorLine(`Enter 1-${found.length}.`); continue; }
    showDetail(found[n - 1]);
    const p = PLATFORM_BY_ID[found[n - 1].platformId];
    const missing = FIELD_ORDER.filter(([k]) => !(p.exposes || []).includes(k)).map(([, l]) => l);
    if (missing.length) kv('Never provided', missing.join(', '));
  }
}

// ───────────────────────────── menu 4 · history, 5 · export ─────────────────────────────

async function menuHistory() {
  screen('4 · Search History', config.persistHistory ? `Stored at ${HISTORY_FILE}` : 'History persistence is OFF (Settings → history). Showing any existing file.');
  const h = readHistory();
  if (!h.length) { infoLine('History is empty.'); return pause(); }
  h.slice(0, 25).forEach((e, i) => { const s = summarize(e.results); print(`${c.grey(pad(String(i + 1), 2))} ${c.white(pad(truncate(e.query, 18), 19))} ${c.grey(e.at.slice(0, 16).replace('T', ' '))} ${c.green('●' + (s.FOUND || 0))} ${c.grey(e.results.length + ' plat.')}`); });
  print(c.grey('  # view entry · c clear all history · Enter back'));
  const v = await askText('history');
  if (v === null || v === '') return;
  if (v.toLowerCase() === 'c') { if (await askYesNo('Delete all saved history?', false)) { clearHistory() ? okLine('History cleared.') : errorLine('Could not clear history.'); } return pause(); }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > Math.min(25, h.length)) { errorLine('Invalid entry number.'); return pause(); }
  const e = h[n - 1];
  print(); kv('Query', e.query); kv('Type', e.kind); kv('Saved', e.at);
  for (const r of e.results) print(`${pad(r.platform, 10)} ${stateTag(r.state)} ${c.grey(r.profileUrl || '')}`);
  print(c.grey('History keeps only states, URLs, sources and timestamps.'));
  await pause();
}

async function menuExport() {
  screen('5 · Export Reports', `Output folder: ${config.reportDir}`);
  const h = readHistory();
  print(`${c.white('1')} Latest scan in this session${lastScan ? c.grey(` (@${lastScan.query}, ${lastScan.results.length} results)`) : c.grey(' (none)')}`);
  print(`${c.white('2')} Entry from saved history${h.length ? c.grey(` (${h.length} saved)`) : c.grey(' (empty)')}`);
  print(c.grey('  0 back'));
  const v = await askText('source');
  if (v === null || v === '0' || v === '') return;
  if (v === '1') { await exportFlow(lastScan); return pause(); }
  if (v === '2') {
    if (!h.length) { errorLine('History is empty.'); return pause(); }
    h.slice(0, 15).forEach((e, i) => print(`${c.grey(pad(String(i + 1), 2))} ${e.query} ${c.grey(e.at.slice(0, 16))}`));
    const n = Number(await askText('entry #'));
    if (!Number.isInteger(n) || n < 1 || n > Math.min(15, h.length)) { errorLine('Invalid entry.'); return pause(); }
    const e = h[n - 1];
    const results = e.results.map((r) => ({ platform: r.platform, platformId: (findPlatform(r.platform) || {}).id, query: e.query, state: r.state, profileUrl: r.profileUrl, fields: {}, extra: [], note: 'Summary from history (profile details are not stored).', confidence: null, source: r.source || { name: null, url: null }, httpStatus: null, retrievedAt: r.retrievedAt }));
    await exportFlow({ kind: 'History entry', query: e.query, platformNames: results.map((r) => r.platform), results });
    return pause();
  }
  errorLine('Choose 1, 2 or 0.'); await pause();
}

// ───────────────────────────── menu 6 · scan config, 14 · settings ─────────────────────────────

async function editNumber(label, key, min, max) {
  const v = await askText(`${label} (${min}-${max}, current ${key === 'timeoutMs' ? config[key] / 1000 : config[key]})`);
  if (v === null || v === '') return;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) { errorLine(`Enter a number between ${min} and ${max}.`); return; }
  config[key] = key === 'timeoutMs' ? Math.round(n * 1000) : Math.round(n);
  saveConfig() ? okLine('Saved.') : errorLine('Changed for this session, but could not write config file.');
}

async function editDefaultPlatforms() {
  platformList(config.defaultPlatforms);
  const v = await askText('new default platforms (numbers/names, Enter = keep)');
  if (v === null || v === '') return;
  const sel = parseSelection(v === 'd' ? '' : v);
  if (sel.error) { errorLine(sel.error); return; }
  config.defaultPlatforms = sel.list.map((p) => p.id);
  saveConfig() ? okLine(`Default platforms: ${sel.list.map((p) => p.name).join(', ')}`) : errorLine('Could not write config file.');
}

async function menuScanConfig() {
  while (true) {
    screen('6 · Scan Configuration', 'How scans run. Conservative defaults protect you from rate limits.');
    kv('Timeout', `${config.timeoutMs / 1000}s per request`);
    kv('Concurrency', `${config.concurrency} simultaneous requests`);
    kv('Cache', `${config.cacheTtlSec}s (successful and definite results only)`);
    kv('Defaults', config.defaultPlatforms.map((id) => PLATFORM_BY_ID[id].name).join(', ') || 'none');
    print(); print(`${c.white('1')} timeout   ${c.white('2')} concurrency   ${c.white('3')} default platforms   ${c.white('4')} cache seconds   ${c.white('0')} back`);
    const v = await askText('config');
    if (v === null || v === '0' || v === '') return;
    if (v === '1') await editNumber('timeout seconds', 'timeoutMs', 2, 60);
    else if (v === '2') await editNumber('concurrency', 'concurrency', 1, 6);
    else if (v === '3') await editDefaultPlatforms();
    else if (v === '4') await editNumber('cache seconds', 'cacheTtlSec', 0, 3600);
    else errorLine('Choose 1-4 or 0.');
    await pause();
  }
}

async function menuSettings() {
  while (true) {
    screen('14 · Settings', `Config file: ${CONFIG_FILE}`);
    kv('1 Color', config.color ? 'on' : 'off'); kv('2 Animation', config.animation ? 'on' : 'off');
    kv('3 Timeout', `${config.timeoutMs / 1000}s`); kv('4 Concurrency', String(config.concurrency));
    kv('5 Defaults', config.defaultPlatforms.map((id) => PLATFORM_BY_ID[id].name).join(', '));
    kv('6 History', config.persistHistory ? 'save summaries' : 'do not save'); kv('7 Report folder', config.reportDir);
    kv('8 API status', `${SECRET_KEYS.filter((s) => hasSecret(s.key)).length}/${SECRET_KEYS.length} keys set`); kv('9 Reset', 'restore defaults');
    print(c.grey('  0 back'));
    const v = await askText('setting');
    if (v === null || v === '0' || v === '') return;
    if (v === '1') { config.color = !config.color; saveConfig(); okLine(`Color ${config.color ? 'on' : 'off'}`); }
    else if (v === '2') { config.animation = !config.animation; saveConfig(); okLine(`Animation ${config.animation ? 'on' : 'off'}`); }
    else if (v === '3') await editNumber('timeout seconds', 'timeoutMs', 2, 60);
    else if (v === '4') await editNumber('concurrency', 'concurrency', 1, 6);
    else if (v === '5') await editDefaultPlatforms();
    else if (v === '6') { config.persistHistory = !config.persistHistory; saveConfig(); okLine(`History ${config.persistHistory ? 'will be saved' : 'will not be saved'}`); }
    else if (v === '7') {
      const d = await askText('new report folder (absolute path, Enter = keep)');
      if (d) { const dir = path.resolve(d.replace(/^~(?=$|\/)/, os.homedir())); try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); config.reportDir = dir; saveConfig(); okLine(`Reports go to ${dir}`); } catch (e) { errorLine(`Folder is not writable: ${e.code || e.message}`); } }
    }
    else if (v === '8') { await menuApiStatus(true); continue; }
    else if (v === '9') { if (await askYesNo('Reset every setting to defaults?', false)) { config = { ...DEFAULTS }; saveConfig(); okLine('Defaults restored.'); } }
    else errorLine('Choose 1-9 or 0.');
    await pause();
  }
}

// ───────────────────────────── menu 7 · API status, 11 · refresh ─────────────────────────────

async function menuApiStatus(noPause = false) {
  screen('7 · Source and API Status');
  print(c.bold('Adapters'));
  for (const p of PLATFORMS) { const st = platformStatusLabel(p); print(`${pad(p.name, 10)} ${st.paint(pad(st.label, 16))} ${c.grey(truncate(p.sourceName, Math.max(8, width() - 30)))}`); }
  print(`${pad('Roblox', 10)} ${c.green(pad('ready (public)', 16))} ${c.grey('Roblox web APIs')}`);
  print(`${pad('PUBG', 10)} ${(hasSecret('PUBG_API_KEY') ? c.green : c.yellow)(pad(hasSecret('PUBG_API_KEY') ? 'ready (api key)' : 'needs key', 16))} ${c.grey('PUBG Developer API')}`);
  print(`${pad('MLBB', 10)} ${c.violet(pad('unavailable', 16))} ${c.grey('no official public API')}`);
  print(); print(c.bold('Credentials') + c.grey(' (values are never shown)'));
  for (const s of SECRET_KEYS) print(`${pad(s.key, 24)} ${hasSecret(s.key) ? c.green('set') : c.grey('not set')} ${c.grey('· ' + s.for)}`);
  print(); print(c.grey(`Set keys as environment variables or in ${ENV_FILE_USER} (or ./.env). See .env.example.`));
  const net = !netStatus.tested ? 'not tested yet (menu 11 tests it)' : `${netStatus.ok ? 'reachable' : 'unreachable'} — ${netStatus.detail} at ${netStatus.at}`;
  kv('Network', net);
  if (!noPause) await pause();
}

async function menuRefresh() {
  screen('11 · Refresh Data');
  const n = cache.size; cache.clear(); delete tokenCache.twitch; delete tokenCache.reddit; hostGate.clear();
  loadEnvFiles(); loadConfig();
  okLine(`Cache cleared (${n} entries), rate-limit gates reset, tokens dropped, config and .env reloaded.`);
  const t = await testNetwork();
  (t.ok ? okLine : errorLine)(`Network test: ${t.ok ? 'reachable' : 'unreachable'} (${t.detail})`);
  await pause();
}

// ───────────────────────────── menu 8 / 9 / 13 / 15 ─────────────────────────────

async function menuHelp() {
  screen('8 · Help and Usage');
  const rows = [
    ['Menus', 'Type the number and press Enter. 0 or empty input goes back.'],
    ['Scanning', 'Option 2 checks one username on chosen platforms; 12 does up to 10 names.'],
    ['States', ''],
  ];
  rows.forEach(([a, b]) => { if (b) kv(a, b); else print(c.grey(a)); });
  Object.entries(STATES).forEach(([k]) => print(`  ${stateTag(k)}  ${c.grey(STATES[k].meaning)}`));
  print(); print(c.bold('Command line'));
  ['node intel.js                 interactive menu', 'node intel.js --scan NAME [--platforms github,medium] [--json]', 'node intel.js --version | --help', 'flags: --no-color  --no-animation  --no-clear', 'NO_COLOR=1 also disables color'].forEach((l) => print('  ' + c.white(l)));
  print(); print(c.grey('Ctrl+C cancels a running scan; at a prompt it exits cleanly.'));
  await pause();
}

async function menuAbout() {
  screen('9 · About Shadow-OmniTrace');
  box([`${APP} v${VERSION}`, 'A single-file Node.js toolkit that checks public profile data only through official or documented sources, and says plainly when a platform offers no legitimate lookup.', 'Honest states instead of guesses: a blocked request is never reported as "not found".', 'No scraping of private data, no CAPTCHA or login bypass, no tracking, no telemetry.']);
  print(madeByLine(phase) + ' ' + c.grey(`· Node ${process.versions.node}`));
  await pause();
}

async function menuPlatformInfo() {
  screen('13 · Platform Information');
  platformList(); print(c.grey('  0 back'));
  const v = await askText('platform #');
  if (v === null || v === '' || v === '0') return;
  const p = /^\d+$/.test(v) ? PLATFORMS[Number(v) - 1] : findPlatform(v);
  if (!p) { errorLine('Unknown platform.'); return pause(); }
  const st = platformStatusLabel(p);
  print(); print(c.bold(p.name) + '  ' + st.paint(st.label)); print(rule('·'));
  kv('Source', p.sourceName); kv('Documentation', p.docs); kv('Username rules', p.ruleText);
  kv('Credentials', (p.needs && p.needs.length) ? p.needs.map((k) => `${k} (${hasSecret(k) ? 'set' : 'missing'})`).join(', ') : p.kind === 'unsupported' ? 'n/a' : 'none required');
  kv('Can return', p.exposes.length ? FIELD_ORDER.filter(([k]) => p.exposes.includes(k)).map(([k, l]) => (k === 'posts' && p.postsLabel ? p.postsLabel : l)).join(', ') : 'nothing (no legitimate lookup)');
  kv('Limitations', p.limitation);
  await pause();
}

async function menuCredits() {
  screen('15 · Credits');
  kv('Created by', 'NullKat Development'); kv('Version', VERSION); kv('Runtime', `Node.js ${process.versions.node}`);
  kv('Dependencies', 'none (Node built-ins only)');
  kv('Data sources', 'GitHub REST, Medium RSS, t.me preview, YouTube Data API, Twitch Helix, Reddit API, X API v2, Meta Graph/Threads APIs, Roblox web APIs, PUBG Developer API');
  print(c.grey('Platform names and marks belong to their owners; this tool is not affiliated with them.'));
  print(madeByLine(phase));
  await pause();
}

// ───────────────────────────── menu 16 · gaming ─────────────────────────────

function showGameResult(r) {
  showDetail({ ...r, platformId: r.platformId || 'x' });
}

async function menuGaming() {
  while (true) {
    screen('16 · Gaming Intelligence', 'Official or documented game APIs only.');
    print(`${c.white('1')} Mobile Legends: Bang Bang  ${c.violet('unavailable')}`);
    print(`${c.white('2')} Roblox                     ${c.green('ready (public)')}`);
    print(`${c.white('3')} PUBG                       ${hasSecret('PUBG_API_KEY') ? c.green('ready (api key)') : c.yellow('needs key')}`);
    print(`${c.white('4')} Back`);
    const v = await askText('game');
    if (v === null || v === '4' || v === '0' || v === '') return;
    if (v === '1') { mlbbInfo().forEach((l) => kv('', l, 0)); const rr = makeResult({ id: 'mlbb', name: 'Mobile Legends: Bang Bang', sourceName: 'None (no official API)' }, '-', 'UNAVAILABLE', { note: 'No official public player-lookup API exists.' }); print(stateTag(rr.state)); await pause(); }
    else if (v === '2') await gameRoblox();
    else if (v === '3') await gamePubg();
    else { errorLine('Choose 1-4.'); await pause(); }
  }
}

async function gameRoblox() {
  const u = await askText('Roblox username'); if (u === null || u === '') return;
  const name = u.replace(/^@+/, '');
  if (!ROBLOX.rule.test(name)) { errorLine(`Not a valid Roblox username: ${ROBLOX.ruleText}`); return pause(); }
  const ctl = new AbortController(); activeAbort = ctl;
  const r = await lookupRoblox(name, ctl.signal); activeAbort = null;
  r.platform = 'Roblox'; r.platformId = 'roblox';
  showRobloxResult(r);
  lastScan = { kind: 'Roblox lookup', query: name, platformNames: ['Roblox'], results: [r], at: nowIso() };
  if (!ctl.signal.aborted) saveHistory(toHistoryEntry('game', name, ['roblox'], [r]));
  if (await askYesNo('Export this result?', false)) await exportFlow(lastScan);
  await pause();
}

function showRobloxResult(r) { showDetailGeneric(r, ROBLOX_FIELDS); }
const ROBLOX_FIELDS = { exposes: ['displayName', 'bio', 'avatar', 'verified', 'followers', 'following', 'created'], limitation: 'Public profile only. Inventory, private data and account access are never requested.' };

/** Detail view for game sources that are not in the social registry. */
function showDetailGeneric(r, meta) {
  print(); print(`${c.bold(c.white(r.platform))}  ${stateTag(r.state)}`); print(rule('·'));
  kv('Queried', r.query);
  if (r.profileUrl) kv('Profile URL', r.profileUrl);
  if (r.confidence) kv('Confidence', r.confidence);
  if (r.note) kv('Note', r.note);
  if (r.state === 'FOUND') {
    for (const [k, label] of FIELD_ORDER) {
      if (!meta.exposes.includes(k)) continue;
      kv(`  ${label}`, fieldValue(k, r.fields[k]) || c.grey('Not available for this account'));
    }
    for (const [k, v] of r.extra || []) kv(`  ${k}`, fieldValue(k, v) || String(v));
  }
  kv('Source', `${r.source.name}${r.source.url ? ` — ${r.source.url}` : ''}`); kv('Retrieved', r.retrievedAt);
  if (meta.limitation) kv('Limitation', meta.limitation);
}

async function gamePubg() {
  if (!hasSecret('PUBG_API_KEY')) {
    box(['PUBG lookups need your own free developer API key.', 'Get one at developer.pubg.com, then set PUBG_API_KEY as an environment variable or in .env. The key is never printed or saved to reports.', 'Developer keys allow 10 requests per minute.'], c.yellow);
    const rr = makeResult(PUBG, '-', 'UNAVAILABLE', { note: 'PUBG_API_KEY not configured.' });
    print(stateTag(rr.state)); return pause();
  }
  print(c.grey(`Shards: ${PUBG_SHARDS.join(', ')}  (current: ${config.pubgShard})`));
  const sh = await askText('shard (Enter = keep)'); if (sh === null) return;
  if (sh) { if (!PUBG_SHARDS.includes(sh.toLowerCase())) { errorLine(`Shard must be one of: ${PUBG_SHARDS.join(', ')}`); return pause(); } config.pubgShard = sh.toLowerCase(); saveConfig(); }
  const u = await askText('PUBG player name (case-sensitive)'); if (u === null || u === '') return;
  if (!PUBG.rule.test(u)) { errorLine(`Not a valid player name: ${PUBG.ruleText}`); return pause(); }
  const ctl = new AbortController(); activeAbort = ctl;
  const r = await lookupPubg(u, config.pubgShard, ctl.signal); activeAbort = null;
  r.platform = 'PUBG'; r.platformId = 'pubg';
  showDetailGeneric(r, { exposes: ['displayName'], limitation: 'Lifetime stats per game mode from the official API; ranked/season stats are not shown.' });
  lastScan = { kind: 'PUBG lookup', query: u, platformNames: ['PUBG'], results: [r], at: nowIso() };
  if (!ctl.signal.aborted) saveHistory(toHistoryEntry('game', u, ['pubg'], [r]));
  if (await askYesNo('Export this result?', false)) await exportFlow(lastScan);
  await pause();
}

// ───────────────────────────── main menu & entry ─────────────────────────────

const MENU = [
  ['Social Media Intelligence', menuSocial], ['Username Scanner', menuScanner], ['Profile Analysis', menuProfile], ['Search History', menuHistory],
  ['Export Reports', menuExport], ['Scan Configuration', menuScanConfig], ['Source and API Status', menuApiStatus], ['Help and Usage', menuHelp],
  ['About Shadow-OmniTrace', menuAbout], ['Clear Terminal', null], ['Refresh Data', menuRefresh], ['Batch Username Check', menuBatch],
  ['Platform Information', menuPlatformInfo], ['Settings', menuSettings], ['Credits', menuCredits], ['Gaming Intelligence', menuGaming], ['Exit', null],
];

function drawMainMenu() {
  screen('main menu');
  const half = Math.ceil(MENU.length / 2);
  const w = width();
  if (w >= 60) {
    for (let i = 0; i < half; i++) { const a = `${c.red(pad(String(i + 1), 2))} ${MENU[i][0]}`; const j = i + half; const b = j < MENU.length ? `${c.red(pad(String(j + 1), 2))} ${MENU[j][0]}` : ''; print(pad(a, 31) + b); }
  } else MENU.forEach(([label], i) => print(`${c.red(pad(String(i + 1), 2))} ${label}`));
  print(rule('·'));
}

async function mainLoop() {
  let first = true;
  while (true) {
    drawMainMenu();
    if (first) { first = false; }
    const v = await askText('select');
    if (v === null) return;
    if (v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > MENU.length) { errorLine(`"${truncate(v, 20)}" is not a menu option. Enter 1-${MENU.length}.`); await pause(); continue; }
    if (n === 17) return;
    if (n === 10) { stdout.write('\x1b[2J\x1b[H'); lineCounter = 0; continue; }
    try { await MENU[n - 1][1](); } catch (e) { errorLine(`Unexpected error: ${redact(e && e.message)}`); await pause(); }
  }
}

async function cliScan() {
  const i = argv.indexOf('--scan'); const user = argv[i + 1];
  if (!user || user.startsWith('--')) { console.error('Usage: node intel.js --scan USERNAME [--platforms github,medium] [--json]'); return 2; }
  let platforms = config.defaultPlatforms.map((id) => PLATFORM_BY_ID[id]);
  const pi = argv.indexOf('--platforms');
  if (pi !== -1) { const sel = parseSelection(argv[pi + 1] || ''); if (sel.error) { console.error(sel.error); return 2; } platforms = sel.list; }
  const ctl = new AbortController(); process.on('SIGINT', () => ctl.abort('cancelled'));
  const out = await runScan(user.replace(/^@+/, ''), platforms, { signal: ctl.signal });
  if (flag('--json')) { process.stdout.write(redact(JSON.stringify(reportObject('CLI scan', user, platforms.map((p) => p.name), out.results), null, 2)) + '\n'); }
  else { out.results.forEach((r) => print(`${pad(r.platform, 10)} ${stateTag(r.state)} ${c.grey(r.profileUrl || r.note || '')}`)); print(summaryLine(out.results)); }
  return out.cancelled ? 130 : 0;
}

async function main() {
  loadEnvFiles(); loadConfig();
  if (flag('--version') || flag('-v')) { console.log(`${APP} ${VERSION}`); return 0; }
  if (flag('--help') || flag('-h')) {
    console.log(`${APP} ${VERSION} — Made by: NullKat Development\n\nUsage:\n  node intel.js                      interactive menu\n  node intel.js --scan NAME [--platforms a,b] [--json]\n  node intel.js --version\n\nFlags: --no-color --no-animation --no-clear   (NO_COLOR=1 also works)`);
    return 0;
  }
  if (flag('--scan')) return cliScan();
  if (!isTTY && process.stdin.isTTY === undefined && !process.env.SHADOW_ALLOW_PIPE) { /* piped input is allowed; prompts are echoed */ }
  initInput();
  process.on('SIGTERM', () => gracefulExit(143));
  await splash();
  await mainLoop();
  stopTicker();
  print(); print(`${c.deep('Shadow')}${c.grey('·')}${c.deep('OmniTrace')} ${c.grey('— session closed.')}`);
  print(madeByLine(phase));
  try { rl.close(); } catch (_) { /* ignore */ }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code || 0)).catch((e) => { console.error(`Fatal: ${redact(e && e.stack || e)}`); process.exit(1); });
} else {
  module.exports = { http, runScan, runPlatform, PLATFORMS, normalizeUsername, lookupRoblox, lookupPubg, reportObject, reportText, writeReports, redact, config: () => config, setConfig: (o) => Object.assign(config, o), cache, hostGate, STATES, saveHistory, readHistory, toHistoryEntry, parseSelection, mlbbInfo };
}

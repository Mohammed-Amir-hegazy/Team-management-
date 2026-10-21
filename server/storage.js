'use strict';

// Where the data lives.
//   EBTIKAR_DB_URL + EBTIKAR_DB_TOKEN        a database you chose yourself (always wins)
//   TURSO_DATABASE_URL + TURSO_AUTH_TOKEN    Turso (on Vercel, set by the Turso integration)
//   DB_FILE / data/team.db                   a local file (development, Docker volume)
//
// The Vercel Turso integration gives every deployment its own database branch ("dpl-…") copied from an
// empty parent, so each deploy would start with no data. EBTIKAR_DB_URL avoids that: the integration
// never touches it.

const path = require('node:path');

function databaseSettings(env = process.env) {
  if (env.EBTIKAR_DB_URL) {
    return { url: env.EBTIKAR_DB_URL.trim(), authToken: (env.EBTIKAR_DB_TOKEN || env.TURSO_AUTH_TOKEN || '').trim() || undefined, source: 'app' };
  }
  if (env.TURSO_DATABASE_URL) {
    return { url: env.TURSO_DATABASE_URL.trim(), authToken: (env.TURSO_AUTH_TOKEN || '').trim() || undefined, source: 'turso' };
  }
  const file = env.DB_FILE || path.join(__dirname, '..', 'data', 'team.db');
  return { url: `file:${file}`, file, source: 'file' };
}

// Where a database is, for logs: the file, or the host of a remote one (never credentials).
function databaseHost(url) {
  if (url.startsWith('file:')) return url.slice(5);
  try {
    return new URL(url.replace(/^libsql:/, 'https:')).host;
  } catch {
    return '?';
  }
}

// 'ephemeral': a file on a host whose disk is wiped (Render, Vercel). 'branch': a per-deployment
// database branch from the Vercel integration. null: storage is permanent.
function storageWarning(env = process.env) {
  const db = databaseSettings(env);
  if (db.source === 'file') return env.RENDER || env.VERCEL ? 'ephemeral' : null;
  if (db.source === 'turso' && databaseHost(db.url).startsWith('dpl-')) return 'branch';
  return null;
}

module.exports = { databaseSettings, databaseHost, storageWarning };

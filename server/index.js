'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { startScheduler } = require('./scheduler');
const { createMessenger } = require('./messaging');
const { loadConfig } = require('./config');
const { syncPlatformOwner } = require('./owner');
const { databaseSettings, databaseHost } = require('./storage');
const { importDatabase } = require('./importer');
const { deliverReleases } = require('./releases');

const PORT = Number(process.env.PORT) || 3000;

const STORAGE_WARNINGS = {
  ephemeral: 'WARNING: no database is configured — data is stored on a temporary disk and is LOST on every deploy. Set EBTIKAR_DB_URL and EBTIKAR_DB_TOKEN.',
  branch: 'WARNING: this is a per-deployment database branch from the Vercel Turso integration — the next deploy starts with a new, empty one. Set EBTIKAR_DB_URL and EBTIKAR_DB_TOKEN to one fixed database.',
};

// Copies the data once from IMPORT_FROM_URL into an empty database (see importer.js).
async function importIfAsked(db, settings) {
  const from = process.env.IMPORT_FROM_URL && process.env.IMPORT_FROM_URL.trim();
  if (!from) return;
  try {
    const r = await importDatabase(db, { url: from, authToken: (process.env.IMPORT_FROM_TOKEN || '').trim() || settings.authToken });
    if (r.copied) console.log(`Imported data from ${databaseHost(from)}:`, JSON.stringify(r.copied));
    else console.log(`Import from ${databaseHost(from)} skipped (${r.skipped}).`);
  } catch (err) {
    console.error(`Import from ${databaseHost(from)} failed; nothing was changed:`, err.message);
  }
}

async function main() {
  const settings = databaseSettings();
  if (settings.file) fs.mkdirSync(path.dirname(settings.file), { recursive: true });
  const db = await openDatabase(settings.url, settings.authToken);
  const config = loadConfig();
  await importIfAsked(db, settings);
  if (config.storageWarning) console.warn(STORAGE_WARNINGS[config.storageWarning]);
  await syncPlatformOwner(db, config);
  const messenger = createMessenger();
  try {
    const sent = await deliverReleases(db, messenger);
    if (sent.length) console.log('Announced platform updates:', sent.join(', '));
  } catch (err) {
    console.error('Could not announce platform updates:', err.message);
  }
  startScheduler(db, { messenger });
  http.createServer(createApp(db, { messenger, config })).listen(PORT, () => {
    const where = `${settings.url.startsWith('file:') ? settings.url : `Turso ${databaseHost(settings.url)}`}${
      settings.source === 'app' ? ' via EBTIKAR_DB_URL' : ''}`;
    console.log(`Team management is running on http://localhost:${PORT} (database: ${where})`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});

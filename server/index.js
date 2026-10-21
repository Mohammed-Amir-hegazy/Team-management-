'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { startScheduler } = require('./scheduler');
const { createMessenger } = require('./messaging');

const PORT = Number(process.env.PORT) || 3000;

// Turso in production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN), a local file otherwise.
function databaseUrl() {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'team.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return `file:${file}`;
}

async function main() {
  const url = databaseUrl();
  const db = await openDatabase(url, process.env.TURSO_AUTH_TOKEN);
  const messenger = createMessenger();
  startScheduler(db, { messenger });
  http.createServer(createApp(db, { messenger })).listen(PORT, () => {
    const where = url.startsWith('file:') ? url : 'Turso';
    console.log(`Team management is running on http://localhost:${PORT} (database: ${where})`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { startScheduler } = require('./scheduler');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'team.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = openDatabase(DB_FILE);
startScheduler(db);

http.createServer(createApp(db)).listen(PORT, () => {
  console.log(`Team management is running on http://localhost:${PORT}`);
});

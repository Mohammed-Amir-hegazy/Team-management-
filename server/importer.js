'use strict';

// One-time copy of all data from another database (e.g. the Vercel deployment branch that holds the
// data) into this one. It only runs when this database has no companies and no users yet, never
// writes to the source, and copies everything in one transaction: all of it or nothing.

const { createClient } = require('@libsql/client');
const { migrate } = require('./db');

// Parents before children. Short-lived rows (login codes, password resets) are not worth carrying over.
const TABLES = [
  'companies', 'users', 'subscription_events', 'sessions', 'projects', 'project_members', 'tasks',
  'task_status_history', 'requests', 'requirements', 'reports', 'attachments', 'images', 'notifications',
];

async function columnsOf(execute, table) {
  const rs = await execute(`PRAGMA table_info(${table})`);
  const idx = rs.columns.indexOf('name');
  return rs.rows.map((r) => r[idx]);
}

const toArg = (value) => (value instanceof ArrayBuffer ? Buffer.from(value) : value);

async function importDatabase(target, { url, authToken }) {
  const { n } = await target.get('SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM companies) AS n');
  if (n > 0) return { skipped: 'target-not-empty' };

  const source = createClient({ url, authToken });
  try {
    const readSource = (sql) => source.execute(sql);
    const readTarget = (sql) => target.client.execute(sql);
    const present = new Set((await readSource("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => r[0]));
    const statements = [{ sql: 'PRAGMA defer_foreign_keys = ON', args: [] }];
    const copied = {};
    for (const table of TABLES) {
      if (!present.has(table)) continue;
      // Only the columns both sides know: the source may come from an older version.
      const targetColumns = new Set(await columnsOf(readTarget, table));
      const columns = (await columnsOf(readSource, table)).filter((c) => targetColumns.has(c));
      const rows = (await readSource(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY rowid`)).rows;
      const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
      for (const row of rows) statements.push({ sql, args: columns.map((_, i) => toArg(row[i])) });
      copied[table] = rows.length;
    }
    if (!copied.users && !copied.companies) return { skipped: 'source-empty' };
    await target.client.batch(statements, 'write');
    await migrate(target);
    return { copied };
  } finally {
    source.close();
  }
}

module.exports = { importDatabase };

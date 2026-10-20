'use strict';

const { createClient } = require('@libsql/client');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'team_leader', 'employee')),
  supervisor_id INTEGER REFERENCES users(id),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold', 'completed')),
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  added_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  assignee_id      INTEGER NOT NULL REFERENCES users(id),
  created_by       INTEGER NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL DEFAULT 'todo'
                   CHECK (status IN ('todo', 'in_progress', 'blocked', 'review', 'done')),
  status_note      TEXT NOT NULL DEFAULT '',
  priority         TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  deadline         TEXT,
  reminder_at      TEXT,
  reminder_sent    INTEGER NOT NULL DEFAULT 0,
  overdue_notified INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_status_history (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- A batch of requirements sent with one click to the sender's direct supervisor.
CREATE TABLE IF NOT EXISTS requests (
  id                INTEGER PRIMARY KEY,
  sender_id         INTEGER NOT NULL REFERENCES users(id),
  recipient_id      INTEGER NOT NULL REFERENCES users(id),
  scope             TEXT NOT NULL CHECK (scope IN ('task', 'project')),
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id           INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'forwarded')),
  note              TEXT NOT NULL DEFAULT '',
  response_note     TEXT NOT NULL DEFAULT '',
  forwarded_from_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
  -- The original request of a forwarding chain (NULL on the original itself); items hang off it.
  root_id           INTEGER REFERENCES requests(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  responded_at      TEXT
);

-- A single requirement item. While request_id is NULL it is a draft owned by requested_by.
CREATE TABLE IF NOT EXISTS requirements (
  id           INTEGER PRIMARY KEY,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  description  TEXT NOT NULL,
  quantity     TEXT NOT NULL DEFAULT '',
  request_id   INTEGER REFERENCES requests(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id                INTEGER PRIMARY KEY,
  sender_id         INTEGER NOT NULL REFERENCES users(id),
  recipient_id      INTEGER NOT NULL REFERENCES users(id),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  task_id           INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  forwarded_from_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  reply             TEXT,
  replied_at        TEXT,
  read_at           TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  link       TEXT NOT NULL DEFAULT '',
  read_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_supervisor ON users(supervisor_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_reminder ON tasks(reminder_sent, reminder_at);
CREATE INDEX IF NOT EXISTS idx_tasks_overdue ON tasks(overdue_notified, deadline);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_requirements_task ON requirements(task_id);
CREATE INDEX IF NOT EXISTS idx_requests_recipient ON requests(recipient_id);
CREATE INDEX IF NOT EXISTS idx_reports_recipient ON reports(recipient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
`;

// Small promise-based query API shared by the database and by open transactions,
// so helpers work the same whether or not they run inside a transaction.
class Queryable {
  constructor(execute) {
    this.execute = execute;
  }

  async all(sql, ...args) {
    const rs = await this.execute({ sql, args });
    return rs.rows.map((row) => Object.fromEntries(rs.columns.map((col, i) => [col, row[i]])));
  }

  async get(sql, ...args) {
    return (await this.all(sql, ...args))[0];
  }

  async run(sql, ...args) {
    const rs = await this.execute({ sql, args });
    return { changes: rs.rowsAffected, lastInsertRowid: Number(rs.lastInsertRowid) };
  }
}

class Database extends Queryable {
  constructor(client) {
    super((stmt) => client.execute(stmt));
    this.client = client;
  }

  async transaction(fn) {
    const tx = await this.client.transaction('write');
    try {
      const result = await fn(new Queryable((stmt) => tx.execute(stmt)));
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      tx.close();
    }
  }

  close() {
    this.client.close();
  }
}

// url: "libsql://<db>.turso.io" for Turso, or "file:path/to.db" for a local file.
async function openDatabase(url, authToken) {
  const client = createClient({ url, authToken });
  if (url.startsWith('file:')) await client.execute('PRAGMA journal_mode = WAL');
  await client.executeMultiple(SCHEMA);
  return new Database(client);
}

function now() {
  return new Date().toISOString();
}

module.exports = { openDatabase, now };

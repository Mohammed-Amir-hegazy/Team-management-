'use strict';

const { createClient } = require('@libsql/client');

const SCHEMA = `
-- Each customer company is an isolated workspace with its own subscription.
CREATE TABLE IF NOT EXISTS companies (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  plan            TEXT NOT NULL CHECK (plan IN ('trial', 'annual', 'owned')),
  seats           INTEGER,            -- maximum active accounts; NULL means unlimited
  starts_at       TEXT NOT NULL,
  ends_at         TEXT,               -- NULL for an owned (perpetual) licence
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  notes           TEXT NOT NULL DEFAULT '',
  reminded_stages TEXT NOT NULL DEFAULT '', -- renewal reminders already sent for the current period
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_events (
  id         INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '',
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'team_leader', 'employee')),
  supervisor_id INTEGER REFERENCES users(id),
  job_title     TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  company_id    INTEGER REFERENCES companies(id),
  is_platform   INTEGER NOT NULL DEFAULT 0, -- may open the platform dashboard (all companies)
  last_login_at TEXT,
  deleted_at    TEXT,                       -- set when the account was deleted (details are wiped, history kept)
  roles         TEXT NOT NULL DEFAULT '',
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
  -- Set on a person's hidden project that holds their standalone tasks (tasks outside any project).
  personal_owner_id INTEGER REFERENCES users(id),
  company_id  INTEGER REFERENCES companies(id),
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
  -- JSON snapshot of the sender's work status (tasks, statuses, team summary) at sending time.
  snapshot          TEXT,
  reply             TEXT,
  replied_at        TEXT,
  read_at           TEXT,
  created_at        TEXT NOT NULL
);

-- Images (hosted on Cloudinary) supporting a task's execution, or attached directly to a report.
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  report_id   INTEGER REFERENCES reports(id) ON DELETE CASCADE,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  url         TEXT NOT NULL,
  public_id   TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  caption     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- One pending password-reset code per user (stored hashed).
CREATE TABLE IF NOT EXISTS password_resets (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_at      TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_count INTEGER NOT NULL DEFAULT 1
);

-- Values the platform makes for itself once and keeps (e.g. its Web Push keys).
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Browsers and installed web apps that receive push notifications (Web Push).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- Phones running the Android app (Firebase Cloud Messaging tokens).
CREATE TABLE IF NOT EXISTS device_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  platform   TEXT NOT NULL DEFAULT 'android',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

-- Platform updates already announced to the companies (see releases.js).
CREATE TABLE IF NOT EXISTS release_notices (
  id      TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);

-- A request from one person to any colleague in the company; the colleague can take it on as a task
-- of their own (task_id) or decline it with a reason.
CREATE TABLE IF NOT EXISTS work_requests (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sender_id     INTEGER NOT NULL REFERENCES users(id),
  recipient_id  INTEGER NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  details       TEXT NOT NULL DEFAULT '',
  priority      TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  due_at        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  response_note TEXT NOT NULL DEFAULT '',
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  responded_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_work_requests_recipient ON work_requests(recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_work_requests_sender ON work_requests(sender_id);
CREATE INDEX IF NOT EXISTS idx_work_requests_task ON work_requests(task_id);

-- Each person's own profile photo (a small square JPEG made in the browser).
CREATE TABLE IF NOT EXISTS user_photos (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       BLOB NOT NULL,
  mime       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A company's own identity for its reports: colours, font (a web font or an uploaded file) and logo.
CREATE TABLE IF NOT EXISTS company_brands (
  company_id      INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  primary_color   TEXT NOT NULL DEFAULT '#06044B',
  secondary_color TEXT NOT NULL DEFAULT '#5146E1',
  accent_color    TEXT NOT NULL DEFAULT '#62E98A',
  font            TEXT NOT NULL DEFAULT 'default',
  font_name       TEXT NOT NULL DEFAULT '',
  font_file       BLOB,
  font_mime       TEXT,
  logo            BLOB,
  logo_mime       TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  updated_at      TEXT NOT NULL
);

-- Task and report photos kept in the database when Cloudinary is not configured (resized in the browser).
CREATE TABLE IF NOT EXISTS images (
  id          TEXT PRIMARY KEY,
  company_id  INTEGER,
  uploaded_by INTEGER NOT NULL,
  mime        TEXT NOT NULL,
  data        BLOB NOT NULL,
  thumb_mime  TEXT NOT NULL,
  thumb       BLOB NOT NULL,
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

-- Second login step for the platform owner: a short-lived code sent by WhatsApp, SMS or email.
CREATE TABLE IF NOT EXISTS login_challenges (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  channel    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  sent_at    TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
CREATE INDEX IF NOT EXISTS idx_attachments_report ON attachments(report_id);
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
  const db = new Database(client);
  await migrate(db);
  return db;
}

// Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to old databases.
const ADDED_COLUMNS = [
  ['users', 'job_title', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'roles', "TEXT NOT NULL DEFAULT ''"],
  ['reports', 'snapshot', 'TEXT'],
  ['users', 'phone', "TEXT NOT NULL DEFAULT ''"],
  ['projects', 'personal_owner_id', 'INTEGER REFERENCES users(id)'],
  ['users', 'company_id', 'INTEGER REFERENCES companies(id)'],
  ['users', 'is_platform', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'last_login_at', 'TEXT'],
  ['users', 'deleted_at', 'TEXT'],
  ['projects', 'company_id', 'INTEGER REFERENCES companies(id)'],
  ['users', 'photo_version', 'INTEGER NOT NULL DEFAULT 0'],
  // 'colleague': anyone in the company; 'manager': someone above the sender, who can also approve it.
  ['work_requests', 'kind', "TEXT NOT NULL DEFAULT 'colleague'"],
  // 'male' / 'female', for addressing people correctly in messages; '' until set.
  ['users', 'gender', "TEXT NOT NULL DEFAULT ''"],
];

async function migrate(db) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const columns = await db.all(`PRAGMA table_info(${table})`);
    if (!columns.some((c) => c.name === column)) {
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  await db.run("UPDATE users SET roles = role WHERE roles = ''");
  // Indexes on columns that older databases only gain in the loop above.
  await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_personal ON projects(personal_owner_id) WHERE personal_owner_id IS NOT NULL');
  await db.run('CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id)');

  // Single-company installs from before the platform: their people become the "ابتكار" company
  // with a perpetual licence. (Who owns the platform is decided by email; see syncPlatformOwner.)
  const { n: orphans } = await db.get('SELECT COUNT(*) AS n FROM users WHERE company_id IS NULL');
  if (orphans > 0) {
    let company = await db.get('SELECT id FROM companies ORDER BY id LIMIT 1');
    if (!company) {
      const ts = now();
      const r = await db.run(`INSERT INTO companies (name, plan, seats, starts_at, ends_at, created_at)
        VALUES ('ابتكار', 'owned', NULL, ?, NULL, ?)`, ts, ts);
      company = { id: r.lastInsertRowid };
      await db.run(`INSERT INTO subscription_events (company_id, kind, details, created_at) VALUES (?, 'created', ?, ?)`,
        company.id, 'نُقلت البيانات الحالية إلى هذه الشركة بترخيص ملكية دائمة', ts);
    }
    await db.run('UPDATE users SET company_id = ? WHERE company_id IS NULL', company.id);
  }
  await db.run(`UPDATE projects SET company_id = (SELECT u.company_id FROM users u WHERE u.id = projects.created_by)
    WHERE company_id IS NULL`);
}

function now() {
  return new Date().toISOString();
}

module.exports = { openDatabase, migrate, now };

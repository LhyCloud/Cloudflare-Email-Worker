-- 参考用 schema。Worker 首次运行时会自动执行同样的语句（见 src/lib/db.js），
-- 正常部署无需手工执行本文件。

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL DEFAULT '',
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',
  status        TEXT    NOT NULL DEFAULT 'active',
  created_at    TEXT    NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  token_hash TEXT    NOT NULL UNIQUE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS emails (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   TEXT,
  user_id      INTEGER,
  sender       TEXT    NOT NULL DEFAULT '',
  sender_name  TEXT    NOT NULL DEFAULT '',
  real_sender  TEXT    NOT NULL DEFAULT '',
  receiver     TEXT    NOT NULL DEFAULT '',
  subject      TEXT    NOT NULL DEFAULT '(无主题)',
  body         TEXT    NOT NULL DEFAULT '',
  body_type    TEXT    NOT NULL DEFAULT 'text',
  preview      TEXT    NOT NULL DEFAULT '',
  attachments  TEXT    NOT NULL DEFAULT '[]',
  is_read      INTEGER NOT NULL DEFAULT 0,
  is_starred   INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT,
  received_at  TEXT    NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_message  ON emails(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_emails_user     ON emails(user_id, id DESC);
CREATE INDEX        IF NOT EXISTS idx_emails_received ON emails(received_at DESC);

CREATE TABLE IF NOT EXISTS sends (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER,
  sender    TEXT    NOT NULL,
  receiver  TEXT    NOT NULL,
  subject   TEXT    NOT NULL DEFAULT '',
  body      TEXT    NOT NULL DEFAULT '',
  status    TEXT    NOT NULL DEFAULT 'sent',
  error     TEXT,
  sent_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sends_user ON sends(user_id, id DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL,
  ip         TEXT    NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_email ON login_attempts(email, created_at);

-- 接口密钥：库里只存 SHA-256，明文仅在创建时返回一次
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  name         TEXT    NOT NULL DEFAULT '',
  key_hash     TEXT    NOT NULL UNIQUE,
  prefix       TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);


-- 运行期设置：目前只有 mail_domain（收件域名自动识别后会写入这里）
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

/**
 * 升级测试：模拟「旧版本已经建过表」的数据库，验证自动建表会补齐新增列。
 * 单独进程运行，因为 ensureSchema 在一个 isolates 内只执行一次。
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../dist/worker.js';

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params;
    return this;
  }
  all() {
    return { results: this.database.prepare(this.sql).all(...this.params), success: true, meta: { changes: 0 } };
  }
  first() {
    const rows = this.database.prepare(this.sql).all(...this.params);
    return rows.length ? rows[0] : null;
  }
  run() {
    const info = this.database.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes || 0), last_row_id: Number(info.lastInsertRowid || 0) } };
  }
}

class D1Database {
  constructor() {
    this.database = new DatabaseSync(':memory:');
  }
  prepare(sql) {
    return new D1Statement(this.database, sql);
  }
  exec(sql) {
    this.database.exec(sql);
    return { count: 0, duration: 0 };
  }
  query(sql, ...params) {
    return this.database.prepare(sql).all(...params);
  }
}

/* 旧版（原始项目）的建表语句：字段更少、没有索引、没有 users/sessions 表 */
const db = new D1Database();
db.exec(`
  CREATE TABLE emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    real_sender TEXT,
    receiver TEXT,
    subject TEXT,
    body TEXT,
    received_at TEXT
  );
  CREATE TABLE sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    receiver TEXT,
    subject TEXT,
    body TEXT,
    sent_at TEXT
  );
  INSERT INTO emails (sender, real_sender, receiver, subject, body, received_at)
  VALUES ('old@example.com', 'old@example.com', 'admin@example.com', '历史邮件', '旧版本留下的正文', '2024-05-01T08:00:00.000Z');
  INSERT INTO sends (sender, receiver, subject, body, sent_at)
  VALUES ('admin@example.com', 'a@b.com', '旧发件', '内容', '2024-05-01T08:00:00.000Z');
`);

const env = {
  DB: db,
  MAIL_DOMAIN: 'example.com',
  EMAIL: { async send() {} },
};

const ORIGIN = 'http://127.0.0.1';
const res = await worker.fetch(
  new Request(`${ORIGIN}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'upgrade-password-1', name: '站长' }),
  }),
  env,
  {},
);
const data = await res.json();
assert.equal(res.status, 200, JSON.stringify(data));

const columnsOf = (table) => db.query(`PRAGMA table_info(${table})`).map((row) => row.name);
const emailColumns = columnsOf('emails');
for (const column of ['message_id', 'sender_name', 'body_type', 'preview', 'attachments', 'is_read', 'is_starred', 'deleted_at', 'size', 'user_id']) {
  assert.ok(emailColumns.includes(column), `emails 缺少列 ${column}`);
}
const sendColumns = columnsOf('sends');
for (const column of ['user_id', 'status', 'error']) {
  assert.ok(sendColumns.includes(column), `sends 缺少列 ${column}`);
}
for (const table of ['users', 'sessions', 'login_attempts']) {
  assert.ok(columnsOf(table).length > 0, `缺少表 ${table}`);
}

const legacy = db.query('SELECT subject, body, is_read, attachments FROM emails WHERE subject = ?', '历史邮件')[0];
assert.equal(legacy.body, '旧版本留下的正文');
assert.equal(legacy.is_read, 0);
assert.equal(legacy.attachments, '[]');

const list = await worker.fetch(
  new Request(`${ORIGIN}/api/mails?box=inbox`, { headers: { authorization: `Bearer ${data.token}` } }),
  env,
  {},
);
assert.equal(list.status, 200);
const listed = await list.json();
assert.equal(listed.total, 1);
assert.equal(listed.items[0].subject, '历史邮件');

console.log('✓ 旧库自动补齐新增列，历史邮件仍可正常读取');
console.log('✓ 升级检查通过');

// Turso SQLite Database Layer
const { createClient } = require('@libsql/client');

const TURSO_URL   = process.env.TURSO_URL   || 'libsql://familycall-anshulsharmaofficial001.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODA0MDIzMzMsImlkIjoiMDE5ZTg4M2YtNTUwMS03MmQ1LWIxMTYtOTM2OGEzNTY2YTZiIiwicmlkIjoiMTFmY2M4ODctZDY5ZC00YzAxLWFjZjMtMzNmY2Q5YjcxZTllIn0.sOCeeD2cWpQjUh1-12b0sLITLexcpIfBmSvjgpnIQiGE30afoYTZrz5T4pK3z9DDyM_YWSXNcNzLOHSlmEtrDw';

const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

async function initDB() {
  await db.batch([
    // Users table
    `CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      avatar TEXT,
      dob TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    // Friends table
    `CREATE TABLE IF NOT EXISTS friends (
      user1 TEXT NOT NULL,
      user2 TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (user1, user2)
    )`,
    // Messages table (rolling delete when >8GB)
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user TEXT NOT NULL,
      to_target TEXT NOT NULL,
      is_group INTEGER DEFAULT 0,
      text TEXT,
      voice_data TEXT,
      voice_mime TEXT,
      status TEXT DEFAULT 'sent',
      ts INTEGER DEFAULT (strftime('%s','now') * 1000)
    )`,
    // Groups table
    `CREATE TABLE IF NOT EXISTS groups_table (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    // Group members table
    `CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      PRIMARY KEY (group_id, username)
    )`,
    // Location history (last 1hr only)
    `CREATE TABLE IF NOT EXISTS locations (
      username TEXT PRIMARY KEY,
      lat REAL,
      lng REAL,
      accuracy REAL,
      ts INTEGER DEFAULT (strftime('%s','now') * 1000)
    )`,
    // Voice statuses (24hr auto-delete)
    `CREATE TABLE IF NOT EXISTS voice_status (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      audio_data TEXT NOT NULL,
      audio_mime TEXT,
      ts INTEGER DEFAULT (strftime('%s','now') * 1000)
    )`,
    // SOS alerts
    `CREATE TABLE IF NOT EXISTS sos_alerts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      lat REAL,
      lng REAL,
      group_id TEXT,
      cancelled INTEGER DEFAULT 0,
      ts INTEGER DEFAULT (strftime('%s','now') * 1000)
    )`,
    // Birthdays notifications log
    `CREATE TABLE IF NOT EXISTS birthday_notifs (
      username TEXT NOT NULL,
      year INTEGER NOT NULL,
      PRIMARY KEY (username, year)
    )`,
  ], 'write');

  try {
    await db.execute("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'");
  } catch(e) {
    // Already exists, ignore
  }

  // Create superadmin if not exists
  const existing = await db.execute({
    sql: 'SELECT username FROM users WHERE username = ?',
    args: ['anshul']
  });
  if (existing.rows.length === 0) {
    await db.execute({
      sql: 'INSERT INTO users (username, name, password, role) VALUES (?, ?, ?, ?)',
      args: ['anshul', 'Anshul Sharma', 'Ansh7023365486', 'superadmin']
    });
    console.log('Superadmin created: anshul');
  } else {
    // Ensure role is superadmin even if tampered
    await db.execute({
      sql: "UPDATE users SET role='superadmin', name='Anshul Sharma', password='Ansh7023365486' WHERE username='anshul'",
      args: []
    });
    console.log('Superadmin verified: anshul');
  }

  console.log('Database initialized');
}

// Rolling delete: remove oldest messages when count exceeds 500k
async function pruneMessages() {
  try {
    const count = await db.execute('SELECT COUNT(*) as c FROM messages');
    const c = Number(count.rows[0].c);
    if (c > 500000) {
      const toDelete = c - 450000;
      await db.execute({
        sql: 'DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY id ASC LIMIT ?)',
        args: [toDelete]
      });
      console.log(`Pruned ${toDelete} old messages`);
    }
  } catch(e) { console.error('prune error', e); }
}

// Clean old locations (older than 1hr)
async function cleanOldLocations() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  await db.execute({ sql: 'DELETE FROM locations WHERE ts < ?', args: [cutoff] }).catch(()=>{});
}

// Clean expired voice statuses (24hr)
async function cleanVoiceStatuses() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  await db.execute({ sql: 'DELETE FROM voice_status WHERE ts < ?', args: [cutoff] }).catch(()=>{});
}

module.exports = { db, initDB, pruneMessages, cleanOldLocations, cleanVoiceStatuses };

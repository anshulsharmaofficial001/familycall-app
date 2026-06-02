const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cron = require('node-cron');
const { db, initDB, pruneMessages, cleanOldLocations, cleanVoiceStatuses } = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const noStoreJs = (file) => (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'js', file));
};
app.get('/js/app.js', noStoreJs('app.js'));
app.get('/js/pcm-recorder.js', noStoreJs('pcm-recorder.js'));
app.get('/js/audio-processor.js', noStoreJs('audio-processor.js'));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory: online status + WS refs + active calls
const onlineUsers = {}; // username -> ws
const activeCalls = {}; // callId -> {callerUsername, calleeUsername, callerName, status}
const logs = [];

// ── Init DB ──
initDB().catch(e => { console.error('DB init failed:', e); process.exit(1); });

// ── Cron jobs ──
cron.schedule('*/10 * * * *', () => { cleanOldLocations(); cleanVoiceStatuses(); });
cron.schedule('0 9 * * *', () => { checkBirthdays(); }); // 9 AM daily
cron.schedule('0 * * * *', () => { pruneMessages(); });   // hourly prune check

// ─────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────
function sendTo(username, obj) {
  const ws = onlineUsers[username];
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function addLog(username, event, data) {
  logs.push({ ts: new Date().toISOString(), username, event, data });
  if (logs.length > 500) logs.shift();
}

async function getUserRow(username) {
  const r = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username.toLowerCase()] });
  return r.rows[0] || null;
}

async function getFriends(username) {
  const r = await db.execute({
    sql: `SELECT u.username, u.name, u.role, u.avatar, u.dob
          FROM friends f
          JOIN users u ON (u.username = CASE WHEN f.user1 = ? THEN f.user2 ELSE f.user1 END)
          WHERE (f.user1 = ? OR f.user2 = ?) AND f.status = 'accepted'`,
    args: [username, username, username]
  });
  return r.rows;
}

async function getGroupMembers(groupId) {
  const r = await db.execute({
    sql: `SELECT gm.username, gm.role, u.name, u.avatar
          FROM group_members gm JOIN users u ON u.username = gm.username
          WHERE gm.group_id = ?`,
    args: [groupId]
  });
  return r.rows;
}

// ─────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Version check endpoint — Android app calls this to check for updates
app.get('/api/version', (req, res) => {
  res.json({
    versionCode: 14,
    versionName: '4.0',
    apkUrl: 'https://github.com/anshulsharmaofficial001/familycall-app/releases/download/v4.0/FamilyCall-latest.apk',
    releaseNotes: 'New features: Groups, SOS, Live Location, Voice Status, Battery Monitor, Birthday Alerts, Auto-update!'
  });
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, name, password, dob } = req.body;
    if (!username || !name || !password) return res.status(400).json({ error: 'Username, name and password required' });
    const key = username.toLowerCase().trim();
    if (key === 'anshul') return res.status(400).json({ error: 'Username reserved' });
    const existing = await getUserRow(key);
    if (existing) return res.status(400).json({ error: 'Username already taken' });
    await db.execute({ sql: 'INSERT INTO users (username, name, password, dob) VALUES (?, ?, ?, ?)', args: [key, name, password, dob||null] });
    res.json({ success: true, user: { username: key, name } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const u = await getUserRow(username.toLowerCase().trim());
    if (!u || u.password !== password) return res.status(401).json({ error: 'Invalid username or password' });
    res.json({ success: true, user: { username: u.username, name: u.name, role: u.role||'user', avatar: u.avatar||null } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/:username', async (req, res) => {
  try {
    const u = await getUserRow(req.params.username);
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({ username: u.username, name: u.name, role: u.role||'user', online: !!onlineUsers[u.username] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/profile/:username', async (req, res) => {
  try {
    const u = await getUserRow(req.params.username);
    if (!u) return res.status(404).json({ error: 'Not found' });
    res.json({ username: u.username, name: u.name, role: u.role||'user', avatar: u.avatar||null, dob: u.dob||null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/profile', async (req, res) => {
  try {
    const { username, name, avatar, dob } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const u = await getUserRow(username);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (name) await db.execute({ sql: 'UPDATE users SET name = ? WHERE username = ?', args: [name, username] });
    if (avatar !== undefined) await db.execute({ sql: 'UPDATE users SET avatar = ? WHERE username = ?', args: [avatar, username] });
    if (dob !== undefined) await db.execute({ sql: 'UPDATE users SET dob = ? WHERE username = ?', args: [dob, username] });
    const updated = await getUserRow(username);
    res.json({ success: true, user: { username: updated.username, name: updated.name, role: updated.role, avatar: updated.avatar } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// FRIENDS ROUTES
// ─────────────────────────────────────────────
app.get('/api/friends/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const u = await getUserRow(username);
    if (!u) return res.status(404).json({ error: 'User not found' });

    // Superadmin sees all users as friends
    let friends;
    if (u.role === 'superadmin') {
      const all = await db.execute({ sql: 'SELECT username, name, role, avatar FROM users WHERE username != ?', args: [username] });
      friends = all.rows.map(r => ({ ...r, online: !!onlineUsers[r.username] }));
    } else {
      const rows = await getFriends(username);
      friends = rows.map(r => ({ ...r, online: !!onlineUsers[r.username] }));
    }

    const pendingIn = await db.execute({
      sql: `SELECT f.user1 as username, u.name FROM friends f JOIN users u ON u.username = f.user1 WHERE f.user2 = ? AND f.status = 'pending'`,
      args: [username]
    });
    const pendingOut = await db.execute({
      sql: `SELECT f.user2 as username, u.name FROM friends f JOIN users u ON u.username = f.user2 WHERE f.user1 = ? AND f.status = 'pending'`,
      args: [username]
    });

    res.json({
      friends,
      pendingIn: pendingIn.rows,
      pendingOut: pendingOut.rows
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Legacy endpoint for Android app compatibility
app.get('/api/users', async (req, res) => {
  try {
    const r = await db.execute('SELECT username, name, role, avatar FROM users LIMIT 100');
    res.json(r.rows.map(u => ({ ...u, online: !!onlineUsers[u.username] })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search/:query', async (req, res) => {
  try {
    const q = req.params.query.toLowerCase();
    const r = await db.execute({
      sql: 'SELECT username, name, role, avatar FROM users WHERE username LIKE ? OR name LIKE ? LIMIT 20',
      args: [`%${q}%`, `%${q}%`]
    });
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/friend-request', async (req, res) => {
  try {
    const { from, to } = req.body;
    const fromKey = from.toLowerCase(), toKey = to.toLowerCase();
    const toUser = await getUserRow(toKey);
    if (!toUser) return res.status(404).json({ error: 'User not found' });
    // Check if already friends/pending
    const existing = await db.execute({
      sql: 'SELECT * FROM friends WHERE (user1=? AND user2=?) OR (user1=? AND user2=?)',
      args: [fromKey, toKey, toKey, fromKey]
    });
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Already friends or pending' });
    await db.execute({ sql: 'INSERT INTO friends (user1, user2, status) VALUES (?, ?, ?)', args: [fromKey, toKey, 'pending'] });
    sendTo(toKey, { type: 'friend_request', from: fromKey, fromName: (await getUserRow(fromKey))?.name });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/friend-accept', async (req, res) => {
  try {
    const { from, to } = req.body;
    const fromKey = from.toLowerCase(), toKey = to.toLowerCase();
    await db.execute({
      sql: `UPDATE friends SET status='accepted' WHERE user1=? AND user2=? AND status='pending'`,
      args: [fromKey, toKey]
    });
    sendTo(fromKey, { type: 'friend_accepted', by: toKey, byName: (await getUserRow(toKey))?.name });
    sendTo(toKey, { type: 'friend_accepted', by: fromKey, byName: (await getUserRow(fromKey))?.name });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/friend-decline', async (req, res) => {
  try {
    const { from, to } = req.body;
    const fromKey = from.toLowerCase(), toKey = to.toLowerCase();
    await db.execute({
      sql: `DELETE FROM friends WHERE user1=? AND user2=? AND status='pending'`,
      args: [fromKey, toKey]
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// GROUPS ROUTES
// ─────────────────────────────────────────────
app.post('/api/groups/create', async (req, res) => {
  try {
    const { name, createdBy, members } = req.body;
    const id = `grp_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
    await db.execute({ sql: 'INSERT INTO groups_table (id, name, created_by) VALUES (?,?,?)', args: [id, name, createdBy] });
    const allMembers = [...new Set([createdBy, ...(members||[])])];
    for (const m of allMembers) {
      const role = (m === createdBy) ? 'admin' : 'member';
      await db.execute({ sql: 'INSERT OR IGNORE INTO group_members (group_id, username, role) VALUES (?,?,?)', args: [id, m, role] });
    }
    res.json({ success: true, groupId: id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/groups/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const r = await db.execute({
      sql: `SELECT g.id, g.name, g.created_by, gm.role FROM groups_table g
            JOIN group_members gm ON gm.group_id = g.id
            WHERE gm.username = ?`,
      args: [username]
    });
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/groups/:groupId/members', async (req, res) => {
  try {
    const members = await getGroupMembers(req.params.groupId);
    res.json(members.map(m => ({ ...m, online: !!onlineUsers[m.username] })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/:groupId/add-member', async (req, res) => {
  try {
    const { username, addedBy } = req.body;
    const groupId = req.params.groupId;
    const adder = await db.execute({ sql: 'SELECT role FROM group_members WHERE group_id=? AND username=?', args: [groupId, addedBy] });
    if (!adder.rows.length || adder.rows[0].role !== 'admin') return res.status(403).json({ error: 'Only admins can add members' });
    await db.execute({ sql: 'INSERT OR IGNORE INTO group_members (group_id, username, role) VALUES (?,?,?)', args: [groupId, username, 'member'] });
    sendTo(username, { type: 'added_to_group', groupId });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// MESSAGES ROUTES (Turso persistent)
// ─────────────────────────────────────────────
app.get('/api/messages/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const r = await db.execute({
      sql: `SELECT * FROM messages WHERE (from_user=? OR to_target=?) AND is_group=0 ORDER BY ts ASC LIMIT 200`,
      args: [username, username]
    });
    // Group by conversation partner
    const result = {};
    for (const msg of r.rows) {
      const other = msg.from_user === username ? msg.to_target : msg.from_user;
      if (!result[other]) result[other] = [];
      result[other].push({ from: msg.from_user, to: msg.to_target, text: msg.text, voiceData: msg.voice_data, voiceMime: msg.voice_mime, ts: msg.ts });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/group-messages/:groupId', async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT * FROM messages WHERE to_target=? AND is_group=1 ORDER BY ts ASC LIMIT 200`,
      args: [req.params.groupId]
    });
    res.json(r.rows.map(m => ({ from: m.from_user, text: m.text, voiceData: m.voice_data, voiceMime: m.voice_mime, ts: m.ts })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// LOCATION ROUTES
// ─────────────────────────────────────────────
app.post('/api/location', async (req, res) => {
  try {
    const { username, lat, lng, accuracy } = req.body;
    await db.execute({
      sql: 'INSERT OR REPLACE INTO locations (username, lat, lng, accuracy, ts) VALUES (?,?,?,?,?)',
      args: [username, lat, lng, accuracy||null, Date.now()]
    });
    // Broadcast to friends
    const friends = await getFriends(username);
    const u = await getUserRow(username);
    for (const f of friends) {
      sendTo(f.username, { type: 'location_update', username, name: u?.name, lat, lng, ts: Date.now() });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/locations/:username', async (req, res) => {
  try {
    const friends = await getFriends(req.params.username);
    const names = friends.map(f => f.username);
    names.push(req.params.username);
    const cutoff = Date.now() - 60 * 60 * 1000; // last 1hr
    const result = [];
    for (const n of names) {
      const r = await db.execute({ sql: 'SELECT * FROM locations WHERE username=? AND ts > ?', args: [n, cutoff] });
      if (r.rows.length) {
        const u = await getUserRow(n);
        result.push({ ...r.rows[0], name: u?.name, avatar: u?.avatar });
      }
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// SOS ROUTES
// ─────────────────────────────────────────────
app.post('/api/sos', async (req, res) => {
  try {
    const { username, lat, lng, groupId } = req.body;
    const id = `sos_${Date.now()}`;
    await db.execute({ sql: 'INSERT INTO sos_alerts (id, username, lat, lng, group_id) VALUES (?,?,?,?,?)', args: [id, username, lat||null, lng||null, groupId||null] });
    const u = await getUserRow(username);
    const mapsLink = lat ? `https://maps.google.com/?q=${lat},${lng}` : null;
    const alert = { type: 'sos_alert', sosId: id, from: username, name: u?.name, lat, lng, mapsLink, ts: Date.now() };
    // Send to group or all friends
    if (groupId) {
      const members = await getGroupMembers(groupId);
      for (const m of members) { if (m.username !== username) sendTo(m.username, alert); }
    } else {
      const friends = await getFriends(username);
      for (const f of friends) sendTo(f.username, alert);
    }
    res.json({ success: true, sosId: id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sos/cancel', async (req, res) => {
  try {
    const { sosId, username } = req.body;
    await db.execute({ sql: 'UPDATE sos_alerts SET cancelled=1 WHERE id=?', args: [sosId] });
    const u = await getUserRow(username);
    const cancel = { type: 'sos_cancelled', sosId, from: username, name: u?.name };
    const friends = await getFriends(username);
    for (const f of friends) sendTo(f.username, cancel);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// VOICE STATUS ROUTES
// ─────────────────────────────────────────────
app.post('/api/voice-status', async (req, res) => {
  try {
    const { username, audioData, audioMime } = req.body;
    const id = `vs_${Date.now()}_${username}`;
    // Remove old status for this user first
    await db.execute({ sql: 'DELETE FROM voice_status WHERE username=?', args: [username] });
    await db.execute({ sql: 'INSERT INTO voice_status (id, username, audio_data, audio_mime) VALUES (?,?,?,?)', args: [id, username, audioData, audioMime||'audio/webm'] });
    const u = await getUserRow(username);
    const friends = await getFriends(username);
    for (const f of friends) sendTo(f.username, { type: 'new_voice_status', username, name: u?.name, avatar: u?.avatar });
    res.json({ success: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/voice-status/:username', async (req, res) => {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const r = await db.execute({ sql: 'SELECT * FROM voice_status WHERE username=? AND ts > ?', args: [req.params.username, cutoff] });
    if (!r.rows.length) return res.json({ hasStatus: false });
    res.json({ hasStatus: true, audioData: r.rows[0].audio_data, audioMime: r.rows[0].audio_mime });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/voice-statuses/:username', async (req, res) => {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const friends = await getFriends(req.params.username);
    const result = [];
    for (const f of friends) {
      const r = await db.execute({ sql: 'SELECT username, ts FROM voice_status WHERE username=? AND ts > ?', args: [f.username, cutoff] });
      if (r.rows.length) result.push({ username: f.username, name: f.name, avatar: f.avatar, ts: r.rows[0].ts });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// BIRTHDAY CHECK
// ─────────────────────────────────────────────
async function checkBirthdays() {
  try {
    const now = new Date();
    const today = `${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const year = now.getFullYear();
    const r = await db.execute({ sql: `SELECT * FROM users WHERE dob IS NOT NULL AND substr(dob,6) = ?`, args: [today] });
    for (const birthdayUser of r.rows) {
      // Check if already notified this year
      const alreadyDone = await db.execute({ sql: 'SELECT * FROM birthday_notifs WHERE username=? AND year=?', args: [birthdayUser.username, year] });
      if (alreadyDone.rows.length) continue;
      await db.execute({ sql: 'INSERT INTO birthday_notifs (username, year) VALUES (?,?)', args: [birthdayUser.username, year] });
      // Notify all friends EXCEPT the birthday person
      const friends = await getFriends(birthdayUser.username);
      for (const f of friends) {
        sendTo(f.username, { type: 'birthday_today', username: birthdayUser.username, name: birthdayUser.name });
      }
      console.log(`Birthday notification sent for ${birthdayUser.name}`);
    }
  } catch(e) { console.error('birthday check error', e); }
}

// ─────────────────────────────────────────────
// BATTERY STATUS
// ─────────────────────────────────────────────
app.post('/api/battery', async (req, res) => {
  try {
    const { username, level, charging } = req.body;
    const friends = await getFriends(username);
    const u = await getUserRow(username);
    for (const f of friends) {
      sendTo(f.username, { type: 'battery_update', username, name: u?.name, level, charging });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// LOGS
// ─────────────────────────────────────────────
app.post('/api/log', (req, res) => {
  const { username, event, data } = req.body;
  addLog(username||'unknown', event||'client', data);
  res.json({ ok: true });
});
app.get('/api/logs/text', (req, res) => {
  res.setHeader('Content-Type','text/plain');
  res.send(logs.map(l=>`${l.ts} [${l.username}] ${l.event} ${l.data?JSON.stringify(l.data):''}`).join('\n'));
});

app.get('/api/reset', async (req, res) => {
  // Only clears non-persistent data; keeps DB intact
  Object.keys(activeCalls).forEach(k => delete activeCalls[k]);
  res.json({ success: true, message: 'Active calls cleared' });
});

// ── Superadmin: Delete user (only anshul can use this, anshul cannot be deleted) ──
app.post('/api/admin/delete-user', async (req, res) => {
  try {
    const { requestedBy, targetUsername } = req.body;
    if (!requestedBy || !targetUsername) return res.status(400).json({ error: 'Missing params' });
    const requester = await getUserRow(requestedBy.toLowerCase());
    if (!requester || requester.role !== 'superadmin') return res.status(403).json({ error: 'Only superadmin can delete users' });
    const target = targetUsername.toLowerCase();
    if (target === 'anshul') return res.status(403).json({ error: 'Cannot delete superadmin' });
    // Delete user and all their data
    await db.execute({ sql: 'DELETE FROM friends WHERE user1=? OR user2=?', args: [target, target] });
    await db.execute({ sql: 'DELETE FROM messages WHERE from_user=? OR to_target=?', args: [target, target] });
    await db.execute({ sql: 'DELETE FROM locations WHERE username=?', args: [target] });
    await db.execute({ sql: 'DELETE FROM voice_status WHERE username=?', args: [target] });
    await db.execute({ sql: 'DELETE FROM sos_alerts WHERE username=?', args: [target] });
    await db.execute({ sql: 'DELETE FROM group_members WHERE username=?', args: [target] });
    await db.execute({ sql: 'DELETE FROM users WHERE username=?', args: [target] });
    // Disconnect if online
    const ws = onlineUsers[target];
    if (ws) { ws.close(); delete onlineUsers[target]; }
    console.log(`User @${target} deleted by superadmin`);
    res.json({ success: true, message: `@${target} deleted` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const username = (url.searchParams.get('username') || '').toLowerCase().trim();
  const name = url.searchParams.get('name') || '';
  if (!username) { ws.close(); return; }

  const u = await getUserRow(username);
  if (!u) { ws.close(); return; }

  onlineUsers[username] = ws;
  console.log(`${name} (@${username}) connected`);

  ws.send(JSON.stringify({ type: 'welcome', username, name: u.name, role: u.role||'user', avatar: u.avatar||null }));

  // Forward pending incoming calls
  for (const [cid, call] of Object.entries(activeCalls)) {
    if (call.calleeUsername === username && call.status === 'ringing') {
      ws.send(JSON.stringify({ type: 'incoming_call', callId: cid, callerName: call.callerName, callerUsername: call.callerUsername }));
    }
  }

  // Notify friends that user is online
  const friends = await getFriends(username);
  for (const f of friends) sendTo(f.username, { type: 'friend_online', username, name: u.name });

  ws.on('message', async (data) => {
    try { await handleMessage(ws, JSON.parse(data), username, u.name); }
    catch(e) { console.error('WS msg error:', e.message); }
  });

  ws.on('close', async () => {
    delete onlineUsers[username];
    console.log(`${name} (@${username}) disconnected`);
    const friends2 = await getFriends(username).catch(()=>[]);
    for (const f of friends2) sendTo(f.username, { type: 'friend_offline', username });
  });
});

async function handleMessage(ws, msg, username, name) {
  switch(msg.type) {

    case 'call': {
      const calleeKey = (msg.calleeUsername||'').toLowerCase();
      const callee = await getUserRow(calleeKey);
      if (!callee) { ws.send(JSON.stringify({ type:'error', message:'User not found' })); return; }
      // Busy check
      const busy = Object.values(activeCalls).some(c =>
        (c.callerUsername===calleeKey || c.calleeUsername===calleeKey) && c.status==='connected'
      );
      if (busy) { ws.send(JSON.stringify({ type:'call_busy', username: calleeKey })); return; }
      const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
      activeCalls[callId] = { callId, callerUsername: username, calleeUsername: calleeKey, callerName: name, status:'ringing' };
      ws.send(JSON.stringify({ type:'call_created', callId }));
      sendTo(calleeKey, { type:'incoming_call', callId, callerName: name, callerUsername: username });
      break;
    }

    case 'accept_call': {
      const call = activeCalls[msg.callId];
      if (!call) return;
      call.status = 'connected';
      sendTo(call.callerUsername, { type:'call_accepted', callId: msg.callId });
      break;
    }

    case 'reject_call': {
      const call = activeCalls[msg.callId];
      if (!call) return;
      call.status = 'rejected';
      sendTo(call.callerUsername, { type:'call_rejected', callId: msg.callId });
      delete activeCalls[msg.callId];
      break;
    }

    case 'end_call': {
      const call = activeCalls[msg.callId];
      if (!call) return;
      call.status = 'ended';
      const otherKey = call.callerUsername===username ? call.calleeUsername : call.callerUsername;
      sendTo(otherKey, { type:'call_ended', callId: msg.callId });
      delete activeCalls[msg.callId];
      break;
    }

    case 'audio': {
      const call = activeCalls[msg.callId];
      if (!call) return;
      const otherKey = call.callerUsername===username ? call.calleeUsername : call.callerUsername;
      sendTo(otherKey, { type:'audio', callId: msg.callId, data: msg.data, sampleRate: msg.sampleRate });
      break;
    }

    case 'chat': {
      const toKey = (msg.to||'').toLowerCase();
      const ts = Date.now();
      // Save to Turso
      await db.execute({
        sql: 'INSERT INTO messages (from_user, to_target, is_group, text, voice_data, voice_mime, ts) VALUES (?,?,0,?,?,?,?)',
        args: [username, toKey, msg.text||null, msg.voiceData||null, msg.voiceMime||null, ts]
      });
      ws.send(JSON.stringify({ type:'chat_sent', to: toKey, text: msg.text, ts }));
      sendTo(toKey, { type:'chat', from: username, text: msg.text, voiceData: msg.voiceData||null, voiceMime: msg.voiceMime||null, ts });
      pruneMessages().catch(()=>{});
      break;
    }

    case 'group_chat': {
      const groupId = msg.groupId;
      const ts = Date.now();
      await db.execute({
        sql: 'INSERT INTO messages (from_user, to_target, is_group, text, voice_data, voice_mime, ts) VALUES (?,?,1,?,?,?,?)',
        args: [username, groupId, msg.text||null, msg.voiceData||null, msg.voiceMime||null, ts]
      });
      const members = await getGroupMembers(groupId);
      for (const m of members) {
        if (m.username !== username) {
          sendTo(m.username, { type:'group_chat', groupId, from: username, fromName: name, text: msg.text, voiceData: msg.voiceData||null, voiceMime: msg.voiceMime||null, ts });
        }
      }
      ws.send(JSON.stringify({ type:'group_chat_sent', groupId, ts }));
      break;
    }

    case 'add_friend': {
      const toKey = (msg.toUsername||'').toLowerCase();
      const toUser = await getUserRow(toKey);
      if (!toUser) { ws.send(JSON.stringify({ type:'error', message:'User not found' })); return; }
      const existing = await db.execute({
        sql: 'SELECT * FROM friends WHERE (user1=? AND user2=?) OR (user1=? AND user2=?)',
        args: [username, toKey, toKey, username]
      });
      if (existing.rows.length) { ws.send(JSON.stringify({ type:'error', message:'Already friends or pending' })); return; }
      await db.execute({ sql: 'INSERT INTO friends (user1,user2,status) VALUES (?,?,?)', args: [username, toKey, 'pending'] });
      sendTo(toKey, { type:'friend_request', from: username, fromName: name });
      ws.send(JSON.stringify({ type:'friend_request_sent', to: toKey }));
      break;
    }

    case 'accept_friend': {
      const fromKey = (msg.fromUsername||'').toLowerCase();
      await db.execute({ sql: `UPDATE friends SET status='accepted' WHERE user1=? AND user2=? AND status='pending'`, args: [fromKey, username] });
      sendTo(fromKey, { type:'friend_accepted', by: username, byName: name });
      ws.send(JSON.stringify({ type:'friend_accepted', by: fromKey }));
      break;
    }

    case 'paging': {
      // Group voice broadcast — admin only
      const { groupId, audioData, audioMime } = msg;
      const adminCheck = await db.execute({ sql: 'SELECT role FROM group_members WHERE group_id=? AND username=?', args: [groupId, username] });
      if (!adminCheck.rows.length || adminCheck.rows[0].role !== 'admin') { ws.send(JSON.stringify({ type:'error', message:'Only admins can broadcast' })); return; }
      const members = await getGroupMembers(groupId);
      for (const m of members) {
        if (m.username !== username) sendTo(m.username, { type:'paging', from: username, fromName: name, audioData, audioMime, groupId });
      }
      break;
    }

    case 'sos_ws': {
      const { lat, lng, groupId } = msg;
      const sosId = `sos_${Date.now()}`;
      await db.execute({ sql: 'INSERT INTO sos_alerts (id,username,lat,lng,group_id) VALUES (?,?,?,?,?)', args: [sosId, username, lat||null, lng||null, groupId||null] });
      const mapsLink = lat ? `https://maps.google.com/?q=${lat},${lng}` : null;
      const alert = { type:'sos_alert', sosId, from: username, name, lat, lng, mapsLink, ts: Date.now() };
      if (groupId) {
        const members = await getGroupMembers(groupId);
        for (const m of members) { if (m.username !== username) sendTo(m.username, alert); }
      } else {
        const friends = await getFriends(username);
        for (const f of friends) sendTo(f.username, alert);
      }
      ws.send(JSON.stringify({ type:'sos_sent', sosId }));
      break;
    }

    case 'sos_cancel': {
      const { sosId } = msg;
      await db.execute({ sql: 'UPDATE sos_alerts SET cancelled=1 WHERE id=?', args: [sosId] });
      const cancel = { type:'sos_cancelled', sosId, from: username, name };
      const friends = await getFriends(username);
      for (const f of friends) sendTo(f.username, cancel);
      break;
    }
  }
}

app.get('/call/:callId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`FamilyCall server running on port ${PORT}`));

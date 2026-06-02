const fs = require('fs');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Serve app.js directly (bypass CDN cache)
app.get('/js/app.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'js', 'app.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

const users = {};
const calls = {};
const messages = {};
const logs = [];
const debugLogFile = path.join(__dirname, 'audio-debug.log');

// ── Pre-create superadmin ──────────────────────────────────────────────────
users['anshul'] = {
  username: 'anshul',
  name: 'Anshul Sharma',
  password: 'Ansh7023365486',
  role: 'superadmin',
  online: false,
  ws: null,
  avatar: null,
  friends: [],
  pendingIn: [],   // friend requests received
  pendingOut: []   // friend requests sent
};

function writeDebugLine(entry) {
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(debugLogFile, line, () => {});
}

function addLog(username, event, data) {
  const entry = { ts: new Date().toISOString(), username, event, data };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  console.log(`[LOG] ${entry.ts} ${username} ${event}`, data || '');
  writeDebugLine(entry);
}

function addMsg(from, to, text) {
  const key = [from, to].sort().join(':');
  if (!messages[key]) messages[key] = [];
  const msg = { from, to, text, ts: Date.now() };
  messages[key].push(msg);
  if (messages[key].length > 100) messages[key].shift();
  return msg;
}

function isOnline(u) {
  return !!(u && u.ws && u.ws.readyState === WebSocket.OPEN);
}

// Check if a user is currently in an active call
function isInCall(username) {
  for (const call of Object.values(calls)) {
    if ((call.callerUsername === username || call.calleeUsername === username) &&
        (call.status === 'ringing' || call.status === 'connected')) {
      return true;
    }
  }
  return false;
}

// ── Auth ──────────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, name, password } = req.body;
  if (!username || !name || !password)
    return res.status(400).json({ error: 'Username, name and password required' });
  const key = username.toLowerCase();
  if (users[key]) return res.status(400).json({ error: 'Username already taken' });
  users[key] = {
    name, username: key, password, role: 'user', online: false, ws: null,
    avatar: null, friends: [], pendingIn: [], pendingOut: []
  };
  res.json({ success: true, user: { username: key, name, role: 'user' } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });
  const key = username.toLowerCase();
  const u = users[key];
  if (!u || u.password !== password)
    return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ success: true, user: { username: u.username, name: u.name, role: u.role || 'user' } });
});

// ── Admin: all users ───────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  const { requester } = req.query;
  const reqUser = requester ? users[requester.toLowerCase()] : null;
  // Superadmin sees everyone; others see only friends
  if (reqUser && reqUser.role === 'superadmin') {
    const list = Object.values(users).map(u => ({
      username: u.username, name: u.name, role: u.role || 'user',
      online: isOnline(u), avatar: u.avatar || null
    }));
    return res.json(list);
  }
  // Legacy: return all for backward compat if no requester param
  if (!requester) {
    const list = Object.values(users).map(u => ({
      username: u.username, name: u.name, role: u.role || 'user',
      online: isOnline(u), avatar: u.avatar || null
    }));
    return res.json(list);
  }
  res.json([]);
});

app.get('/api/user/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ username: u.username, name: u.name, role: u.role || 'user', online: isOnline(u), avatar: u.avatar || null });
});

// ── Friends ────────────────────────────────────────────────────────────────
app.get('/api/friends/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found' });
  const friendList = (u.friends || []).map(fname => {
    const f = users[fname];
    if (!f) return null;
    return { username: f.username, name: f.name, role: f.role || 'user', online: isOnline(f), avatar: f.avatar || null };
  }).filter(Boolean);
  // Also include pending requests info
  res.json({
    friends: friendList,
    pendingIn: u.pendingIn || [],
    pendingOut: u.pendingOut || []
  });
});

app.post('/api/friend-request', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const fromKey = from.toLowerCase(), toKey = to.toLowerCase();
  const fromUser = users[fromKey], toUser = users[toKey];
  if (!fromUser) return res.status(404).json({ error: 'Sender not found' });
  if (!toUser) return res.status(404).json({ error: 'User not found' });
  if (fromKey === toKey) return res.status(400).json({ error: 'Cannot add yourself' });
  if (fromUser.friends.includes(toKey)) return res.status(400).json({ error: 'Already friends' });
  if (toUser.pendingIn.includes(fromKey)) return res.status(400).json({ error: 'Request already sent' });
  toUser.pendingIn.push(fromKey);
  fromUser.pendingOut.push(toKey);
  // Notify recipient if online
  if (isOnline(toUser)) {
    toUser.ws.send(JSON.stringify({
      type: 'friend_request', from: fromKey, fromName: fromUser.name
    }));
  }
  addLog(fromKey, 'friend_request_sent', { to: toKey });
  res.json({ success: true });
});

app.post('/api/friend-accept', (req, res) => {
  const { from, to } = req.body; // from=requester who sent, to=acceptor
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const fromKey = from.toLowerCase(), toKey = to.toLowerCase();
  const fromUser = users[fromKey], toUser = users[toKey];
  if (!fromUser || !toUser) return res.status(404).json({ error: 'User not found' });
  // toUser accepts request from fromUser
  const idx = toUser.pendingIn.indexOf(fromKey);
  if (idx === -1) return res.status(400).json({ error: 'No pending request from this user' });
  toUser.pendingIn.splice(idx, 1);
  const outIdx = fromUser.pendingOut.indexOf(toKey);
  if (outIdx !== -1) fromUser.pendingOut.splice(outIdx, 1);
  if (!toUser.friends.includes(fromKey)) toUser.friends.push(fromKey);
  if (!fromUser.friends.includes(toKey)) fromUser.friends.push(toKey);
  // Notify both if online
  if (isOnline(toUser)) {
    toUser.ws.send(JSON.stringify({ type: 'friend_accepted', with: fromKey, withName: fromUser.name }));
  }
  if (isOnline(fromUser)) {
    fromUser.ws.send(JSON.stringify({ type: 'friend_accepted', with: toKey, withName: toUser.name }));
  }
  addLog(toKey, 'friend_accepted', { from: fromKey });
  res.json({ success: true });
});

// ── Search ─────────────────────────────────────────────────────────────────
app.get('/api/search/:query', (req, res) => {
  const q = (req.params.query || '').toLowerCase().trim();
  if (!q || q.length < 1) return res.json([]);
  const results = Object.values(users)
    .filter(u => u.username.includes(q) || u.name.toLowerCase().includes(q))
    .slice(0, 10)
    .map(u => ({ username: u.username, name: u.name, role: u.role || 'user', avatar: u.avatar || null }));
  res.json(results);
});

// ── Profile ────────────────────────────────────────────────────────────────
app.post('/api/profile', (req, res) => {
  const { username, name, avatar } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const key = username.toLowerCase();
  const u = users[key];
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (name && name.trim()) u.name = name.trim();
  if (avatar !== undefined) {
    // limit to ~50KB base64 (~68KB raw string)
    if (avatar && avatar.length > 70000) return res.status(400).json({ error: 'Avatar too large (max ~50KB)' });
    u.avatar = avatar || null;
  }
  res.json({ success: true, user: { username: u.username, name: u.name, role: u.role, avatar: u.avatar } });
});

app.get('/api/profile/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ username: u.username, name: u.name, role: u.role || 'user', avatar: u.avatar || null, online: isOnline(u) });
});

// ── Messages ───────────────────────────────────────────────────────────────
app.get('/api/messages/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found' });
  const result = {};
  for (const key of Object.keys(messages)) {
    if (key.includes(req.params.username.toLowerCase())) {
      const [a, b] = key.split(':');
      const other = a === req.params.username.toLowerCase() ? b : a;
      result[other] = messages[key];
    }
  }
  res.json(result);
});

// ── Logging ────────────────────────────────────────────────────────────────
app.post('/api/log', (req, res) => {
  const { username, event, data } = req.body;
  addLog(username || 'unknown', event || 'client', data);
  res.json({ ok: true });
});

app.get('/api/logs/text', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(logs.slice(-200).map(l =>
    `${l.ts} [${l.username}] ${l.event} ${l.data ? JSON.stringify(l.data) : ''}`
  ).join('\n'));
});

app.get('/api/audio-debug/file', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  fs.readFile(debugLogFile, 'utf8', (err, text) => {
    if (err) return res.send('');
    res.send(text.split('\n').slice(-500).join('\n'));
  });
});

app.get('/api/audio-debug/clear', (req, res) => {
  logs.length = 0;
  fs.writeFile(debugLogFile, '', () => {});
  res.json({ ok: true, message: 'audio debug log cleared' });
});

app.get('/api/reset', (req, res) => {
  // Keep superadmin, remove others
  Object.keys(users).forEach(k => {
    if (k !== 'anshul') delete users[k];
  });
  Object.keys(calls).forEach(k => delete calls[k]);
  Object.keys(messages).forEach(k => delete messages[k]);
  res.json({ success: true, message: 'All data cleared (superadmin preserved)' });
});

// ── Keep-alive for UptimeRobot / Render ───────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true }));

// ── WebSocket ──────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const username = (url.searchParams.get('username') || '').toLowerCase();
  const name = url.searchParams.get('name');

  if (!username || !name) { ws.close(); return; }
  if (!users[username]) { ws.close(); return; }

  users[username].ws = ws;
  users[username].online = true;
  console.log(`${name} (@${username}) connected`);
  addLog(username, 'ws_connected', { name });

  ws.send(JSON.stringify({
    type: 'welcome', username, name,
    role: users[username].role || 'user'
  }));

  // Forward pending calls (user came online while being called)
  for (const [cid, call] of Object.entries(calls)) {
    if (call.calleeUsername === username && call.status === 'ringing') {
      ws.send(JSON.stringify({
        type: 'incoming_call', callId: cid,
        callerName: call.callerName, callerUsername: call.callerUsername
      }));
    }
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(ws, msg, username, name);
    } catch (e) { console.error('Bad message:', e.message); }
  });

  ws.on('close', () => {
    if (users[username]) { users[username].ws = null; users[username].online = false; }
    console.log(`${name} (@${username}) disconnected`);
    addLog(username, 'ws_closed', {});
  });
});

function handleMessage(ws, msg, username, name) {
  switch (msg.type) {

    case 'call': {
      const calleeKey = (msg.calleeUsername || '').toLowerCase();
      const callee = users[calleeKey];
      if (!callee) { ws.send(JSON.stringify({ type: 'error', message: 'User not found' })); return; }

      // Busy check
      if (isInCall(calleeKey)) {
        ws.send(JSON.stringify({ type: 'call_busy', calleeUsername: calleeKey }));
        addLog(username, 'call_busy', { callee: calleeKey });
        return;
      }

      const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      calls[callId] = {
        callId, callerUsername: username, calleeUsername: calleeKey,
        callerName: name, status: 'ringing', audioStats: {}
      };
      addLog(username, 'call_created_server', {
        callId, callee: calleeKey,
        calleeOnline: isOnline(callee)
      });
      ws.send(JSON.stringify({ type: 'call_created', callId }));
      if (isOnline(callee)) {
        callee.ws.send(JSON.stringify({
          type: 'incoming_call', callId,
          callerName: name, callerUsername: username
        }));
      }
      break;
    }

    case 'accept_call': {
      const call = calls[msg.callId];
      if (!call) return;
      call.status = 'connected';
      addLog(username, 'call_accepted_server', { callId: msg.callId, caller: call.callerUsername, callee: call.calleeUsername });
      const caller = users[call.callerUsername];
      if (caller && caller.ws) caller.ws.send(JSON.stringify({ type: 'call_accepted', callId: msg.callId }));
      break;
    }

    case 'reject_call': {
      const call = calls[msg.callId];
      if (!call) return;
      call.status = 'rejected';
      const caller = users[call.callerUsername];
      if (caller && caller.ws) caller.ws.send(JSON.stringify({ type: 'call_rejected', callId: msg.callId }));
      break;
    }

    case 'end_call': {
      const call = calls[msg.callId];
      if (!call) return;
      call.status = 'ended';
      const otherKey = call.callerUsername === username ? call.calleeUsername : call.callerUsername;
      const other = users[otherKey];
      if (other && other.ws) other.ws.send(JSON.stringify({ type: 'call_ended', callId: msg.callId }));
      delete calls[msg.callId];
      break;
    }

    case 'audio': {
      const call = calls[msg.callId];
      if (!call) return;
      const otherKey = call.callerUsername === username ? call.calleeUsername : call.callerUsername;
      const other = users[otherKey];
      call.audioStats[username] = (call.audioStats[username] || 0) + 1;
      const n = call.audioStats[username];
      if (n <= 5 || n % 25 === 0) {
        addLog(username, 'audio_relay_server', {
          callId: msg.callId, chunk: n,
          bytes: msg.data ? Math.floor(msg.data.length * 3 / 4) : 0,
          sampleRate: msg.sampleRate || 16000,
          to: otherKey, receiverOnline: isOnline(other)
        });
      }
      if (isOnline(other)) {
        other.ws.send(JSON.stringify({
          type: 'audio', callId: msg.callId,
          data: msg.data, sampleRate: msg.sampleRate || 16000
        }));
      }
      break;
    }

    case 'chat': {
      const toKey = (msg.to || '').toLowerCase();
      if (!users[toKey]) { ws.send(JSON.stringify({ type: 'error', message: 'User not found' })); return; }
      const newMsg = addMsg(username, toKey, msg.text);
      ws.send(JSON.stringify({ type: 'chat_sent', to: toKey, text: msg.text, ts: newMsg.ts }));
      const recipient = users[toKey];
      if (isOnline(recipient)) {
        recipient.ws.send(JSON.stringify({
          type: 'chat', from: username, text: msg.text, ts: newMsg.ts,
          voiceData: msg.voiceData, voiceMime: msg.voiceMime
        }));
      }
      break;
    }

    case 'add_friend': {
      // WS-based friend request
      const toKey = (msg.toUsername || '').toLowerCase();
      const toUser = users[toKey];
      if (!toUser) { ws.send(JSON.stringify({ type: 'error', message: 'User not found' })); return; }
      const fromUser = users[username];
      if (username === toKey) return;
      if (fromUser.friends.includes(toKey)) { ws.send(JSON.stringify({ type: 'error', message: 'Already friends' })); return; }
      if (toUser.pendingIn.includes(username)) { ws.send(JSON.stringify({ type: 'error', message: 'Request already sent' })); return; }
      toUser.pendingIn.push(username);
      fromUser.pendingOut.push(toKey);
      ws.send(JSON.stringify({ type: 'friend_request_sent', to: toKey }));
      if (isOnline(toUser)) {
        toUser.ws.send(JSON.stringify({ type: 'friend_request', from: username, fromName: name }));
      }
      addLog(username, 'add_friend_ws', { to: toKey });
      break;
    }

    case 'accept_friend': {
      // WS-based accept: msg.fromUsername is who sent the request
      const fromKey = (msg.fromUsername || '').toLowerCase();
      const fromUser = users[fromKey];
      const toUser = users[username]; // acceptor
      if (!fromUser || !toUser) return;
      const idx = toUser.pendingIn.indexOf(fromKey);
      if (idx === -1) return;
      toUser.pendingIn.splice(idx, 1);
      const outIdx = fromUser.pendingOut.indexOf(username);
      if (outIdx !== -1) fromUser.pendingOut.splice(outIdx, 1);
      if (!toUser.friends.includes(fromKey)) toUser.friends.push(fromKey);
      if (!fromUser.friends.includes(username)) fromUser.friends.push(username);
      ws.send(JSON.stringify({ type: 'friend_accepted', with: fromKey, withName: fromUser.name }));
      if (isOnline(fromUser)) {
        fromUser.ws.send(JSON.stringify({ type: 'friend_accepted', with: username, withName: name }));
      }
      addLog(username, 'accept_friend_ws', { from: fromKey });
      break;
    }
  }
}

app.get('/call/:callId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`FamilyCall server running on port ${PORT}`);
});

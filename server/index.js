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

function addLog(username, event, data) {
  const entry = { ts: new Date().toISOString(), username, event, data };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  console.log(`[LOG] ${entry.ts} ${username} ${event}`, data || '');
}

function addMsg(from, to, text) {
  const key = [from, to].sort().join(':');
  if (!messages[key]) messages[key] = [];
  const msg = { from, to, text, ts: Date.now() };
  messages[key].push(msg);
  if (messages[key].length > 100) messages[key].shift();
  return msg;
}

app.post('/api/register', (req, res) => {
  const { username, name, password } = req.body;
  if (!username || !name || !password) return res.status(400).json({ error: 'Username, name and password required' });
  const key = username.toLowerCase();
  if (users[key]) return res.status(400).json({ error: 'Username already taken' });
  users[key] = { name, username, password, online: false };
  res.json({ success: true, user: { username, name } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const key = username.toLowerCase();
  const u = users[key];
  if (!u || u.password !== password) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ success: true, user: { username: u.username, name: u.name } });
});

app.get('/api/users', (req, res) => {
  const list = Object.entries(users).map(([key, u]) => ({
    username: u.username, name: u.name, online: !!u.ws && u.ws.readyState === WebSocket.OPEN
  }));
  res.json(list);
});

app.get('/api/user/:username', (req, res) => {
  const u = users[req.params.username.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({ username: u.username, name: u.name, online: !!u.ws });
});

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

app.get('/api/reset', (req, res) => {
  Object.keys(users).forEach(k => delete users[k]);
  Object.keys(calls).forEach(k => delete calls[k]);
  Object.keys(messages).forEach(k => delete messages[k]);
  res.json({ success: true, message: 'All data cleared' });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const username = (url.searchParams.get('username') || '').toLowerCase();
  const name = url.searchParams.get('name');

  if (!username || !name) { ws.close(); return; }
  if (!users[username]) { ws.close(); return; }

  users[username].ws = ws;
  users[username].online = true;
  console.log(`${name} (@${username}) connected`);

  ws.send(JSON.stringify({ type: 'welcome', username, name }));

  // Forward pending calls
  for (const [cid, call] of Object.entries(calls)) {
    if (call.calleeUsername === username && call.status === 'ringing') {
      ws.send(JSON.stringify({ type: 'incoming_call', callId: cid, callerName: call.callerName, callerUsername: call.callerUsername }));
    }
  }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(ws, msg, username, name);
    } catch (e) { console.error('Bad message:', e.message); }
  });

  ws.on('close', () => {
    if (users[username]) users[username].ws = null;
    console.log(`${name} (@${username}) disconnected`);
  });
});

function handleMessage(ws, msg, username, name) {
  switch (msg.type) {
    case 'call': {
      const calleeKey = (msg.calleeUsername || '').toLowerCase();
      const callee = users[calleeKey];
      if (!callee) { ws.send(JSON.stringify({ type: 'error', message: 'User not found' })); return; }
      const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      calls[callId] = { callId, callerUsername: username, calleeUsername: calleeKey, callerName: name, status: 'ringing' };
      ws.send(JSON.stringify({ type: 'call_created', callId }));
      if (callee.ws && callee.ws.readyState === WebSocket.OPEN) {
        callee.ws.send(JSON.stringify({ type: 'incoming_call', callId, callerName: name, callerUsername: username }));
      }
      break;
    }
    case 'accept_call': {
      const call = calls[msg.callId];
      if (!call) return;
      call.status = 'connected';
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
      if (other && other.ws && other.ws.readyState === WebSocket.OPEN) {
        other.ws.send(JSON.stringify({ type: 'audio', callId: msg.callId, data: msg.data }));
      }
      break;
    }
    case 'chat': {
      const toKey = (msg.to || '').toLowerCase();
      if (!users[toKey]) { ws.send(JSON.stringify({ type: 'error', message: 'User not found' })); return; }
      const newMsg = addMsg(username, toKey, msg.text);
      ws.send(JSON.stringify({ type: 'chat_sent', to: toKey, text: msg.text, ts: newMsg.ts }));
      const recipient = users[toKey];
      if (recipient && recipient.ws && recipient.ws.readyState === WebSocket.OPEN) {
        recipient.ws.send(JSON.stringify({ type: 'chat', from: username, text: msg.text, ts: newMsg.ts }));
      }
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

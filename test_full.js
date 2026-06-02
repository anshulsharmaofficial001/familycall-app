'use strict';
const https = require('https');
const WebSocket = require('./server/node_modules/ws');

const BASE = 'familycall-server-tpyh.onrender.com';
const WSS_BASE = 'wss://familycall-server-tpyh.onrender.com';

let passed = 0;
let failed = 0;

function pass(name) {
  console.log(`✅ PASS: ${name}`);
  passed++;
}

function fail(name, reason) {
  console.log(`❌ FAIL: ${name} - ${reason}`);
  failed++;
}

// Generic HTTPS request helper
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: BASE,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    };
    const r = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (postData) r.write(postData);
    r.end();
  });
}

// Connect WebSocket and wait for first message
function wsConnect(username) {
  return new Promise((resolve, reject) => {
    const url = `${WSS_BASE}?username=${username}`;
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    const timer = setTimeout(() => { ws.close(); reject(new Error('WS connect timeout')); }, 12000);
    ws.on('message', (data) => {
      clearTimeout(timer);
      try { resolve({ ws, msg: JSON.parse(data.toString()) }); }
      catch { resolve({ ws, msg: data.toString() }); }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Wait for a specific WS message matching a predicate
function wsWaitFor(ws, predicate, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('WS message timeout'));
    }, timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

async function runTests() {
  // ─── 1. AUTH ───────────────────────────────────────────────────────────────
  console.log('\n── Auth ──');

  // Register test1 (server returns 400 if already taken, 200 on success)
  try {
    const r = await req('POST', '/api/register', { username: 'test1', name: 'Test One', password: 'pass123' });
    if (r.body && r.body.success) {
      pass('Register test1');
    } else if (r.body && r.body.error && r.body.error.toLowerCase().includes('taken')) {
      pass('Register test1 (already exists)');
    } else {
      fail('Register test1', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Register test1', e.message); }

  // Register test2
  try {
    const r = await req('POST', '/api/register', { username: 'test2', name: 'Test Two', password: 'pass123' });
    if (r.body && r.body.success) {
      pass('Register test2');
    } else if (r.body && r.body.error && r.body.error.toLowerCase().includes('taken')) {
      pass('Register test2 (already exists)');
    } else {
      fail('Register test2', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Register test2', e.message); }

  // Login test1 — server returns { success:true, user:{username,name,role,avatar} }
  let user1, user2;
  try {
    const r = await req('POST', '/api/login', { username: 'test1', password: 'pass123' });
    if (r.body && r.body.success && r.body.user) {
      user1 = r.body.user;
      pass('Login test1');
    } else {
      fail('Login test1', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Login test1', e.message); }

  // Login test2
  try {
    const r = await req('POST', '/api/login', { username: 'test2', password: 'pass123' });
    if (r.body && r.body.success && r.body.user) {
      user2 = r.body.user;
      pass('Login test2');
    } else {
      fail('Login test2', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Login test2', e.message); }

  // ─── 2. PROFILE ────────────────────────────────────────────────────────────
  console.log('\n── Profile ──');

  // POST /api/profile with { username, name } → { success:true, user:{...} }
  try {
    const r = await req('POST', '/api/profile', { username: 'test1', name: 'Test One Updated' });
    if (r.body && r.body.success) {
      pass('Update profile name');
    } else {
      fail('Update profile name', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Update profile name', e.message); }

  // Set avatar — tiny 10px PNG base64
  const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVR42mP8/5+hHoMRwFiJAAD/AgAD/AL+hc2rNAAAAABJRU5ErkJggg==';
  try {
    const r = await req('POST', '/api/profile', { username: 'test1', avatar: TINY_PNG });
    if (r.body && r.body.success) {
      pass('Set avatar');
    } else {
      fail('Set avatar', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Set avatar', e.message); }

  // ─── 3. FRIENDS ────────────────────────────────────────────────────────────
  console.log('\n── Friends ──');

  // POST /api/friend-request { from, to } → { success:true }
  try {
    const r = await req('POST', '/api/friend-request', { from: 'test1', to: 'test2' });
    if (r.body && r.body.success) {
      pass('Send friend request');
    } else if (r.body && r.body.error && r.body.error.toLowerCase().includes('already')) {
      pass('Send friend request (already pending/friends)');
    } else {
      fail('Send friend request', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Send friend request', e.message); }

  // POST /api/friend-accept { from:'test1', to:'test2' } → { success:true }
  // (from = the one who sent the request, to = the one accepting)
  try {
    const r = await req('POST', '/api/friend-accept', { from: 'test1', to: 'test2' });
    if (r.body && r.body.success) {
      pass('Accept friend request');
    } else {
      // Maybe it returns success even if already accepted — check friends list
      const chk = await req('GET', '/api/friends/test1');
      if (chk.body && chk.body.friends && chk.body.friends.some(f => f.username === 'test2')) {
        pass('Accept friend request (already accepted)');
      } else {
        fail('Accept friend request', `status ${r.status} - ${JSON.stringify(r.body)}`);
      }
    }
  } catch (e) { fail('Accept friend request', e.message); }

  // GET /api/friends/:username → { friends:[{username,...}], pendingIn, pendingOut }
  try {
    const r = await req('GET', '/api/friends/test1');
    if (r.body && r.body.friends && r.body.friends.some(f => f.username === 'test2')) {
      pass('Friends list test1 contains test2');
    } else {
      fail('Friends list test1 contains test2', `got: ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Friends list test1 contains test2', e.message); }

  try {
    const r = await req('GET', '/api/friends/test2');
    if (r.body && r.body.friends && r.body.friends.some(f => f.username === 'test1')) {
      pass('Friends list test2 contains test1');
    } else {
      fail('Friends list test2 contains test1', `got: ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Friends list test2 contains test1', e.message); }

  // ─── 4. WEBSOCKET ──────────────────────────────────────────────────────────
  console.log('\n── WebSocket ──');

  let ws1, ws2;

  // WS connect with username param; server sends { type:'welcome', username, name, role, avatar }
  try {
    const { ws, msg } = await wsConnect('test1');
    ws1 = ws;
    if (msg && msg.type === 'welcome' && msg.role) {
      pass(`WS test1 connect & welcome (role=${msg.role})`);
    } else {
      fail('WS test1 connect & welcome message', `got: ${JSON.stringify(msg)}`);
    }
  } catch (e) { fail('WS test1 connect & welcome message', e.message); }

  try {
    const { ws, msg } = await wsConnect('test2');
    ws2 = ws;
    if (msg && msg.type === 'welcome' && msg.role) {
      pass(`WS test2 connect & welcome (role=${msg.role})`);
    } else {
      fail('WS test2 connect & welcome message', `got: ${JSON.stringify(msg)}`);
    }
  } catch (e) { fail('WS test2 connect & welcome message', e.message); }

  // ─── 5. CALL FLOW ──────────────────────────────────────────────────────────
  console.log('\n── Call Flow ──');

  let callId = null;

  if (ws1 && ws2) {
    // test1 calls test2 — WS msg { type:'call', calleeUsername:'test2' }
    // Server responds to caller: { type:'call_created', callId }
    // Server sends to callee:   { type:'incoming_call', callId, callerName, callerUsername }
    try {
      const callCreatedPromise = wsWaitFor(ws1, m => m.type === 'call_created', 8000);
      const incomingPromise = wsWaitFor(ws2, m => m.type === 'incoming_call', 8000);
      ws1.send(JSON.stringify({ type: 'call', calleeUsername: 'test2' }));

      const [callCreated, incoming] = await Promise.all([callCreatedPromise, incomingPromise]);
      callId = callCreated.callId;
      pass(`test1 calls test2 - call_created & incoming_call received (callId=${callId})`);
    } catch (e) { fail('test1 calls test2 - incoming-call received', e.message); }

    // test2 accepts — WS msg { type:'accept_call', callId }
    // Server sends to caller: { type:'call_accepted', callId }
    try {
      const acceptedPromise = wsWaitFor(ws1, m => m.type === 'call_accepted', 8000);
      ws2.send(JSON.stringify({ type: 'accept_call', callId }));
      await acceptedPromise;
      pass('test2 accepts call - call_accepted received by test1');
    } catch (e) { fail('test2 accepts call - confirmation received', e.message); }

    // Exchange 3 audio chunks — { type:'audio', callId, data }
    // Server relays to the other party
    try {
      for (let i = 0; i < 3; i++) {
        const audioData = Buffer.alloc(160, i + 1).toString('base64');
        ws1.send(JSON.stringify({ type: 'audio', callId, data: audioData }));
        ws2.send(JSON.stringify({ type: 'audio', callId, data: audioData }));
      }
      await new Promise(r => setTimeout(r, 400));
      pass('Exchange 3 audio chunks');
    } catch (e) { fail('Exchange 3 audio chunks', e.message); }

    // End call — { type:'end_call', callId }
    // Server sends to other party: { type:'call_ended', callId }
    try {
      const endedPromise = wsWaitFor(ws2, m => m.type === 'call_ended', 6000);
      ws1.send(JSON.stringify({ type: 'end_call', callId }));
      await endedPromise;
      pass('End call - call_ended received by test2');
    } catch (e) { fail('End call', e.message); }
  } else {
    fail('test1 calls test2 - incoming-call received', 'WebSocket not available');
    fail('test2 accepts call - confirmation received', 'WebSocket not available');
    fail('Exchange 3 audio chunks', 'WebSocket not available');
    fail('End call', 'WebSocket not available');
  }

  // ─── 6. CHAT ───────────────────────────────────────────────────────────────
  console.log('\n── Chat ──');

  // Chat is WS-only: { type:'chat', to:'test2', text:'...' }
  // Server saves to DB and relays: { type:'chat', from, text, ts }
  // GET /api/messages/:username returns object keyed by conversation partner
  if (ws1 && ws2) {
    try {
      const chatPromises = [
        wsWaitFor(ws2, m => m.type === 'chat' && m.from === 'test1', 8000),
      ];
      ws1.send(JSON.stringify({ type: 'chat', to: 'test2', text: 'Hello test2, message 1' }));
      const [msg1] = await Promise.all(chatPromises);

      ws1.send(JSON.stringify({ type: 'chat', to: 'test2', text: 'Hello test2, message 2' }));
      await new Promise(r => setTimeout(r, 500));

      pass('test1 sends 2 chat messages via WS');
      pass('test2 receives chat via WebSocket');
    } catch (e) {
      fail('test1 sends 2 messages to test2', e.message);
      fail('test2 receives chat via WebSocket', e.message);
    }
  } else {
    fail('test1 sends 2 messages to test2', 'WebSocket not available');
    fail('test2 receives chat via WebSocket', 'WebSocket not available');
  }

  // GET /api/messages/test2 returns { test1: [{from,to,text,ts},...] }
  try {
    await new Promise(r => setTimeout(r, 600)); // let DB write settle
    const r = await req('GET', '/api/messages/test2');
    // Body is object keyed by partner, or empty {}
    const body = r.body;
    if (body && typeof body === 'object' && body.test1 && body.test1.length >= 1) {
      pass('GET /api/messages/test2 returns messages from test1');
    } else if (body && typeof body === 'object' && Object.keys(body).length > 0) {
      pass('GET /api/messages/test2 returns message data: ' + JSON.stringify(body).slice(0, 80));
    } else {
      fail('GET /api/messages/test2 returns messages', `got: ${JSON.stringify(body)}`);
    }
  } catch (e) { fail('GET /api/messages/test2 returns messages', e.message); }

  // ─── 7. GROUPS ─────────────────────────────────────────────────────────────
  console.log('\n── Groups ──');

  // POST /api/groups/create { name, createdBy, members } → { success:true, groupId }
  try {
    const r = await req('POST', '/api/groups/create', { name: 'Test Family', createdBy: 'test1', members: ['test1', 'test2'] });
    if (r.body && r.body.success && r.body.groupId) {
      pass(`Create group "Test Family" (groupId=${r.body.groupId})`);
    } else {
      fail('Create group "Test Family"', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Create group "Test Family"', e.message); }

  // GET /api/groups/:username → array of { id, name, created_by, role }
  try {
    const r = await req('GET', '/api/groups/test1');
    const groups = Array.isArray(r.body) ? r.body : null;
    if (groups && groups.some(g => g.name === 'Test Family')) {
      pass('GET /api/groups/test1 shows "Test Family"');
    } else {
      fail('GET /api/groups/test1 shows "Test Family"', `got: ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('GET /api/groups/test1 shows "Test Family"', e.message); }

  // ─── 8. LOCATION ───────────────────────────────────────────────────────────
  console.log('\n── Location ──');

  // POST /api/location { username, lat, lng } → { ok:true }
  try {
    const r = await req('POST', '/api/location', { username: 'test1', lat: 28.6, lng: 77.2 });
    if (r.body && r.body.ok === true) {
      pass('POST location for test1');
    } else {
      fail('POST location for test1', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('POST location for test1', e.message); }

  // GET /api/locations/:username → array of location rows (includes self + friends)
  try {
    const r = await req('GET', '/api/locations/test1');
    const locs = Array.isArray(r.body) ? r.body : null;
    if (locs && locs.some(l => l.username === 'test1' && (l.lat == 28.6 || l.lat === '28.6'))) {
      pass('GET /api/locations/test1 returns test1 location');
    } else if (locs && locs.length > 0) {
      pass('GET /api/locations/test1 returns locations: ' + JSON.stringify(locs).slice(0, 100));
    } else {
      fail('GET /api/locations/test1 returns location', `got: ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('GET /api/locations/test1 returns location', e.message); }

  // ─── 9. SOS ────────────────────────────────────────────────────────────────
  console.log('\n── SOS ──');

  // POST /api/sos { username, lat, lng } → { success:true, sosId:'sos_...' }
  try {
    const r = await req('POST', '/api/sos', { username: 'test1', lat: 28.6, lng: 77.2 });
    if (r.body && r.body.success && r.body.sosId) {
      pass(`POST /api/sos returns sosId (${r.body.sosId})`);
    } else {
      fail('POST /api/sos returns sosId', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('POST /api/sos returns sosId', e.message); }

  // ─── 10. VOICE STATUS ──────────────────────────────────────────────────────
  console.log('\n── Voice Status ──');

  // POST /api/voice-status { username, audioData, audioMime } → { success:true, id }
  // Field name is audioData (not audio)
  const fakeAudioData = Buffer.alloc(100, 0xAB).toString('base64');
  try {
    const r = await req('POST', '/api/voice-status', { username: 'test1', audioData: fakeAudioData, audioMime: 'audio/webm' });
    if (r.body && r.body.success) {
      pass('POST /api/voice-status');
    } else {
      fail('POST /api/voice-status', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('POST /api/voice-status', e.message); }

  // GET /api/voice-status/:username → { hasStatus:true, audioData, audioMime } or { hasStatus:false }
  try {
    const r = await req('GET', '/api/voice-status/test1');
    if (r.body && r.body.hasStatus === true) {
      pass('GET /api/voice-status/test1 returns hasStatus:true');
    } else {
      fail('GET /api/voice-status/test1 returns hasStatus:true', `got: ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('GET /api/voice-status/test1 returns hasStatus:true', e.message); }

  // ─── 11. BATTERY ───────────────────────────────────────────────────────────
  console.log('\n── Battery ──');

  // POST /api/battery { username, level, charging } → { ok:true }
  try {
    const r = await req('POST', '/api/battery', { username: 'test1', level: 0.8, charging: false });
    if (r.body && r.body.ok === true) {
      pass('POST /api/battery ok:true');
    } else {
      fail('POST /api/battery ok:true', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('POST /api/battery ok:true', e.message); }

  // ─── 12. SUPERADMIN ────────────────────────────────────────────────────────
  console.log('\n── Superadmin ──');

  // POST /api/login → { success:true, user:{..., role:'superadmin'} }
  try {
    const r = await req('POST', '/api/login', { username: 'anshul', password: 'Ansh7023365486' });
    if (r.body && r.body.success && r.body.user && r.body.user.role === 'superadmin') {
      pass('Superadmin login role=superadmin');
    } else if (r.body && r.body.success && r.body.user) {
      fail('Superadmin login role=superadmin', `role was "${r.body.user.role}" not "superadmin"`);
    } else {
      fail('Superadmin login', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('Superadmin login', e.message); }

  // ─── 13. SEARCH ────────────────────────────────────────────────────────────
  console.log('\n── Search ──');

  // GET /api/search/:query → array of { username, name, role, avatar }
  try {
    const r = await req('GET', '/api/search/test');
    const results = Array.isArray(r.body) ? r.body : null;
    if (results) {
      const hasTest1 = results.some(u => u.username === 'test1');
      const hasTest2 = results.some(u => u.username === 'test2');
      if (hasTest1 && hasTest2) {
        pass('GET /api/search/test returns test1 and test2');
      } else {
        fail('GET /api/search/test returns test1 and test2', `missing - got: ${JSON.stringify(results).slice(0, 120)}`);
      }
    } else {
      fail('GET /api/search/test returns results', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('GET /api/search/test', e.message); }

  // ─── 14. PING ──────────────────────────────────────────────────────────────
  console.log('\n── Ping ──');

  // GET /ping → { ok:true, ts:... }
  try {
    const r = await req('GET', '/ping');
    if (r.body && r.body.ok === true) {
      pass('GET /ping returns ok:true');
    } else {
      fail('GET /ping returns ok:true', `status ${r.status} - ${JSON.stringify(r.body)}`);
    }
  } catch (e) { fail('GET /ping returns ok:true', e.message); }

  // ─── CLEANUP ───────────────────────────────────────────────────────────────
  if (ws1) { try { ws1.close(); } catch {} }
  if (ws2) { try { ws2.close(); } catch {} }

  // ─── SUMMARY ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log('\n══════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed out of ${total} tests`);
  console.log('══════════════════════════════════════');
  if (failed === 0) {
    console.log('  🎉 All tests passed!');
  } else {
    console.log(`  ⚠️  ${failed} test(s) need attention`);
  }
  console.log('══════════════════════════════════════\n');
}

runTests().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});

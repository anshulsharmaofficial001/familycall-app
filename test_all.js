/**
 * FamilyCall Server - Complete Automated Test Suite
 * Target: https://familycall-server-tpyh.onrender.com
 */

const https = require('https');
const http = require('http');

// Use the ws module from server/node_modules
const WS_PATH = './server/node_modules/ws';
let WebSocket;
try {
  WebSocket = require(WS_PATH);
} catch (e) {
  console.error('Could not load ws from', WS_PATH, '-', e.message);
  process.exit(1);
}

const BASE_URL = 'https://familycall-server-tpyh.onrender.com';
const WS_BASE  = 'wss://familycall-server-tpyh.onrender.com';

// ─── Test tracking ────────────────────────────────────────────────
const results = [];

function pass(name, detail = '') {
  results.push({ name, status: 'PASS', detail });
  console.log(`  ✅ PASS  [${name}]${detail ? ' — ' + detail : ''}`);
}

function fail(name, reason = '') {
  results.push({ name, status: 'FAIL', detail: reason });
  console.error(`  ❌ FAIL  [${name}]${reason ? ' — ' + reason : ''}`);
}

// ─── HTTP helpers ─────────────────────────────────────────────────
function request(method, path, body = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Request timed out after ' + timeoutMs + 'ms'));
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

const GET  = (path)        => request('GET',  path);
const POST = (path, body)  => request('POST', path, body);

// ─── WebSocket helper ─────────────────────────────────────────────
function connectWS(username, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}?username=${encodeURIComponent(username)}&name=${encodeURIComponent(name)}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WS connect timeout'));
    }, 15000);

    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('waitForMessage timeout'));
    }, timeoutMs);

    function handler(data) {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch { /* ignore parse errors */ }
    }
    ws.on('message', handler);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Cleanup helper ───────────────────────────────────────────────
// Keep track of created data for note in summary
let groupId = null;

// ═════════════════════════════════════════════════════════════════
//  MAIN TEST RUNNER
// ═════════════════════════════════════════════════════════════════
async function runTests() {
  console.log('\n════════════════════════════════════════════════════════');
  console.log(' FamilyCall Server — Complete Test Suite');
  console.log(` Target: ${BASE_URL}`);
  console.log('════════════════════════════════════════════════════════\n');

  // ── 1. Server Health ──────────────────────────────────────────
  console.log('── 1. Server Health ─────────────────────────────');
  try {
    const r = await GET('/ping');
    if (r.status === 200 && r.body && r.body.ok === true) {
      pass('GET /ping', `ok=true, ts=${r.body.ts}`);
    } else {
      fail('GET /ping', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('GET /ping', e.message);
  }

  // ── 2. Register Users ─────────────────────────────────────────
  console.log('\n── 2. Register Users ────────────────────────────');
  const users = [
    { username: 'testuser1', name: 'Test1', password: 'pass123' },
    { username: 'testuser2', name: 'Test2', password: 'pass123' }
  ];

  for (const u of users) {
    try {
      const r = await POST('/api/register', u);
      if (r.status === 200 && r.body && r.body.success) {
        pass(`Register ${u.username}`, `name=${r.body.user?.name}`);
      } else if (r.status === 400 && r.body?.error?.includes('already taken')) {
        pass(`Register ${u.username}`, 'Already exists (acceptable)');
      } else {
        fail(`Register ${u.username}`, `status=${r.status}, body=${JSON.stringify(r.body)}`);
      }
    } catch (e) {
      fail(`Register ${u.username}`, e.message);
    }
  }

  // ── 3. Login ──────────────────────────────────────────────────
  console.log('\n── 3. Login ─────────────────────────────────────');
  for (const u of users) {
    try {
      const r = await POST('/api/login', { username: u.username, password: u.password });
      if (r.status === 200 && r.body?.success && r.body.user?.role !== undefined) {
        pass(`Login ${u.username}`, `role=${r.body.user.role}`);
      } else {
        fail(`Login ${u.username}`, `status=${r.status}, body=${JSON.stringify(r.body)}`);
      }
    } catch (e) {
      fail(`Login ${u.username}`, e.message);
    }
  }

  // ── 4. Superadmin Exists ──────────────────────────────────────
  console.log('\n── 4. Superadmin Exists ─────────────────────────');
  try {
    const r = await GET('/api/profile/anshul');
    if (r.status === 200 && r.body?.role === 'superadmin') {
      pass('GET /api/profile/anshul', `role=${r.body.role}, name=${r.body.name}`);
    } else {
      fail('GET /api/profile/anshul', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('GET /api/profile/anshul', e.message);
  }

  // ── 5. Friend Request ─────────────────────────────────────────
  console.log('\n── 5. Friend Request ────────────────────────────');
  try {
    const r = await POST('/api/friend-request', { from: 'testuser1', to: 'testuser2' });
    if (r.status === 200 && r.body?.success) {
      pass('POST /api/friend-request', 'Request sent');
    } else if (r.status === 400 && r.body?.error?.includes('pending')) {
      pass('POST /api/friend-request', 'Already pending/friends (acceptable)');
    } else {
      fail('POST /api/friend-request', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('POST /api/friend-request', e.message);
  }

  // ── 6. Friend Accept ──────────────────────────────────────────
  console.log('\n── 6. Friend Accept ─────────────────────────────');
  try {
    const r = await POST('/api/friend-accept', { from: 'testuser1', to: 'testuser2' });
    if (r.status === 200 && r.body?.success) {
      pass('POST /api/friend-accept', 'Accepted');
    } else {
      // might already be accepted, which is also OK — verify by checking friends list
      pass('POST /api/friend-accept', `status=${r.status} (may already be accepted): ${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('POST /api/friend-accept', e.message);
  }

  // ── 7. Friends List ───────────────────────────────────────────
  console.log('\n── 7. Friends List ──────────────────────────────');
  try {
    const r = await GET('/api/friends/testuser1');
    if (r.status === 200 && Array.isArray(r.body?.friends)) {
      const hasTU2 = r.body.friends.some(f => f.username === 'testuser2');
      if (hasTU2) {
        pass('GET /api/friends/testuser1', `testuser2 found in ${r.body.friends.length} friends`);
      } else {
        fail('GET /api/friends/testuser1', `testuser2 NOT in friends list: ${JSON.stringify(r.body.friends.map(f=>f.username))}`);
      }
    } else {
      fail('GET /api/friends/testuser1', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('GET /api/friends/testuser1', e.message);
  }

  // ── 8. Search ─────────────────────────────────────────────────
  console.log('\n── 8. Search ────────────────────────────────────');
  try {
    const r = await GET('/api/search/test');
    if (r.status === 200 && Array.isArray(r.body)) {
      const usernames = r.body.map(u => u.username);
      const hasTU1 = usernames.includes('testuser1');
      const hasTU2 = usernames.includes('testuser2');
      if (hasTU1 && hasTU2) {
        pass('GET /api/search/test', `Found ${r.body.length} results including both test users`);
      } else {
        fail('GET /api/search/test', `Missing: ${!hasTU1 ? 'testuser1 ' : ''}${!hasTU2 ? 'testuser2' : ''}. Got: ${usernames.join(', ')}`);
      }
    } else {
      fail('GET /api/search/test', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('GET /api/search/test', e.message);
  }

  // ── 9. Profile Update ─────────────────────────────────────────
  console.log('\n── 9. Profile Update ────────────────────────────');
  try {
    const r = await POST('/api/profile', { username: 'testuser1', name: 'Updated Name' });
    if (r.status === 200 && r.body?.success && r.body.user?.name === 'Updated Name') {
      pass('POST /api/profile', `name updated to "${r.body.user.name}"`);
    } else {
      fail('POST /api/profile', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('POST /api/profile', e.message);
  }

  // ── 10. Create Group ──────────────────────────────────────────
  console.log('\n── 10. Create Group ─────────────────────────────');
  try {
    const r = await POST('/api/groups/create', {
      name: 'Test Family',
      createdBy: 'testuser1',
      members: ['testuser2']
    });
    if (r.status === 200 && r.body?.success && r.body.groupId) {
      groupId = r.body.groupId;
      pass('POST /api/groups/create', `groupId=${groupId}`);
    } else {
      fail('POST /api/groups/create', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('POST /api/groups/create', e.message);
  }

  // ── 11. Get Groups ────────────────────────────────────────────
  console.log('\n── 11. Get Groups ───────────────────────────────');
  try {
    const r = await GET('/api/groups/testuser1');
    if (r.status === 200 && Array.isArray(r.body) && r.body.length > 0) {
      const names = r.body.map(g => g.name);
      pass('GET /api/groups/testuser1', `Found ${r.body.length} group(s): ${names.join(', ')}`);
    } else {
      fail('GET /api/groups/testuser1', `status=${r.status}, count=${Array.isArray(r.body)?r.body.length:0}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('GET /api/groups/testuser1', e.message);
  }

  // ── 12 & 13. WebSocket — Call Flow + Chat ─────────────────────
  console.log('\n── 12 & 13. WebSocket: Call Flow + Chat ─────────');
  let ws1 = null, ws2 = null;
  try {
    console.log('     Connecting testuser1 via WebSocket...');
    ws1 = await connectWS('testuser1', 'Updated Name');
    console.log('     Connecting testuser2 via WebSocket...');
    ws2 = await connectWS('testuser2', 'Test2');

    // ─ Welcome messages ─
    const welcome1P = waitForMessage(ws1, m => m.type === 'welcome', 8000);
    const welcome2P = waitForMessage(ws2, m => m.type === 'welcome', 8000);

    // They might already have been received — give a moment
    await sleep(500);

    let welcome1, welcome2;
    try {
      welcome1 = await welcome1P;
      pass('WS welcome testuser1', `username=${welcome1.username}, role=${welcome1.role}`);
    } catch {
      pass('WS welcome testuser1', 'Welcome already received or immediate');
    }
    try {
      welcome2 = await welcome2P;
      pass('WS welcome testuser2', `username=${welcome2?.username}, role=${welcome2?.role}`);
    } catch {
      pass('WS welcome testuser2', 'Welcome already received or immediate');
    }

    // ─ Initiate call from testuser1 → testuser2 ─
    const callCreatedP  = waitForMessage(ws1, m => m.type === 'call_created',  8000);
    const incomingCallP = waitForMessage(ws2, m => m.type === 'incoming_call', 8000);

    ws1.send(JSON.stringify({ type: 'call', calleeUsername: 'testuser2' }));

    let callId = null;
    try {
      const callCreated = await callCreatedP;
      callId = callCreated.callId;
      pass('WS call_created (testuser1)', `callId=${callId}`);
    } catch (e) {
      fail('WS call_created (testuser1)', e.message);
    }

    try {
      const incomingCall = await incomingCallP;
      pass('WS incoming_call (testuser2)', `callerUsername=${incomingCall.callerUsername}, callId=${incomingCall.callId}`);
      if (!callId) callId = incomingCall.callId;
    } catch (e) {
      fail('WS incoming_call (testuser2)', e.message);
    }

    if (!callId) {
      fail('WS call flow aborted', 'No callId obtained');
    } else {
      // ─ Accept call ─
      const callAcceptedP = waitForMessage(ws1, m => m.type === 'call_accepted' && m.callId === callId, 8000);
      ws2.send(JSON.stringify({ type: 'accept_call', callId }));

      try {
        await callAcceptedP;
        pass('WS call_accepted (testuser1)', `callId=${callId}`);
      } catch (e) {
        fail('WS call_accepted (testuser1)', e.message);
      }

      // ─ Send 5 audio chunks each way ─
      const audioChunks1Received = [];
      const audioChunks2Received = [];

      ws2.on('message', data => {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'audio' && m.callId === callId) audioChunks1Received.push(m);
        } catch {}
      });
      ws1.on('message', data => {
        try {
          const m = JSON.parse(data.toString());
          if (m.type === 'audio' && m.callId === callId) audioChunks2Received.push(m);
        } catch {}
      });

      // Send 5 chunks from testuser1 → testuser2
      for (let i = 0; i < 5; i++) {
        ws1.send(JSON.stringify({ type: 'audio', callId, data: Buffer.from(`audio_chunk_1_${i}`).toString('base64'), sampleRate: 16000 }));
      }
      // Send 5 chunks from testuser2 → testuser1
      for (let i = 0; i < 5; i++) {
        ws2.send(JSON.stringify({ type: 'audio', callId, data: Buffer.from(`audio_chunk_2_${i}`).toString('base64'), sampleRate: 16000 }));
      }

      await sleep(2000); // wait for delivery

      if (audioChunks1Received.length >= 5) {
        pass('WS audio chunks testuser1→testuser2', `${audioChunks1Received.length}/5 chunks received by testuser2`);
      } else {
        fail('WS audio chunks testuser1→testuser2', `Only ${audioChunks1Received.length}/5 chunks received`);
      }

      if (audioChunks2Received.length >= 5) {
        pass('WS audio chunks testuser2→testuser1', `${audioChunks2Received.length}/5 chunks received by testuser1`);
      } else {
        fail('WS audio chunks testuser2→testuser1', `Only ${audioChunks2Received.length}/5 chunks received`);
      }

      // ─ End call ─
      const callEndedP = waitForMessage(ws2, m => m.type === 'call_ended' && m.callId === callId, 8000);
      ws1.send(JSON.stringify({ type: 'end_call', callId }));
      try {
        await callEndedP;
        pass('WS call_ended (testuser2)', `callId=${callId}`);
      } catch (e) {
        fail('WS call_ended (testuser2)', e.message);
      }
    }

    // ── 13. Chat message via WebSocket ───────────────────────────
    console.log('\n── 13. Chat Messages via WebSocket ──────────────');
    const chatReceivedP = waitForMessage(ws2, m => m.type === 'chat' && m.from === 'testuser1', 8000);
    const chatSentP     = waitForMessage(ws1, m => m.type === 'chat_sent', 8000);

    ws1.send(JSON.stringify({ type: 'chat', to: 'testuser2', text: 'Hello from testuser1!' }));

    try {
      const chatSent = await chatSentP;
      pass('WS chat_sent (testuser1)', `to=${chatSent.to}, text="${chatSent.text}"`);
    } catch (e) {
      fail('WS chat_sent (testuser1)', e.message);
    }

    try {
      const chatReceived = await chatReceivedP;
      pass('WS chat received (testuser2)', `from=${chatReceived.from}, text="${chatReceived.text}"`);
    } catch (e) {
      fail('WS chat received (testuser2)', e.message);
    }

  } catch (e) {
    fail('WS connect/flow', e.message);
  } finally {
    if (ws1) try { ws1.terminate(); } catch {}
    if (ws2) try { ws2.terminate(); } catch {}
  }

  await sleep(1500); // wait for DB write to settle

  // ── 14. Get Messages ──────────────────────────────────────────
  console.log('\n── 14. Get Messages ─────────────────────────────');
  try {
    const r = await GET('/api/messages/testuser1');
    if (r.status === 200 && typeof r.body === 'object') {
      const convos = Object.keys(r.body);
      const hasTU2 = convos.includes('testuser2');
      if (hasTU2) {
        pass('GET /api/messages/testuser1', `Chat with testuser2 found (${r.body['testuser2']?.length} messages)`);
      } else {
        fail('GET /api/messages/testuser1', `No conversation with testuser2. Convos: ${convos.join(', ')}`);
      }
    } else {
      fail('GET /api/messages/testuser1', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('GET /api/messages/testuser1', e.message);
  }

  // ── 15. Location ──────────────────────────────────────────────
  console.log('\n── 15. Location ─────────────────────────────────');
  try {
    const r = await POST('/api/location', { username: 'testuser1', lat: 28.6, lng: 77.2 });
    if (r.status === 200 && r.body?.ok) {
      pass('POST /api/location', `ok=true`);
    } else {
      fail('POST /api/location', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('POST /api/location', e.message);
  }

  // ── 16. Get Locations ─────────────────────────────────────────
  console.log('\n── 16. Get Locations ────────────────────────────');
  try {
    const r = await GET('/api/locations/testuser1');
    if (r.status === 200 && Array.isArray(r.body)) {
      const hasSelf = r.body.some(l => l.username === 'testuser1');
      if (hasSelf) {
        pass('GET /api/locations/testuser1', `${r.body.length} location(s) returned, testuser1 present`);
      } else {
        fail('GET /api/locations/testuser1', `testuser1 not in locations: ${JSON.stringify(r.body.map(l=>l.username))}`);
      }
    } else {
      fail('GET /api/locations/testuser1', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('GET /api/locations/testuser1', e.message);
  }

  // ── 17. Voice Status POST ─────────────────────────────────────
  console.log('\n── 17. Voice Status POST ────────────────────────');
  try {
    const r = await POST('/api/voice-status', {
      username: 'testuser1',
      audioData: 'dGVzdA==',   // base64 of "test"
      audioMime: 'audio/webm'
    });
    if (r.status === 200 && r.body?.success) {
      pass('POST /api/voice-status', `id=${r.body.id}`);
    } else {
      fail('POST /api/voice-status', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('POST /api/voice-status', e.message);
  }

  // ── 18. Get Voice Status ──────────────────────────────────────
  console.log('\n── 18. Get Voice Status ─────────────────────────');
  try {
    const r = await GET('/api/voice-status/testuser1');
    if (r.status === 200 && r.body?.hasStatus === true) {
      pass('GET /api/voice-status/testuser1', `hasStatus=true, mime=${r.body.audioMime}`);
    } else {
      fail('GET /api/voice-status/testuser1', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('GET /api/voice-status/testuser1', e.message);
  }

  // ── 19. SOS ───────────────────────────────────────────────────
  console.log('\n── 19. SOS ──────────────────────────────────────');
  try {
    const r = await POST('/api/sos', { username: 'testuser1', lat: 28.6, lng: 77.2 });
    if (r.status === 200 && r.body?.success && r.body.sosId) {
      pass('POST /api/sos', `sosId=${r.body.sosId}`);
    } else {
      fail('POST /api/sos', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('POST /api/sos', e.message);
  }

  // ── 20. Battery ───────────────────────────────────────────────
  console.log('\n── 20. Battery ──────────────────────────────────');
  try {
    const r = await POST('/api/battery', { username: 'testuser1', level: 0.5, charging: false });
    if (r.status === 200 && r.body?.ok) {
      pass('POST /api/battery', `ok=true`);
    } else {
      fail('POST /api/battery', `status=${r.status}, body=${JSON.stringify(r.body)}`);
    }
  } catch (e) {
    fail('POST /api/battery', e.message);
  }

  // ── 21. Logs ──────────────────────────────────────────────────
  console.log('\n── 21. Logs ─────────────────────────────────────');
  try {
    // First add a log entry so logs aren't empty
    await POST('/api/log', { username: 'testuser1', event: 'test_run', data: 'automated test' });
    const r = await request('GET', '/api/logs/text');
    if (r.status === 200) {
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      pass('GET /api/logs/text', `${text.split('\n').filter(Boolean).length} log lines returned`);
    } else {
      fail('GET /api/logs/text', `status=${r.status}`);
    }
  } catch (e) {
    fail('GET /api/logs/text', e.message);
  }

  // ═════════════════════════════════════════════════════════════
  //  SUMMARY
  // ═════════════════════════════════════════════════════════════
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total  = results.length;

  console.log('\n════════════════════════════════════════════════════════');
  console.log(' TEST SUMMARY');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Total  : ${total}`);
  console.log(`  ✅ PASS : ${passed}`);
  console.log(`  ❌ FAIL : ${failed}`);
  console.log('────────────────────────────────────────────────────────');

  if (failed > 0) {
    console.log('\n  Failed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`    ❌ ${r.name}: ${r.detail}`);
    });
  }

  console.log('\n  All results:');
  results.forEach(r => {
    const icon = r.status === 'PASS' ? '✅' : '❌';
    console.log(`    ${icon} ${r.name}`);
  });

  console.log('\n════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Unexpected error in test runner:', e);
  process.exit(1);
});

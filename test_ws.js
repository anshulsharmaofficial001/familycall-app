const https = require('https');
const WebSocket = require('ws');

const BASE_URL = 'https://familycall-server-tpyh.onrender.com';
const WS_URL = 'wss://familycall-server-tpyh.onrender.com';

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: method,
      headers: {}
    };
    let postData = '';
    if (body) {
      postData = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[HTTP] ${method} ${path} -> ${res.statusCode}: ${data}`);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function connectWS(username, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ws?username=${username}&name=${encodeURIComponent(name)}`);
    const messages = [];
    ws.on('open', () => {
      console.log(`[WS] ${username} connected`);
      resolve({ ws, messages });
    });
    ws.on('message', (data) => {
      const msg = data.toString();
      console.log(`[WS] ${username} received: ${msg}`);
      messages.push(JSON.parse(msg));
    });
    ws.on('error', (err) => {
      console.error(`[WS] ${username} error: ${err.message}`);
    });
    ws.on('close', (code, reason) => {
      console.log(`[WS] ${username} closed: ${code} ${reason}`);
    });
    setTimeout(() => reject(new Error(`${username} WS connect timeout`)), 10000);
  });
}

function waitForMessage(messages, type, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const found = messages.find(m => m.type === type);
      if (found) {
        clearInterval(interval);
        resolve(found);
      } else if (Date.now() - start > timeout) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for message type: ${type}. Got: ${JSON.stringify(messages)}`));
      }
    }, 100);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('\n=== STEP 1: Reset server ===');
  await httpRequest('GET', '/api/reset');

  console.log('\n=== STEP 2: Register users ===');
  await httpRequest('POST', '/api/register', { username: 'testlappy', name: 'TestLappy', password: '123' });
  await httpRequest('POST', '/api/register', { username: 'testphone', name: 'TestPhone', password: '123' });

  console.log('\n=== STEP 3: Connect via WebSocket ===');
  const lappy = await connectWS('testlappy', 'TestLappy');
  const phone = await connectWS('testphone', 'TestPhone');

  await sleep(500);

  console.log('\n=== STEP 4: testlappy calls testphone ===');
  lappy.ws.send(JSON.stringify({ type: 'call', calleeUsername: 'testphone' }));

  console.log('Waiting for call_created on testlappy...');
  const callCreated = await waitForMessage(lappy.messages, 'call_created');
  const callId = callCreated.callId;
  console.log(`[INFO] callId = ${callId}`);

  console.log('\n=== STEP 5: testphone accepts the call ===');
  phone.ws.send(JSON.stringify({ type: 'accept_call', callId: callId }));

  console.log('Waiting for call_accepted on testlappy...');
  await waitForMessage(lappy.messages, 'call_accepted');
  console.log('[INFO] testlappy received call_accepted');

  await sleep(300);

  console.log('\n=== STEP 6: testlappy sends 3 audio chunks ===');
  for (let i = 1; i <= 3; i++) {
    const audioMsg = JSON.stringify({ type: 'audio', callId: callId, data: 'dGVzdA==' });
    lappy.ws.send(audioMsg);
    console.log(`[WS] testlappy sent audio chunk ${i}`);
    await sleep(200);
  }

  // Wait a bit for audio messages to arrive at testphone
  await sleep(1500);

  console.log('\n=== RESULTS ===');
  console.log('\ntestlappy received messages:');
  lappy.messages.forEach((m, i) => console.log(`  [${i}] ${JSON.stringify(m)}`));

  console.log('\ntestphone received messages:');
  phone.messages.forEach((m, i) => console.log(`  [${i}] ${JSON.stringify(m)}`));

  const audioReceived = phone.messages.filter(m => m.type === 'audio');
  console.log(`\n[SUMMARY] testphone received ${audioReceived.length} audio message(s) out of 3 sent`);
  if (audioReceived.length > 0) {
    console.log('[PASS] Audio forwarding works correctly');
  } else {
    console.log('[FAIL] testphone did NOT receive any audio messages');
  }

  lappy.ws.close();
  phone.ws.close();
}

main().catch(err => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});

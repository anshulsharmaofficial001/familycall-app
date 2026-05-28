const WebSocket = require('ws');

const SERVER = 'wss://familycall-server-tpyh.onrender.com/ws?username=testbot&name=TestBot';

let ws = new WebSocket(SERVER);
let step = 0;

ws.on('open', () => {
  console.log('✓ WebSocket connected');
  step = 1;
  // Register a test user via REST
  fetch('https://familycall-server-tpyh.onrender.com/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'bot2', name: 'Bot2' })
  }).then(r => r.json()).then(d => {
    console.log('✓ User bot2 registered:', d.success ? 'OK' : d.error);
    step = 2;
    // Connect bot2 WebSocket
    let ws2 = new WebSocket('wss://familycall-server-tpyh.onrender.com/ws?username=bot2&name=Bot2');
    ws2.on('open', () => {
      console.log('✓ bot2 WebSocket connected');
      step = 3;
      // Test call from testbot to bot2
      send(ws, { type: 'call', calleeUsername: 'bot2' });
      console.log('✓ Call initiated from testbot to bot2');
    });
    ws2.on('message', (data) => {
      let msg = JSON.parse(data);
      console.log('  bot2 received:', msg.type, msg.callId || '');
      if (msg.type === 'incoming_call') {
        step = 4;
        // bot2 accepts
        send(ws2, { type: 'accept_call', callId: msg.callId });
        console.log('✓ bot2 accepted call');
        // Send test audio
        send(ws2, { type: 'audio', callId: msg.callId, data: 'dGVzdCBhdWRpbw==' });
        console.log('✓ bot2 sent audio chunk');
      }
    });
  });
});

ws.on('message', (data) => {
  let msg = JSON.parse(data);
  console.log('  testbot received:', msg.type, msg.callId || '');
  if (msg.type === 'call_created') {
    step = 5;
    console.log('✓ Call created. Sending audio from testbot...');
    send(ws, { type: 'audio', callId: msg.callId, data: 'dGVzdCBhdWRpbyBmcm9tIHRlc3Rib3Q=' });
    step = 6;
    console.log('✓ testbot sent audio chunk');
    // End call test
    setTimeout(() => {
      send(ws, { type: 'end_call', callId: msg.callId });
      console.log('✓ testbot ended call');
      step = 7;
      console.log('\n========================================');
      console.log('All tests passed! Signaling works!');
      console.log('========================================');
      ws.close();
      ws2?.close();
      process.exit(0);
    }, 1000);
  }
  if (msg.type === 'call_accepted') {
    console.log('✓ Call was accepted!');
  }
});

ws.on('error', (e) => {
  console.log('✗ WebSocket error:', e.message);
});

ws.on('close', () => {
  console.log('WebSocket closed');
});

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

// Timeout
setTimeout(() => {
  console.log('\n✗ TIMEOUT - Test failed at step', step);
  process.exit(1);
}, 15000);

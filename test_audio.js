const WebSocket = require('ws');
const https = require('https');

const BASE = 'https://familycall-server-tpyh.onrender.com';
const WSS  = 'wss://familycall-server-tpyh.onrender.com';

function api(path, method='GET', body=null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = { method, headers: {'Content-Type':'application/json'} };
    const req = https.request(url, opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function connect(username, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSS}/ws?username=${username}&name=${name}`);
    const msgs = [];
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('message', d => msgs.push(JSON.parse(d)));
    ws.on('error', reject);
  });
}

function waitFor(msgs, type, timeout=5000) {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const check = setInterval(() => {
      const found = msgs.find(m => m.type === type);
      if (found) { clearInterval(check); resolve(found); }
      else if (Date.now() - t > timeout) { clearInterval(check); reject(new Error(`Timeout waiting for ${type}`)); }
    }, 50);
  });
}

function makePCM() {
  // 4096 bytes of fake PCM16 audio (sine wave)
  const buf = Buffer.alloc(4096);
  for (let i = 0; i < 2048; i++) {
    const v = Math.floor(Math.sin(i * 0.1) * 16000);
    buf.writeInt16LE(v, i * 2);
  }
  return buf.toString('base64');
}

async function run() {
  console.log('=== FamilyCall Audio Test ===\n');

  // 1. Reset
  const reset = await api('/api/reset');
  console.log('1. Reset:', reset.message);

  // 2. Register
  const r1 = await api('/api/register','POST',{username:'lappy',name:'Laptop',password:'123'});
  const r2 = await api('/api/register','POST',{username:'iphone',name:'iPhone',password:'123'});
  console.log('2. Register lappy:', r1.success ? 'OK' : r1.error);
  console.log('   Register iphone:', r2.success ? 'OK' : r2.error);

  // 3. Connect WebSockets
  const lappy  = await connect('lappy',  'Laptop');
  const iphone = await connect('iphone', 'iPhone');
  console.log('3. WebSocket lappy: connected');
  console.log('   WebSocket iphone: connected');
  await new Promise(r => setTimeout(r, 300));

  // 4. lappy calls iphone
  lappy.ws.send(JSON.stringify({type:'call', calleeUsername:'iphone'}));
  const created  = await waitFor(lappy.msgs,  'call_created');
  const incoming = await waitFor(iphone.msgs, 'incoming_call');
  const callId = created.callId;
  console.log('4. Call created:', callId);
  console.log('   iphone got incoming_call: caller =', incoming.callerName);

  // 5. iphone accepts
  iphone.ws.send(JSON.stringify({type:'accept_call', callId}));
  await waitFor(lappy.msgs, 'call_accepted');
  console.log('5. Call accepted - both sides connected');

  await new Promise(r => setTimeout(r, 200));

  // 6. lappy sends 10 audio chunks to iphone
  const pcm = makePCM();
  let lappySent = 0, iphoneSent = 0;

  for (let i = 0; i < 10; i++) {
    lappy.ws.send(JSON.stringify({type:'audio', callId, data:pcm, sampleRate:16000}));
    lappySent++;
    await new Promise(r => setTimeout(r, 80)); // 80ms apart like real audio
  }
  console.log('6. lappy sent', lappySent, 'audio chunks');

  // 7. iphone sends 10 audio chunks to lappy
  for (let i = 0; i < 10; i++) {
    iphone.ws.send(JSON.stringify({type:'audio', callId, data:pcm, sampleRate:16000}));
    iphoneSent++;
    await new Promise(r => setTimeout(r, 80));
  }
  console.log('7. iphone sent', iphoneSent, 'audio chunks');

  await new Promise(r => setTimeout(r, 500));

  // 8. Verify delivery
  const iphoneRxAudio = iphone.msgs.filter(m=>m.type==='audio').length;
  const lappyRxAudio  = lappy.msgs.filter(m=>m.type==='audio').length;
  console.log('\n=== RESULTS ===');
  console.log(`lappy  sent ${lappySent} → iphone received ${iphoneRxAudio} : ${iphoneRxAudio===lappySent ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`iphone sent ${iphoneSent} → lappy  received ${lappyRxAudio}  : ${lappyRxAudio===iphoneSent ? '✅ PASS' : '❌ FAIL'}`);

  // 9. End call
  lappy.ws.send(JSON.stringify({type:'end_call', callId}));
  await waitFor(iphone.msgs, 'call_ended', 3000);
  console.log('8. End call: ✅ iphone got call_ended');

  // 10. Check audio data integrity
  const sampleAudio = iphone.msgs.find(m=>m.type==='audio');
  if (sampleAudio) {
    const decoded = Buffer.from(sampleAudio.data, 'base64');
    const match = decoded.toString('base64') === pcm;
    console.log('9. Audio data integrity:', match ? '✅ PASS (data matches)' : '❌ FAIL (data corrupted)');
    console.log('   Received bytes:', decoded.length, '/ Expected:', 4096);
  }

  lappy.ws.close(); iphone.ws.close();
  console.log('\nTest complete.');

  const passed = iphoneRxAudio === lappySent && lappyRxAudio === iphoneSent;
  process.exit(passed ? 0 : 1);
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTO}//${location.host}`;
const HTTP_URL = location.origin;

let ws = null, currentCallId = null, timerInterval = null, seconds = 0;
let myUsername = '', myName = '', chatTarget = '', refreshInterval = null;

// ── Audio state ──
let audioCtx = null;          // single AudioContext (created on user gesture)
let micStream = null;
let mediaRecorder = null;
let audioStreamStarted = false;
let isMuted = false;

// Playback — AudioWorklet path (desktop) with ScriptProcessor fallback (mobile)
let workletNode = null;
let spNode = null;             // ScriptProcessor fallback
let pcmQueue = [];             // Float32Array chunks waiting to play
let workletReady = false;

// Ring tone
let ringOscillator = null;
let ringGain = null;

const $ = id => document.getElementById(id);

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
$('showRegister').onclick = e => { e.preventDefault(); $('loginPage').classList.add('hide'); $('registerPage').classList.remove('hide'); };
$('showLogin').onclick    = e => { e.preventDefault(); $('registerPage').classList.add('hide'); $('loginPage').classList.remove('hide'); };

$('loginBtn').onclick = () => {
  const u = $('loginUser').value.trim().toLowerCase(), p = $('loginPass').value;
  if (!u || !p) return alert('Enter username and password');
  $('loginBtn').textContent = 'Signing in...'; $('loginBtn').disabled = true;
  fetch(HTTP_URL + '/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u,password:p}) })
    .then(r => { if (!r.ok) return r.json().then(e=>{throw new Error(e.error||'Login failed');}); return r.json(); })
    .then(r => { localStorage.setItem('fc_user',r.user.username); localStorage.setItem('fc_name',r.user.name); connectApp(r.user.username,r.user.name); })
    .catch(e => { $('loginBtn').textContent='Sign In'; $('loginBtn').disabled=false; alert(e.message||'Connection error'); });
};

$('regBtn').onclick = () => {
  const u=$('regUser').value.trim().toLowerCase(), n=$('regName').value.trim(), p=$('regPass').value;
  if (!u||!n||!p) return alert('Fill all fields');
  if (u.includes(' ')) return alert('No spaces in username');
  $('regBtn').textContent='Creating...'; $('regBtn').disabled=true;
  fetch(HTTP_URL+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,name:n,password:p})})
    .then(r=>{if(!r.ok)return r.json().then(e=>{throw new Error(e.error||'Registration failed');});return r.json();})
    .then(()=>{ localStorage.setItem('fc_user',u); localStorage.setItem('fc_name',n); connectApp(u,n); })
    .catch(e=>{ $('regBtn').textContent='Create Account'; $('regBtn').disabled=false; alert(e.message||'Connection error'); });
};

$('logoutBtn').onclick = () => {
  localStorage.removeItem('fc_user'); localStorage.removeItem('fc_name');
  if (ws) ws.close();
  $('mainPage').classList.add('hide'); $('loginPage').classList.remove('hide');
  $('loginUser').value=''; $('loginPass').value='';
};

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
function connectApp(username, name) {
  myUsername=username; myName=name;
  $('myName').textContent=name; $('myUser').textContent=username;
  $('loginPage').classList.add('hide'); $('registerPage').classList.add('hide'); $('mainPage').classList.remove('hide');
  const url=`${WS_URL}/ws?username=${encodeURIComponent(username)}&name=${encodeURIComponent(name)}`;
  ws=new WebSocket(url);
  ws.onopen=()=>{ loadContacts(); refreshInterval=setInterval(loadContacts,5000); };
  ws.onmessage=e=>handleMsg(JSON.parse(e.data));
  ws.onclose=()=>{ if(refreshInterval)clearInterval(refreshInterval); setTimeout(()=>location.reload(),2000); };
}

function handleMsg(msg) {
  switch(msg.type) {
    case 'welcome': break;
    case 'pending_messages': loadChatContacts(); break;

    case 'incoming_call':
      if (currentCallId) { send({type:'reject_call',callId:msg.callId}); return; }
      currentCallId = msg.callId;
      $('incomingName').textContent = msg.callerName;
      $('incomingAvatarLetter').textContent = msg.callerName.charAt(0).toUpperCase();
      $('incomingPage').classList.remove('hide');
      $('mainPage').classList.add('hide');
      startRing();
      break;

    case 'call_created':
      currentCallId = msg.callId;
      $('callStatusText').textContent = 'Ringing...';
      $('callTimer').classList.add('hide');
      startAudioStream();
      break;

    case 'call_accepted':
      stopRing();
      $('callStatusText').textContent = 'Connected';
      $('callTimer').classList.remove('hide');
      startCallTimer();
      break;

    case 'call_rejected':
      stopRing(); endCallUI(); alert('Call was declined');
      break;

    case 'call_ended':
      stopRing(); endCallUI();
      break;

    case 'audio':
      if (currentCallId === msg.callId && msg.data) receiveAudio(msg.data);
      break;

    case 'chat':
      appendChatMsg(msg.from, msg.text, false); loadChatContacts();
      break;

    case 'chat_sent': break;
    case 'error': alert(msg.message); break;
  }
}

function send(obj) { if(ws&&ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

// ─────────────────────────────────────────────
// RING TONE (Web Audio beep — no file needed)
// ─────────────────────────────────────────────
function startRing() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    if (audioCtx.state==='suspended') audioCtx.resume();
    ringGain = audioCtx.createGain();
    ringGain.gain.value = 0.4;
    ringGain.connect(audioCtx.destination);
    let phase = 0;
    function beep() {
      if (!ringGain) return;
      ringOscillator = audioCtx.createOscillator();
      ringOscillator.type = 'sine';
      ringOscillator.frequency.value = phase===0 ? 480 : 440;
      ringOscillator.connect(ringGain);
      ringOscillator.start();
      ringOscillator.stop(audioCtx.currentTime + 0.4);
      ringOscillator.onended = () => {
        phase = 1 - phase;
        if (ringGain) setTimeout(beep, 200);
      };
    }
    beep();
  } catch(e) {}
}

function stopRing() {
  try { if(ringOscillator) { ringOscillator.onended=null; ringOscillator.stop(); } } catch(e) {}
  try { if(ringGain) ringGain.disconnect(); } catch(e) {}
  ringOscillator=null; ringGain=null;
}

// ─────────────────────────────────────────────
// AUDIO CONTEXT INIT (must be from user gesture)
// ─────────────────────────────────────────────
async function initAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)({ sampleRate: 16000 });
  if (audioCtx.state==='suspended') await audioCtx.resume();

  // Try AudioWorklet first (Chrome 66+, Firefox 76+)
  if (!workletReady && audioCtx.audioWorklet) {
    try {
      await audioCtx.audioWorklet.addModule('/js/audio-processor.js');
      workletNode = new AudioWorkletNode(audioCtx, 'pcm-player');
      workletNode.connect(audioCtx.destination);
      workletReady = true;
    } catch(e) {
      workletReady = false;
      setupScriptProcessorPlayback();
    }
  } else if (!workletReady) {
    setupScriptProcessorPlayback();
  }
}

// ScriptProcessor fallback for playback (older mobile browsers)
function setupScriptProcessorPlayback() {
  if (spNode) return;
  try {
    spNode = audioCtx.createScriptProcessor(2048, 0, 1);
    spNode.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      let written = 0;
      while (written < out.length && pcmQueue.length) {
        const chunk = pcmQueue[0];
        const avail = chunk.length;
        const need = out.length - written;
        if (avail <= need) {
          out.set(chunk, written);
          written += avail;
          pcmQueue.shift();
        } else {
          out.set(chunk.subarray(0, need), written);
          pcmQueue[0] = chunk.subarray(need);
          written = out.length;
        }
      }
      if (written < out.length) out.fill(0, written);
    };
    const silentSrc = audioCtx.createConstantSource();
    silentSrc.offset.value = 0;
    silentSrc.connect(spNode);
    spNode.connect(audioCtx.destination);
    silentSrc.start();
  } catch(e) {}
}

// ─────────────────────────────────────────────
// CAPTURE: MediaRecorder → PCM16 via AudioContext
// We decode MediaRecorder output → PCM16 → send
// This gives us raw PCM that ANY device can play back
// ─────────────────────────────────────────────
async function startAudioStream() {
  if (audioStreamStarted) return;
  audioStreamStarted = true;

  await initAudioCtx();

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000
      }
    });
  } catch(e) {
    alert('Microphone access denied: ' + e.message);
    audioStreamStarted = false;
    return;
  }

  // Use ScriptProcessor for capture — reads raw PCM from mic
  // This works on desktop. On mobile we fall back to MediaRecorder.
  let captureWorking = false;

  if (audioCtx.createScriptProcessor) {
    try {
      const src = audioCtx.createMediaStreamSource(micStream);
      const captureNode = audioCtx.createScriptProcessor(1024, 1, 1);
      captureNode.onaudioprocess = (e) => {
        if (isMuted || !currentCallId) return;
        const f32 = e.inputBuffer.getChannelData(0);
        // Check if we're actually getting audio (not silence from dead node)
        let hasSignal = false;
        for (let i = 0; i < f32.length; i += 64) { if (Math.abs(f32[i]) > 0.0001) { hasSignal = true; break; } }
        if (!hasSignal && captureWorking) return; // skip silence
        captureWorking = true;
        const pcm = floatToPCM16(f32);
        send({ type:'audio', callId:currentCallId, data: arrayBufferToBase64(pcm.buffer) });
      };
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      src.connect(captureNode);
      captureNode.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      // Check after 500ms if ScriptProcessor is firing
      setTimeout(() => {
        if (!captureWorking) {
          // ScriptProcessor not working (mobile) — fall back to MediaRecorder
          try { captureNode.disconnect(); src.disconnect(); } catch(e) {}
          startMediaRecorderCapture();
        }
      }, 500);
    } catch(e) {
      startMediaRecorderCapture();
    }
  } else {
    startMediaRecorderCapture();
  }
}

// MediaRecorder fallback capture (for mobile where ScriptProcessor fails)
function startMediaRecorderCapture() {
  if (!micStream) return;
  const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4',''];
  let mime = '';
  for (const t of types) {
    if (!t || (typeof MediaRecorder!=='undefined' && MediaRecorder.isTypeSupported(t))) { mime=t; break; }
  }
  try {
    mediaRecorder = new MediaRecorder(micStream, mime ? {mimeType:mime} : {});
  } catch(e) {
    mediaRecorder = new MediaRecorder(micStream);
  }

  // We decode each MediaRecorder chunk → PCM16 → send
  // This ensures receiver always gets raw PCM regardless of sender's codec
  const decodeCtx = new (window.AudioContext||window.webkitAudioContext)({ sampleRate: 16000 });

  mediaRecorder.ondataavailable = async (e) => {
    if (!e.data || e.data.size < 100 || !currentCallId || isMuted) return;
    try {
      const ab = await e.data.arrayBuffer();
      decodeCtx.decodeAudioData(ab.slice(0), (decoded) => {
        const f32 = decoded.getChannelData(0);
        // Resample to 16kHz if needed
        const resampled = resampleTo16k(f32, decoded.sampleRate);
        const pcm = floatToPCM16(resampled);
        send({ type:'audio', callId:currentCallId, data: arrayBufferToBase64(pcm.buffer) });
      }, () => {
        // decode failed — send raw with mime tag so receiver can try
        const bytes = new Uint8Array(ab);
        let s=''; for(let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]);
        send({ type:'audio', callId:currentCallId, mime: mediaRecorder.mimeType, data: btoa(s), raw:true });
      });
    } catch(e) {}
  };

  mediaRecorder.start(100);
}

// ─────────────────────────────────────────────
// PLAYBACK: receive PCM16 → play via AudioWorklet or ScriptProcessor
// ─────────────────────────────────────────────
function receiveAudio(b64) {
  if (!audioCtx || audioCtx.state === 'closed') return;
  if (audioCtx.state === 'suspended') { audioCtx.resume(); }

  try {
    const s = atob(b64);
    const buf = new ArrayBuffer(s.length);
    const view = new Uint8Array(buf);
    for (let i=0;i<s.length;i++) view[i]=s.charCodeAt(i);

    const int16 = new Int16Array(buf);
    const float32 = pcm16ToFloat(int16);

    if (workletReady && workletNode) {
      workletNode.port.postMessage({ type:'chunk', samples: float32 });
    } else {
      // Limit queue to avoid delay buildup (max 800ms of audio at 16kHz)
      const maxSamples = 16000 * 0.8;
      let total = pcmQueue.reduce((a,c)=>a+c.length,0);
      if (total < maxSamples) pcmQueue.push(float32);
    }
  } catch(e) {}
}

// ─────────────────────────────────────────────
// CALL UI
// ─────────────────────────────────────────────
function startCall(username, name) {
  initAudioCtx();
  $('callDisplayName').textContent = name;
  $('callAvatarLetter').textContent = name.charAt(0).toUpperCase();
  $('callStatusText').textContent = 'Calling...';
  $('callTimer').classList.add('hide');
  $('callingPage').classList.remove('hide');
  $('mainPage').classList.add('hide');
  audioStreamStarted = false;
  send({type:'call', calleeUsername:username});
  startCallTimer();
}

$('callEndBtn').onclick = () => {
  if (currentCallId) send({type:'end_call', callId:currentCallId});
  endCallUI();
};

$('acceptBtn').onclick = () => {
  if (!currentCallId||!ws) return;
  stopRing();
  initAudioCtx();
  send({type:'accept_call', callId:currentCallId});
  $('callDisplayName').textContent = $('incomingName').textContent;
  $('callAvatarLetter').textContent = $('incomingName').textContent.charAt(0).toUpperCase();
  $('callStatusText').textContent = 'Connected';
  $('callTimer').classList.remove('hide');
  $('incomingPage').classList.add('hide');
  $('callingPage').classList.remove('hide');
  startCallTimer();
  audioStreamStarted = false;
  startAudioStream();
};

$('declineBtn').onclick = () => {
  stopRing();
  if (currentCallId) send({type:'reject_call', callId:currentCallId});
  currentCallId = null;
  $('incomingPage').classList.add('hide');
  $('mainPage').classList.remove('hide');
};

$('muteBtn').onclick = function() {
  isMuted = !isMuted;
  if (mediaRecorder) {
    if (isMuted && mediaRecorder.state==='recording') mediaRecorder.pause();
    else if (!isMuted && mediaRecorder.state==='paused') mediaRecorder.resume();
  }
  this.querySelector('.ctrl-btn-circle').textContent = isMuted ? '🔇' : '🎙️';
  this.querySelector('span').textContent = isMuted ? 'Unmute' : 'Mute';
  this.classList.toggle('active', isMuted);
};

$('speakerBtn').onclick = function() { this.classList.toggle('active'); };

function endCallUI() {
  stopAudioStream();
  currentCallId = null;
  $('callingPage').classList.add('hide');
  $('incomingPage').classList.add('hide');
  $('mainPage').classList.remove('hide');
  loadContacts();
}

function stopAudioStream() {
  audioStreamStarted = false;

  // Stop capture
  if (mediaRecorder && mediaRecorder.state!=='inactive') { try { mediaRecorder.stop(); } catch(e) {} }
  mediaRecorder = null;
  if (micStream) { micStream.getTracks().forEach(t=>t.stop()); micStream=null; }

  // Clear playback queue immediately
  pcmQueue = [];
  if (workletNode) { try { workletNode.port.postMessage({type:'clear'}); } catch(e) {} }

  // Stop timer
  if (timerInterval) { clearInterval(timerInterval); timerInterval=null; }

  isMuted = false;
  const mb = $('muteBtn');
  if (mb) { mb.querySelector('.ctrl-btn-circle').textContent='🎙️'; mb.querySelector('span').textContent='Mute'; mb.classList.remove('active'); }
}

// ─────────────────────────────────────────────
// PCM HELPERS
// ─────────────────────────────────────────────
function floatToPCM16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i=0;i<f32.length;i++) {
    const s = Math.max(-1,Math.min(1,f32[i]));
    i16[i] = s<0 ? s*0x8000 : s*0x7FFF;
  }
  return i16;
}

function pcm16ToFloat(i16) {
  const f32 = new Float32Array(i16.length);
  for (let i=0;i<i16.length;i++) f32[i] = i16[i] / (i16[i]<0 ? 0x8000 : 0x7FFF);
  return f32;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s=''; for(let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]);
  return btoa(s);
}

function resampleTo16k(f32, fromRate) {
  if (fromRate === 16000) return f32;
  const ratio = fromRate / 16000;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i=0;i<outLen;i++) out[i] = f32[Math.floor(i*ratio)];
  return out;
}

// ─────────────────────────────────────────────
// TIMER
// ─────────────────────────────────────────────
function startCallTimer() {
  seconds=0;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(()=>{
    seconds++;
    $('callTimer').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  },1000);
}

// ─────────────────────────────────────────────
// CONTACTS
// ─────────────────────────────────────────────
async function loadContacts() {
  const users = await fetch(HTTP_URL+'/api/users').then(r=>r.json());
  const others = users.filter(u=>u.username!==myUsername);
  const list = $('contactsList');
  if (!others.length) { list.innerHTML=''; $('noContacts').classList.remove('hide'); return; }
  $('noContacts').classList.add('hide');
  list.innerHTML = others.map(u=>`
    <div class="contact-item">
      <div class="contact-avatar">${u.name.charAt(0).toUpperCase()}<span class="status-dot ${u.online?'dot-on':'dot-off'}"></span></div>
      <div class="contact-info">
        <div class="contact-name">${u.name}</div>
        <div class="contact-user">@${u.username} · ${u.online?'Online':'Offline'}</div>
      </div>
      <div class="contact-actions">
        <button class="action-btn chat-btn-sm" onclick="openChat('${u.username}','${u.name}')">💬</button>
        <button class="action-btn call-btn" onclick="startCall('${u.username}','${u.name}')">📞</button>
      </div>
    </div>`).join('');
  loadChatContacts();
}

$('callUserBtn').onclick = ()=>{ const u=$('searchUser').value.trim().toLowerCase(); if(u) startCall(u,u); };
$('searchUser').onkeydown = e=>{ if(e.key==='Enter') $('callUserBtn').click(); };

// ─────────────────────────────────────────────
// TABS
// ─────────────────────────────────────────────
$('tabContacts').onclick = function(){ $('tabContacts').classList.add('active'); $('tabChat').classList.remove('active'); $('contactsView').classList.remove('hide'); $('chatView').classList.add('hide'); loadContacts(); };
$('tabChat').onclick = function(){ $('tabChat').classList.add('active'); $('tabContacts').classList.remove('active'); $('contactsView').classList.add('hide'); $('chatView').classList.remove('hide'); loadChatContacts(); };

// ─────────────────────────────────────────────
// CHAT
// ─────────────────────────────────────────────
function loadChatContacts() {
  fetch(HTTP_URL+'/api/users').then(r=>r.json()).then(users=>{
    const others=users.filter(u=>u.username!==myUsername);
    fetch(HTTP_URL+'/api/messages/'+myUsername).then(r=>r.json()).then(data=>{
      $('chatContactsList').innerHTML=others.map(u=>`
        <div class="contact-item" onclick="openChat('${u.username}','${u.name}')">
          <div class="contact-avatar" style="background:#5c6bc0">${u.name.charAt(0).toUpperCase()}</div>
          <div class="contact-info"><div class="contact-name">${u.name}</div><div class="contact-user">${data[u.username]?data[u.username].length+' messages':'Start a conversation'}</div></div>
          <div style="color:#5f6368;font-size:20px">›</div>
        </div>`).join('');
    });
  });
}

function openChat(username,name) {
  chatTarget=username; $('chatWith').textContent=name||('@'+username);
  $('chatListView').classList.add('hide'); $('chatAreaView').classList.remove('hide');
  fetch(HTTP_URL+'/api/messages/'+myUsername).then(r=>r.json()).then(data=>{
    $('chatMessages').innerHTML=(data[username]||[]).map(m=>`<div class="chat-msg ${m.from===myUsername?'chat-mine':'chat-other'}">${m.text}</div>`).join('');
    $('chatMessages').scrollTop=$('chatMessages').scrollHeight;
  });
  $('chatInput').focus();
}

function closeChatArea() { $('chatAreaView').classList.add('hide'); $('chatListView').classList.remove('hide'); chatTarget=''; }

$('chatSendBtn').onclick=()=>{ const t=$('chatInput').value.trim(); if(!t||!chatTarget)return; send({type:'chat',to:chatTarget,text:t}); appendChatMsg(myUsername,t,true); $('chatInput').value=''; };
$('chatInput').onkeydown=e=>{ if(e.key==='Enter') $('chatSendBtn').click(); };

function appendChatMsg(from,text,mine) {
  if(!mine&&chatTarget!==from)return;
  const div=document.createElement('div');
  div.className='chat-msg '+(mine?'chat-mine':'chat-other');
  div.textContent=text;
  $('chatMessages').appendChild(div);
  $('chatMessages').scrollTop=$('chatMessages').scrollHeight;
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
(async function init() {
  const savedUser=localStorage.getItem('fc_user'), savedName=localStorage.getItem('fc_name');
  if (savedUser&&savedName) {
    try {
      const r=await fetch(HTTP_URL+'/api/user/'+savedUser);
      if(r.ok){connectApp(savedUser,savedName);}
      else{localStorage.removeItem('fc_user');localStorage.removeItem('fc_name');}
    } catch(e){localStorage.removeItem('fc_user');localStorage.removeItem('fc_name');}
  }
})();

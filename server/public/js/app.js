const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTO}//${location.host}`;
const HTTP_URL = location.origin;

let ws = null, currentCallId = null, timerInterval = null, seconds = 0;
let myUsername = '', myName = '', chatTarget = '', refreshInterval = null;

// ── Audio ──
let micStream = null;
let mediaRecorder = null;
let audioStreamStarted = false;
let isMuted = false;

// Playback
let playCtx = null;           // AudioContext for playback — created on user gesture
let nextPlayTime = 0;         // scheduled playback cursor
let decoding = false;
let decodeQueue = [];         // {mime, ab} waiting to decode

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
      if (currentCallId === msg.callId && msg.data) {
        receiveAudio(msg.mime || 'audio/webm', msg.data);
      }
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
// RING
// ─────────────────────────────────────────────
let ringCtx = null, ringGain = null, ringOsc = null, ringing = false;

function startRing() {
  if (ringing) return;
  ringing = true;
  try {
    ringCtx = new (window.AudioContext||window.webkitAudioContext)();
    ringGain = ringCtx.createGain();
    ringGain.gain.value = 0.35;
    ringGain.connect(ringCtx.destination);
    let hi = true;
    function pulse() {
      if (!ringing) return;
      ringOsc = ringCtx.createOscillator();
      ringOsc.type = 'sine';
      ringOsc.frequency.value = hi ? 480 : 420;
      ringOsc.connect(ringGain);
      ringOsc.start();
      ringOsc.stop(ringCtx.currentTime + 0.35);
      ringOsc.onended = () => { hi=!hi; if(ringing) setTimeout(pulse, 180); };
    }
    pulse();
  } catch(e) {}
}

function stopRing() {
  ringing = false;
  try { if(ringOsc){ringOsc.onended=null;ringOsc.stop();} } catch(e) {}
  try { if(ringGain) ringGain.disconnect(); } catch(e) {}
  try { if(ringCtx) ringCtx.close(); } catch(e) {}
  ringCtx=null; ringGain=null; ringOsc=null;
}

// ─────────────────────────────────────────────
// PLAYBACK CONTEXT — created on user gesture
// ─────────────────────────────────────────────
function ensurePlayCtx() {
  if (!playCtx || playCtx.state === 'closed') {
    playCtx = new (window.AudioContext||window.webkitAudioContext)();
    nextPlayTime = 0;
  }
  if (playCtx.state === 'suspended') playCtx.resume();
}

// ─────────────────────────────────────────────
// CAPTURE — MediaRecorder (works on ALL devices)
// ─────────────────────────────────────────────
function getSupportedMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const list = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    ''
  ];
  for (const t of list) {
    if (!t || MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

async function startAudioStream() {
  if (audioStreamStarted) return;
  audioStreamStarted = true;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });
  } catch(e) {
    alert('Microphone access denied: ' + e.message);
    audioStreamStarted = false;
    return;
  }

  const mime = getSupportedMime();
  try {
    mediaRecorder = mime
      ? new MediaRecorder(micStream, {mimeType: mime})
      : new MediaRecorder(micStream);
  } catch(e) {
    mediaRecorder = new MediaRecorder(micStream);
  }

  const actualMime = mediaRecorder.mimeType || mime || 'audio/webm';

  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || e.data.size < 50 || !currentCallId || isMuted) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      // reader.result is "data:<mime>;base64,<data>"
      const b64 = reader.result.split(',')[1];
      if (b64) send({ type:'audio', callId:currentCallId, mime:actualMime, data:b64 });
    };
    reader.readAsDataURL(e.data);
  };

  mediaRecorder.start(80); // 80ms chunks
}

function stopAudioStream() {
  audioStreamStarted = false;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch(e) {}
  }
  mediaRecorder = null;
  if (micStream) { micStream.getTracks().forEach(t=>t.stop()); micStream=null; }

  // Clear decode queue & reset playback
  decodeQueue = [];
  decoding = false;
  nextPlayTime = 0;

  if (timerInterval) { clearInterval(timerInterval); timerInterval=null; }
  isMuted = false;
  const mb = $('muteBtn');
  if (mb) {
    mb.querySelector('.ctrl-btn-circle').textContent = '🎙️';
    mb.querySelector('span').textContent = 'Mute';
    mb.classList.remove('active');
  }
}

// ─────────────────────────────────────────────
// PLAYBACK — decodeAudioData + scheduled play
// ─────────────────────────────────────────────
function receiveAudio(mime, b64) {
  if (!playCtx || playCtx.state === 'closed') return;
  if (playCtx.state === 'suspended') { playCtx.resume(); }

  // Convert base64 → ArrayBuffer
  let ab;
  try {
    const s = atob(b64);
    ab = new ArrayBuffer(s.length);
    const v = new Uint8Array(ab);
    for (let i=0;i<s.length;i++) v[i]=s.charCodeAt(i);
  } catch(e) { return; }

  // Limit queue to avoid delay buildup (max 5 chunks)
  if (decodeQueue.length > 5) decodeQueue.shift();
  decodeQueue.push({mime, ab});

  if (!decoding) drainDecodeQueue();
}

function drainDecodeQueue() {
  if (!decodeQueue.length || !playCtx || playCtx.state==='closed') {
    decoding = false;
    return;
  }
  decoding = true;
  const item = decodeQueue.shift();

  playCtx.decodeAudioData(
    item.ab,
    (decoded) => {
      const now = playCtx.currentTime;
      // If we've fallen behind, reset schedule to now + small buffer
      if (nextPlayTime < now) nextPlayTime = now + 0.04;

      const src = playCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(playCtx.destination);
      src.start(nextPlayTime);
      nextPlayTime += decoded.duration;

      // Decode next chunk after this one starts
      const delay = Math.max(0, (nextPlayTime - playCtx.currentTime - decoded.duration) * 1000);
      setTimeout(drainDecodeQueue, Math.min(delay, 20));
    },
    () => {
      // Decode failed — skip and try next
      drainDecodeQueue();
    }
  );
}

// ─────────────────────────────────────────────
// CALL UI
// ─────────────────────────────────────────────
function startCall(username, name) {
  ensurePlayCtx();
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
  ensurePlayCtx();
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
    try {
      if (isMuted && mediaRecorder.state==='recording') mediaRecorder.pause();
      else if (!isMuted && mediaRecorder.state==='paused') mediaRecorder.resume();
    } catch(e) {}
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

// ─────────────────────────────────────────────
// TIMER
// ─────────────────────────────────────────────
function startCallTimer() {
  seconds=0;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval=setInterval(()=>{
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
$('tabContacts').onclick = function(){
  $('tabContacts').classList.add('active'); $('tabChat').classList.remove('active');
  $('contactsView').classList.remove('hide'); $('chatView').classList.add('hide');
  loadContacts();
};
$('tabChat').onclick = function(){
  $('tabChat').classList.add('active'); $('tabContacts').classList.remove('active');
  $('contactsView').classList.add('hide'); $('chatView').classList.remove('hide');
  loadChatContacts();
};

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
          <div class="contact-info"><div class="contact-name">${u.name}</div>
          <div class="contact-user">${data[u.username]?data[u.username].length+' messages':'Start a conversation'}</div></div>
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
      if(r.ok) connectApp(savedUser,savedName);
      else { localStorage.removeItem('fc_user'); localStorage.removeItem('fc_name'); }
    } catch(e) { localStorage.removeItem('fc_user'); localStorage.removeItem('fc_name'); }
  }
})();

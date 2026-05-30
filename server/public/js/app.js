'use strict';
const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL   = `${WS_PROTO}//${location.host}`;
const HTTP_URL = location.origin;

let ws = null, currentCallId = null, timerInterval = null, seconds = 0;
let myUsername = '', myName = '', chatTarget = '', refreshInterval = null;

/* ── Audio ── */
let micStream        = null;
let mediaRecorder    = null;
let audioStarted     = false;
let isMuted          = false;

/* Playback */
let mimeForPlayback  = '';
let blobQueue = [], blobPlaying = false;

/* Ring */
let ringCtx = null, ringGain = null, ringOsc = null, ringing = false;

const $ = id => document.getElementById(id);

/* ── Server-side logger ── */
function slog(event, data) {
  if (!myUsername) return;
  fetch(`${HTTP_URL}/api/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: myUsername, event, data })
  }).catch(() => {});
}

/* ═══════════════════════════════════════════
   AUTH
═══════════════════════════════════════════ */
$('showRegister').onclick = e => { e.preventDefault(); $('loginPage').classList.add('hide'); $('registerPage').classList.remove('hide'); };
$('showLogin').onclick    = e => { e.preventDefault(); $('registerPage').classList.add('hide'); $('loginPage').classList.remove('hide'); };

$('loginBtn').onclick = () => {
  const u = $('loginUser').value.trim().toLowerCase(), p = $('loginPass').value;
  if (!u || !p) return alert('Enter username and password');
  $('loginBtn').textContent = 'Signing in…'; $('loginBtn').disabled = true;
  fetch(`${HTTP_URL}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u,password:p}) })
    .then(r => r.ok ? r.json() : r.json().then(e=>{throw new Error(e.error||'Login failed');}))
    .then(r => { localStorage.setItem('fc_user',r.user.username); localStorage.setItem('fc_name',r.user.name); connectApp(r.user.username,r.user.name); })
    .catch(e => { $('loginBtn').textContent='Sign In'; $('loginBtn').disabled=false; alert(e.message); });
};

$('regBtn').onclick = () => {
  const u=$('regUser').value.trim().toLowerCase(), n=$('regName').value.trim(), p=$('regPass').value;
  if (!u||!n||!p) return alert('Fill all fields');
  if (u.includes(' ')) return alert('No spaces in username');
  $('regBtn').textContent='Creating…'; $('regBtn').disabled=true;
  fetch(`${HTTP_URL}/api/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,name:n,password:p})})
    .then(r => r.ok ? r.json() : r.json().then(e=>{throw new Error(e.error||'Registration failed');}))
    .then(()=>{ localStorage.setItem('fc_user',u); localStorage.setItem('fc_name',n); connectApp(u,n); })
    .catch(e=>{ $('regBtn').textContent='Create Account'; $('regBtn').disabled=false; alert(e.message); });
};

$('logoutBtn').onclick = () => {
  localStorage.removeItem('fc_user'); localStorage.removeItem('fc_name');
  if (ws) ws.close();
  $('mainPage').classList.add('hide'); $('loginPage').classList.remove('hide');
  $('loginUser').value=''; $('loginPass').value='';
};

/* ═══════════════════════════════════════════
   WEBSOCKET
═══════════════════════════════════════════ */
function connectApp(username, name) {
  myUsername=username; myName=name;
  $('myName').textContent=name; $('myUser').textContent=username;
  $('loginPage').classList.add('hide'); $('registerPage').classList.add('hide'); $('mainPage').classList.remove('hide');
  ws = new WebSocket(`${WS_URL}/ws?username=${encodeURIComponent(username)}&name=${encodeURIComponent(name)}`);
  ws.onopen  = () => { loadContacts(); refreshInterval=setInterval(loadContacts,5000); };
  ws.onmessage = e => handleMsg(JSON.parse(e.data));
  ws.onclose = () => { if(refreshInterval)clearInterval(refreshInterval); setTimeout(()=>location.reload(),2000); };
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
      $('callStatusText').textContent = 'Ringing…';
      $('callTimer').classList.add('hide');
      startCapture();
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
      if (currentCallId === msg.callId && msg.data)
        playChunk(msg.mime, msg.data);
      break;

    case 'chat':
      appendChatMsg(msg.from,msg.text,false); loadChatContacts();
      break;

    case 'error': alert(msg.message); break;
  }
}

function send(obj) { if(ws&&ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

/* ═══════════════════════════════════════════
   RING
═══════════════════════════════════════════ */
function startRing() {
  if (ringing) return; ringing=true;
  try {
    ringCtx  = new (window.AudioContext||window.webkitAudioContext)();
    ringGain = ringCtx.createGain(); ringGain.gain.value=0.35; ringGain.connect(ringCtx.destination);
    let hi=true;
    (function pulse(){
      if(!ringing)return;
      ringOsc=ringCtx.createOscillator(); ringOsc.type='sine'; ringOsc.frequency.value=hi?480:420;
      ringOsc.connect(ringGain); ringOsc.start(); ringOsc.stop(ringCtx.currentTime+0.35);
      ringOsc.onended=()=>{hi=!hi; if(ringing)setTimeout(pulse,180);};
    })();
  } catch(e){}
}
function stopRing() {
  ringing=false;
  try{if(ringOsc){ringOsc.onended=null;ringOsc.stop();}}catch(e){}
  try{if(ringGain)ringGain.disconnect();}catch(e){}
  try{if(ringCtx)ringCtx.close();}catch(e){}
  ringCtx=null;ringGain=null;ringOsc=null;
}

/* ═══════════════════════════════════════════
   CAPTURE  (MediaRecorder → base64 → WS)
═══════════════════════════════════════════ */
function getBestMime() {
  if (typeof MediaRecorder==='undefined') return '';
  for (const t of ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4',''])
    if (!t||MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

async function startCapture() {
  if (audioStarted) return;
  audioStarted = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1 }
    });
  } catch(e) { alert('Mic denied: '+e.message); audioStarted=false; slog('mic_denied',{err:e.message}); return; }

  const mime = getBestMime();
  slog('mic_ok', { mime, ua: navigator.userAgent.substring(0,80) });

  try { mediaRecorder = mime ? new MediaRecorder(micStream,{mimeType:mime}) : new MediaRecorder(micStream); }
  catch(e) { mediaRecorder = new MediaRecorder(micStream); }

  const actualMime = mediaRecorder.mimeType || mime || 'audio/webm';
  slog('recorder_start', { actualMime });

  let chunkCount = 0;
  mediaRecorder.ondataavailable = e => {
    if (!e.data||e.data.size<50||!currentCallId||isMuted) return;
    chunkCount++;
    const reader = new FileReader();
    reader.onloadend = () => {
      const b64 = reader.result.split(',')[1];
      if (b64) {
        if (chunkCount <= 3 || chunkCount % 20 === 0)
          slog('chunk_sent', { n: chunkCount, size: e.data.size, mime: actualMime });
        send({type:'audio', callId:currentCallId, mime:actualMime, data:b64});
      }
    };
    reader.readAsDataURL(e.data);
  };
  mediaRecorder.start(100);
}

function stopCapture() {
  audioStarted=false;
  if (mediaRecorder&&mediaRecorder.state!=='inactive') try{mediaRecorder.stop();}catch(e){}
  mediaRecorder=null;
  if (micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null;}
}

/* ═══════════════════════════════════════════
   PLAYBACK — Blob <audio> (universal)
   Each chunk → Blob → objectURL → new Audio → play()
   Queued so chunks don't overlap
═══════════════════════════════════════════ */
let rxCount = 0;

function playChunk(mime, b64) {
  rxCount++;
  if (rxCount <= 3 || rxCount % 20 === 0)
    slog('chunk_recv', { n: rxCount, mime, b64len: b64.length });

  let ab;
  try {
    const s = atob(b64);
    ab = new ArrayBuffer(s.length);
    const v = new Uint8Array(ab);
    for (let i=0;i<s.length;i++) v[i]=s.charCodeAt(i);
  } catch(e) { slog('b64_fail',{err:e.message}); return; }

  // Keep queue small to avoid delay buildup
  if (blobQueue.length > 4) {
    slog('queue_drop', { qlen: blobQueue.length });
    blobQueue = blobQueue.slice(-2);
  }
  blobQueue.push({mime: mime||'audio/webm', ab});
  if (!blobPlaying) nextBlob();
}

function nextBlob() {
  if (!blobQueue.length) { blobPlaying=false; return; }
  blobPlaying = true;
  const item = blobQueue.shift();
  const blob = new Blob([item.ab], {type: item.mime});
  const url  = URL.createObjectURL(blob);
  const a    = new Audio(url);
  a.onended  = () => { URL.revokeObjectURL(url); nextBlob(); };
  a.onerror  = (e) => { slog('play_err',{mime:item.mime,err:String(e)}); URL.revokeObjectURL(url); nextBlob(); };
  a.play()
    .then(() => { if (rxCount <= 3) slog('play_ok',{mime:item.mime}); })
    .catch(e => { slog('play_blocked',{err:e.message,mime:item.mime}); URL.revokeObjectURL(url); nextBlob(); });
}

function cleanupPlayback() {
  blobQueue=[]; blobPlaying=false; rxCount=0; mimeForPlayback='';
}

/* ═══════════════════════════════════════════
   CALL UI
═══════════════════════════════════════════ */
function startCall(username, name) {
  $('callDisplayName').textContent=name;
  $('callAvatarLetter').textContent=name.charAt(0).toUpperCase();
  $('callStatusText').textContent='Calling…';
  $('callTimer').classList.add('hide');
  $('callingPage').classList.remove('hide');
  $('mainPage').classList.add('hide');
  audioStarted=false;
  send({type:'call',calleeUsername:username});
  startCallTimer();
}

$('callEndBtn').onclick = () => {
  if (currentCallId) send({type:'end_call',callId:currentCallId});
  endCallUI();
};

$('acceptBtn').onclick = () => {
  if (!currentCallId||!ws) return;
  stopRing();
  send({type:'accept_call',callId:currentCallId});
  $('callDisplayName').textContent=$('incomingName').textContent;
  $('callAvatarLetter').textContent=$('incomingName').textContent.charAt(0).toUpperCase();
  $('callStatusText').textContent='Connected';
  $('callTimer').classList.remove('hide');
  $('incomingPage').classList.add('hide');
  $('callingPage').classList.remove('hide');
  startCallTimer();
  audioStarted=false;
  startCapture();
};

$('declineBtn').onclick = () => {
  stopRing();
  if (currentCallId) send({type:'reject_call',callId:currentCallId});
  currentCallId=null;
  $('incomingPage').classList.add('hide');
  $('mainPage').classList.remove('hide');
};

$('muteBtn').onclick = function(){
  isMuted=!isMuted;
  if(mediaRecorder){
    try{ isMuted&&mediaRecorder.state==='recording'?mediaRecorder.pause():!isMuted&&mediaRecorder.state==='paused'?mediaRecorder.resume():null; }catch(e){}
  }
  this.querySelector('.ctrl-btn-circle').textContent=isMuted?'🔇':'🎙️';
  this.querySelector('span').textContent=isMuted?'Unmute':'Mute';
  this.classList.toggle('active',isMuted);
};

$('speakerBtn').onclick=function(){this.classList.toggle('active');};

function endCallUI() {
  stopCapture();
  cleanupPlayback();
  currentCallId=null;
  if(timerInterval){clearInterval(timerInterval);timerInterval=null;}
  isMuted=false;
  const mb=$('muteBtn');
  if(mb){mb.querySelector('.ctrl-btn-circle').textContent='🎙️';mb.querySelector('span').textContent='Mute';mb.classList.remove('active');}
  $('callingPage').classList.add('hide');
  $('incomingPage').classList.add('hide');
  $('mainPage').classList.remove('hide');
  loadContacts();
}

/* ═══════════════════════════════════════════
   TIMER
═══════════════════════════════════════════ */
function startCallTimer(){
  seconds=0; if(timerInterval)clearInterval(timerInterval);
  timerInterval=setInterval(()=>{seconds++;$('callTimer').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;},1000);
}

/* ═══════════════════════════════════════════
   CONTACTS
═══════════════════════════════════════════ */
async function loadContacts(){
  const users=await fetch(`${HTTP_URL}/api/users`).then(r=>r.json());
  const others=users.filter(u=>u.username!==myUsername);
  const list=$('contactsList');
  if(!others.length){list.innerHTML='';$('noContacts').classList.remove('hide');return;}
  $('noContacts').classList.add('hide');
  list.innerHTML=others.map(u=>`
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

$('callUserBtn').onclick=()=>{const u=$('searchUser').value.trim().toLowerCase();if(u)startCall(u,u);};
$('searchUser').onkeydown=e=>{if(e.key==='Enter')$('callUserBtn').click();};

/* ═══════════════════════════════════════════
   TABS
═══════════════════════════════════════════ */
$('tabContacts').onclick=function(){$('tabContacts').classList.add('active');$('tabChat').classList.remove('active');$('contactsView').classList.remove('hide');$('chatView').classList.add('hide');loadContacts();};
$('tabChat').onclick=function(){$('tabChat').classList.add('active');$('tabContacts').classList.remove('active');$('contactsView').classList.add('hide');$('chatView').classList.remove('hide');loadChatContacts();};

/* ═══════════════════════════════════════════
   CHAT
═══════════════════════════════════════════ */
function loadChatContacts(){
  fetch(`${HTTP_URL}/api/users`).then(r=>r.json()).then(users=>{
    const others=users.filter(u=>u.username!==myUsername);
    fetch(`${HTTP_URL}/api/messages/${myUsername}`).then(r=>r.json()).then(data=>{
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

function openChat(username,name){
  chatTarget=username;$('chatWith').textContent=name||('@'+username);
  $('chatListView').classList.add('hide');$('chatAreaView').classList.remove('hide');
  fetch(`${HTTP_URL}/api/messages/${myUsername}`).then(r=>r.json()).then(data=>{
    $('chatMessages').innerHTML=(data[username]||[]).map(m=>`<div class="chat-msg ${m.from===myUsername?'chat-mine':'chat-other'}">${m.text}</div>`).join('');
    $('chatMessages').scrollTop=$('chatMessages').scrollHeight;
  });
  $('chatInput').focus();
}

function closeChatArea(){$('chatAreaView').classList.add('hide');$('chatListView').classList.remove('hide');chatTarget='';}

$('chatSendBtn').onclick=()=>{const t=$('chatInput').value.trim();if(!t||!chatTarget)return;send({type:'chat',to:chatTarget,text:t});appendChatMsg(myUsername,t,true);$('chatInput').value='';};
$('chatInput').onkeydown=e=>{if(e.key==='Enter')$('chatSendBtn').click();};

function appendChatMsg(from,text,mine){
  if(!mine&&chatTarget!==from)return;
  const div=document.createElement('div');
  div.className='chat-msg '+(mine?'chat-mine':'chat-other');
  div.textContent=text;
  $('chatMessages').appendChild(div);
  $('chatMessages').scrollTop=$('chatMessages').scrollHeight;
}

/* ═══════════════════════════════════════════
   INIT
═══════════════════════════════════════════ */
(async()=>{
  const u=localStorage.getItem('fc_user'),n=localStorage.getItem('fc_name');
  if(u&&n){
    try{const r=await fetch(`${HTTP_URL}/api/user/${u}`);if(r.ok)connectApp(u,n);else{localStorage.removeItem('fc_user');localStorage.removeItem('fc_name');}}
    catch(e){localStorage.removeItem('fc_user');localStorage.removeItem('fc_name');}
  }
})();

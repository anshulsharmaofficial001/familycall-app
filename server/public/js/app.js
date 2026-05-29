const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTO}//${location.host}`;
const HTTP_URL = location.origin;

let ws = null, currentCallId = null, timerInterval = null, seconds = 0;
let micStream = null, audioRecorder = null, audioCtx = null, audioQ = [], playing = false;
let myUsername = '', myName = '', chatTarget = '', refreshInterval = null;

// DOM refs
const $ = id => document.getElementById(id);
const loginPage = $('loginPage'), registerPage = $('registerPage'), mainPage = $('mainPage');
const callingPage = $('callingPage'), incomingPage = $('incomingPage');
const contactsList = $('contactsList'), chatContactsList = $('chatContactsList'), chatMessages = $('chatMessages');

// === Auth ===
$('showRegister').onclick = e => { e.preventDefault(); loginPage.classList.add('hide'); registerPage.classList.remove('hide'); };
$('showLogin').onclick = e => { e.preventDefault(); registerPage.classList.add('hide'); loginPage.classList.remove('hide'); };

$('loginBtn').onclick = () => {
  const u = $('loginUser').value.trim().toLowerCase(), p = $('loginPass').value;
  if (!u || !p) return alert('Enter username and password');
  $('loginBtn').textContent = 'Signing in...'; $('loginBtn').disabled = true;
  fetch(HTTP_URL + '/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u, password:p}) })
    .then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error || 'Login failed'); }); return r.json(); })
    .then(r => {
      localStorage.setItem('fc_user', r.user.username); localStorage.setItem('fc_name', r.user.name);
      connectApp(r.user.username, r.user.name);
    })
    .catch(e => { $('loginBtn').textContent = 'Sign In'; $('loginBtn').disabled = false; alert(e.message || 'Connection error'); });
};

$('regBtn').onclick = () => {
  const u = $('regUser').value.trim().toLowerCase(), n = $('regName').value.trim(), p = $('regPass').value;
  if (!u || !n || !p) return alert('Fill all fields');
  if (u.includes(' ')) return alert('No spaces in username');
  $('regBtn').textContent = 'Creating...'; $('regBtn').disabled = true;
  fetch(HTTP_URL + '/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:u, name:n, password:p}) })
    .then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error || 'Registration failed'); }); return r.json(); })
    .then(r => {
      localStorage.setItem('fc_user', u); localStorage.setItem('fc_name', n);
      connectApp(u, n);
    })
    .catch(e => { $('regBtn').textContent = 'Create Account'; $('regBtn').disabled = false; alert(e.message || 'Connection error'); });
};

$('logoutBtn').onclick = () => {
  localStorage.removeItem('fc_user'); localStorage.removeItem('fc_name');
  if (ws) ws.close();
  mainPage.classList.add('hide'); loginPage.classList.remove('hide');
  $('loginUser').value = ''; $('loginPass').value = '';
};

// === WebSocket ===
function connectApp(username, name) {
  myUsername = username; myName = name;
  $('myName').textContent = name; $('myUser').textContent = username;
  loginPage.classList.add('hide'); registerPage.classList.add('hide'); mainPage.classList.remove('hide');

  const url = `${WS_URL}/ws?username=${encodeURIComponent(username)}&name=${encodeURIComponent(name)}`;
  ws = new WebSocket(url);
  ws.onopen = () => { loadContacts(); refreshInterval = setInterval(loadContacts, 5000); };
  ws.onmessage = e => handleMsg(JSON.parse(e.data));
  ws.onclose = () => { if (refreshInterval) clearInterval(refreshInterval); setTimeout(() => location.reload(), 2000); };
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'welcome': break;
    case 'pending_messages': loadChatContacts(); break;
    case 'incoming_call':
      if (currentCallId) { send({type:'reject_call', callId:msg.callId}); return; }
      currentCallId = msg.callId;
      $('incomingName').textContent = msg.callerName;
      incomingPage.classList.remove('hide'); mainPage.classList.add('hide');
      break;
    case 'call_created':
      currentCallId = msg.callId;
      $('callStatusText').textContent = 'Ringing...';
      callingPage.classList.remove('hide'); mainPage.classList.add('hide');
      startCallTimer();
      break;
    case 'call_accepted':
      $('callStatusText').textContent = 'Connected';
      console.log('Call accepted, starting audio stream...');
      startAudioStream();
      break;
    case 'call_rejected':
      endCallUI(); alert('Call rejected');
      break;
    case 'call_ended':
      endCallUI();
      break;
    case 'audio':
        if (currentCallId === msg.callId && msg.data) { if (audioQ.length < 50) audioQ.push(msg.data); if (!playing) playNext(); }
        break;
    case 'chat':
      appendChatMsg(msg.from, msg.text, false);
      loadChatContacts();
      break;
    case 'chat_sent':
      break;
    case 'error': alert(msg.message); break;
  }
}

function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

// === Contacts ===
async function loadContacts() {
  const r = await fetch(HTTP_URL + '/api/users').then(r=>r.json());
  const others = r.filter(u => u.username !== myUsername);
  contactsList.innerHTML = others.map(u =>
    `<li>
      <span><span class="dot ${u.online?'dot-on':'dot-off'}"></span><span class="name">${u.name}</span> <span style="opacity:.6;font-size:13px">@${u.username}</span></span>
      <span>
        <button class="btn-small" onclick="event.stopPropagation();openChat('${u.username}')">💬</button>
        <button class="btn-small" onclick="event.stopPropagation();startCall('${u.username}','${u.name}')" style="margin-left:6px">📞</button>
      </span>
    </li>`
  ).join('');
  $('noContacts').style.display = others.length ? 'none' : 'block';
  loadChatContacts();
}

$('callUserBtn').onclick = () => {
  const u = $('searchUser').value.trim().toLowerCase();
  if (u) startCall(u, u);
};

$('searchUser').onkeydown = e => { if (e.key === 'Enter') $('callUserBtn').click(); };

// === Call ===
function startCall(username, name) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  $('callDisplayName').textContent = name;
  $('callStatusText').textContent = 'Calling...';
  callingPage.classList.remove('hide'); mainPage.classList.add('hide');
  currentCallId = 'calling_' + Date.now();
  send({type:'call', calleeUsername: username});
  startCallTimer();
}

$('callEndBtn').onclick = () => { if (currentCallId) send({type:'end_call', callId: currentCallId}); endCallUI(); };

$('acceptBtn').onclick = () => {
  if (currentCallId && ws) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    send({type:'accept_call', callId: currentCallId});
    $('callDisplayName').textContent = $('incomingName').textContent;
    $('callStatusText').textContent = 'Connected';
    incomingPage.classList.add('hide'); callingPage.classList.remove('hide');
    startCallTimer(); startAudioStream();
  }
};

$('declineBtn').onclick = () => {
  if (currentCallId) send({type:'reject_call', callId: currentCallId});
  currentCallId = null;
  incomingPage.classList.add('hide'); mainPage.classList.remove('hide');
};

$('muteBtn').onclick = function() {
  if (micStream) {
    const en = !micStream.getAudioTracks()[0].enabled;
    micStream.getAudioTracks()[0].enabled = en;
    this.style.opacity = en ? '1' : '0.4';
  }
};

function endCallUI() {
  cleanupAudio(); currentCallId = null;
  callingPage.classList.add('hide'); incomingPage.classList.add('hide');
  mainPage.classList.remove('hide'); loadContacts();
}

// === Audio (PCM16 via Web Audio API) ===
function startAudioStream() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  navigator.mediaDevices.getUserMedia({audio: true, echoCancellation: true, noiseSuppression: true}).then(stream => {
    micStream = stream;
    const src = audioCtx.createMediaStreamSource(stream);
    const p = audioCtx.createScriptProcessor(4096, 1, 1);
    src.connect(p);
    const silent = audioCtx.createGain();
    silent.gain.value = 0;
    p.connect(silent);
    silent.connect(audioCtx.destination);
    p.onaudioprocess = e => {
      if (!currentCallId) return;
      send({type:'audio', callId:currentCallId, data: buf2b64(pcm16(e.inputBuffer.getChannelData(0)).buffer)});
    };
    audioRecorder = p;
  }).catch(() => alert('Microphone access denied. Allow mic in browser settings.'));
}

function pcm16(f) { const i = new Int16Array(f.length); for(let j=0;j<f.length;j++){const s=Math.max(-1,Math.min(1,f[j]));i[j]=s<0?s*0x8000:s*0x7FFF;} return i; }
function f32(i) { const f = new Float32Array(i.length); for(let j=0;j<i.length;j++) f[j]=i[j]/(i[j]<0?0x8000:0x7FFF); return f; }
function buf2b64(b) { let s=''; new Uint8Array(b).forEach(v=>s+=String.fromCharCode(v)); return btoa(s); }
function b642buf(b) { const s=atob(b),u=new Uint8Array(s.length); for(let i=0;i<s.length;i++) u[i]=s.charCodeAt(i); return u.buffer; }

function playNext() {
  if (!audioQ.length || !audioCtx) { playing=false; return; }
  playing=true;
  try {
    const buf = b642buf(audioQ.shift()), f = f32(new Int16Array(buf)), ab = audioCtx.createBuffer(1, f.length, audioCtx.sampleRate);
    ab.getChannelData(0).set(f);
    const n = audioCtx.createBufferSource(); n.buffer = ab; n.connect(audioCtx.destination);
    n.onended = () => playNext();
    n.start();
  } catch(e) { setTimeout(playNext, 100); }
}

function startCallTimer() { seconds = 0; if (timerInterval) clearInterval(timerInterval); timerInterval = setInterval(() => { seconds++; $('callTimer').textContent = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`; }, 1000); }
function cleanupAudio() { if(timerInterval)clearInterval(timerInterval);timerInterval=null; if(audioRecorder)try{audioRecorder.disconnect()}catch(e){} if(micStream)micStream.getTracks().forEach(t=>t.stop()); if(refreshInterval)clearInterval(refreshInterval); audioRecorder=null; micStream=null; audioQ=[]; playing=false; }

// === Tabs ===
$('tabContacts').onclick = function() { $('tabContacts').classList.add('active'); $('tabChat').classList.remove('active'); $('contactsView').classList.remove('hide'); $('chatView').classList.add('hide'); loadContacts(); };
$('tabChat').onclick = function() { $('tabChat').classList.add('active'); $('tabContacts').classList.remove('active'); $('contactsView').classList.add('hide'); $('chatView').classList.remove('hide'); loadChatContacts(); };

// === Chat ===
function loadChatContacts() {
  fetch(HTTP_URL + '/api/users').then(r=>r.json()).then(users => {
    const others = users.filter(u => u.username !== myUsername);
    fetch(HTTP_URL + '/api/messages/' + myUsername).then(r=>r.json()).then(data => {
      chatContactsList.innerHTML = others.map(u =>
        `<li onclick="openChat('${u.username}')">
          💬 <span class="name">${u.name}</span> @${u.username}
          ${data[u.username] ? `<span style="opacity:.6;font-size:12px">${data[u.username].length} msgs</span>` : '<span style="opacity:.4;font-size:12px">Start Convo</span>'}
        </li>`
      ).join('');
    });
  });
}

function openChat(username) {
  chatTarget = username; $('chatWith').textContent = '@' + username;
  $('tabChat').classList.add('active'); $('tabContacts').classList.remove('active');
  $('contactsView').classList.add('hide'); $('chatView').classList.remove('hide');
  $('chatArea').classList.remove('hide'); loadChatContacts();
  fetch(HTTP_URL + '/api/messages/' + myUsername).then(r=>r.json()).then(data => {
    chatMessages.innerHTML = (data[username]||[]).map(m =>
      `<div class="chat-msg ${m.from===myUsername?'chat-mine':'chat-other'}">${m.text}</div>`
    ).join('');
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
  $('chatInput').focus();
}

$('chatSendBtn').onclick = () => {
  const t = $('chatInput').value.trim();
  if (!t || !chatTarget) return;
  send({type:'chat', to: chatTarget, text: t});
  appendChatMsg(myUsername, t, true);
  $('chatInput').value = '';
};

$('chatInput').onkeydown = e => { if (e.key === 'Enter') $('chatSendBtn').click(); };

function appendChatMsg(from, text, mine) {
  if (chatTarget !== from && !mine) return;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (mine ? 'chat-mine' : 'chat-other');
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// === Init ===
(async function init() {
  const savedUser = localStorage.getItem('fc_user');
  const savedName = localStorage.getItem('fc_name');
  if (savedUser && savedName) {
    try {
      const r = await fetch(HTTP_URL + '/api/user/' + savedUser);
      if (r.ok) { connectApp(savedUser, savedName); }
      else { localStorage.removeItem('fc_user'); localStorage.removeItem('fc_name'); }
    } catch(e) { localStorage.removeItem('fc_user'); localStorage.removeItem('fc_name'); }
  }
})();

const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTO}//${location.host}`;
const HTTP_URL = location.origin;

let ws = null, currentCallId = null, timerInterval = null, seconds = 0;
let myUsername = '', myName = '', chatTarget = '', refreshInterval = null;

// Audio state
let audioCtx = null;
let micStream = null;
let mediaRecorder = null;
let audioStreamStarted = false;
let isMuted = false;

// Playback queue
let playQueue = [];
let isPlaying = false;
let playbackCtx = null; // separate context for playback to avoid suspend issues

const $ = id => document.getElementById(id);

// === Auth ===
$('showRegister').onclick = e => {
  e.preventDefault();
  $('loginPage').classList.add('hide');
  $('registerPage').classList.remove('hide');
};
$('showLogin').onclick = e => {
  e.preventDefault();
  $('registerPage').classList.add('hide');
  $('loginPage').classList.remove('hide');
};

$('loginBtn').onclick = () => {
  const u = $('loginUser').value.trim().toLowerCase();
  const p = $('loginPass').value;
  if (!u || !p) return alert('Enter username and password');
  $('loginBtn').textContent = 'Signing in...';
  $('loginBtn').disabled = true;
  fetch(HTTP_URL + '/api/login', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: u, password: p})
  })
  .then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error || 'Login failed'); }); return r.json(); })
  .then(r => {
    localStorage.setItem('fc_user', r.user.username);
    localStorage.setItem('fc_name', r.user.name);
    connectApp(r.user.username, r.user.name);
  })
  .catch(e => { $('loginBtn').textContent = 'Sign In'; $('loginBtn').disabled = false; alert(e.message || 'Connection error'); });
};

$('regBtn').onclick = () => {
  const u = $('regUser').value.trim().toLowerCase();
  const n = $('regName').value.trim();
  const p = $('regPass').value;
  if (!u || !n || !p) return alert('Fill all fields');
  if (u.includes(' ')) return alert('No spaces in username');
  $('regBtn').textContent = 'Creating...';
  $('regBtn').disabled = true;
  fetch(HTTP_URL + '/api/register', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: u, name: n, password: p})
  })
  .then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error || 'Registration failed'); }); return r.json(); })
  .then(() => {
    localStorage.setItem('fc_user', u);
    localStorage.setItem('fc_name', n);
    connectApp(u, n);
  })
  .catch(e => { $('regBtn').textContent = 'Create Account'; $('regBtn').disabled = false; alert(e.message || 'Connection error'); });
};

$('logoutBtn').onclick = () => {
  localStorage.removeItem('fc_user');
  localStorage.removeItem('fc_name');
  if (ws) ws.close();
  $('mainPage').classList.add('hide');
  $('loginPage').classList.remove('hide');
  $('loginUser').value = ''; $('loginPass').value = '';
};

// === WebSocket ===
function connectApp(username, name) {
  myUsername = username; myName = name;
  $('myName').textContent = name; $('myUser').textContent = username;
  $('loginPage').classList.add('hide');
  $('registerPage').classList.add('hide');
  $('mainPage').classList.remove('hide');

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
      if (currentCallId) { send({type: 'reject_call', callId: msg.callId}); return; }
      currentCallId = msg.callId;
      $('incomingName').textContent = msg.callerName;
      $('incomingAvatarLetter').textContent = msg.callerName.charAt(0).toUpperCase();
      $('incomingPage').classList.remove('hide');
      $('mainPage').classList.add('hide');
      break;

    case 'call_created':
      currentCallId = msg.callId;
      $('callStatusText').textContent = 'Ringing...';
      $('callTimer').classList.add('hide');
      // Caller: start sending audio right away
      startAudioStream();
      break;

    case 'call_accepted':
      $('callStatusText').textContent = 'Connected';
      $('callTimer').classList.remove('hide');
      startCallTimer();
      break;

    case 'call_rejected':
      endCallUI(); alert('Call was declined');
      break;

    case 'call_ended':
      endCallUI();
      break;

    case 'audio':
      if (currentCallId === msg.callId && msg.data) {
        enqueueAudio(msg.mime, msg.data);
      }
      break;

    case 'chat':
      appendChatMsg(msg.from, msg.text, false);
      loadChatContacts();
      break;

    case 'chat_sent': break;
    case 'error': alert(msg.message); break;
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// === Contacts ===
async function loadContacts() {
  const users = await fetch(HTTP_URL + '/api/users').then(r => r.json());
  const others = users.filter(u => u.username !== myUsername);
  const list = $('contactsList');
  if (others.length === 0) {
    list.innerHTML = '';
    $('noContacts').classList.remove('hide');
    return;
  }
  $('noContacts').classList.add('hide');
  list.innerHTML = others.map(u => `
    <div class="contact-item">
      <div class="contact-avatar">
        ${u.name.charAt(0).toUpperCase()}
        <span class="status-dot ${u.online ? 'dot-on' : 'dot-off'}"></span>
      </div>
      <div class="contact-info">
        <div class="contact-name">${u.name}</div>
        <div class="contact-user">@${u.username} · ${u.online ? 'Online' : 'Offline'}</div>
      </div>
      <div class="contact-actions">
        <button class="action-btn chat-btn-sm" onclick="openChat('${u.username}','${u.name}')">💬</button>
        <button class="action-btn call-btn" onclick="startCall('${u.username}','${u.name}')">📞</button>
      </div>
    </div>
  `).join('');
  loadChatContacts();
}

$('callUserBtn').onclick = () => {
  const u = $('searchUser').value.trim().toLowerCase();
  if (u) startCall(u, u);
};
$('searchUser').onkeydown = e => { if (e.key === 'Enter') $('callUserBtn').click(); };

// === Call ===
function startCall(username, name) {
  initPlaybackCtx(); // must be from user gesture
  $('callDisplayName').textContent = name;
  $('callAvatarLetter').textContent = name.charAt(0).toUpperCase();
  $('callStatusText').textContent = 'Calling...';
  $('callTimer').classList.add('hide');
  $('callingPage').classList.remove('hide');
  $('mainPage').classList.add('hide');
  audioStreamStarted = false;
  send({type: 'call', calleeUsername: username});
  startCallTimer();
}

$('callEndBtn').onclick = () => {
  if (currentCallId) send({type: 'end_call', callId: currentCallId});
  endCallUI();
};

$('acceptBtn').onclick = () => {
  if (!currentCallId || !ws) return;
  initPlaybackCtx(); // must be from user gesture
  send({type: 'accept_call', callId: currentCallId});
  $('callDisplayName').textContent = $('incomingName').textContent;
  $('callAvatarLetter').textContent = $('incomingName').textContent.charAt(0).toUpperCase();
  $('callStatusText').textContent = 'Connected';
  $('callTimer').classList.remove('hide');
  $('incomingPage').classList.add('hide');
  $('callingPage').classList.remove('hide');
  startCallTimer();
  audioStreamStarted = false;
  startAudioStream(); // callee starts mic
};

$('declineBtn').onclick = () => {
  if (currentCallId) send({type: 'reject_call', callId: currentCallId});
  currentCallId = null;
  $('incomingPage').classList.add('hide');
  $('mainPage').classList.remove('hide');
};

$('muteBtn').onclick = function() {
  isMuted = !isMuted;
  if (mediaRecorder) {
    if (isMuted && mediaRecorder.state === 'recording') mediaRecorder.pause();
    else if (!isMuted && mediaRecorder.state === 'paused') mediaRecorder.resume();
  }
  this.querySelector('.ctrl-btn-circle').textContent = isMuted ? '🔇' : '🎙️';
  this.querySelector('span').textContent = isMuted ? 'Unmute' : 'Mute';
  this.classList.toggle('active', isMuted);
};

$('speakerBtn').onclick = function() {
  this.classList.toggle('active');
};

function endCallUI() {
  stopAudioStream();
  currentCallId = null;
  $('callingPage').classList.add('hide');
  $('incomingPage').classList.add('hide');
  $('mainPage').classList.remove('hide');
  loadContacts();
}

// === Playback AudioContext (created from user gesture) ===
function initPlaybackCtx() {
  if (!playbackCtx) {
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (playbackCtx.state === 'suspended') playbackCtx.resume();
}

// === Audio Capture: MediaRecorder → base64 → WebSocket ===
// Works on ALL devices (mobile Chrome, Safari, desktop Chrome/Firefox)
function getBestMime() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    ''
  ];
  for (const t of types) {
    if (t === '' || (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t))) return t;
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

  const mime = getBestMime();
  const options = mime ? {mimeType: mime} : {};

  try {
    mediaRecorder = new MediaRecorder(micStream, options);
  } catch(e) {
    mediaRecorder = new MediaRecorder(micStream);
  }

  const actualMime = mediaRecorder.mimeType || mime || 'audio/webm';

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0 && currentCallId && !isMuted) {
      e.data.arrayBuffer().then(buf => {
        const bytes = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        send({type: 'audio', callId: currentCallId, mime: actualMime, data: btoa(s)});
      });
    }
  };

  mediaRecorder.start(60); // 60ms chunks — small enough for low latency
}

function stopAudioStream() {
  audioStreamStarted = false;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch(e) {}
  }
  mediaRecorder = null;
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  playQueue = []; isPlaying = false;
  isMuted = false;
  const mb = $('muteBtn');
  if (mb) { mb.querySelector('.ctrl-btn-circle').textContent = '🎙️'; mb.querySelector('span').textContent = 'Mute'; mb.classList.remove('active'); }
}

// === Audio Playback: queue + decodeAudioData ===
// Key fix: we pass the SENDER's mime type to decodeAudioData
// This solves phone→laptop (mp4) and laptop→phone (webm) mismatch

function enqueueAudio(mime, b64) {
  playQueue.push({mime, b64});
  if (!isPlaying) drainQueue();
}

function drainQueue() {
  if (!playQueue.length) { isPlaying = false; return; }
  if (!playbackCtx) { isPlaying = false; return; }
  if (playbackCtx.state === 'suspended') {
    playbackCtx.resume().then(drainQueue);
    return;
  }

  isPlaying = true;
  const item = playQueue.shift();

  // Decode the raw bytes
  let buf;
  try {
    const s = atob(item.b64);
    buf = new ArrayBuffer(s.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
  } catch(e) { drainQueue(); return; }

  playbackCtx.decodeAudioData(
    buf,
    (decoded) => {
      const src = playbackCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(playbackCtx.destination);
      src.onended = () => drainQueue();
      src.start(0);
    },
    () => {
      // decode failed — skip this chunk and continue
      drainQueue();
    }
  );
}

// === Timer ===
function startCallTimer() {
  seconds = 0;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    seconds++;
    $('callTimer').textContent =
      `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }, 1000);
}

// === Tabs ===
$('tabContacts').onclick = function() {
  $('tabContacts').classList.add('active'); $('tabChat').classList.remove('active');
  $('contactsView').classList.remove('hide'); $('chatView').classList.add('hide');
  loadContacts();
};
$('tabChat').onclick = function() {
  $('tabChat').classList.add('active'); $('tabContacts').classList.remove('active');
  $('contactsView').classList.add('hide'); $('chatView').classList.remove('hide');
  loadChatContacts();
};

// === Chat ===
function loadChatContacts() {
  fetch(HTTP_URL + '/api/users').then(r => r.json()).then(users => {
    const others = users.filter(u => u.username !== myUsername);
    fetch(HTTP_URL + '/api/messages/' + myUsername).then(r => r.json()).then(data => {
      $('chatContactsList').innerHTML = others.map(u => `
        <div class="contact-item" onclick="openChat('${u.username}','${u.name}')">
          <div class="contact-avatar" style="background:#5c6bc0">${u.name.charAt(0).toUpperCase()}</div>
          <div class="contact-info">
            <div class="contact-name">${u.name}</div>
            <div class="contact-user">${data[u.username] ? data[u.username].length + ' messages' : 'Start a conversation'}</div>
          </div>
          <div style="color:#5f6368;font-size:20px">›</div>
        </div>
      `).join('');
    });
  });
}

function openChat(username, name) {
  chatTarget = username;
  $('chatWith').textContent = name || ('@' + username);
  $('chatListView').classList.add('hide');
  $('chatAreaView').classList.remove('hide');
  fetch(HTTP_URL + '/api/messages/' + myUsername).then(r => r.json()).then(data => {
    $('chatMessages').innerHTML = (data[username] || []).map(m =>
      `<div class="chat-msg ${m.from === myUsername ? 'chat-mine' : 'chat-other'}">${m.text}</div>`
    ).join('');
    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
  });
  $('chatInput').focus();
}

function closeChatArea() {
  $('chatAreaView').classList.add('hide');
  $('chatListView').classList.remove('hide');
  chatTarget = '';
}

$('chatSendBtn').onclick = () => {
  const t = $('chatInput').value.trim();
  if (!t || !chatTarget) return;
  send({type: 'chat', to: chatTarget, text: t});
  appendChatMsg(myUsername, t, true);
  $('chatInput').value = '';
};
$('chatInput').onkeydown = e => { if (e.key === 'Enter') $('chatSendBtn').click(); };

function appendChatMsg(from, text, mine) {
  if (!mine && chatTarget !== from) return;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (mine ? 'chat-mine' : 'chat-other');
  div.textContent = text;
  $('chatMessages').appendChild(div);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
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

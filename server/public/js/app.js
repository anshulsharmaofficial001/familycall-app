// FamilyCall v8 - Complete Family App
'use strict';
const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL   = `${WS_PROTO}//${location.host}`;
const HTTP_URL = location.origin;

let ws = null, currentCallId = null, timerInterval = null, seconds = 0;
let myUsername = '', myName = '', myRole = 'user', chatTarget = '', refreshInterval = null;
let myAvatar = null, myDob = null;

/* ── Audio ── */
let micStream = null, audioStarted = false, isMuted = false, isOnHold = false;
let captureCtx = null, captureSource = null, captureProc = null, captureNode = null, captureGain = null;
let playCtx = null, playNextTime = 0, playNode = null, playGain = null, playMode = 'buffer';
let txAudioChunks = 0, rxAudioChunks = 0, playedAudioChunks = 0;
let speakerActive = false;

/* Ring */
let ringCtx = null, ringGain = null, ringOsc = null, ringing = false;

/* State */
let callerInfoStore = {name:'',username:'',avatar:null};
let friendsCache = [];
let pendingInCache = [];
let pendingOutCache = [];
let myGroupsCache = [];
let batteryCache = {}; // username -> level
let locationWatchId = null;
let locationPaused = false;
let activeSosId = null;
let currentGroupId = null; // for group chat

const $ = id => document.getElementById(id);
function onClick(id, fn) {
  const el = $(id);
  if (!el) { console.warn('[FamilyCall] missing #' + id); return false; }
  el.onclick = fn;
  return true;
}
function bindEl(id, prop, fn) {
  const el = $(id);
  if (!el) return false;
  el[prop] = fn;
  return true;
}

function doLogin() {
  const u = ($('loginUser') && $('loginUser').value || '').trim().toLowerCase();
  const p = $('loginPass') && $('loginPass').value || '';
  if (!u || !p) return alert('Enter username and password');
  const btn = $('loginBtn');
  if (btn) { btn.textContent = 'Signing in…'; btn.disabled = true; }
  myUsername = u;
  slog('login_click', { username: u });
  fetch(`${HTTP_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p })
  })
    .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e.error || 'Login failed'); }))
    .then(r => {
      slog('login_success', { username: r.user.username });
      localStorage.setItem('fc_user', r.user.username);
      localStorage.setItem('fc_name', r.user.name);
      localStorage.setItem('fc_role', r.user.role || 'user');
      connectApp(r.user.username, r.user.name, r.user.role || 'user');
    })
    .catch(e => {
      slog('login_failed', { username: u, err: e.message });
      if (btn) { btn.textContent = 'Sign In'; btn.disabled = false; }
      alert(e.message || 'Login failed');
    });
}

function doRegister() {
  const u = ($('regUser') && $('regUser').value || '').trim().toLowerCase();
  const n = ($('regName') && $('regName').value || '').trim();
  const p = $('regPass') && $('regPass').value || '';
  const dob = $('regDob') && $('regDob').value || null;
  if (!u || !n || !p) return alert('Fill all fields');
  if (u.includes(' ')) return alert('No spaces in username');
  const btn = $('regBtn');
  if (btn) { btn.textContent = 'Creating…'; btn.disabled = true; }
  myUsername = u;
  slog('register_click', { username: u, name: n });
  fetch(`${HTTP_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, name: n, password: p, dob: dob||undefined })
  })
    .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e.error || 'Registration failed'); }))
    .then(() => {
      slog('register_success', { username: u });
      localStorage.setItem('fc_user', u);
      localStorage.setItem('fc_name', n);
      localStorage.setItem('fc_role', 'user');
      connectApp(u, n, 'user');
    })
    .catch(e => {
      slog('register_failed', { username: u, err: e.message });
      if (btn) { btn.textContent = 'Create Account'; btn.disabled = false; }
      alert(e.message || 'Registration failed');
    });
}

window.doLogin = doLogin;
window.doRegister = doRegister;
window.connectApp = connectApp;

/* ── Avatar helper ── */
function setAvatarEl(el, name, avatarB64, isCreator) {
  if (!el) return;
  el.innerHTML = '';
  if (avatarB64) {
    const img = document.createElement('img');
    img.src = avatarB64;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
    el.appendChild(img);
  } else {
    el.textContent = (name||'?').charAt(0).toUpperCase();
  }
}

function updateTopbar() {
  const av = $('topbarAvatar');
  if (!av) return;
  av.innerHTML = '';
  if (myAvatar) {
    const img = document.createElement('img');
    img.src = myAvatar;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
    av.appendChild(img);
  } else {
    av.textContent = (myName||'?').charAt(0).toUpperCase();
  }
  if (myRole === 'superadmin') {
    av.className = 'topbar-avatar creator-ring';
  } else {
    av.className = 'topbar-avatar';
  }
  const titleEl = $('topbarName');
  if (titleEl) titleEl.textContent = myName || 'Family';
  const statusLine = $('userStatusLine');
  if (statusLine) {
    const online = ws && ws.readyState === WebSocket.OPEN;
    const dot = online ? '<span style="color:var(--green);font-weight:700">● Online</span>' : '<span style="color:var(--text2)">○ Offline</span>';
    if (myRole === 'superadmin') {
      statusLine.innerHTML = `${dot} · <span style="color:var(--gold);font-family:Pacifico,cursive;font-size:11px;animation:creator-glow 2s infinite">✦ Creator</span>`;
    } else {
      statusLine.innerHTML = `${dot} · @${myUsername}`;
    }
  }
  showAdminButton();
}

/* ── Notifications ── */
if (Notification && Notification.permission === 'default') {
  Notification.requestPermission().catch(() => {});
}

function showCallNotification(callerName) {
  if (document.visibilityState !== 'hidden') return;
  if (!Notification || Notification.permission !== 'granted') return;
  try {
    new Notification('Incoming Call', { body: callerName + ' is calling you', icon: '/icon.png' });
  } catch(e) {}
}

/* ── Logger ── */
function slog(event, data) {
  if (!myUsername) return;
  fetch(`${HTTP_URL}/api/log`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ username: myUsername, event, data })
  }).catch(()=>{});
}

window.addEventListener('error', e => slog('window_error', { message:e.message, source:e.filename, line:e.lineno }));
window.addEventListener('unhandledrejection', e => slog('promise_rejection', { reason:String(e.reason && (e.reason.message || e.reason)) }));

/* ═══════════════════════════════════════════
   AUTH (logout — login/register via inline handler in index.html)
═══════════════════════════════════════════ */
onClick('logoutBtn', () => {
  localStorage.removeItem('fc_user'); localStorage.removeItem('fc_name'); localStorage.removeItem('fc_role');
  if (ws) ws.close();
  $('mainPage').classList.add('hide'); $('loginPage').classList.remove('hide');
  $('loginUser').value=''; $('loginPass').value='';
});

/* ═══════════════════════════════════════════
   WEBSOCKET
═══════════════════════════════════════════ */
function connectApp(username, name, role) {
  myUsername=username; myName=name; myRole=role||'user';
  const AC = window.AudioContext || window.webkitAudioContext;
  slog('client_ready',{ua:navigator.userAgent, audioWorklet:!!(AC&&AC.prototype&&('audioWorklet' in AC.prototype))});
  $('loginPage').classList.add('hide'); $('registerPage').classList.add('hide'); $('mainPage').classList.remove('hide');
  // Load profile for avatar
  fetch(`${HTTP_URL}/api/profile/${username}`).then(r=>r.json()).then(u=>{
    if(u.avatar) myAvatar=u.avatar;
    if(u.role) myRole=u.role;
    if(u.name) myName=u.name;
    updateTopbar();
    // Start new features after profile loaded
    startBatteryMonitor();
    startLocationTracking();
    loadGroups();
  }).catch(()=>{ updateTopbar(); });
  ws=new WebSocket(`${WS_URL}/ws?username=${encodeURIComponent(username)}&name=${encodeURIComponent(name)}`);
  ws.onopen=()=>{slog('ws_open',{});updateTopbar();loadContacts();refreshInterval=setInterval(loadContacts,8000);};
  initSOSButton();
  ws.onmessage=e=>handleMsg(JSON.parse(e.data));
  ws.onclose=()=>{slog('ws_close',{});if(refreshInterval)clearInterval(refreshInterval);setTimeout(()=>location.reload(),2000);};
}

function handleMsg(msg) {
  switch(msg.type) {
    case 'welcome':
      myRole = msg.role || myRole;
      break;
    case 'pending_messages': loadChatContacts(); break;

    case 'incoming_call':
      if (currentCallId){send({type:'reject_call',callId:msg.callId});return;}
      currentCallId=msg.callId;
      callerInfoStore = {name: msg.callerName, username: msg.callerUsername, avatar: msg.callerAvatar||null};
      $('incomingName').textContent=msg.callerName;
      setAvatarEl($('incomingAvatarEl'), msg.callerName, msg.callerAvatar||null);
      $('incomingPage').classList.remove('hide');
      $('mainPage').classList.add('hide');
      startRing();
      showCallNotification(msg.callerName);
      break;

    case 'call_created':
      currentCallId=msg.callId;
      $('callStatusText').textContent='Ringing…';
      $('callTimer').classList.add('hide');
      audioStarted=false;
      txAudioChunks=0; rxAudioChunks=0; playedAudioChunks=0;
      setTimeout(()=>startCapture(), 100);
      break;

    case 'call_busy':
      stopRing(); endCallUI();
      alert('📵 User is busy in another call');
      break;

    case 'call_accepted':
      stopRing();
      $('callStatusText').textContent='Connected';
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
      if (currentCallId===msg.callId && msg.data) receiveAudio(msg.data, msg.sampleRate || SAMPLE_RATE);
      break;

    case 'chat':
      appendChatMsg(msg.from,msg.text,false,msg.voiceData,msg.voiceMime); loadChatContacts();
      break;

    case 'friend_request':
      loadContacts(); // refresh to show pending
      showFriendRequestNotif(msg.fromName || msg.from, msg.from);
      break;

    case 'friend_request_sent':
      loadContacts();
      break;

    case 'friend_accepted':
      loadContacts();
      showToast('✅ ' + (msg.byName || msg.by) + ' accepted your request! You are now friends 🎉');
      showSystemNotif('Friend Request Accepted! 🎉', (msg.byName||msg.by) + ' is now your friend in FamilyCall');
      break;

    case 'friend_online':
      updateContactOnlineStatus(msg.username, true);
      break;

    case 'friend_offline':
      updateContactOnlineStatus(msg.username, false);
      break;

    case 'battery_update':
      batteryCache[msg.username] = { level: msg.level, charging: msg.charging };
      updateBatteryDot(msg.username, msg.level, msg.charging);
      if (msg.level <= 5) showToast(`🔴 ${msg.name || msg.username} battery critically low: ${Math.round(msg.level*100)}%`);
      else if (msg.level <= 15) showToast(`🟡 ${msg.name || msg.username} battery low: ${Math.round(msg.level*100)}%`);
      break;

    case 'location_update':
      updateFriendLocation(msg);
      break;

    case 'sos_alert':
      handleSOSAlert(msg);
      break;

    case 'sos_cancelled':
      handleSOSCancelled(msg);
      break;

    case 'new_voice_status':
      showVoiceStatusRing(msg.username, msg.avatar, msg.name);
      break;

    case 'group_chat':
      if (currentGroupId === msg.groupId) {
        appendGroupMsg(msg.fromName||msg.from, msg.text, false, msg.voiceData, msg.voiceMime);
      }
      showToast(`💬 ${msg.fromName||msg.from}: ${msg.text||'🎤'}`);
      break;

    case 'paging':
      handlePaging(msg);
      break;

    case 'birthday_today':
      showBirthdayAlert(msg.name);
      break;

    case 'added_to_group':
      loadGroups(); showToast('🎉 Added to a group!');
      break;

    case 'error': alert(msg.message); break;
  }
}

function send(obj){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}

function showFriendRequestToast(fromName) {
  showToast('👤 Friend request from ' + fromName);
}

/* ═══════════════════════════════════════════
   RING
═══════════════════════════════════════════ */
function startRing(){
  if(ringing)return; ringing=true;
  try{
    ringCtx=new(window.AudioContext||window.webkitAudioContext)();
    ringGain=ringCtx.createGain();ringGain.gain.value=0.3;ringGain.connect(ringCtx.destination);
    let hi=true;
    (function pulse(){
      if(!ringing)return;
      ringOsc=ringCtx.createOscillator();ringOsc.type='sine';ringOsc.frequency.value=hi?480:420;
      ringOsc.connect(ringGain);ringOsc.start();ringOsc.stop(ringCtx.currentTime+0.35);
      ringOsc.onended=()=>{hi=!hi;if(ringing)setTimeout(pulse,180);};
    })();
  }catch(e){}
}
function stopRing(){
  ringing=false;
  try{if(ringOsc){ringOsc.onended=null;ringOsc.stop();}}catch(e){}
  try{if(ringGain)ringGain.disconnect();}catch(e){}
  try{if(ringCtx)ringCtx.close();}catch(e){}
  ringCtx=null;ringGain=null;ringOsc=null;
}

/* ═══════════════════════════════════════════
   CAPTURE — AudioContext ScriptProcessor → PCM16 → base64
═══════════════════════════════════════════ */
const SAMPLE_RATE = 16000;
const PROC_BUFFER = 4096;

async function startCapture(){
  if(audioStarted){ slog('capture_already_started',{callId:currentCallId}); return; }
  audioStarted=true;
  slog('capture_attempting',{callId:currentCallId,audioStarted});
  try{
    micStream=await navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}
    });
    slog('mic_granted',{tracks:micStream.getAudioTracks().map(t=>({label:t.label,enabled:t.enabled,muted:t.muted,readyState:t.readyState}))});
  }catch(e){
    alert('Mic denied: '+e.message);
    audioStarted=false;
    slog('mic_denied',{err:e.message});
    return;
  }
  captureCtx=new(window.AudioContext||window.webkitAudioContext)();
  if(captureCtx.state==='suspended')await captureCtx.resume();
  const nativeRate=captureCtx.sampleRate;
  slog('capture_start',{nativeRate,ua:navigator.userAgent.substring(0,60)});
  captureSource=captureCtx.createMediaStreamSource(micStream);
  captureGain=captureCtx.createGain();
  captureGain.gain.value=0;
  if(captureCtx.audioWorklet){
    try{
      await captureCtx.audioWorklet.addModule('/js/pcm-recorder.js?v=3');
      captureNode=new AudioWorkletNode(captureCtx,'pcm-recorder',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
      captureNode.port.onmessage=e=>{
        if(!currentCallId||isMuted||isOnHold||!e.data||e.data.type!=='pcm')return;
        const bytes=new Uint8Array(e.data.buffer);
        let bin='';
        for(let i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
        txAudioChunks++;
        if(txAudioChunks<=5||txAudioChunks%25===0)slog('tx_audio_chunk',{mode:'audioWorklet',chunk:txAudioChunks,bytes:bytes.length,ctxState:captureCtx.state});
        send({type:'audio',callId:currentCallId,data:btoa(bin),sampleRate:SAMPLE_RATE});
      };
      captureSource.connect(captureNode);
      captureNode.connect(captureGain);
      captureGain.connect(captureCtx.destination);
      slog('capture_mode',{mode:'audioWorklet'});
      return;
    }catch(e){ slog('worklet_failed',{err:e.message}); }
  }
  captureProc=captureCtx.createScriptProcessor(PROC_BUFFER,1,1);
  captureProc.onaudioprocess=e=>{
    if(isMuted||isOnHold||!currentCallId)return;
    const input=e.inputBuffer.getChannelData(0);
    const ratio=nativeRate/SAMPLE_RATE;
    const outLen=Math.floor(input.length/ratio);
    const pcm=new Int16Array(outLen);
    for(let i=0;i<outLen;i++){
      const s=Math.max(-1,Math.min(1,input[Math.floor(i*ratio)]));
      pcm[i]=s<0?s*0x8000:s*0x7FFF;
    }
    const bytes=new Uint8Array(pcm.buffer);
    let bin='';
    for(let i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
    txAudioChunks++;
    if(txAudioChunks<=5||txAudioChunks%25===0)slog('tx_audio_chunk',{mode:'scriptProcessor',chunk:txAudioChunks,bytes:bytes.length,ctxState:captureCtx.state});
    send({type:'audio',callId:currentCallId,data:btoa(bin),sampleRate:SAMPLE_RATE});
  };
  captureSource.connect(captureProc);
  captureProc.connect(captureGain);
  captureGain.connect(captureCtx.destination);
  slog('capture_mode',{mode:'scriptProcessor'});
}

function stopCapture(){
  audioStarted=false;
  slog('capture_stop',{txAudioChunks});
  try{if(captureNode)captureNode.disconnect();}catch(e){}
  try{if(captureProc)captureProc.disconnect();}catch(e){}
  try{if(captureSource)captureSource.disconnect();}catch(e){}
  try{if(captureGain)captureGain.disconnect();}catch(e){}
  try{if(captureCtx)captureCtx.close();}catch(e){}
  captureProc=null;captureNode=null;captureSource=null;captureGain=null;captureCtx=null;
  if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null;}
}

/* ═══════════════════════════════════════════
   PLAYBACK — PCM16 base64 → AudioContext scheduled play
═══════════════════════════════════════════ */
function resampleFloat32(input, fromRate, toRate) {
  fromRate = Number(fromRate) || SAMPLE_RATE;
  toRate = Number(toRate) || SAMPLE_RATE;
  if (Math.abs(fromRate - toRate) < 1) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))];
  return out;
}

function unlockAudioOutput() {
  if (!playCtx || playCtx.state === 'closed') return;
  try {
    const buffer = playCtx.createBuffer(1, 1, playCtx.sampleRate || SAMPLE_RATE);
    const src = playCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(playGain || playCtx.destination);
    src.start(0);
    slog('audio_output_unlocked', { state: playCtx.state, sampleRate: playCtx.sampleRate, mode: playMode });
  } catch (e) {
    slog('audio_unlock_failed', { err: e.message, state: playCtx ? playCtx.state : 'none' });
  }
}

async function ensurePlayCtx(){
  if(!playCtx||playCtx.state==='closed'){
    // Do NOT force sampleRate — let browser use its native rate (44100/48000)
    // Forcing 16000 causes silent failure on many Android/iOS devices
    playCtx=new(window.AudioContext||window.webkitAudioContext)();
    playNextTime=0; playNode=null;
    playGain=playCtx.createGain();
    playGain.gain.value=2.0;
    playGain.connect(playCtx.destination);
    slog('playctx_created',{state:playCtx.state,sampleRate:playCtx.sampleRate});
  }
  if(playCtx.state==='suspended'){
    await playCtx.resume()
      .then(()=>slog('playctx_resumed',{state:playCtx.state}))
      .catch(e=>slog('playctx_resume_failed',{err:e.message,state:playCtx.state}));
  }
  if(!playNode && playCtx.audioWorklet){
    try{
      await playCtx.audioWorklet.addModule('/js/audio-processor.js?v=4');
      playNode=new AudioWorkletNode(playCtx,'pcm-player',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1]});
      playNode.connect(playGain);
      playMode='worklet';
      slog('playback_mode',{mode:playMode,state:playCtx.state,sampleRate:playCtx.sampleRate});
    }catch(e){ playMode='buffer'; slog('playworklet_failed',{err:e.message}); }
  }
  unlockAudioOutput();
}

/* Build a WAV ArrayBuffer from PCM16 — universally decodable by ALL browsers */
function pcm16ToWavBuffer(int16Array, sampleRate) {
  const numSamples = int16Array.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (off, str) => { for(let i=0;i<str.length;i++) view.setUint8(off+i, str.charCodeAt(i)); };
  writeStr(0,'RIFF'); view.setUint32(4, 36+numSamples*2, true);
  writeStr(8,'WAVE'); writeStr(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true);
  writeStr(36,'data'); view.setUint32(40,numSamples*2,true);
  new Int16Array(buffer, 44).set(int16Array);
  return buffer;
}

/* Build a proper WAV blob from PCM16 data — works on ALL browsers/mobile */
function pcm16ToWavBlob(int16Array, sampleRate) {
  const numSamples = int16Array.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (off, str) => { for(let i=0;i<str.length;i++) view.setUint8(off+i, str.charCodeAt(i)); };
  writeStr(0,'RIFF'); view.setUint32(4, 36+numSamples*2, true);
  writeStr(8,'WAVE'); writeStr(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true);
  writeStr(36,'data'); view.setUint32(40,numSamples*2,true);
  const pcmOut = new Int16Array(buffer, 44);
  pcmOut.set(int16Array);
  return new Blob([buffer], {type:'audio/wav'});
}

async function receiveAudio(b64, sourceRate){
  rxAudioChunks++;
  const sr = Number(sourceRate) || SAMPLE_RATE;
  if(rxAudioChunks<=5||rxAudioChunks%25===0)slog('rx_audio_chunk',{chunk:rxAudioChunks,b64Length:b64.length,sourceRate:sr,playState:playCtx?playCtx.state:'none',visibility:document.visibilityState});
  await ensurePlayCtx();
  if(!playCtx||playCtx.state==='closed'){slog('rx_drop_no_playctx',{chunk:rxAudioChunks});return;}

  /* Decode base64 → Int16Array */
  let pcm;
  try{
    const bin=atob(b64);
    const buf=new ArrayBuffer(bin.length);
    const view=new Uint8Array(buf);
    for(let i=0;i<bin.length;i++)view[i]=bin.charCodeAt(i);
    pcm=new Int16Array(buf);
  }catch(e){slog('rx_b64_fail',{err:e.message});return;}

  /* Convert to Float32 */
  const f32=new Float32Array(pcm.length);
  for(let i=0;i<pcm.length;i++)f32[i]=pcm[i]/(pcm[i]<0?0x8000:0x7FFF);

  /* Try AudioWorklet (best path) */
  if(playNode){
    try{
      const out = resampleFloat32(f32, sr, playCtx.sampleRate);
      playNode.port.postMessage({type:'chunk', samples: out}, [out.buffer]);
      playedAudioChunks++;
      if(playedAudioChunks<=5||playedAudioChunks%25===0)slog('play_audio_queued',{chunk:playedAudioChunks,samples:out.length,sourceRate:sr,ctxRate:playCtx.sampleRate,state:playCtx.state,mode:playMode});
      return;
    }catch(e){ slog('play_worklet_queue_failed',{err:e.message,chunk:rxAudioChunks,state:playCtx.state}); }
  }

  /* Path 2: WAV → decodeAudioData → AudioBufferSourceNode
     WAV is universally decodable. AudioContext is already unlocked from user gesture.
     This works on ALL mobile browsers — no autoplay block, no sampleRate mismatch. */
  try{
    const wavBuf = pcm16ToWavBuffer(pcm, sr);
    playCtx.decodeAudioData(wavBuf, (decoded) => {
      try{
        const src = playCtx.createBufferSource();
        src.buffer = decoded;
        src.connect(playGain || playCtx.destination);
        const now = playCtx.currentTime;
        if(playNextTime < now + 0.02) playNextTime = now + 0.05;
        src.start(playNextTime);
        playNextTime += decoded.duration;
        playedAudioChunks++;
        if(playedAudioChunks<=5||playedAudioChunks%25===0)
          slog('play_wav_decoded',{chunk:playedAudioChunks,dur:decoded.duration,ctxRate:playCtx.sampleRate});
      }catch(e2){ slog('play_wav_src_err',{err:e2.message}); }
    }, (decErr) => {
      slog('play_wav_decode_fail',{err:String(decErr),chunk:rxAudioChunks});
    });
    return;
  }catch(e){ slog('play_wav_err',{err:e.message,chunk:rxAudioChunks}); }
}

function cleanupPlayback(){
  slog('playback_cleanup',{rxAudioChunks,playedAudioChunks,state:playCtx?playCtx.state:'none'});
  try{if(playNode){playNode.port.postMessage({type:'clear'});playNode.disconnect();}}catch(e){}
  try{if(playGain)playGain.disconnect();}catch(e){}
  try{if(playCtx)playCtx.close();}catch(e){}
  playCtx=null;playNode=null;playGain=null;playNextTime=0;playMode='buffer';
}

/* ═══════════════════════════════════════════
   CALL UI
═══════════════════════════════════════════ */
let callChatTarget = '';

async function startCall(username, name){
  txAudioChunks=0;rxAudioChunks=0;playedAudioChunks=0;
  callChatTarget = username;
  await ensurePlayCtx();
  $('callDisplayName').textContent=name;
  // fetch avatar for this contact
  const friend = friendsCache.find(f=>f.username===username);
  setAvatarEl($('callAvatarEl'), name, friend&&friend.avatar||null);
  $('callStatusText').textContent='Calling…';
  $('callTimer').classList.add('hide');
  $('callingPage').classList.remove('hide');
  $('mainPage').classList.add('hide');
  audioStarted=false;
  isOnHold=false;
  send({type:'call',calleeUsername:username});
  startCallTimer();
}

onClick('callEndBtn', ()=>{
  if(currentCallId)send({type:'end_call',callId:currentCallId});
  endCallUI();
});

onClick('acceptBtn', async()=>{
  if(!currentCallId||!ws)return;
  stopRing();
  callChatTarget = '';
  // Try to get caller username from the stored call info (set in handleMsg)
  await ensurePlayCtx();
  send({type:'accept_call',callId:currentCallId});
  $('callDisplayName').textContent=$('incomingName').textContent;
  setAvatarEl($('callAvatarEl'), callerInfoStore.name, callerInfoStore.avatar||null);
  callChatTarget = callerInfoStore.username||'';
  $('callStatusText').textContent='Connected';
  $('callTimer').classList.remove('hide');
  $('incomingPage').classList.add('hide');
  $('callingPage').classList.remove('hide');
  startCallTimer();
  audioStarted=false;
  txAudioChunks=0; rxAudioChunks=0; playedAudioChunks=0;
  isOnHold=false;
  slog('callee_accept_capture_start',{callId:currentCallId});
  startCapture();
});

onClick('declineBtn', ()=>{
  stopRing();
  if(currentCallId)send({type:'reject_call',callId:currentCallId});
  currentCallId=null;
  $('incomingPage').classList.add('hide');
  $('mainPage').classList.remove('hide');
});

onClick('muteBtn', function(){
  isMuted=!isMuted;
  this.querySelector('.ctrl-btn-circle').textContent=isMuted?'🔇':'🎙️';
  this.querySelector('span').textContent=isMuted?'Unmute':'Mute';
  this.classList.toggle('active',isMuted);
});

onClick('holdBtn', function(){
  isOnHold=!isOnHold;
  this.querySelector('.ctrl-btn-circle').textContent=isOnHold?'▶':'⏸';
  this.querySelector('span').textContent=isOnHold?'Resume':'Hold';
  this.classList.toggle('active',isOnHold);
  $('callStatusText').textContent=isOnHold?'On Hold':'Connected';
});

onClick('speakerBtn', function(){
  speakerActive=!speakerActive;
  this.querySelector('.ctrl-btn-circle').textContent=speakerActive?'📢':'🔊';
  this.querySelector('span').textContent=speakerActive?'Speaker On':'Speaker';
  this.classList.toggle('active',speakerActive);
  if(playCtx && playCtx.destination && playCtx.destination.stream){
    // For browsers supporting audio output selection
    const audioEls = document.querySelectorAll('audio');
    audioEls.forEach(a => {
      if(typeof a.setSinkId === 'function'){
        a.setSinkId(speakerActive ? 'speaker' : 'default').catch(()=>{});
      }
    });
  }
  slog('speaker_toggle', { active: speakerActive });
});

onClick('callMsgBtn', function(){
  const overlay = $('callChatOverlay');
  if(overlay){ overlay.classList.toggle('hide'); if(!overlay.classList.contains('hide')&&callChatTarget){ const t=$('callChatTarget'); if(t)t.textContent=$('callDisplayName').textContent; const m=$('callChatMessages'); if(m)m.innerHTML=''; } }
});

const callChatClose=$('callChatClose'); if(callChatClose) callChatClose.onclick=function(){ $('callChatOverlay').classList.add('hide'); };

const callChatSendBtn=$('callChatSendBtn'); if(callChatSendBtn) callChatSendBtn.onclick=function(){
  const inp=$('callChatInput'); if(!inp)return;
  const t=inp.value.trim(); if(!t)return;
  const target=callChatTarget||chatTarget;
  if(!target)return;
  send({type:'chat',to:target,text:t});
  const div=document.createElement('div'); div.className='chat-msg chat-mine'; div.textContent=t;
  const msgs=$('callChatMessages'); if(msgs){msgs.appendChild(div);msgs.scrollTop=msgs.scrollHeight;}
  inp.value='';
};

const callChatInput=$('callChatInput'); if(callChatInput) callChatInput.onkeydown=e=>{if(e.key==='Enter'&&callChatSendBtn)callChatSendBtn.click();};

function endCallUI(){
  stopCapture();
  cleanupPlayback();
  currentCallId=null;
  callChatTarget='';
  isOnHold=false;
  if(timerInterval){clearInterval(timerInterval);timerInterval=null;}
  isMuted=false;
  const mb=$('muteBtn');
  if(mb){mb.querySelector('.ctrl-btn-circle').textContent='🎙️';mb.querySelector('span').textContent='Mute';mb.classList.remove('active');}
  const hb=$('holdBtn');
  if(hb){hb.querySelector('.ctrl-btn-circle').textContent='⏸️';hb.querySelector('span').textContent='Hold';hb.classList.remove('active');}
  const sb=$('speakerBtn');
  if(sb){sb.querySelector('.ctrl-btn-circle').textContent='🔊';sb.querySelector('span').textContent='Speaker';sb.classList.remove('active');}
  const overlay=$('callChatOverlay');
  if(overlay) overlay.classList.add('hide');
  $('callingPage').classList.add('hide');
  $('incomingPage').classList.add('hide');
  $('mainPage').classList.remove('hide');
  loadContacts();
}

/* ═══════════════════════════════════════════
   TIMER
═══════════════════════════════════════════ */
function startCallTimer(){
  seconds=0;if(timerInterval)clearInterval(timerInterval);
  timerInterval=setInterval(()=>{
    seconds++;
    $('callTimer').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  },1000);
}

/* ═══════════════════════════════════════════
   CONTACTS — Friends system
═══════════════════════════════════════════ */
async function loadContacts(){
  if (!myUsername) return;
  try {
    const data = await fetch(`${HTTP_URL}/api/friends/${myUsername}`).then(r=>r.json());
    const friends = data.friends || [];
    const pendingIn = data.pendingIn || [];
    const pendingOut = data.pendingOut || [];
    friendsCache = friends;
    pendingInCache = pendingIn;
    pendingOutCache = pendingOut;

    const list = $('contactsList');
    const pendingDiv = $('pendingRequests');

    // Pending incoming
    if (pendingIn.length > 0) {
      pendingDiv.innerHTML = `<div class="section-title">🔔 Friend Requests (${pendingIn.length})</div>` +
        pendingIn.map(u => {
          const avatarContent = u.avatar
            ? `<img src="${u.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
            : `<span>${(u.username||u.name||'?').charAt(0).toUpperCase()}</span>`;
          return `
            <div class="req-item">
              <div class="contact-avatar" style="width:38px;height:38px;font-size:14px;margin-right:10px;flex-shrink:0;overflow:hidden">${avatarContent}</div>
              <div class="req-name">${u.name||u} <span style="font-size:11px;color:var(--text2)">@${u.username||u}</span></div>
              <div class="req-btns">
                <button class="req-accept" onclick="acceptFriend('${u.username||u}')">✓ Accept</button>
                <button class="req-decline" onclick="declineFriend('${u.username||u}')">✕</button>
              </div>
            </div>`;
        }).join('');
    } else {
      pendingDiv.innerHTML = '';
    }

    if (!friends.length) {
      list.innerHTML = '';
      $('noContacts').classList.remove('hide');
      return;
    }
    $('noContacts').classList.add('hide');

    list.innerHTML = `<div class="section-title">\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66 Family & Friends</div>` +
      friends.map(u => {
        const isCreator = u.role === 'superadmin';
        const avatarClass = isCreator ? 'contact-avatar creator-av' : 'contact-avatar';
        // Profile pic > username first letter (not name)
        const avatarContent = u.avatar
          ? `<img src="${u.avatar}" alt="${u.name}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
          : `<span>${(u.username||'?').charAt(0).toUpperCase()}</span>`;
        const creatorBadge = isCreator ? `<span class="creator-badge">\u2756 Creator</span>` : '';
        const statusText = u.online
          ? `<span style="color:var(--green);font-weight:700">\u25cf Online</span>`
          : `<span style="color:var(--text2)">\u25cb Offline</span>`;
        const bat = batteryCache[u.username];
        const batPct = bat ? Math.round(bat.level*100) : null;
        const batColor = !bat ? '' : bat.charging ? '#4CAF50' : batPct>30 ? '#4CAF50' : batPct>15 ? '#FF9800' : '#F44336';
        const batDot = bat ? `<span class="battery-dot" data-user="${u.username}" title="Battery: ${batPct}%${bat.charging?' \u26a1':''}" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${batColor};margin-left:4px"></span>` : '';
        const safeUser = u.username.replace(/'/g,"\\'");
        const safeName = u.name.replace(/"/g,'&quot;').replace(/'/g,"\\'");
        return `
          <div class="contact-item" onclick="openChat('${safeUser}','${safeName}')" style="cursor:pointer">
            <div class="${avatarClass}" data-vsuser="${u.username}" style="overflow:hidden">
              ${avatarContent}
              <span class="status-dot ${u.online?'dot-on':'dot-off'}" data-user="${u.username}"></span>
            </div>
            <div class="contact-info">
              <div class="contact-name">${u.name} ${creatorBadge}${batDot}</div>
              <div class="contact-sub">@${u.username} \u00b7 ${statusText}</div>
            </div>
            <div class="contact-actions" onclick="event.stopPropagation()">
              <button class="action-btn call-btn" data-username="${u.username}" data-name="${u.name.replace(/"/g,'&quot;')}" onclick="startCall(this.dataset.username,this.dataset.name)">\ud83d\udcde</button>
            </div>
          </div>`;
      }).join('');
  } catch(e) {
    console.error('loadContacts error', e);
  }
  loadChatContacts();
}


async function searchUsers(q) {
  const resultDiv = $('searchResults');
  if (!q || q.length < 1) { resultDiv.innerHTML=''; return; }
  try {
    const results = await fetch(`${HTTP_URL}/api/search/${encodeURIComponent(q)}`).then(r=>r.json());
    if (!results.length) {
      resultDiv.innerHTML='<div class="section-title">🔍 Search Results</div><div class="empty-state" style="padding:20px"><div class="empty-icon" style="font-size:32px">🔍</div><p>No users found</p></div>';
      return;
    }
    resultDiv.innerHTML = `<div class="section-title">🔍 Search Results</div>` +
      results.map(u => {
        const isCreator = u.role==='superadmin';
        const creatorBadge = isCreator ? `<span class="creator-badge">✦ Creator</span>` : '';
        
        let actionHtml = '';
        const isSelf = u.username === myUsername;
        const isFriend = friendsCache.some(f => f.username === u.username);
        const isPendingOut = pendingOutCache.some(f => f.username === u.username);
        const isPendingIn = pendingInCache.some(f => f.username === u.username);

        if (isSelf) {
          actionHtml = `<span style="color:var(--text2);font-size:13px">You</span>`;
        } else if (isFriend) {
          actionHtml = `<span style="color:var(--text2);font-size:13px;font-weight:700">Friends</span>`;
        } else if (isPendingOut || isPendingIn) {
          actionHtml = `<button class="action-btn add-btn" style="background:#E2E8F0;color:#718096" disabled>Pending</button>`;
        } else {
          actionHtml = `<button class="action-btn add-btn" id="addbtn-${u.username}" onclick="sendFriendRequest('${u.username}',this)">+ Add</button>`;
        }

        return `
          <div class="contact-item">
            <div class="contact-avatar ${isCreator?'creator-av':''}">
              ${u.avatar
                ? `<img src="${u.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" alt="${u.name}">`
                : `<span>${(u.username||u.name||'?').charAt(0).toUpperCase()}</span>`
              }
            </div>
            <div class="contact-info">
              <div class="contact-name">${u.name} ${creatorBadge}</div>
              <div class="contact-sub">@${u.username}</div>
            </div>
            <div class="contact-actions">
              ${actionHtml}
            </div>
          </div>`;
      }).join('');
  } catch(e) {}
}

function sendFriendRequest(toUsername, btnEl) {
  if (btnEl) { btnEl.textContent = 'Requested'; btnEl.disabled = true; btnEl.style.background='#E2E8F0'; btnEl.style.color='#718096'; }
  fetch(`${HTTP_URL}/api/friend-request`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ from: myUsername, to: toUsername })
  }).then(r=>r.json()).then(r=>{
    if(r.success) showToast('Friend request sent to @'+toUsername);
    else { alert(r.error || 'Could not send request'); if(btnEl){btnEl.textContent='+ Add';btnEl.disabled=false;btnEl.style.background='';btnEl.style.color='';} }
  }).catch(()=>{ alert('Error sending request'); if(btnEl){btnEl.textContent='+ Add';btnEl.disabled=false;} });
}

function acceptFriend(fromUsername) {
  fetch(`${HTTP_URL}/api/friend-accept`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ from: fromUsername, to: myUsername })
  }).then(r=>r.json()).then(r=>{
    if(r.success) showToast('You are now friends with @'+fromUsername);
    else alert(r.error || 'Could not accept');
    loadContacts();
  }).catch(()=>alert('Error accepting request'));
}

function initMainUI() {
  bindEl('searchUser', 'oninput', function() {
    const q = this.value.trim();
    if (q.length >= 1) searchUsers(q);
    else loadContacts();
  });
  onClick('callUserBtn', () => {
    const su = $('searchUser');
    const u = su ? su.value.trim().toLowerCase() : '';
    if (u) searchUsers(u);
  });
  bindEl('searchUser', 'onkeydown', e => { if (e.key === 'Enter') { const b = $('callUserBtn'); if (b) b.click(); } });
  onClick('tabContacts', function() {
    $('tabContacts').classList.add('active'); $('tabChat').classList.remove('active');
    $('contactsView').classList.remove('hide'); $('chatView').classList.add('hide');
    loadContacts();
  });
  onClick('tabChat', function() {
    $('tabChat').classList.add('active'); $('tabContacts').classList.remove('active');
    $('contactsView').classList.add('hide'); $('chatView').classList.remove('hide');
    loadChatContacts();
  });
  onClick('chatSendBtn', () => {
    const t = ($('chatInput') && $('chatInput').value || '').trim();
    if (!t) return;
    if (currentGroupId) {
      send({ type: 'group_chat', groupId: currentGroupId, text: t });
      appendGroupMsg(myName, t, true);
    } else if (chatTarget) {
      send({ type: 'chat', to: chatTarget, text: t });
      appendChatMsg(myUsername, t, true);
    }
    if ($('chatInput')) $('chatInput').value = '';
  });
  bindEl('chatInput', 'onkeydown', e => { if (e.key === 'Enter') { const b = $('chatSendBtn'); if (b) b.click(); } });
  initVoiceNoteBtn();
}

/* ═══════════════════════════════════════════
   CHAT
═══════════════════════════════════════════ */
function loadChatContacts(){
  if (!myUsername) return;
  fetch(`${HTTP_URL}/api/friends/${myUsername}`).then(r=>r.json()).then(data=>{
    const friends = data.friends || [];
    fetch(`${HTTP_URL}/api/messages/${myUsername}`).then(r=>r.json()).then(msgs=>{
      $('chatContactsList').innerHTML = friends.length === 0
        ? '<div class="empty-state"><div class="empty-icon">💬</div><p>No friends yet</p><small>Add family members first!</small></div>'
        : `<div class="section-title">💬 Messages</div>` + friends.map(u=>{
            const avatarContent = u.avatar ? `<img src="${u.avatar}" alt="${u.name}">` : u.name.charAt(0).toUpperCase();
            const msgCount = msgs[u.username] ? msgs[u.username].length : 0;
            return `
              <div class="contact-item" data-username="${u.username}" data-name="${u.name.replace(/"/g,'&quot;')}" onclick="openChat(this.dataset.username,this.dataset.name)">
                <div class="contact-avatar ${u.role==='superadmin'?'creator-av':''}">${avatarContent}</div>
                <div class="contact-info">
                  <div class="contact-name">${u.name}</div>
                  <div class="contact-sub">${msgCount ? msgCount+' messages' : 'Say hello! 👋'}</div>
                </div>
                <div style="color:var(--text2);font-size:22px">›</div>
              </div>`;
          }).join('');
    });
  });
}

/* ─ Update chat header for 1-to-1 chat ─ */
function setChatHeader(username, name, avatar, online, isGroup) {
  // Avatar
  const av = document.getElementById('chatHeaderAvatar');
  if (av) {
    if (avatar) {
      av.innerHTML = `<img src="${avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else if (isGroup) {
      av.innerHTML = '👨‍👩‍👧‍👦';
      av.style.background = 'linear-gradient(135deg,#FF9800,#F44336)';
      av.style.fontSize = '20px';
    } else {
      av.textContent = (name||'?').charAt(0).toUpperCase();
      av.style.background = 'linear-gradient(135deg,var(--primary),var(--primary-dark))';
      av.style.fontSize = '18px';
    }
  }
  // Name
  const cw = document.getElementById('chatWith');
  if (cw) cw.textContent = name || username;
  // Sub status
  const sub = document.getElementById('chatHeaderSub');
  if (sub) {
    if (isGroup) sub.textContent = 'Family Group';
    else sub.textContent = online ? '● Online' : '○ Offline';
    sub.style.color = (!isGroup && online) ? 'var(--green)' : 'var(--text2)';
  }
  // Buttons — group shows broadcast, 1-to-1 shows call
  const callBtn = document.getElementById('chatCallBtn');
  const broadcastBtn = document.getElementById('chatBroadcastBtn');
  if (callBtn) callBtn.style.display = isGroup ? 'none' : 'flex';
  if (broadcastBtn) broadcastBtn.style.display = isGroup ? 'flex' : 'none';
}

function openChat(username, name) {
  chatTarget = username;
  currentGroupId = null;
  const friend = friendsCache.find(f => f.username === username);
  const displayName = name || (friend && friend.name) || username;
  const avatar = friend ? friend.avatar : null;
  const online = friend ? friend.online : false;

  setChatHeader(username, displayName, avatar, online, false);

  // Switch to chat view
  const chatView = document.getElementById('chatView');
  const contactsView = document.getElementById('contactsView');
  if (chatView) chatView.classList.remove('hide');
  if (contactsView) contactsView.classList.add('hide');
  // Make sure tab state correct
  const tabChat = document.getElementById('tabChat');
  const tabContacts = document.getElementById('tabContacts');
  if (tabChat) tabChat.classList.add('active');
  if (tabContacts) tabContacts.classList.remove('active');

  document.getElementById('chatListView').classList.add('hide');
  document.getElementById('chatAreaView').classList.remove('hide');

  fetch(`${HTTP_URL}/api/messages/${myUsername}`).then(r => r.json()).then(data => {
    const msgs = data[username] || [];
    document.getElementById('chatMessages').innerHTML = msgs.map(m => {
      const time = m.ts ? new Date(m.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';
      return `<div class="chat-msg ${m.from === myUsername ? 'chat-mine' : 'chat-other'}">
        ${escHtml(m.text)}
        ${time ? `<span style="font-size:9px;opacity:.5;margin-left:6px;display:inline-block">${time}</span>` : ''}
      </div>`;
    }).join('');
    document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
  });
  const inp = document.getElementById('chatInput');
  if (inp) inp.focus();
}

function closeChatArea() {
  document.getElementById('chatAreaView').classList.add('hide');
  document.getElementById('chatListView').classList.remove('hide');
  chatTarget = ''; currentGroupId = null;
}

function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
/* ─ Chat header action buttons ─ */
function chatHeaderCall() {
  if (!chatTarget) return;
  const friend = friendsCache.find(f => f.username === chatTarget);
  startCall(chatTarget, friend ? friend.name : chatTarget);
}

function chatHeaderSOS() {
  // Send SOS — works from both 1-to-1 and group chat
  const name = document.getElementById('chatWith') ? document.getElementById('chatWith').textContent : '';
  if (!confirm(`🆘 Send SOS alert to ${name || 'family'}?\n\nThis will alert everyone with your location.`)) return;
  triggerSOS();
}

function chatHeaderBroadcast() {
  if (!currentGroupId) return;
  sendPaging(currentGroupId);
}

function openChatProfile() {
  // Tapping header name/avatar shows mini profile info
  if (currentGroupId) return; // group — no profile
  if (!chatTarget) return;
  const friend = friendsCache.find(f => f.username === chatTarget);
  if (!friend) return;
  const batInfo = batteryCache[chatTarget];
  const batText = batInfo ? `\nBattery: ${Math.round(batInfo.level*100)}%${batInfo.charging?' ⚡':''}` : '';
  const onlineText = friend.online ? '✅ Online now' : '⭕ Offline';
  alert(`👤 ${friend.name}\n@${friend.username}\n${onlineText}${batText}`);
}



function appendChatMsg(from,text,mine,voiceData,voiceMime){
  if(!mine&&chatTarget!==from)return;
  if(voiceData){appendVoiceMsg(from,voiceData,voiceMime,mine);return;}
  const div=document.createElement('div');
  div.className='chat-msg '+(mine?'chat-mine':'chat-other');
  div.textContent=text;
  $('chatMessages').appendChild(div);
  $('chatMessages').scrollTop=$('chatMessages').scrollHeight;
}

/* ═══════════════════════════════════════════
   VOICE NOTE
═══════════════════════════════════════════ */
let vnRecorder=null, vnStream=null, vnChunks=[], vnRecording=false;

function initVoiceNoteBtn() {
  onClick('voiceNoteBtn', async function() {
  if(!chatTarget)return;
  if(!vnRecording){
    try{
      vnStream=await navigator.mediaDevices.getUserMedia({audio:true});
      vnChunks=[];
      const mime=typeof MediaRecorder!=='undefined'&&MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/mp4';
      vnRecorder=new MediaRecorder(vnStream,{mimeType:mime});
      vnRecorder.ondataavailable=e=>{if(e.data&&e.data.size>0)vnChunks.push(e.data);};
      vnRecorder.onstop=async()=>{
        const blob=new Blob(vnChunks,{type:vnRecorder.mimeType});
        const reader=new FileReader();
        reader.onloadend=()=>{
          const b64=reader.result.split(',')[1];
          if(b64&&chatTarget){
            send({type:'chat',to:chatTarget,text:'🎤 [Voice Note]',voiceData:b64,voiceMime:vnRecorder.mimeType});
            appendVoiceMsg(myUsername,b64,vnRecorder.mimeType,true);
          }
        };
        reader.readAsDataURL(blob);
        if(vnStream)vnStream.getTracks().forEach(t=>t.stop());
        vnStream=null;
      };
      vnRecorder.start();
      vnRecording=true;
      this.textContent='⏹';
      this.classList.add('recording');
    }catch(e){alert('Mic denied: '+e.message);}
  } else {
    vnRecording=false;
    this.textContent='🎤';
    this.classList.remove('recording');
    if(vnRecorder&&vnRecorder.state!=='inactive')vnRecorder.stop();
  }
  });
}

function appendVoiceMsg(from,b64,mime,mine){
  if(!mine&&chatTarget!==from)return;
  const div=document.createElement('div');
  div.className='chat-msg '+(mine?'chat-mine':'chat-other');
  const blob=new Blob([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],{type:mime});
  const url=URL.createObjectURL(blob);
  const audio=document.createElement('audio');
  audio.controls=true;
  audio.src=url;
  audio.style.cssText='width:200px;height:36px;border-radius:20px';
  div.appendChild(audio);
  $('chatMessages').appendChild(div);
  $('chatMessages').scrollTop=$('chatMessages').scrollHeight;
}

/* ═══════════════════════════════════════════
   PROFILE / SETTINGS
═══════════════════════════════════════════ */
function openProfileModal(){
  const modal = $('profileModal');
  if(modal) modal.classList.remove('hide');
  fetch(`${HTTP_URL}/api/profile/${myUsername}`).then(r=>r.json()).then(u=>{
    const ni = $('profileNameInput');
    if(ni) ni.value = u.name || myName;
    const dobIn = $('profileDobInput');
    if(dobIn && u.dob) dobIn.value = u.dob;
    const preview = $('profileAvatarPreview');
    if(preview) {
      if(u.avatar){
        preview.innerHTML = `<img src="${u.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
        preview.setAttribute('data-b64', u.avatar);
      } else {
        preview.textContent = (myName||'?').charAt(0).toUpperCase();
      }
    }
  }).catch(()=>{});
}

function closeProfileModal(){
  const modal = $('profileModal');
  if(modal) modal.classList.add('hide');
}

function saveProfile(){
  const name = $('profileNameInput') ? $('profileNameInput').value.trim() : '';
  const dob = $('profileDobInput') ? $('profileDobInput').value || null : null;
  const preview = $('profileAvatarPreview');
  const avatar = preview ? (preview.getAttribute('data-b64') || null) : null;
  fetch(`${HTTP_URL}/api/profile`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ username: myUsername, name: name||undefined, avatar: avatar||undefined, dob: dob||undefined })
  }).then(r=>r.json()).then(r=>{
    if(r.success){
      if(name){ myName=r.user.name; localStorage.setItem('fc_name',r.user.name); }
      if(avatar){ myAvatar=avatar; }
      updateTopbar();
      showToast('✅ Profile updated!');
      closeProfileModal();
      loadContacts();
    } else { alert(r.error||'Update failed'); }
  }).catch(()=>alert('Error updating profile'));
}

// Handle avatar file input — no size limit
document.addEventListener('DOMContentLoaded', ()=>{
  initMainUI();
  const fileInput = $('avatarFileInput');
  if(fileInput) {
    fileInput.onchange = function(){
      const file = this.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onloadend = () => {
        const b64 = reader.result;
        const preview = $('profileAvatarPreview');
        if(preview){
          preview.innerHTML = `<img src="${b64}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
          preview.setAttribute('data-b64', b64);
        }
        // Also update topbar live
        myAvatar = b64;
        updateTopbar();
      };
      reader.readAsDataURL(file);
    };
  }
});

/* ═══════════════════════════════════════════
   SECTION HEADER STYLE (injected)
═══════════════════════════════════════════ */
(function injectStyles(){
  const style = document.createElement('style');
  style.textContent = `
.section-header{padding:6px 16px;font-size:9px;letter-spacing:3px;color:var(--neon-cyan);opacity:.6;text-transform:uppercase;font-family:'Orbitron',monospace;background:var(--bg2);border-bottom:1px solid rgba(0,245,255,0.07)}
.sa-badge{font-size:9px;color:#ffff00;letter-spacing:2px;margin-left:6px;text-shadow:0 0 8px #ffff00}
#toastMsg{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a1a2e;border:1px solid #00f5ff;color:#00f5ff;padding:10px 18px;font-size:12px;letter-spacing:1px;z-index:9999;border-radius:2px;pointer-events:none;transition:opacity .3s;opacity:0}
/* Call screen extra buttons */
.call-btns-row-2{display:flex;gap:20px;justify-content:center;align-items:center;margin-top:4px}
/* Call chat overlay */
#callChatOverlay{position:absolute;bottom:160px;left:12px;right:12px;background:#0d0d1a;border:1px solid rgba(0,245,255,0.3);z-index:200;max-height:260px;display:flex;flex-direction:column}
#callChatOverlay.hide{display:none!important}
#callChatOverlay .cco-header{padding:8px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(0,245,255,0.2);font-size:11px;color:var(--neon-cyan);font-family:'Orbitron',monospace;letter-spacing:2px}
#callChatMessages{flex:1;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:4px;min-height:80px}
#callChatInput{flex:1;background:rgba(0,245,255,0.05);border:1px solid rgba(0,245,255,0.2);padding:8px 10px;font-size:12px;color:var(--text);font-family:'Share Tech Mono',monospace;outline:none}
#callChatSendBtn{background:transparent;border:1px solid var(--neon-cyan);color:var(--neon-cyan);width:36px;height:36px;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.cco-input-row{display:flex;gap:6px;padding:6px 8px;border-top:1px solid rgba(0,245,255,0.15)}
/* Profile modal */
#profileModal{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:500;display:flex;align-items:center;justify-content:center}
#profileModal.hide{display:none!important}
#profileModalInner{background:#0d0d1a;border:1px solid rgba(0,245,255,0.3);padding:24px;width:90%;max-width:340px}
#profileModalInner h3{font-family:'Orbitron',monospace;font-size:12px;color:var(--neon-cyan);letter-spacing:3px;margin-bottom:16px}
#profileAvatarPreview{width:64px;height:64px;object-fit:cover;border:1px solid rgba(0,245,255,0.3);display:none;margin-bottom:10px}
  `;
  document.head.appendChild(style);
})();

/* ═══════════════════════════════════════════
   NEW FEATURES MODULE
═══════════════════════════════════════════ */

/* ── Toast (warm style) ── */
function showToast(message, duration=3500) {
  let t = document.getElementById('toastMsg');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastMsg';
    t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#fff;color:#2D3748;padding:12px 20px;font-size:14px;font-weight:700;z-index:9999;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.15);pointer-events:none;transition:opacity .3s;max-width:300px;text-align:center;font-family:Nunito,sans-serif';
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.style.opacity = '1';
  clearTimeout(t._to);
  t._to = setTimeout(() => { t.style.opacity = '0'; }, duration);
}

/* ── System Notification (push-style) ── */
function showSystemNotif(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/icon.svg', badge: '/icon.svg', tag: 'fc-notif' }); } catch(e) {}
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') {
        try { new Notification(title, { body, icon: '/icon.svg', badge: '/icon.svg', tag: 'fc-notif' }); } catch(e) {}
      }
    });
  }
}

/* ── Friend Request Notification (in-app banner + system notif) ── */
function showFriendRequestNotif(fromName, fromUsername) {
  // In-app banner (more prominent than toast)
  let banner = document.getElementById('friendReqBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'friendReqBanner';
    banner.style.cssText = 'position:fixed;top:70px;left:12px;right:12px;z-index:9998;font-family:Nunito,sans-serif;';
    document.body.appendChild(banner);
  }
  banner.innerHTML = `
    <div style="background:linear-gradient(135deg,#4A90D9,#2C6FAC);color:#fff;border-radius:16px;padding:14px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 4px 20px rgba(74,144,217,0.4);animation:slideDown .3s ease">
      <div style="width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">👤</div>
      <div style="flex:1">
        <div style="font-weight:800;font-size:14px">${fromName} sent you a friend request!</div>
        <div style="font-size:11px;opacity:.85">Go to contacts to accept or decline</div>
      </div>
      <button onclick="this.closest('#friendReqBanner').innerHTML=''" style="background:rgba(255,255,255,0.2);border:none;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center">✕</button>
    </div>`;
  setTimeout(() => { if (banner) banner.innerHTML = ''; }, 8000);
  // System notification
  showSystemNotif('🔔 New Friend Request', fromName + ' wants to connect with you on FamilyCall');
}



/* ── Battery Monitoring ── */
async function startBatteryMonitor() {
  if (!('getBattery' in navigator)) return;
  try {
    const battery = await navigator.getBattery();
    const report = () => {
      fetch(`${HTTP_URL}/api/battery`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ username: myUsername, level: battery.level, charging: battery.charging })
      }).catch(()=>{});
    };
    report();
    battery.addEventListener('levelchange', report);
    battery.addEventListener('chargingchange', report);
  } catch(e) {}
}

function updateBatteryDot(username, level, charging) {
  const dot = document.querySelector(`.battery-dot[data-user="${username}"]`);
  if (!dot) return;
  const pct = Math.round((level||0) * 100);
  dot.style.background = charging ? '#4CAF50' : pct > 30 ? '#4CAF50' : pct > 15 ? '#FF9800' : '#F44336';
  dot.title = `Battery: ${pct}%${charging?' ⚡':''}`;
}

function updateContactOnlineStatus(username, online) {
  const dots = document.querySelectorAll(`.status-dot[data-user="${username}"]`);
  dots.forEach(d => { d.className = `status-dot ${online?'dot-on':'dot-off'}`; d.dataset.user = username; });
}

/* ── Location Tracking ── */
function startLocationTracking() {
  if (!navigator.geolocation || locationPaused) return;
  if (locationWatchId) navigator.geolocation.clearWatch(locationWatchId);
  locationWatchId = navigator.geolocation.watchPosition(
    pos => {
      fetch(`${HTTP_URL}/api/location`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ username: myUsername, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy })
      }).catch(()=>{});
    },
    ()=>{},
    { enableHighAccuracy: true, maximumAge: 60000, timeout: 30000 }
  );
}

function pauseLocationTracking(minutes) {
  locationPaused = true;
  if (locationWatchId) { navigator.geolocation.clearWatch(locationWatchId); locationWatchId = null; }
  showToast(`📍 Location paused for ${minutes} min`);
  setTimeout(() => { locationPaused = false; startLocationTracking(); showToast('📍 Location sharing resumed'); }, minutes * 60 * 1000);
}

function updateFriendLocation(msg) {
  // Update map if open
  const mapEl = document.getElementById('locationMap');
  if (mapEl && window._leafletMap) {
    if (!window._locationMarkers) window._locationMarkers = {};
    const latlng = [msg.lat, msg.lng];
    if (window._locationMarkers[msg.username]) {
      window._locationMarkers[msg.username].setLatLng(latlng);
    } else {
      const marker = window.L.marker(latlng).addTo(window._leafletMap)
        .bindPopup(`<b>${msg.name||msg.username}</b>`);
      window._locationMarkers[msg.username] = marker;
    }
  }
}

/* ── SOS System ── */
let sosHoldTimer = null;
let sosCountdown = 0;

function initSOSButton() {
  const btn = document.getElementById('sosBtn');
  if (!btn) return;

  btn.addEventListener('touchstart', startSOSHold);
  btn.addEventListener('mousedown', startSOSHold);
  btn.addEventListener('touchend', cancelSOSHold);
  btn.addEventListener('mouseup', cancelSOSHold);
  btn.addEventListener('mouseleave', cancelSOSHold);
}

function startSOSHold() {
  sosCountdown = 3;
  const btn = document.getElementById('sosBtn');
  if (btn) btn.textContent = `🆘 Hold... ${sosCountdown}`;
  sosHoldTimer = setInterval(() => {
    sosCountdown--;
    if (btn) btn.textContent = sosCountdown > 0 ? `🆘 Hold... ${sosCountdown}` : '🆘 Sending...';
    if (sosCountdown <= 0) {
      clearInterval(sosHoldTimer);
      triggerSOS();
    }
  }, 1000);
}

function cancelSOSHold() {
  if (sosHoldTimer) { clearInterval(sosHoldTimer); sosHoldTimer = null; }
  const btn = document.getElementById('sosBtn');
  if (btn && sosCountdown > 0) btn.textContent = '🆘 SOS';
}

function triggerSOS() {
  const btn = document.getElementById('sosBtn');
  if (btn) btn.textContent = '🆘 SOS Sent!';
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    send({ type: 'sos_ws', lat, lng, groupId: myGroupsCache[0]?.id || null });
    activeSosId = `sos_${Date.now()}`;
    showSOSConfirmation(lat, lng);
  }, () => {
    send({ type: 'sos_ws', lat: null, lng: null, groupId: myGroupsCache[0]?.id || null });
    showSOSConfirmation(null, null);
  });
  // Re-enable after 10 seconds
  setTimeout(() => { if (btn) btn.textContent = '🆘 SOS'; }, 10000);
}

function showSOSConfirmation(lat, lng) {
  const overlay = document.getElementById('sosOverlay');
  if (!overlay) return;
  const mapsLink = lat ? `https://maps.google.com/?q=${lat},${lng}` : null;
  document.getElementById('sosLocationLink').href = mapsLink || '#';
  document.getElementById('sosLocationLink').style.display = mapsLink ? 'block' : 'none';
  overlay.classList.remove('hide');
}

function cancelSOS() {
  if (activeSosId) send({ type: 'sos_cancel', sosId: activeSosId });
  activeSosId = null;
  const overlay = document.getElementById('sosOverlay');
  if (overlay) overlay.classList.add('hide');
  showToast('✅ SOS cancelled — Family notified');
}

function handleSOSAlert(msg) {
  // Show alert overlay
  const overlay = document.getElementById('sosAlertOverlay');
  if (!overlay) { alert(`🆘 SOS from ${msg.name||msg.from}! ${msg.mapsLink||''}`); return; }
  document.getElementById('sosAlertName').textContent = msg.name || msg.from;
  const link = document.getElementById('sosAlertMapLink');
  if (link) { link.href = msg.mapsLink||'#'; link.style.display = msg.mapsLink?'inline-block':'none'; }
  overlay.classList.remove('hide');
  // Vibrate
  if ('vibrate' in navigator) navigator.vibrate([500,200,500,200,500]);
  // Play alert sound
  try {
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    for (let i=0;i<3;i++) {
      const osc = ctx.createOscillator(); const g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.frequency.value = 880; g.gain.value = 0.5;
      osc.start(ctx.currentTime + i*0.5);
      osc.stop(ctx.currentTime + i*0.5 + 0.3);
    }
  } catch(e) {}
}

function handleSOSCancelled(msg) {
  const overlay = document.getElementById('sosAlertOverlay');
  if (overlay) overlay.classList.add('hide');
  showToast(`✅ ${msg.name||msg.from}: Everything is OK, false alarm`);
}

/* ── Voice Status ── */
let vsRecorder = null, vsStream = null, vsChunks = [], vsRecording = false;

async function recordVoiceStatus() {
  const btn = document.getElementById('vsRecordBtn');
  if (vsRecording) {
    vsRecording = false;
    if (btn) btn.textContent = '🎙️ Record Status';
    if (vsRecorder && vsRecorder.state !== 'inactive') vsRecorder.stop();
    return;
  }
  try {
    vsStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    vsChunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4';
    vsRecorder = new MediaRecorder(vsStream, { mimeType: mime });
    vsRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) vsChunks.push(e.data); };
    vsRecorder.onstop = async () => {
      const blob = new Blob(vsChunks, { type: vsRecorder.mimeType });
      const reader = new FileReader();
      reader.onloadend = () => {
        const b64 = reader.result;
        fetch(`${HTTP_URL}/api/voice-status`, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ username: myUsername, audioData: b64, audioMime: vsRecorder.mimeType })
        }).then(()=>showToast('✅ Voice status posted! (24hr)')).catch(()=>{});
      };
      reader.readAsDataURL(blob);
      if (vsStream) vsStream.getTracks().forEach(t=>t.stop());
    };
    vsRecorder.start();
    vsRecording = true;
    if (btn) btn.textContent = '⏹️ Stop Recording';
    // Auto-stop after 60 seconds
    setTimeout(() => { if (vsRecording) { vsRecording=false; if(btn)btn.textContent='🎙️ Record Status'; if(vsRecorder&&vsRecorder.state!=='inactive')vsRecorder.stop(); } }, 60000);
  } catch(e) { alert('Mic denied: ' + e.message); }
}

async function playVoiceStatus(username) {
  try {
    const r = await fetch(`${HTTP_URL}/api/voice-status/${username}`).then(res=>res.json());
    if (!r.hasStatus) { showToast('No status available'); return; }
    const audio = new Audio(r.audioData);
} catch(e) {}
}

function showVoiceStatusRing(username, avatar, name) {
  const el = document.querySelector(`.contact-avatar[data-vsuser="${username}"]`);
  if (el) el.style.outline = '3px solid #FF9800';
}



/* ── Voice Broadcast (Paging) ── */
async function sendPaging(groupId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    recorder.ondataavailable = e => { if(e.data&&e.data.size>0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      const reader = new FileReader();
      reader.onloadend = () => {
        send({ type: 'paging', groupId, audioData: reader.result, audioMime: mime });
        showToast('📢 Broadcast sent!');
      };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(t=>t.stop());
    };
    recorder.start();
    showToast('🎙️ Recording... (5 sec)');
    setTimeout(() => recorder.stop(), 5000);
  } catch(e) { alert('Mic denied: ' + e.message); }
}

function handlePaging(msg) {
  // Play on speaker if not silent
  const audio = new Audio(msg.audioData);
  audio.play().catch(()=>{
    // Blocked — show flash overlay
    showToast(`📢 ${msg.fromName||msg.from} is announcing something! (check notifications)`);
  });
  showToast(`📢 Announcement from ${msg.fromName||msg.from}`);
}

/* ── Groups ── */
async function loadGroups() {
  try {
    const groups = await fetch(`${HTTP_URL}/api/groups/${myUsername}`).then(r=>r.json());
    myGroupsCache = groups;
    renderGroupsInUI(groups);
  } catch(e) {}
}

function renderGroupsInUI(groups) {
  const el = document.getElementById('groupsList');
  if (!el) return;
  if (!groups.length) { el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text2);font-size:13px">No groups yet<br><small>Create one below</small></div>'; return; }
  el.innerHTML = groups.map(g => `
    <div class="contact-item" onclick="openGroupChat('${g.id}','${g.name.replace(/'/g,"\\'")}')">
      <div class="contact-avatar" style="background:linear-gradient(135deg,#FF9800,#F44336);font-size:22px">👨‍👩‍👧‍👦</div>
      <div class="contact-info">
        <div class="contact-name">${g.name}</div>
        <div class="contact-sub">${g.role==='admin'?'👑 Admin':'Member'}</div>
      </div>
      ${g.role==='admin' ? `<button class="action-btn call-btn" onclick="event.stopPropagation();sendPaging('${g.id}')" title="Broadcast">📢</button>` : ''}
    </div>`).join('');
}

function openGroupChat(groupId, groupName) {
  currentGroupId = groupId;
  const chatWith = document.getElementById('chatWith');
  if (chatWith) chatWith.textContent = `👨‍👩‍👧‍👦 ${groupName}`;
  const listView = document.getElementById('chatListView');
  const areaView = document.getElementById('chatAreaView');
  if (listView) listView.classList.add('hide');
  if (areaView) areaView.classList.remove('hide');
  fetch(`${HTTP_URL}/api/group-messages/${groupId}`).then(r=>r.json()).then(msgs => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    chatMessages.innerHTML = msgs.map(m => `
      <div class="chat-msg ${m.from===myUsername?'chat-mine':'chat-other'}">
        ${m.from!==myUsername?`<div style="font-size:10px;margin-bottom:4px;opacity:.7">${m.from}</div>`:''}
        ${m.text||'🎤 Voice'}
      </div>`).join('');
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }).catch(()=>{});
}

function appendGroupMsg(fromName, text, mine, voiceData, voiceMime) {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (mine ? 'chat-mine' : 'chat-other');
  if (!mine) div.innerHTML = `<div style="font-size:10px;margin-bottom:4px;opacity:.7">${fromName}</div>`;
  if (voiceData) {
    const audio = document.createElement('audio');
    audio.controls = true; audio.src = voiceData;
    audio.style.cssText = 'width:200px;height:36px';
    div.appendChild(audio);
  } else {
    div.appendChild(document.createTextNode(text||''));
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/* ── Birthday Alert ── */
function showBirthdayAlert(name) {
  showToast(`🎂 Today is ${name}'s birthday! Wish them!`, 8000);
  // Show bigger alert
  const msg = `🎉 Happy Birthday ${name}! 🎂\n\nTap OK to send a surprise call!`;
  if (confirm(msg)) {
    const friend = friendsCache.find(f=>f.name===name);
    if (friend) startCall(friend.username, friend.name);
  }
}

/* ── Translation (MyMemory API - free) ── */
async function translateText(text, targetLang) {
  try {
    const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`);
    const data = await r.json();
    return data.responseData?.translatedText || text;
  } catch(e) { return text; }
}

async function translateMessage(btnEl, text) {
  btnEl.textContent = '⏳';
  const lang = navigator.language.startsWith('hi') ? 'hi' : 'hi'; // default Hindi
  const translated = await translateText(text, lang);
  const parent = btnEl.closest('.chat-msg');
  let transDiv = parent.querySelector('.translation');
  if (!transDiv) {
    transDiv = document.createElement('div');
    transDiv.className = 'translation';
    transDiv.style.cssText = 'font-size:11px;margin-top:4px;opacity:.8;border-top:1px solid rgba(0,0,0,0.1);padding-top:4px';
    parent.appendChild(transDiv);
  }
  transDiv.textContent = '🌐 ' + translated;
  btnEl.textContent = '🌐';
}

/* ── Location Map (Leaflet.js - free) ── */
function openLocationMap() {
  const mapModal = document.getElementById('locationMapModal');
  if (!mapModal) return;
  mapModal.classList.remove('hide');

  if (!window._leafletMap) {
    // Load Leaflet dynamically
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => initMap();
    document.head.appendChild(script);
  } else {
    refreshMapLocations();
  }
}

function initMap() {
  const mapEl = document.getElementById('locationMap');
  if (!mapEl || !window.L) return;
  window._leafletMap = window.L.map('locationMap').setView([20.5937, 78.9629], 5);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap'
  }).addTo(window._leafletMap);
  window._locationMarkers = {};
  refreshMapLocations();
}

async function refreshMapLocations() {
  try {
    const locs = await fetch(`${HTTP_URL}/api/locations/${myUsername}`).then(r=>r.json());
    for (const loc of locs) {
      if (!loc.lat) continue;
      const latlng = [loc.lat, loc.lng];
      const popupText = `<b>${loc.name||loc.username}</b><br>${new Date(loc.ts).toLocaleTimeString()}`;
      if (window._locationMarkers && window._locationMarkers[loc.username]) {
        window._locationMarkers[loc.username].setLatLng(latlng).setPopupContent(popupText);
      } else if (window._leafletMap && window.L) {
        const m = window.L.marker(latlng).addTo(window._leafletMap).bindPopup(popupText);
        if (!window._locationMarkers) window._locationMarkers = {};
        window._locationMarkers[loc.username] = m;
      }
    }
    if (window._leafletMap) window._leafletMap.invalidateSize();
  } catch(e) {}
}

function closeLocationMap() {
  const mapModal = document.getElementById('locationMapModal');
  if (mapModal) mapModal.classList.add('hide');
}

function openVoiceStatusModal() {
  const modal = document.getElementById('voiceStatusModal');
  if (!modal) return;
  modal.classList.remove('hide');
  // Load friends' statuses
  fetch(`${HTTP_URL}/api/voice-statuses/${myUsername}`).then(r=>r.json()).then(statuses => {
    const el = document.getElementById('vsStatusList');
    if (!el) return;
    if (!statuses.length) { el.innerHTML='<p style="font-size:12px;color:var(--text2);text-align:center">No family statuses yet</p>'; return; }
    el.innerHTML = statuses.map(s => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px;background:#F8F9FA;border-radius:12px;margin-bottom:6px;cursor:pointer" onclick="playVoiceStatus('${s.username}')">
        <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#FF9800,#F44336);display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:16px;border:3px solid #FF9800">${s.name.charAt(0)}</div>
        <div><div style="font-weight:700;font-size:14px">${s.name}</div><div style="font-size:11px;color:var(--text2)">Tap to play</div></div>
        <span style="margin-left:auto;font-size:20px">▶️</span>
      </div>`).join('');
  }).catch(()=>{});
}

function openGroupsModal() {
  const modal = document.getElementById('groupsModal');
  if (modal) { modal.classList.remove('hide'); loadGroups(); }
}

async function createGroup() {
  const nameInput = document.getElementById('newGroupName');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) { alert('Enter group name'); return; }
  const members = friendsCache.map(f=>f.username);
  try {
    const r = await fetch(`${HTTP_URL}/api/groups/create`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, createdBy: myUsername, members })
    }).then(res=>res.json());
    if (r.success) {
      showToast('✅ Group created!');
      if (nameInput) nameInput.value = '';
      loadGroups();
    }
  } catch(e) { alert('Error creating group'); }
}

/* ── declineFriend ── */
function declineFriend(fromUsername) {
  fetch(`${HTTP_URL}/api/friend-decline`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ from: fromUsername, to: myUsername })
  }).catch(()=>{});
  showToast('Request declined');
  loadContacts();
}

/* ═══════════════════════════════════════════
   ADMIN PANEL (superadmin only)
═══════════════════════════════════════════ */
function showAdminButton() {
  const btn = document.getElementById('adminPanelBtn');
  if (btn && myRole === 'superadmin') btn.style.display = 'inline-flex';
}

async function openAdminPanel() {
  if (myRole !== 'superadmin') return;
  const modal = document.getElementById('adminModal');
  if (!modal) return;
  modal.classList.remove('hide');
  const listEl = document.getElementById('adminUserList');
  if (!listEl) return;
  listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text2)">Loading...</div>';
  try {
    const users = await fetch(`${HTTP_URL}/api/users`).then(r => r.json());
    if (!users.length) { listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text2)">No users found</div>'; return; }
    listEl.innerHTML = users.map(u => {
      const isSelf = u.username === 'anshul';
      const avatarBg = u.role === 'superadmin' ? 'linear-gradient(135deg,#FFD700,#FFA500)' : 'linear-gradient(135deg,var(--primary),var(--primary-dark))';
      const avatarLetter = u.avatar
        ? `<img src="${u.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
        : u.name.charAt(0).toUpperCase();
      return `
        <div style="display:flex;align-items:center;padding:10px 4px;border-bottom:1px solid #EDF2F7;gap:10px">
          <div style="width:44px;height:44px;border-radius:50%;background:${avatarBg};display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;flex-shrink:0;overflow:hidden">${avatarLetter}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:700;color:var(--text)">${u.name} ${u.role==='superadmin'?'👑':''}</div>
            <div style="font-size:12px;color:var(--text2)">@${u.username} · ${u.online?'<span style="color:var(--green)">● Online</span>':'<span style="color:#CBD5E0">○ Offline</span>'}</div>
          </div>
          ${isSelf
            ? `<div style="font-size:11px;color:var(--gold2);font-weight:700;padding:6px 12px;background:#FFF8E1;border-radius:10px">Protected</div>`
            : `<button onclick="adminDeleteUser('${u.username}','${u.name.replace(/'/g,"\\'")}',this)"
                style="background:#FFEBEE;color:#C62828;border:1.5px solid #EF9A9A;border-radius:10px;padding:7px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:Nunito,sans-serif;flex-shrink:0;transition:all .2s">
                🗑️ Delete
              </button>`
          }
        </div>`;
    }).join('');
  } catch(e) {
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#F44336">Error loading users</div>';
  }
}

async function adminDeleteUser(username, name, btnEl) {
  if (myRole !== 'superadmin') return;
  if (!confirm(`⚠️ Delete @${username} (${name})?\n\nThis will permanently delete their account, messages, and all data.\n\nThis CANNOT be undone!`)) return;
  // Double confirm for safety
  if (!confirm(`Final confirm: DELETE @${username}?`)) return;
  btnEl.textContent = '⏳ Deleting...';
  btnEl.disabled = true;
  try {
    const r = await fetch(`${HTTP_URL}/api/admin/delete-user`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ requestedBy: myUsername, targetUsername: username })
    }).then(res => res.json());
    if (r.success) {
      showToast(`✅ @${username} deleted`);
      // Remove row from UI
      btnEl.closest('div[style*="border-bottom"]').remove();
      loadContacts();
    } else {
      alert(r.error || 'Delete failed');
      btnEl.textContent = '🗑️ Delete';
      btnEl.disabled = false;
    }
  } catch(e) {
    alert('Error deleting user');
    btnEl.textContent = '🗑️ Delete';
    btnEl.disabled = false;
  }
}



/* ═══════════════════════════════════════════
   INIT
═══════════════════════════════════════════ */
(async()=>{
  const u=localStorage.getItem('fc_user'),n=localStorage.getItem('fc_name'),r=localStorage.getItem('fc_role')||'user';
  if(u&&n){
    try{
      const res=await fetch(`${HTTP_URL}/api/user/${u}`);
      if(res.ok){
        connectApp(u,n,r);
      } else{ localStorage.removeItem('fc_user');localStorage.removeItem('fc_name');localStorage.removeItem('fc_role'); }
    }catch(e){ localStorage.removeItem('fc_user');localStorage.removeItem('fc_name');localStorage.removeItem('fc_role'); }
  }
  // Request notification permission
  if('Notification' in window && Notification.permission==='default') Notification.requestPermission();
})();

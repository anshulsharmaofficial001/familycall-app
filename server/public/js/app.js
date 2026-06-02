// FamilyCall v7 - PCM16 pure audio + friend system + superadmin + notifications
'use strict';
const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL   = `${WS_PROTO}//${location.host}`;
const HTTP_URL = location.origin;

let ws = null, currentCallId = null, timerInterval = null, seconds = 0;
let myUsername = '', myName = '', myRole = 'user', chatTarget = '', refreshInterval = null;

/* ── Audio ── */
let micStream     = null;
let audioStarted  = false;
let isMuted       = false;
let isOnHold      = false;

/* Capture via AudioContext → PCM16 (no MediaRecorder, no codec issues) */
let captureCtx    = null;
let captureSource = null;
let captureProc   = null;
let captureNode   = null;
let captureGain   = null;

/* Playback via AudioContext → scheduled PCM16 */
let playCtx       = null;
let playNextTime  = 0;
let playNode      = null;
let playGain      = null;
let playMode      = 'buffer';
let txAudioChunks = 0;
let rxAudioChunks = 0;
let playedAudioChunks = 0;

/* Speaker / output routing */
let speakerActive = false;

/* Ring */
let ringCtx = null, ringGain = null, ringOsc = null, ringing = false;

const $ = id => document.getElementById(id);

/* ── State ── */
let callerInfoStore = {name:'',username:'',avatar:null};
let friendsCache = [];
let myAvatar = null;
let myRole = '';

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
  const statusLine = $('userStatusLine');
  if (statusLine) {
    if (myRole === 'superadmin') {
      statusLine.innerHTML = `<span id="myName">${myName}</span> <span style="color:var(--gold);font-family:Pacifico,cursive;font-size:11px;animation:creator-glow 2s infinite">✦ Creator</span>`;
    } else {
      statusLine.innerHTML = `<span id="myName">${myName}</span> · @<span id="myUser">${myUsername}</span>`;
    }
  }
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
   AUTH
═══════════════════════════════════════════ */
$('showRegister').onclick = e => { e.preventDefault(); $('loginPage').classList.add('hide'); $('registerPage').classList.remove('hide'); };
$('showLogin').onclick    = e => { e.preventDefault(); $('registerPage').classList.add('hide'); $('loginPage').classList.remove('hide'); };

$('loginBtn').onclick = () => {
  const u=$('loginUser').value.trim().toLowerCase(), p=$('loginPass').value;
  if (!u||!p) return alert('Enter username and password');
  $('loginBtn').textContent='Signing in…'; $('loginBtn').disabled=true;
  myUsername=u;
  slog('login_click',{username:u});
  fetch(`${HTTP_URL}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})})
    .then(r=>r.ok?r.json():r.json().then(e=>{throw new Error(e.error||'Login failed');}))
    .then(r=>{
      slog('login_success',{username:r.user.username});
      localStorage.setItem('fc_user',r.user.username);
      localStorage.setItem('fc_name',r.user.name);
      localStorage.setItem('fc_role',r.user.role||'user');
      connectApp(r.user.username,r.user.name,r.user.role||'user');
    })
    .catch(e=>{slog('login_failed',{username:u,err:e.message});$('loginBtn').textContent='Sign In';$('loginBtn').disabled=false;alert(e.message);});
};

$('regBtn').onclick = () => {
  const u=$('regUser').value.trim().toLowerCase(),n=$('regName').value.trim(),p=$('regPass').value;
  if (!u||!n||!p) return alert('Fill all fields');
  if (u.includes(' ')) return alert('No spaces in username');
  $('regBtn').textContent='Creating…'; $('regBtn').disabled=true;
  myUsername=u;
  slog('register_click',{username:u,name:n});
  fetch(`${HTTP_URL}/api/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,name:n,password:p})})
    .then(r=>r.ok?r.json():r.json().then(e=>{throw new Error(e.error||'Registration failed');}))
    .then(r=>{
      slog('register_success',{username:u});
      localStorage.setItem('fc_user',u);
      localStorage.setItem('fc_name',n);
      localStorage.setItem('fc_role',r.user&&r.user.role?r.user.role:'user');
      connectApp(u,n,'user');
    })
    .catch(e=>{slog('register_failed',{username:u,err:e.message});$('regBtn').textContent='Create Account';$('regBtn').disabled=false;alert(e.message);});
};

$('logoutBtn').onclick = () => {
  localStorage.removeItem('fc_user'); localStorage.removeItem('fc_name'); localStorage.removeItem('fc_role');
  if (ws) ws.close();
  $('mainPage').classList.add('hide'); $('loginPage').classList.remove('hide');
  $('loginUser').value=''; $('loginPass').value='';
};

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
  }).catch(()=>{ updateTopbar(); });
  ws=new WebSocket(`${WS_URL}/ws?username=${encodeURIComponent(username)}&name=${encodeURIComponent(name)}`);
  ws.onopen=()=>{slog('ws_open',{});loadContacts();refreshInterval=setInterval(loadContacts,8000);};
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
      showFriendRequestToast(msg.fromName || msg.from);
      break;

    case 'friend_request_sent':
      loadContacts();
      break;

    case 'friend_accepted':
      loadContacts();
      showToast('✅ ' + (msg.withName || msg.with) + ' is now your friend!');
      break;

    case 'error': alert(msg.message); break;
  }
}

function send(obj){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}

function showToast(msg) {
  let t = document.getElementById('toastMsg');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastMsg';
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a1a2e;border:1px solid #00f5ff;color:#00f5ff;padding:10px 18px;font-size:12px;letter-spacing:1px;z-index:9999;border-radius:2px;pointer-events:none;transition:opacity .3s';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._to);
  t._to = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

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
      await captureCtx.audioWorklet.addModule('/js/pcm-recorder.js?v=1');
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
    playCtx=new(window.AudioContext||window.webkitAudioContext)({sampleRate:SAMPLE_RATE});
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
      await playCtx.audioWorklet.addModule('/js/audio-processor.js?v=2');
      playNode=new AudioWorkletNode(playCtx,'pcm-player',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1]});
      playNode.connect(playGain);
      playMode='worklet';
      slog('playback_mode',{mode:playMode,state:playCtx.state,sampleRate:playCtx.sampleRate});
    }catch(e){ playMode='buffer'; slog('playworklet_failed',{err:e.message}); }
  }
  unlockAudioOutput();
}

async function receiveAudio(b64, sourceRate){
  rxAudioChunks++;
  if(rxAudioChunks<=5||rxAudioChunks%25===0)slog('rx_audio_chunk',{chunk:rxAudioChunks,b64Length:b64.length,sourceRate,playState:playCtx?playCtx.state:'none',visibility:document.visibilityState});
  await ensurePlayCtx();
  if(!playCtx||playCtx.state==='closed'){slog('rx_drop_no_playctx',{chunk:rxAudioChunks});return;}
  let pcm;
  try{
    const bin=atob(b64);
    const buf=new ArrayBuffer(bin.length);
    const view=new Uint8Array(buf);
    for(let i=0;i<bin.length;i++)view[i]=bin.charCodeAt(i);
    pcm=new Int16Array(buf);
  }catch(e){slog('rx_b64_fail',{err:e.message});return;}
  const f32=new Float32Array(pcm.length);
  for(let i=0;i<pcm.length;i++)f32[i]=pcm[i]/(pcm[i]<0?0x8000:0x7FFF);
  if(playNode){
    try{
      const out = resampleFloat32(f32, sourceRate, playCtx.sampleRate);
      playNode.port.postMessage({type:'chunk', samples: out}, [out.buffer]);
      playedAudioChunks++;
      if(playedAudioChunks<=5||playedAudioChunks%25===0)slog('play_audio_queued',{chunk:playedAudioChunks,samples:out.length,sourceRate,ctxRate:playCtx.sampleRate,state:playCtx.state,mode:playMode});
      return;
    }catch(e){ slog('play_worklet_queue_failed',{err:e.message,chunk:rxAudioChunks,state:playCtx.state}); }
  }
  try{
    const ab=playCtx.createBuffer(1,f32.length,Number(sourceRate)||SAMPLE_RATE);
    ab.copyToChannel(f32,0);
    const src=playCtx.createBufferSource();
    src.buffer=ab;
    src.connect(playGain || playCtx.destination);
    const now=playCtx.currentTime;
    if(playNextTime<now+0.01)playNextTime=now+0.05;
    src.start(playNextTime);
    playNextTime+=ab.duration;
    playedAudioChunks++;
    if(playedAudioChunks<=5||playedAudioChunks%25===0)slog('play_audio_scheduled',{chunk:playedAudioChunks,duration:ab.duration,state:playCtx.state});
  }catch(e){ slog('play_audio_failed',{err:e.message,chunk:rxAudioChunks,state:playCtx.state}); }
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

$('callEndBtn').onclick=()=>{
  if(currentCallId)send({type:'end_call',callId:currentCallId});
  endCallUI();
};

$('acceptBtn').onclick=async()=>{
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
};

$('declineBtn').onclick=()=>{
  stopRing();
  if(currentCallId)send({type:'reject_call',callId:currentCallId});
  currentCallId=null;
  $('incomingPage').classList.add('hide');
  $('mainPage').classList.remove('hide');
};

$('muteBtn').onclick=function(){
  isMuted=!isMuted;
  this.querySelector('.ctrl-btn-circle').textContent=isMuted?'🔇':'🎙️';
  this.querySelector('span').textContent=isMuted?'Unmute':'Mute';
  this.classList.toggle('active',isMuted);
};

// Hold button
$('holdBtn').onclick=function(){
  isOnHold=!isOnHold;
  this.querySelector('.ctrl-btn-circle').textContent=isOnHold?'▶':'⏸';
  this.querySelector('span').textContent=isOnHold?'Resume':'Hold';
  this.classList.toggle('active',isOnHold);
  $('callStatusText').textContent=isOnHold?'On Hold':'Connected';
};

// Speaker button — route audio to speaker via setSinkId if available
$('speakerBtn').onclick=function(){
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
};

// Message button on call screen — opens mini chat overlay
$('callMsgBtn').onclick=function(){
  const overlay = $('callChatOverlay');
  if(overlay){
    overlay.classList.toggle('hide');
    if(!overlay.classList.contains('hide') && callChatTarget){
      $('callChatTarget').textContent = $('callDisplayName').textContent;
      $('callChatMessages').innerHTML = '';
    }
  }
};

$('callChatClose').onclick=function(){
  $('callChatOverlay').classList.add('hide');
};

$('callChatSendBtn').onclick=function(){
  const inp = $('callChatInput');
  const t = inp.value.trim();
  if(!t) return;
  const target = callChatTarget || chatTarget;
  if(!target){ alert('No chat target'); return; }
  send({type:'chat', to:target, text:t});
  const div = document.createElement('div');
  div.className='chat-msg chat-mine';
  div.textContent=t;
  $('callChatMessages').appendChild(div);
  $('callChatMessages').scrollTop=$('callChatMessages').scrollHeight;
  inp.value='';
};

$('callChatInput').onkeydown=e=>{ if(e.key==='Enter')$('callChatSendBtn').click(); };

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
  if(hb){hb.querySelector('.ctrl-btn-circle').textContent='⏸';hb.querySelector('span').textContent='Hold';hb.classList.remove('active');}
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

    const list = $('contactsList');
    const pendingDiv = $('pendingRequests');

    // Pending incoming
    if (pendingIn.length > 0) {
      pendingDiv.innerHTML = `<div class="section-title">🔔 Friend Requests</div>` +
        pendingIn.map(u => `
          <div class="req-item">
            <div class="contact-avatar" style="width:38px;height:38px;font-size:14px;margin-right:10px;flex-shrink:0">${u.name ? u.name.charAt(0).toUpperCase() : u.charAt(0).toUpperCase()}</div>
            <div class="req-name">${u.name||u} <span style="font-size:11px;color:var(--text2)">@${u.username||u}</span></div>
            <div class="req-btns">
              <button class="req-accept" onclick="acceptFriend('${u.username||u}')">✓ Accept</button>
              <button class="req-decline" onclick="declineFriend('${u.username||u}')">✕</button>
            </div>
          </div>`).join('');
    } else {
      pendingDiv.innerHTML = '';
    }

    if (!friends.length) {
      list.innerHTML = '';
      $('noContacts').classList.remove('hide');
      return;
    }
    $('noContacts').classList.add('hide');

    list.innerHTML = `<div class="section-title">👨‍👩‍👧‍👦 Family & Friends</div>` +
      friends.map(u => {
        const isCreator = u.role === 'superadmin';
        const avatarClass = isCreator ? 'contact-avatar creator-av' : 'contact-avatar';
        const avatarContent = u.avatar
          ? `<img src="${u.avatar}" alt="${u.name}">`
          : u.name.charAt(0).toUpperCase();
        const creatorBadge = isCreator
          ? `<span class="creator-badge">✦ Creator</span>` : '';
        const statusText = u.online
          ? `<span style="color:var(--green);font-weight:700">● Online</span>`
          : `<span style="color:var(--text2)">○ Offline</span>`;
        return `
          <div class="contact-item">
            <div class="${avatarClass}">
              ${avatarContent}
              <span class="status-dot ${u.online?'dot-on':'dot-off'}"></span>
            </div>
            <div class="contact-info">
              <div class="contact-name">${u.name} ${creatorBadge}</div>
              <div class="contact-sub">@${u.username} · ${statusText}</div>
            </div>
            <div class="contact-actions">
              <button class="action-btn chat-btn-sm" data-username="${u.username}" data-name="${u.name.replace(/"/g,'&quot;')}" onclick="openChat(this.dataset.username,this.dataset.name)">💬</button>
              <button class="action-btn call-btn" data-username="${u.username}" data-name="${u.name.replace(/"/g,'&quot;')}" onclick="startCall(this.dataset.username,this.dataset.name)">📞</button>
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
        const avatarContent = u.avatar ? `<img src="${u.avatar}" alt="${u.name}">` : u.name.charAt(0).toUpperCase();
        const creatorBadge = isCreator ? `<span class="creator-badge">✦ Creator</span>` : '';
        return `
          <div class="contact-item">
            <div class="contact-avatar ${isCreator?'creator-av':''}">${avatarContent}</div>
            <div class="contact-info">
              <div class="contact-name">${u.name} ${creatorBadge}</div>
              <div class="contact-sub">@${u.username}</div>
            </div>
            <div class="contact-actions">
              <button class="action-btn add-btn" onclick="sendFriendRequest('${u.username}')">+ Add</button>
            </div>
          </div>`;
      }).join('');
  } catch(e) {}
}

function sendFriendRequest(toUsername) {
  fetch(`${HTTP_URL}/api/friend-request`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ from: myUsername, to: toUsername })
  }).then(r=>r.json()).then(r=>{
    if(r.success) showToast('Friend request sent to @'+toUsername);
    else alert(r.error || 'Could not send request');
    loadContacts();
  }).catch(()=>alert('Error sending request'));
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

// Search bar wiring
$('searchUser').oninput = function() {
  const q = this.value.trim();
  if (q.length >= 1) searchUsers(q);
  else loadContacts();
};
$('callUserBtn').onclick=()=>{
  const u=$('searchUser').value.trim().toLowerCase();
  if(u) searchUsers(u);
};
$('searchUser').onkeydown=e=>{ if(e.key==='Enter') $('callUserBtn').click(); };

/* ═══════════════════════════════════════════
   TABS
═══════════════════════════════════════════ */
$('tabContacts').onclick=function(){
  $('tabContacts').classList.add('active');$('tabChat').classList.remove('active');
  $('contactsView').classList.remove('hide');$('chatView').classList.add('hide');
  loadContacts();
};
$('tabChat').onclick=function(){
  $('tabChat').classList.add('active');$('tabContacts').classList.remove('active');
  $('contactsView').classList.add('hide');$('chatView').classList.remove('hide');
  loadChatContacts();
};

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

function openChat(username,name){
  chatTarget=username;
  const friend = friendsCache.find(f=>f.username===username);
  const displayName = name || (friend&&friend.name) || username;
  $('chatWith').textContent = '💬 ' + displayName;
  $('chatListView').classList.add('hide');$('chatAreaView').classList.remove('hide');
  fetch(`${HTTP_URL}/api/messages/${myUsername}`).then(r=>r.json()).then(data=>{
    $('chatMessages').innerHTML=(data[username]||[]).map(m=>`<div class="chat-msg ${m.from===myUsername?'chat-mine':'chat-other'}">${escHtml(m.text)}</div>`).join('');
    $('chatMessages').scrollTop=$('chatMessages').scrollHeight;
  });
  $('chatInput').focus();
}

function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function closeChatArea(){$('chatAreaView').classList.add('hide');$('chatListView').classList.remove('hide');chatTarget='';}

$('chatSendBtn').onclick=()=>{
  const t=$('chatInput').value.trim();
  if(!t||!chatTarget)return;
  send({type:'chat',to:chatTarget,text:t});
  appendChatMsg(myUsername,t,true);
  $('chatInput').value='';
};
$('chatInput').onkeydown=e=>{if(e.key==='Enter')$('chatSendBtn').click();};

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

$('voiceNoteBtn').onclick=async function(){
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
};

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
  const preview = $('profileAvatarPreview');
  const avatar = preview ? (preview.getAttribute('data-b64') || null) : null;
  fetch(`${HTTP_URL}/api/profile`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ username: myUsername, name: name||undefined, avatar: avatar||undefined })
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
   INIT
═══════════════════════════════════════════ */
(async()=>{
  const u=localStorage.getItem('fc_user'),n=localStorage.getItem('fc_name'),r=localStorage.getItem('fc_role')||'user';
  if(u&&n){
    try{
      const res=await fetch(`${HTTP_URL}/api/user/${u}`);
      if(res.ok) connectApp(u,n,r);
      else{ localStorage.removeItem('fc_user');localStorage.removeItem('fc_name');localStorage.removeItem('fc_role'); }
    }catch(e){ localStorage.removeItem('fc_user');localStorage.removeItem('fc_name');localStorage.removeItem('fc_role'); }
  }
})();

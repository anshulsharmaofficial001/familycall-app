// FamilyCall v6 - PCM16 pure audio
'use strict';
const WS_PROTO = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL   = `${WS_PROTO}//${location.host}`;
const HTTP_URL = location.origin;

let ws = null, currentCallId = null, timerInterval = null, seconds = 0;
let myUsername = '', myName = '', chatTarget = '', refreshInterval = null;

/* ── Audio ── */
let micStream     = null;
let audioStarted  = false;
let isMuted       = false;

/* Capture via AudioContext → PCM16 (no MediaRecorder, no codec issues) */
let captureCtx    = null;
let captureSource = null;
let captureProc   = null;

/* Playback via AudioContext → scheduled PCM16 */
let playCtx       = null;
let playNextTime  = 0;

/* Ring */
let ringCtx = null, ringGain = null, ringOsc = null, ringing = false;

const $ = id => document.getElementById(id);

/* ── Logger ── */
function slog(event, data) {
  if (!myUsername) return;
  fetch(`${HTTP_URL}/api/log`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ username: myUsername, event, data })
  }).catch(()=>{});
}

/* ═══════════════════════════════════════════
   AUTH
═══════════════════════════════════════════ */
$('showRegister').onclick = e => { e.preventDefault(); $('loginPage').classList.add('hide'); $('registerPage').classList.remove('hide'); };
$('showLogin').onclick    = e => { e.preventDefault(); $('registerPage').classList.add('hide'); $('loginPage').classList.remove('hide'); };

$('loginBtn').onclick = () => {
  const u=$('loginUser').value.trim().toLowerCase(), p=$('loginPass').value;
  if (!u||!p) return alert('Enter username and password');
  $('loginBtn').textContent='Signing in…'; $('loginBtn').disabled=true;
  fetch(`${HTTP_URL}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})})
    .then(r=>r.ok?r.json():r.json().then(e=>{throw new Error(e.error||'Login failed');}))
    .then(r=>{localStorage.setItem('fc_user',r.user.username);localStorage.setItem('fc_name',r.user.name);connectApp(r.user.username,r.user.name);})
    .catch(e=>{$('loginBtn').textContent='Sign In';$('loginBtn').disabled=false;alert(e.message);});
};

$('regBtn').onclick = () => {
  const u=$('regUser').value.trim().toLowerCase(),n=$('regName').value.trim(),p=$('regPass').value;
  if (!u||!n||!p) return alert('Fill all fields');
  if (u.includes(' ')) return alert('No spaces in username');
  $('regBtn').textContent='Creating…'; $('regBtn').disabled=true;
  fetch(`${HTTP_URL}/api/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,name:n,password:p})})
    .then(r=>r.ok?r.json():r.json().then(e=>{throw new Error(e.error||'Registration failed');}))
    .then(()=>{localStorage.setItem('fc_user',u);localStorage.setItem('fc_name',n);connectApp(u,n);})
    .catch(e=>{$('regBtn').textContent='Create Account';$('regBtn').disabled=false;alert(e.message);});
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
  ws=new WebSocket(`${WS_URL}/ws?username=${encodeURIComponent(username)}&name=${encodeURIComponent(name)}`);
  ws.onopen=()=>{loadContacts();refreshInterval=setInterval(loadContacts,5000);};
  ws.onmessage=e=>handleMsg(JSON.parse(e.data));
  ws.onclose=()=>{if(refreshInterval)clearInterval(refreshInterval);setTimeout(()=>location.reload(),2000);};
}

function handleMsg(msg) {
  switch(msg.type) {
    case 'welcome': break;
    case 'pending_messages': loadChatContacts(); break;

    case 'incoming_call':
      if (currentCallId){send({type:'reject_call',callId:msg.callId});return;}
      currentCallId=msg.callId;
      $('incomingName').textContent=msg.callerName;
      $('incomingAvatarLetter').textContent=msg.callerName.charAt(0).toUpperCase();
      $('incomingPage').classList.remove('hide');
      $('mainPage').classList.add('hide');
      startRing();
      break;

    case 'call_created':
      currentCallId=msg.callId;
      $('callStatusText').textContent='Ringing…';
      $('callTimer').classList.add('hide');
      startCapture();
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
      if (currentCallId===msg.callId && msg.data) receiveAudio(msg.data);
      break;

    case 'chat':
      appendChatMsg(msg.from,msg.text,false); loadChatContacts();
      break;

    case 'error': alert(msg.message); break;
  }
}

function send(obj){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}

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
   
   Why this works on ALL devices:
   - No MediaRecorder, no codec, no MIME type
   - Raw PCM16 samples — universally decodable
   - ScriptProcessor connected to silent gain node so mobile doesn't kill it
═══════════════════════════════════════════ */
const SAMPLE_RATE = 16000;
const PROC_BUFFER = 4096; // ~256ms per chunk at 16kHz

async function startCapture(){
  if(audioStarted)return;
  audioStarted=true;

  try{
    micStream=await navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}
    });
  }catch(e){
    alert('Mic denied: '+e.message);
    audioStarted=false;
    slog('mic_denied',{err:e.message});
    return;
  }

  // Create AudioContext at device native rate, then downsample to 16kHz
  captureCtx=new(window.AudioContext||window.webkitAudioContext)();
  const nativeRate=captureCtx.sampleRate;
  slog('capture_start',{nativeRate,ua:navigator.userAgent.substring(0,60)});

  captureSource=captureCtx.createMediaStreamSource(micStream);

  // ScriptProcessor: bufferSize must be power of 2
  captureProc=captureCtx.createScriptProcessor(PROC_BUFFER,1,1);

  captureProc.onaudioprocess=e=>{
    if(isMuted||!currentCallId)return;
    const input=e.inputBuffer.getChannelData(0); // Float32 at nativeRate
    // Downsample to 16kHz
    const ratio=nativeRate/SAMPLE_RATE;
    const outLen=Math.floor(input.length/ratio);
    const pcm=new Int16Array(outLen);
    for(let i=0;i<outLen;i++){
      const s=Math.max(-1,Math.min(1,input[Math.floor(i*ratio)]));
      pcm[i]=s<0?s*0x8000:s*0x7FFF;
    }
    // base64 encode
    const bytes=new Uint8Array(pcm.buffer);
    let bin='';
    for(let i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
    send({type:'audio',callId:currentCallId,data:btoa(bin)});
  };

  // MUST connect to destination (via silent gain) or mobile Chrome kills the node
  const silentGain=captureCtx.createGain();
  silentGain.gain.value=0;
  captureSource.connect(captureProc);
  captureProc.connect(silentGain);
  silentGain.connect(captureCtx.destination);
}

function stopCapture(){
  audioStarted=false;
  try{if(captureProc)captureProc.disconnect();}catch(e){}
  try{if(captureSource)captureSource.disconnect();}catch(e){}
  try{if(captureCtx)captureCtx.close();}catch(e){}
  captureProc=null;captureSource=null;captureCtx=null;
  if(micStream){micStream.getTracks().forEach(t=>t.stop());micStream=null;}
}

/* ═══════════════════════════════════════════
   PLAYBACK — PCM16 base64 → AudioContext scheduled play
   
   Why this works on ALL devices:
   - No decodeAudioData, no codec, no MIME
   - Raw PCM16 → Float32 → AudioBuffer → play
   - Scheduled so no gaps or overlaps
═══════════════════════════════════════════ */
function ensurePlayCtx(){
  if(!playCtx||playCtx.state==='closed'){
    playCtx=new(window.AudioContext||window.webkitAudioContext)({sampleRate:SAMPLE_RATE});
    playNextTime=0;
    slog('playctx_created',{state:playCtx.state});
  }
  if(playCtx.state==='suspended'){
    playCtx.resume().then(()=>slog('playctx_resumed',{}));
  }
}

function receiveAudio(b64){
  ensurePlayCtx();
  if(!playCtx||playCtx.state==='closed')return;

  // base64 → Int16Array
  let pcm;
  try{
    const bin=atob(b64);
    const buf=new ArrayBuffer(bin.length);
    const view=new Uint8Array(buf);
    for(let i=0;i<bin.length;i++)view[i]=bin.charCodeAt(i);
    pcm=new Int16Array(buf);
  }catch(e){slog('rx_b64_fail',{err:e.message});return;}

  // Int16 → Float32
  const f32=new Float32Array(pcm.length);
  for(let i=0;i<pcm.length;i++)f32[i]=pcm[i]/(pcm[i]<0?0x8000:0x7FFF);

  // Create AudioBuffer and schedule
  const ab=playCtx.createBuffer(1,f32.length,SAMPLE_RATE);
  ab.copyToChannel(f32,0);

  const src=playCtx.createBufferSource();
  src.buffer=ab;
  src.connect(playCtx.destination);

  const now=playCtx.currentTime;
  // If we've fallen behind (e.g. tab was hidden), reset
  if(playNextTime<now+0.01)playNextTime=now+0.05;
  src.start(playNextTime);
  playNextTime+=ab.duration;
}

function cleanupPlayback(){
  try{if(playCtx)playCtx.close();}catch(e){}
  playCtx=null;playNextTime=0;
}

/* ═══════════════════════════════════════════
   CALL UI
═══════════════════════════════════════════ */
function startCall(username,name){
  ensurePlayCtx(); // create from user gesture
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

$('callEndBtn').onclick=()=>{
  if(currentCallId)send({type:'end_call',callId:currentCallId});
  endCallUI();
};

$('acceptBtn').onclick=()=>{
  if(!currentCallId||!ws)return;
  stopRing();
  ensurePlayCtx(); // create from user gesture
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

$('speakerBtn').onclick=function(){this.classList.toggle('active');};

function endCallUI(){
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
  seconds=0;if(timerInterval)clearInterval(timerInterval);
  timerInterval=setInterval(()=>{
    seconds++;
    $('callTimer').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  },1000);
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
    try{
      const r=await fetch(`${HTTP_URL}/api/user/${u}`);
      if(r.ok)connectApp(u,n);
      else{localStorage.removeItem('fc_user');localStorage.removeItem('fc_name');}
    }catch(e){localStorage.removeItem('fc_user');localStorage.removeItem('fc_name');}
  }
})();

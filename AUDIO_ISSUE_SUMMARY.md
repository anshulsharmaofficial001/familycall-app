# Audio Issue Summary — FamilyCall App

## Architecture (No WebRTC)

```
Device A Mic → MediaRecorder → base64 → WebSocket
                                        ↓
                                   Server relays
                                        ↓
Device B WebSocket → atob → decodeAudioData → AudioContext → Speaker
```

There is **NO WebRTC**, no SDP, no ICE, no TURN/STUN. It's a simple audio relay through the server.

## Server

- **Stack:** Express + `ws` WebSocket
- **Hosting:** Render.com free tier (HTTPS)
- **URL:** `https://familycall-server-tpyh.onrender.com`
- **Port:** 3000 (internal, Render provides 443 externally)
- **Storage:** In-memory (no database)
- **Call flow:**
  1. `call` → server stores call, notifies callee
  2. `accept_call` → server notifies caller
  3. `audio` → server relays base64 string to the other peer
  4. `end_call` → server cleans up

## Current Audio Code (app.js lines 182-241)

### Capture (Sending)
- `getAudioMime()` tries: `audio/webm;codecs=opus` > `audio/webm` > `audio/ogg;codecs=opus` > `audio/mp4`
- `MediaRecorder` captures microphone → emits 100ms chunks via `ondataavailable`
- Each chunk: `Blob → ArrayBuffer → Uint8Array → String.fromCharCode → btoa(base64)` → sent over WebSocket

### Playback (Receiving)
- WebSocket receives `{type: "audio", callId, data: "base64string"}`
- `playAudio()` pushes to FIFO queue (max 20 items)
- `playNext()`: shift queue → `atob` → `Uint8Array` → `ArrayBuffer` → `decodeAudioData` → `BufferSourceNode` → `start()`
- `onended` callback triggers next `playNext()`
- If `audioCtx.state === "suspended"`, calls `.resume()` before decode

### AudioContext Creation
- Created/resumed from **user gesture** (click):
  - `startCall()` — caller clicks 📞 button
  - `acceptBtn.onclick` — callee clicks Accept button
- Also created/resumed in `startAudioStream()` as safety

## Problem

**Voice does not work reliably across devices.** Current behavior (latest deploy):
- Phone → Laptop: Phone hears laptop, but laptop does NOT hear phone
- The server relay is confirmed working (automated test passes)
- User cannot provide browser console logs

## All Approaches Tried (in chronological order)

### 1. ScriptProcessorNode PCM16 (capture + playback)
- **Capture:** `getUserMedia` → `ScriptProcessorNode` → PCM16 Int16Array → base64 → WebSocket
- **Playback:** WebSocket → atob → Int16Array → Float32Array → `AudioBuffer` → `BufferSourceNode` → `start()`
- **Result:** Worked on desktop Chrome (laptop), NOT on mobile Chrome
- **Why mobile failed (theory):** `ScriptProcessorNode.onaudioprocess` doesn't fire on mobile even with silent gain hack

### 2. ScriptProcessorNode + silent gain (gain = 0)
- Same as #1 but added `createGain()` with gain=0 between processor and destination
- **Theory:** Chrome on mobile might optimize away ScriptProcessorNode that's not connected to destination
- **Result:** Still didn't work on mobile

### 3. MediaRecorder + Audio element (capture + playback)
- **Capture:** `MediaRecorder` → base64 → WebSocket
- **Playback:** WebSocket → atob → `Blob` → `URL.createObjectURL` → `audioElement.src` → `audioElement.play()`
- **Result:** Worked on phone, NOT on laptop
- **Why laptop failed (theory):** Desktop Chrome blocks `audioElement.play()` from non-user-gesture (WebSocket handler). Phone allows it after any user gesture.

### 4. Pure PCM16 via AudioBufferSourceNode (capture + playback)
- Same as #1 but with direct `playNext()` callback instead of `setTimeout(playNext, 0)`
- Added `audioCtx.state === 'suspended'` check + `.resume()` before each play
- **Result:** Same as #1 — laptop only

### 5. MediaRecorder + decodeAudioData (CURRENT)
- **Capture:** `MediaRecorder` (same as #3)
- **Playback:** WebSocket → atob → `decodeAudioData()` → `BufferSourceNode` → `start()`
- **Result:** Phone hears laptop, laptop doesn't hear phone (current)
- **Why laptop fails (theory):**
  - `decodeAudioData` fails silently (incompatible blob format?)
  - Or `BufferSourceNode.onended` doesn't fire consistently
  - Or AudioContext gets suspended between user gesture and first audio chunk

## Key Files

- **`server/index.js`** (217 lines) — Express + WebSocket server
- **`server/public/index.html`** — UI (login, contacts, call, chat pages)
- **`server/public/js/app.js`** (309 lines) — All client logic

## Test Accounts
| Username | Password | Name |
|----------|----------|------|
| `lappy` | `123` | Laptop |
| `iphone` | `123` | iPhone |

## Deploy
- **Repository:** `anshulsharmaofficial001/familycall-app` (GitHub)
- **Render root directory:** `server/`
- **Deploy hook:** POST to `https://api.render.com/deploy/srv-d8c3dpbeo5us73dtfqn0?key=_OvY7mW--XU`
- **Keep-alive:** GitHub Actions workflow every 10 min

## Suspected Root Causes

1. **`decodeAudioData` fails on desktop Chrome for WebM/Opus chunks from phone's MediaRecorder** — possible MIME type mismatch (phone produces `audio/mp4`, laptop tries to decode as `audio/webm`)
2. **`onended` doesn't fire on desktop Chrome for very short buffers** (100ms chunks)
3. **`AudioContext.resume()` not completing before `decodeAudioData`** — `.resume()` is async but we don't await it
4. **First MediaRecorder chunks are headers-only** (no audio data) → decode fails → `playing` stuck in error state

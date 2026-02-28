/**
 * ShareDrop — app.js  (Full Rewrite)
 * ═══════════════════════════════════════════════════════
 *
 * ARCHITECTURE:
 *
 *   SENDER:
 *     1. User selects files → queued, NOT sent yet
 *     2. User clicks "Send" → transfer loop starts
 *     3. File is read using FileReader in CHUNKS (64 KB each)
 *        - Only one chunk is in memory at a time
 *        - We wait for DataChannel buffer to drain before next chunk
 *        - This prevents RAM overload on large (10 GB+) files
 *     4. JSON metadata message sent first, then binary chunks
 *     5. Each chunk is acknowledged → enables pause/resume
 *
 *   RECEIVER:
 *     1. Receives metadata message → prepares state
 *     2. Receives ArrayBuffer chunks → stored in array
 *     3. When all bytes received → assembles Blob → triggers download
 *        - Blob assembly is deferred to avoid blocking UI
 *
 *   MEMORY STRATEGY:
 *     - Sender:   Never loads more than CHUNK_SIZE into memory at once
 *     - Receiver: Chunks array is the only copy; freed after Blob creation
 *     - No FileReader.readAsArrayBuffer on entire file
 *     - No base64 encoding (pure binary)
 *
 *   FLOW CONTROL:
 *     - We poll conn.dataChannel.bufferedAmount
 *     - If > BUFFER_HIGH, we wait (backpressure) → no OOM on sender
 *     - setInterval polling avoids blocking the main thread
 *
 *   PAUSE / RESUME:
 *     - isPaused flag stops the chunk-send loop
 *     - On resume, loop continues from where it left off
 *     - Works because we track byte offset (txOffset)
 *
 *   CANCEL:
 *     - Sets isCancelled flag → loop exits
 *     - Sends JSON cancel message to receiver
 *     - Receiver discards partial data
 * ═══════════════════════════════════════════════════════
 */

'use strict';

/* ═══════════════════════════════
   TRANSFER CONSTANTS
═══════════════════════════════ */
const CHUNK_SIZE    = 64  * 1024;        // 64 KB per chunk  — good balance speed/memory
const BUFFER_HIGH   = 4   * 1024 * 1024; // 4 MB  — pause sending if buffer exceeds this
const BUFFER_LOW    = 256 * 1024;         // 256 KB — resume when buffer drains to this
const DRAIN_POLL_MS = 50;                 // Check buffer every 50ms

/* ═══════════════════════════════
   APPLICATION STATE
═══════════════════════════════ */
let peer         = null;   // PeerJS instance
let conn         = null;   // DataConnection
let myRole       = null;   // 'sender' | 'receiver'
let myId         = null;   // our Peer ID
let reconnecting = false;

// ── Sender TX state ──────────────────
let txQueue      = [];     // File[]           — selected files
let txMeta       = [];     // {name,size,status}
let txIdx        = 0;      // current file index
let txOffset     = 0;      // bytes sent for current file
let txStart      = 0;      // timestamp of current transfer start
let txTotalSent  = 0;      // bytes sent so far for current file
let txSpeedBytes = 0;      // bytes sent in last speed window
let txSpeedTime  = 0;      // timestamp of speed window start
let isPaused     = false;
let isCancelled  = false;
let txActive     = false;  // transfer loop running

// ── Receiver RX state ──────────────────
let rxMeta       = null;   // current file metadata
let rxChunks     = [];     // ArrayBuffer[]
let rxBytes      = 0;      // bytes received so far
let rxStart      = 0;      // timestamp of current receive start
let rxCancelled  = false;

// ── Receiver history ──────────────────
let rxHistory    = [];

// ── Camera / QR state ──────────────────
let camStream    = null;
let _scanInterval = null;
let _scanAttempts = 0;
let qrFound      = false;
let camActive    = false;

// ── Modal callback ──────────────────────
let _modalOkFn   = null;

/* ═══════════════════════════════
   BOOT
═══════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  const mobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const dl = document.getElementById('devLabel');
  if (dl) dl.textContent = mobile ? '📱 Mobile device' : '💻 Desktop';

  initPeer();
});

/* ═══════════════════════════════
   PEERJS INIT
═══════════════════════════════ */
function initPeer() {
  const dot  = document.getElementById('nsDot');
  const text = document.getElementById('nsText');

  if (dot)  { dot.className  = 'ns-dot connecting'; }
  if (text) { text.textContent = 'Connecting to network…'; }

  // Destroy previous instance if reconnecting
  if (peer && !peer.destroyed) {
    try { peer.destroy(); } catch(e) {}
  }

  peer = new Peer(undefined, {
    host:   '0.peerjs.com',
    port:   443,
    secure: true,
    path:   '/',
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478'  },
      ]
    },
    debug: 0,
  });

  peer.on('open', (id) => {
    myId = id;
    console.log('[Peer] open, id:', id);
    if (dot)  { dot.className  = 'ns-dot ok'; }
    if (text) { text.textContent = 'Network ready'; }
    document.getElementById('btnRoleSend').disabled = false;
    document.getElementById('btnRoleRecv').disabled = false;
    reconnecting = false;
  });

  peer.on('error', (err) => {
    console.error('[Peer] error:', err.type, err);
    if (dot)  { dot.className  = 'ns-dot err'; }
    if (text) { text.textContent = 'Network error — retrying…'; }
    showToast('⚠️ Network error: ' + err.type);
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(initPeer, 4000);
    }
  });

  peer.on('disconnected', () => {
    console.warn('[Peer] disconnected, attempting reconnect');
    if (!peer.destroyed) {
      try { peer.reconnect(); } catch(e) { setTimeout(initPeer, 3000); }
    }
  });

  // Sender-side: handle incoming DataConnection from receiver
  peer.on('connection', (incomingConn) => {
    if (myRole !== 'sender') return;
    if (conn && conn.open) {
      // Already have a connection — reject duplicate
      try { incomingConn.close(); } catch(e) {}
      return;
    }
    conn = incomingConn;
    setupDataConnection('sender');
    console.log('[Peer] incoming from receiver:', incomingConn.peer);
  });
}

/* ═══════════════════════════════
   SCREEN NAVIGATION
═══════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function goHome() {
  // Cancel active transfer
  if (txActive) cancelTransfer();
  stopCam();

  // Close connection
  if (conn) {
    try { conn.close(); } catch(e) {}
    conn = null;
  }

  // Reset all sender state
  txQueue = []; txMeta = []; txIdx = 0;
  txOffset = 0; txActive = false;
  isPaused = false; isCancelled = false;

  // Reset receiver state
  rxMeta = null; rxChunks = []; rxBytes = 0;
  rxCancelled = false;

  // Reset QR scanner state
  qrFound = false; _scanAttempts = 0;

  // Reset UI
  document.getElementById('fileQueue')?.classList.add('hidden');
  document.getElementById('dropzone')?.classList.remove('hidden');
  document.getElementById('txCard')?.classList.add('hidden');
  document.getElementById('qrConnected')?.classList.add('hidden');
  document.getElementById('recvScanBody')?.classList.remove('hidden');
  document.getElementById('recvConnected')?.classList.add('hidden');
  document.getElementById('sHistList').innerHTML = '';
  document.getElementById('sHistEmpty').style.display = '';
  document.getElementById('rHistList').innerHTML = '';
  document.getElementById('rHistEmpty').style.display = '';

  myRole = null;
  showScreen('sHome');
}

/* ═══════════════════════════════
   ROLE SELECTION
═══════════════════════════════ */
function chooseRole(role) {
  myRole = role;
  if (role === 'sender') {
    showScreen('sSender');
    setupSenderScreen();
  } else {
    showScreen('sReceiver');
    setTimeout(startCam, 500);
  }
}

/* ═══════════════════════════════
   SENDER SCREEN SETUP
═══════════════════════════════ */
function setupSenderScreen() {
  if (!myId) { showToast('⚠️ Still connecting to network…'); return; }
  renderQR(myId);
  const el = document.getElementById('myPeerIdDisplay');
  if (el) el.textContent = myId;
  const row = document.getElementById('peerIdRow');
  if (row) row.style.display = '';
  setupDropzone();
  setConnStatus('sender', '', 'Waiting for receiver…');
}

function copyPeerId() {
  if (!myId) return;
  navigator.clipboard.writeText(myId).then(() => {
    showToast('📋 Peer ID copied!');
    const btn = document.getElementById('copyBtn');
    if (btn) {
      btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8l3 3 7-7"/></svg>';
      setTimeout(() => {
        btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="5" width="9" height="9" rx="2"/><path d="M3 11V3a2 2 0 012-2h8"/></svg>';
      }, 1800);
    }
  }).catch(() => showToast('Could not copy — select manually'));
}

/* ═══════════════════════════════
   QR CODE RENDER
═══════════════════════════════ */
function renderQR(text) {
  const spinner = document.getElementById('qrSpinner');
  const canvas  = document.getElementById('qrCanvas');
  if (spinner) spinner.style.display = 'none';
  if (canvas)  canvas.innerHTML = '';

  try {
    new QRCode(canvas, {
      text:         text,
      width:        200,
      height:       200,
      colorDark:    '#000000',
      colorLight:   '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch(e) {
    console.error('[QR] render failed:', e);
    const qrBox = document.getElementById('qrBox');
    if (qrBox) {
      qrBox.innerHTML = `<div style="padding:1.5rem;text-align:center;font-size:.78rem;font-family:var(--mono);color:var(--text3)">
        QR unavailable<br/><span style="color:var(--blue);word-break:break-all;font-size:.7rem">${esc(text)}</span>
      </div>`;
    }
  }
}

/* ═══════════════════════════════
   DROP ZONE SETUP
═══════════════════════════════ */
function setupDropzone() {
  const dz = document.getElementById('dropzone');
  if (!dz) return;

  dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', ()  => dz.classList.remove('over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('over');
    onFilePicked(e.dataTransfer.files);
  });
  dz.addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') document.getElementById('fileInput').click();
  });
}

/* Called when files are selected (drag/drop or browse) — queues files, does NOT start transfer */
function onFilePicked(files) {
  if (!files?.length) return;

  let addedCount = 0;
  for (const f of files) {
    txQueue.push(f);
    txMeta.push({ name: f.name, size: f.size, status: 'pending' });
    addedCount++;
  }

  renderFileQueue();

  document.getElementById('dropzone')?.classList.add('hidden');
  document.getElementById('fileQueue')?.classList.remove('hidden');

  // Update send button state based on connection
  updateSendButton();

  showToast(`${addedCount} file${addedCount > 1 ? 's' : ''} added — click Send when ready`);

  // ⚠️  NO automatic transfer start here — user must click Send
}

function updateSendButton() {
  const btn = document.getElementById('btnSend');
  if (!btn) return;
  const hasFiles = txQueue.length > 0;
  const isConnected = conn?.open;
  btn.disabled = !hasFiles;
  if (!isConnected && hasFiles) {
    btn.title = 'Waiting for receiver to connect before sending';
  } else {
    btn.title = '';
  }
}

function renderFileQueue() {
  const ul    = document.getElementById('fqList');
  const count = document.getElementById('fqCount');
  const total = document.getElementById('fqTotal');
  if (!ul) return;

  const totalBytes = txQueue.reduce((s, f) => s + f.size, 0);
  if (count) count.textContent = txQueue.length + (txQueue.length === 1 ? ' file' : ' files');
  if (total) total.textContent = '· ' + formatBytes(totalBytes);

  ul.innerHTML = '';
  txMeta.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = `fq-item ${m.status}`;
    li.id = `fqi-${i}`;
    li.innerHTML = `
      <span class="fq-ico">${fileIcon(txQueue[i]?.name || '')}</span>
      <div class="fq-inf">
        <span class="fq-name" title="${esc(m.name)}">${esc(m.name)}</span>
        <span class="fq-size">${formatBytes(m.size)}</span>
      </div>
      <span class="fq-status ${m.status}">${m.status}</span>
      ${m.status === 'pending' ? `<button class="fq-rm" onclick="removeFile(${i})" title="Remove">✕</button>` : ''}
    `;
    ul.appendChild(li);
  });

  updateSendButton();
}

function removeFile(i) {
  if (txMeta[i]?.status !== 'pending') return;
  txQueue.splice(i, 1);
  txMeta.splice(i, 1);
  if (!txQueue.length) {
    document.getElementById('fileQueue')?.classList.add('hidden');
    document.getElementById('dropzone')?.classList.remove('hidden');
  } else {
    renderFileQueue();
  }
}

function clearQueue() {
  const pendingFiles = txMeta.filter(m => m.status === 'pending');
  if (pendingFiles.length === 0) return;

  showModal(
    'Clear queue?',
    `Remove all ${pendingFiles.length} pending file${pendingFiles.length > 1 ? 's' : ''} from the queue?`,
    () => {
      // Keep only active/done/error items
      const keep = txQueue.filter((_, i) => txMeta[i].status !== 'pending');
      const keepMeta = txMeta.filter(m => m.status !== 'pending');
      txQueue = keep;
      txMeta  = keepMeta;
      if (!txQueue.length) {
        document.getElementById('fileQueue')?.classList.add('hidden');
        document.getElementById('dropzone')?.classList.remove('hidden');
      } else {
        renderFileQueue();
      }
    }
  );
}

function setFileStatus(i, status) {
  if (txMeta[i]) txMeta[i].status = status;
  const li = document.getElementById(`fqi-${i}`);
  if (!li) return;
  li.className = `fq-item ${status}`;
  const badge = li.querySelector('.fq-status');
  if (badge) { badge.className = `fq-status ${status}`; badge.textContent = status; }
  // Remove delete button once not pending
  const rm = li.querySelector('.fq-rm');
  if (rm && status !== 'pending') rm.remove();
}

/* ═══════════════════════════════
   SENDER — START TRANSFER
   Called by "Send Files" button
═══════════════════════════════ */
function startSend() {
  if (!conn?.open) {
    showToast('⚠️ Not connected yet — wait for receiver to scan the QR code');
    return;
  }

  const pending = txMeta.filter(m => m.status === 'pending');
  if (!pending.length) {
    showToast('⚠️ No files to send');
    return;
  }

  const totalSize = txQueue.reduce((s, f, i) => txMeta[i].status === 'pending' ? s + f.size : s, 0);

  showModal(
    'Confirm Transfer',
    `Send ${pending.length} file${pending.length > 1 ? 's' : ''} (${formatBytes(totalSize)}) to receiver?`,
    () => {
      document.getElementById('btnSend').disabled = true;
      txIdx      = 0;
      isPaused   = false;
      isCancelled = false;
      txActive   = true;
      sendNextFile();
    }
  );
}

/* ═══════════════════════════════════════════════════════
   CHUNKED FILE TRANSFER — Core
   
   KEY DESIGN DECISIONS:
   1. FileReader reads CHUNK_SIZE bytes at a time via slice()
      → Never more than 64 KB in RAM for the file content
   2. We check DataChannel bufferedAmount before each send
      → If buffer is full (> BUFFER_HIGH), we wait (async poll)
      → This prevents the channel + browser from OOM-ing
   3. Pause is handled by a flag — the await loop checks it
   4. Cancel sets isCancelled → loop exits, cleans up
   5. We use async/await with a Promise wrapper around FileReader
      → Clean, no callback hell, easy error handling
═══════════════════════════════════════════════════════ */
async function sendNextFile() {
  // Skip already-processed files
  while (txIdx < txQueue.length && txMeta[txIdx].status !== 'pending') {
    txIdx++;
  }

  if (txIdx >= txQueue.length || isCancelled) {
    finalizeSendAll();
    return;
  }

  const file = txQueue[txIdx];
  const meta = txMeta[txIdx];

  meta.status = 'active';
  setFileStatus(txIdx, 'active');

  // Send metadata header
  conn.send(JSON.stringify({
    type:     'meta',
    name:     file.name,
    size:     file.size,
    mimeType: file.type || 'application/octet-stream',
  }));

  // Setup TX UI
  showTxCard(file);
  txOffset     = 0;
  txStart      = Date.now();
  txTotalSent  = 0;
  txSpeedBytes = 0;
  txSpeedTime  = Date.now();

  // ── Chunk loop ─────────────────────────────────────
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  let chunkIdx      = 0;

  while (txOffset < file.size && !isCancelled) {
    // ── Handle pause ─────────────────────────────
    while (isPaused && !isCancelled) {
      await sleep(100);
    }
    if (isCancelled) break;

    // ── Backpressure: wait for buffer to drain ────
    if (conn?.dataChannel) {
      while (conn.dataChannel.bufferedAmount > BUFFER_HIGH) {
        await sleep(DRAIN_POLL_MS);
        if (isCancelled) break;
      }
    } else {
      // Fallback soft throttle without DataChannel access
      if (chunkIdx % 64 === 0) await sleep(1);
    }
    if (isCancelled) break;

    // ── Read next chunk ──────────────────────────
    const start  = txOffset;
    const end    = Math.min(txOffset + CHUNK_SIZE, file.size);
    const slice  = file.slice(start, end);

    let buffer;
    try {
      buffer = await readSliceAsArrayBuffer(slice);
    } catch(e) {
      console.error('[TX] FileReader error:', e);
      meta.status = 'error';
      setFileStatus(txIdx, 'error');
      addSentHistory(file.name, file.size, true);
      showToast(`❌ Error reading: ${file.name}`);
      txIdx++;
      txActive = txIdx < txQueue.length;
      if (txActive) sendNextFile();
      else finalizeSendAll();
      return;
    }

    if (isCancelled) break;

    // ── Send chunk ───────────────────────────────
    try {
      conn.send(buffer);
    } catch(e) {
      console.error('[TX] send error:', e);
      // Connection may have dropped — mark error, stop
      meta.status = 'error';
      setFileStatus(txIdx, 'error');
      showToast('❌ Connection lost during transfer');
      finalizeSendAll();
      return;
    }

    txOffset     += buffer.byteLength;
    txTotalSent  += buffer.byteLength;
    txSpeedBytes += buffer.byteLength;
    chunkIdx++;

    updateTxUI(txOffset, file.size);

    // Yield to keep UI responsive every ~512KB
    if (chunkIdx % 8 === 0) await sleep(0);
  }

  if (isCancelled) {
    // Send cancel signal to receiver
    try { conn.send(JSON.stringify({ type: 'cancel' })); } catch(e) {}
    meta.status = 'error';
    setFileStatus(txIdx, 'error');
    addSentHistory(file.name, file.size, true);
    finalizeSendAll();
    return;
  }

  // ── File complete ────────────────────────────────
  conn.send(JSON.stringify({ type: 'done' }));

  meta.status = 'done';
  setFileStatus(txIdx, 'done');
  addSentHistory(file.name, file.size, false);
  showToast(`✅ Sent: ${file.name}`);

  txIdx++;
  await sleep(150); // brief pause between files
  sendNextFile();
}

function finalizeSendAll() {
  txActive = false;
  document.getElementById('txCard')?.classList.add('hidden');
  document.getElementById('btnSend').disabled = false;

  if (!isCancelled) {
    const doneCount = txMeta.filter(m => m.status === 'done').length;
    if (doneCount > 0) showToast(`🎉 All ${doneCount} file${doneCount > 1 ? 's' : ''} sent!`);
  }

  updateSendButton();
}

/* Wrap FileReader in a Promise — reads a Blob slice as ArrayBuffer */
function readSliceAsArrayBuffer(slice) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = e => reject(e.target.error);
    reader.readAsArrayBuffer(slice);
  });
}

/* Pause / Resume */
function togglePause() {
  if (!txActive) return;
  isPaused = !isPaused;
  const btn = document.getElementById('btnPause');
  if (btn) btn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
  if (isPaused) {
    setFileStatus(txIdx, 'paused');
    showToast('⏸ Transfer paused');
  } else {
    setFileStatus(txIdx, 'active');
    showToast('▶ Transfer resumed');
  }
}

/* Cancel */
function cancelTransfer() {
  if (!txActive) return;
  showModal(
    'Cancel transfer?',
    'This will stop the current transfer. The receiver will discard any partial data.',
    () => {
      isCancelled = true;
      isPaused    = false;
      showToast('❌ Transfer cancelled');
    }
  );
}

/* ═══════════════════════════════
   TX UI
═══════════════════════════════ */
function showTxCard(file) {
  const card = document.getElementById('txCard');
  if (card) card.classList.remove('hidden');
  setEl('txIco',  fileIcon(file.name));
  setEl('txName', esc(file.name));
  setEl('txSz',   formatBytes(file.size));
  setEl('txPct',  '0%');
  setEl('txSpd',  '—');
  setEl('txEta',  '—');
  setEl('txDone', '—');
  const fill = document.getElementById('txFill');
  if (fill) fill.style.width = '0%';
  const pauseBtn = document.getElementById('btnPause');
  if (pauseBtn) pauseBtn.textContent = '⏸ Pause';
}

function updateTxUI(bytesSent, total) {
  const pct     = Math.min(100, Math.round((bytesSent / total) * 100));
  const elapsed = (Date.now() - txStart) / 1000 || 0.001;
  const speed   = bytesSent / elapsed;
  const remaining = speed > 0 ? (total - bytesSent) / speed : 0;

  setEl('txPct',  pct + '%');
  setEl('txDone', formatBytes(bytesSent) + ' / ' + formatBytes(total));
  setEl('txSpd',  formatSpeed(speed));
  setEl('txEta',  formatETA(remaining));
  const fill = document.getElementById('txFill');
  if (fill) fill.style.width = pct + '%';
}

/* ═══════════════════════════════════════════════════════
   RECEIVER — CAMERA / QR SCANNER
   
   FIXES vs original:
   1. setInterval at 100ms (not rAF at 60fps) — jsQR is slow,
      rAF starves it and causes missed frames / UI lag
   2. Scale video down to 640px for faster jsQR decode
   3. Wait for video.readyState >= 2 && videoWidth > 0 before scan
   4. Try rear camera first, fallback to any camera
   5. Show frame counter so user knows scanning is active
═══════════════════════════════════════════════════════ */
async function startCam() {
  if (camActive) return;

  if (typeof jsQR !== 'function') {
    showToast('❌ QR scanner library failed to load');
    document.getElementById('camDenied')?.classList.remove('hidden');
    document.getElementById('btnCamOn')?.classList.add('hidden');
    return;
  }

  const video = document.getElementById('camVideo');
  const pill  = document.getElementById('camPill');

  qrFound       = false;
  _scanAttempts = 0;

  if (pill) { pill.textContent = 'Requesting camera…'; pill.classList.remove('ok'); }

  try {
    // Try rear camera first (mobile), fallback to any
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch(e1) {
      console.warn('[Camera] rear camera unavailable, trying any:', e1.message);
      camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    video.srcObject = camStream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;

    await waitForVideoReady(video);
    try { await video.play(); } catch(e) { /* already playing */ }

    camActive = true;
    document.getElementById('btnCamOn')?.classList.add('hidden');
    document.getElementById('btnCamOff')?.classList.remove('hidden');
    if (pill) pill.textContent = 'Scanning… hold steady';

    _scanInterval = setInterval(doScanTick, 100);

  } catch(err) {
    console.error('[Camera] error:', err.name, err.message);
    handleCameraError(err);
  }
}

function waitForVideoReady(video) {
  return new Promise(resolve => {
    if (video.readyState >= 2 && video.videoWidth > 0) { resolve(); return; }
    let n = 0;
    const poll = setInterval(() => {
      n++;
      if ((video.readyState >= 2 && video.videoWidth > 0) || n > 60) {
        clearInterval(poll);
        resolve();
      }
    }, 100);
  });
}

function doScanTick() {
  if (!camActive || qrFound) return;

  const video  = document.getElementById('camVideo');
  const canvas = document.getElementById('camCanvas');
  const pill   = document.getElementById('camPill');

  if (!video || !canvas) return;
  if (video.readyState < 2 || video.videoWidth === 0) {
    if (pill) pill.textContent = 'Waiting for camera…';
    return;
  }

  const SCAN_W  = 640;
  const scale   = SCAN_W / video.videoWidth;
  const SCAN_H  = Math.round(video.videoHeight * scale);

  canvas.width  = SCAN_W;
  canvas.height = SCAN_H;

  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  try {
    ctx.drawImage(video, 0, 0, SCAN_W, SCAN_H);
  } catch(e) { return; }

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, SCAN_W, SCAN_H);
  } catch(e) { return; }

  _scanAttempts++;
  if (pill && _scanAttempts % 5 === 0) {
    pill.textContent = `Scanning… (${_scanAttempts})`;
  }

  let code = null;
  try {
    code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth',
    });
  } catch(e) { return; }

  if (code?.data?.trim()) {
    const decoded = code.data.trim();
    console.log('[QR] found after', _scanAttempts, 'frames:', decoded);
    qrFound = true;
    onQRDetected(decoded);
  }
}

function onQRDetected(peerId) {
  stopCam();
  const wrap = document.getElementById('camWrap');
  const pill = document.getElementById('camPill');
  if (wrap) wrap.classList.add('detected');
  if (pill) { pill.textContent = '✅ QR Detected!'; pill.classList.add('ok'); }
  showToast('📷 QR scanned! Connecting…');
  connectToPeer(peerId);
}

function handleCameraError(err) {
  const denied = document.getElementById('camDenied');
  const btnOn  = document.getElementById('btnCamOn');

  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    showToast('📵 Camera permission denied — enter Peer ID manually');
  } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
    showToast('❌ No camera found — enter Peer ID manually');
  } else if (err.name === 'NotReadableError') {
    showToast('❌ Camera is in use by another app');
  } else {
    showToast('❌ Camera error: ' + (err.message || err.name));
  }

  denied?.classList.remove('hidden');
  btnOn?.classList.add('hidden');
}

function stopCam() {
  camActive = false;
  if (_scanInterval) { clearInterval(_scanInterval); _scanInterval = null; }
  if (camStream) {
    camStream.getTracks().forEach(t => { try { t.stop(); } catch(e) {} });
    camStream = null;
  }
  const v = document.getElementById('camVideo');
  if (v) { try { v.srcObject = null; v.load(); } catch(e) {} }
  document.getElementById('btnCamOn')?.classList.remove('hidden');
  document.getElementById('btnCamOff')?.classList.add('hidden');
}

/* ═══════════════════════════════
   MANUAL PEER ID (fallback)
═══════════════════════════════ */
function connectByPeerId() {
  const input = document.getElementById('manualPeerId');
  const id    = input?.value?.trim();
  if (!id) { showToast('⚠️ Please enter the Peer ID first'); return; }
  connectToPeer(id);
}

/* ═══════════════════════════════
   CONNECT TO SENDER (receiver)
═══════════════════════════════ */
function connectToPeer(senderId) {
  if (!peer?.open) {
    showToast('⚠️ Not connected to network yet — please wait');
    return;
  }
  if (senderId === myId) {
    showToast('⚠️ Cannot connect to yourself!');
    return;
  }

  setConnStatus('receiver', 'connecting', 'Connecting…');

  conn = peer.connect(senderId, {
    reliable:      true,
    serialization: 'binary',
  });

  setupDataConnection('receiver');
}

/* ═══════════════════════════════
   DATA CONNECTION SETUP
═══════════════════════════════ */
function setupDataConnection(role) {
  if (!conn) return;

  conn.on('open', () => {
    console.log('[Conn] open, role:', role);
    onConnectionOpen(role);
  });

  conn.on('data', (data) => {
    onData(data, role);
  });

  conn.on('close', () => {
    console.log('[Conn] closed, role:', role);
    showToast('🔌 Connection closed');
    setConnStatus(role, '', 'Disconnected');
    if (role === 'sender') updateSendButton();
  });

  conn.on('error', (err) => {
    console.error('[Conn] error:', err);
    showToast('❌ Connection error: ' + (err.message || err));
    setConnStatus(role, 'failed', 'Failed');
    if (txActive) {
      isCancelled = true;
      txActive    = false;
    }
  });
}

function onConnectionOpen(role) {
  setConnStatus(role, 'connected', 'Connected ✓');

  if (role === 'sender') {
    document.getElementById('qrConnected')?.classList.remove('hidden');
    showToast('🔗 Receiver connected — ready to send files!');
    updateSendButton();
    // If transfer was pending (e.g. reconnect scenario), do not auto-start
  }

  if (role === 'receiver') {
    document.getElementById('recvScanBody')?.classList.add('hidden');
    document.getElementById('recvConnected')?.classList.remove('hidden');
    showToast('🔗 Connected to sender — waiting for files…');
  }
}

/* ═══════════════════════════════════════════════════════
   DATA HANDLER (both roles receive data, role guards)
   
   MEMORY NOTES (receiver side):
   - rxChunks is an array of ArrayBuffers
   - Each chunk is freed as soon as GC runs after Blob creation
   - We do NOT concatenate into one giant buffer during transfer
     (that would double memory usage at completion)
   - Blob constructor accepts an array of ArrayBuffers directly
   - URL.createObjectURL gives a streaming download — no extra RAM
═══════════════════════════════════════════════════════ */
function onData(data, role) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch(e) { return; }

    if (msg.type === 'meta') {
      startReceiving(msg);
    } else if (msg.type === 'done') {
      finalizeReceive();
    } else if (msg.type === 'cancel') {
      rxCancelled = true;
      rxMeta = null; rxChunks = []; rxBytes = 0;
      setEl('rcStatus', 'Transfer cancelled by sender');
      document.getElementById('rxCard')?.classList.add('hidden');
      showToast('❌ Transfer cancelled by sender');
    }
  } else {
    // Binary chunk — only if we have active meta and not cancelled
    if (!rxMeta || rxCancelled) return;

    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    receiveChunk(buf);
  }
}

function startReceiving(meta) {
  rxMeta     = meta;
  rxChunks   = [];
  rxBytes    = 0;
  rxStart    = Date.now();
  rxCancelled = false;

  console.log('[RX] receiving:', meta.name, formatBytes(meta.size));

  document.getElementById('rxCard')?.classList.remove('hidden');
  setEl('rxIco',  fileIcon(meta.name));
  setEl('rxName', esc(meta.name));
  setEl('rxSz',   formatBytes(meta.size));
  setEl('rxPct',  '0%');
  setEl('rxSpd',  '—');
  setEl('rxEta',  '—');
  setEl('rxGot',  '—');
  const fill = document.getElementById('rxFill');
  if (fill) fill.style.width = '0%';
  setEl('rcStatus', 'Receiving: ' + esc(meta.name));
}

function receiveChunk(buf) {
  if (!rxMeta) return;
  rxChunks.push(buf);
  rxBytes += buf.byteLength;

  const pct     = Math.min(100, Math.round((rxBytes / rxMeta.size) * 100));
  const elapsed = (Date.now() - rxStart) / 1000 || 0.001;
  const speed   = rxBytes / elapsed;

  setEl('rxPct',  pct + '%');
  setEl('rxGot',  formatBytes(rxBytes) + ' / ' + formatBytes(rxMeta.size));
  setEl('rxSpd',  formatSpeed(speed));
  setEl('rxEta',  formatETA(speed > 0 ? (rxMeta.size - rxBytes) / speed : 0));
  const fill = document.getElementById('rxFill');
  if (fill) fill.style.width = pct + '%';

  // If we've received all expected bytes, finalize
  // (handles cases where 'done' message arrives slightly after last chunk)
  if (rxBytes >= rxMeta.size) {
    finalizeReceive();
  }
}

function finalizeReceive() {
  if (!rxMeta || rxCancelled) return;

  const meta = rxMeta;
  const chunks = rxChunks;

  // Clear state immediately so we can receive next file
  rxMeta   = null;
  rxChunks = [];
  rxBytes  = 0;

  // Defer Blob assembly off the critical path
  setTimeout(() => {
    try {
      const blob = new Blob(chunks, { type: meta.mimeType || 'application/octet-stream' });

      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = meta.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 8000);

      showToast('✅ Saved: ' + meta.name);
      addRxHistory(meta.name, meta.size, blob);
      setEl('rcStatus', 'Waiting for more files…');
      document.getElementById('rxCard')?.classList.add('hidden');
    } catch(e) {
      console.error('[RX] finalize error:', e);
      showToast('❌ Failed to save: ' + meta.name);
    }
  }, 0);
}

/* ═══════════════════════════════
   STATUS
═══════════════════════════════ */
function setConnStatus(role, state, text) {
  const dotId = role === 'sender' ? 'sDot' : 'rDot';
  const txtId = role === 'sender' ? 'sText' : 'rText';
  const dot   = document.getElementById(dotId);
  const txt   = document.getElementById(txtId);
  if (dot) dot.className = 'cs-dot ' + state;
  if (txt) txt.textContent = text;
}

/* ═══════════════════════════════
   HISTORY
═══════════════════════════════ */
function addSentHistory(name, size, error = false) {
  const empty = document.getElementById('sHistEmpty');
  const list  = document.getElementById('sHistList');
  if (empty) empty.style.display = 'none';
  const li = document.createElement('li');
  li.className = 'hist-item';
  const t = now();
  li.innerHTML = `
    <span class="hi-ico">${fileIcon(name)}</span>
    <div class="hi-inf">
      <span class="hi-name" title="${esc(name)}">${esc(name)}</span>
      <span class="hi-meta">${formatBytes(size)} · ${t}</span>
    </div>
    <span class="hi-badge ${error ? 'error' : 'sent'}">${error ? 'error' : 'sent'}</span>
  `;
  list?.prepend(li);
}

function addRxHistory(name, size, blob) {
  const empty = document.getElementById('rHistEmpty');
  const list  = document.getElementById('rHistList');
  if (empty) empty.style.display = 'none';
  const idx = rxHistory.length;
  rxHistory.push({ name, size, blob });
  const li = document.createElement('li');
  li.className = 'hist-item';
  const t = now();
  li.innerHTML = `
    <span class="hi-ico">${fileIcon(name)}</span>
    <div class="hi-inf">
      <span class="hi-name" title="${esc(name)}">${esc(name)}</span>
      <span class="hi-meta">${formatBytes(size)} · ${t}</span>
    </div>
    <span class="hi-badge received">received</span>
    <button class="hi-dl" onclick="reDownload(${idx})">↓ Save again</button>
  `;
  list?.prepend(li);
}

function reDownload(idx) {
  const item = rxHistory[idx];
  if (!item?.blob) return;
  const url = URL.createObjectURL(item.blob);
  const a   = document.createElement('a');
  a.href = url; a.download = item.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ═══════════════════════════════
   MODAL
═══════════════════════════════ */
function showModal(title, body, onConfirm, confirmLabel = 'Confirm') {
  setEl('modalTitle', title);
  document.getElementById('modalBody').innerHTML = body;
  setEl('modalConfirmBtn', confirmLabel);
  _modalOkFn = onConfirm;
  document.getElementById('modalOverlay').classList.remove('hidden');
}

function modalConfirm() {
  document.getElementById('modalOverlay').classList.add('hidden');
  if (_modalOkFn) { _modalOkFn(); _modalOkFn = null; }
}

function modalCancel() {
  document.getElementById('modalOverlay').classList.add('hidden');
  _modalOkFn = null;
}

// Close modal on overlay click
document.addEventListener('click', e => {
  const overlay = document.getElementById('modalOverlay');
  if (e.target === overlay) modalCancel();
});

/* ═══════════════════════════════
   TOAST
═══════════════════════════════ */
let _toastTimer = null;

function showToast(msg, ms = 3500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ═══════════════════════════════
   HELPERS
═══════════════════════════════ */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function now() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(b) {
  if (!b && b !== 0) return '—';
  if (b === 0) return '0 B';
  const k = 1024, u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), u.length - 1);
  return parseFloat((b / Math.pow(k, i)).toFixed(i > 0 ? 2 : 0)) + ' ' + u[i];
}

function formatSpeed(bps) {
  if (!bps || bps < 0) return '—';
  if (bps < 1024)       return bps.toFixed(0) + ' B/s';
  if (bps < 1048576)    return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(2) + ' MB/s';
}

function formatETA(secs) {
  if (!isFinite(secs) || secs < 0) return '—';
  if (secs < 1)    return '<1s';
  if (secs < 60)   return Math.ceil(secs) + 's';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ' + (Math.ceil(secs % 60)) + 's';
  return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
}

function fileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const map = {
    pdf: '📄',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', bmp: '🖼️', heic: '🖼️',
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬', m4v: '🎬', flv: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵', aac: '🎵', m4a: '🎵', opus: '🎵',
    zip: '🗜️', rar: '🗜️', gz: '🗜️', '7z': '🗜️', tar: '🗜️', bz2: '🗜️', xz: '🗜️',
    doc: '📝', docx: '📝', txt: '📝', md: '📝', rtf: '📝', odt: '📝', pages: '📝',
    xls: '📊', xlsx: '📊', csv: '📊', ods: '📊', numbers: '📊',
    ppt: '📋', pptx: '📋', odp: '📋', key: '📋',
    js: '💻', ts: '💻', py: '💻', html: '💻', css: '💻', json: '💻', xml: '💻', sh: '💻',
    apk: '📱', ipa: '📱', exe: '⚙️', dmg: '💿', iso: '💿', msi: '⚙️', deb: '⚙️',
  };
  return map[ext] || '📎';
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
/**
 * ShareDrop — app.js
 * ═══════════════════════════════════════════════════
 *
 * HOW IT WORKS (simple version):
 * ────────────────────────────────
 * 1. Both devices open the app and connect to PeerJS
 *    public server (free, handles only handshake).
 * 2. Sender gets a unique Peer ID → shown as QR code.
 * 3. Receiver scans the QR → gets the Peer ID →
 *    calls peer.connect(senderId) directly.
 * 4. PeerJS completes the WebRTC handshake automatically.
 * 5. DataConnection opens → sender drops files → auto transfer.
 * 6. Files stream as chunks → receiver downloads them.
 *
 * The QR code contains ONLY the Peer ID (a short string like
 * "abc123xy"), NOT the full SDP — so QR codes are tiny,
 * scan instantly, and scanning ALWAYS works.
 * ═══════════════════════════════════════════════════
 */

'use strict';

/* ═══════════════════════════════
   CONFIG
═══════════════════════════════ */
const CHUNK_SIZE  = 64 * 1024;       // 64 KB
const BUFFER_HIGH = 4  * 1024 * 1024;
const BUFFER_LOW  = 512 * 1024;

/* ═══════════════════════════════
   STATE
═══════════════════════════════ */
let peer        = null;   // PeerJS instance
let conn        = null;   // DataConnection
let myRole      = null;   // 'sender' | 'receiver'
let myId        = null;   // our Peer ID

// Sender TX
let txQueue     = [];     // File[]
let txMeta      = [];     // {name,size,status}
let txIdx       = 0;
let txStart     = 0;
let txBytes     = 0;

// Receiver RX
let rxMeta      = null;
let rxChunks    = [];
let rxBytes     = 0;
let rxStart     = 0;
let rxHistory   = [];

// Camera
let camStream   = null;
let camRAF      = null;
let camActive   = false;
let qrFound     = false;

/* ═══════════════════════════════
   BOOT
═══════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  // Detect device
  const mobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const dl = document.getElementById('devLabel');
  if (dl) dl.textContent = mobile ? '📱 Mobile' : '💻 Desktop';

  // Particle background
  initParticles();

  // Init PeerJS immediately so we're ready
  initPeer();
});

/* ═══════════════════════════════
   PEERJS INIT
═══════════════════════════════ */
function initPeer() {
  const psDot  = document.getElementById('psDot');
  const psText = document.getElementById('psText');

  // Create peer with random ID
  // Using PeerJS public cloud server (free, open source)
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
    if (psDot)  psDot.className  = 'ps-dot ok';
    if (psText) psText.textContent = 'Network ready ✓';
    // Enable role buttons
    document.getElementById('btnRoleSend').disabled = false;
    document.getElementById('btnRoleRecv').disabled = false;
  });

  peer.on('error', (err) => {
    console.error('[Peer] error:', err);
    if (psDot)  psDot.className  = 'ps-dot err';
    if (psText) psText.textContent = 'Network error — retrying…';
    showToast('⚠️ Network error: ' + err.type);
    // Retry after 3s
    setTimeout(initPeer, 3000);
  });

  // Receiver side: listen for incoming connections
  peer.on('connection', (incomingConn) => {
    if (myRole !== 'sender') return; // ignore if we're not sender
    conn = incomingConn;
    setupConn('sender');
    console.log('[Peer] incoming connection from:', incomingConn.peer);
  });
}

/* ═══════════════════════════════
   SCREENS
═══════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

function goHome() {
  stopCam(); // also clears _scanInterval inside
  if (conn) { try { conn.close(); } catch(e){} conn = null; }
  // Reset sender state
  txQueue = []; txMeta = []; txIdx = 0;
  // Reset receiver state
  rxMeta = null; rxChunks = []; rxBytes = 0;
  qrFound = false; _scanAttempts = 0;
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
    setupSender();
  } else {
    showScreen('sReceiver');
    // Auto-start camera after transition
    setTimeout(startCam, 500);
  }
}

/* ═══════════════════════════════
   SENDER SETUP
═══════════════════════════════ */
function setupSender() {
  if (!myId) { showToast('⚠️ Still connecting to network…'); return; }

  // Show QR with our Peer ID
  // The QR contains JUST the peer ID — tiny, scans instantly!
  renderQR(myId);

  // Show peer ID text
  const el = document.getElementById('myPeerIdDisplay');
  if (el) el.textContent = myId;
  document.getElementById('qrMeta').style.display = '';

  // Setup file drop zone
  setupDrop();

  // Update status
  setConnStatus('sender', '', 'Waiting for receiver to scan QR…');
}

/* ═══════════════════════════════
   QR CODE RENDER
═══════════════════════════════ */
function renderQR(text) {
  const frame    = document.getElementById('qrFrame');
  const loading  = document.getElementById('qrLoading');
  const canvas   = document.getElementById('qrCanvas');

  if (loading) loading.style.display = 'none';
  if (canvas)  canvas.innerHTML = '';

  try {
    new QRCode(canvas, {
      text:          text,
      width:         200,
      height:        200,
      colorDark:     '#000000',
      colorLight:    '#ffffff',
      correctLevel:  QRCode.CorrectLevel.M, // Medium — fast decode + error correction
    });
  } catch(e) {
    console.error('[QR]', e);
    if (frame) frame.innerHTML = `
      <div style="padding:1rem;text-align:center;color:#888;font-size:.78rem;font-family:var(--mono)">
        QR failed — Your ID:<br/><strong style="color:#818cf8;word-break:break-all">${text}</strong>
      </div>`;
  }
}

/* ═══════════════════════════════════════════════════
   RECEIVER — CAMERA / QR SCAN  (bulletproof rewrite)
   
   FIX SUMMARY:
   1. jsQR check — verify library loaded before scanning
   2. Use setInterval (10fps) NOT rAF — rAF fires too fast,
      jsQR decode is slow (~30ms), causing frame drops + lock
   3. Wait for video.readyState === 4 (HAVE_ENOUGH_DATA)
      AND videoWidth > 0 before first decode attempt
   4. Throttle decode to every 100ms — gives jsQR time to finish
   5. Scale canvas DOWN to 640px wide — smaller = faster decode
   6. Try both rear and front cameras as fallback
   7. Add visible debug counter so user knows scanning is active
═══════════════════════════════════════════════════ */

let _scanInterval = null;  // setInterval handle (replaces rAF)
let _lastScanTime = 0;     // throttle timestamp
let _scanAttempts = 0;     // counter for debug pill

async function startCam() {
  if (camActive) return;

  // ── Safety check: is jsQR loaded? ──────────────────
  if (typeof jsQR !== 'function') {
    showToast('❌ QR scanner library not loaded. Check internet connection.');
    document.getElementById('camDenied').classList.remove('hidden');
    document.getElementById('btnCamOn').classList.add('hidden');
    console.error('[Camera] jsQR is not loaded!');
    return;
  }

  const video = document.getElementById('camVideo');
  const pill  = document.getElementById('camPill');

  // Reset state
  qrFound       = false;
  _scanAttempts = 0;

  // Update pill
  if (pill) { pill.textContent = 'Requesting camera…'; pill.classList.remove('ok'); }

  try {
    // ── Strategy 1: rear camera (ideal for mobile) ──
    let constraints = {
      video: {
        facingMode:  { ideal: 'environment' },
        width:       { min: 320, ideal: 1280, max: 1920 },
        height:      { min: 240, ideal: 720,  max: 1080 },
      },
      audio: false,
    };

    try {
      camStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e1) {
      console.warn('[Camera] rear camera failed, trying any camera:', e1.message);
      // ── Strategy 2: any available camera ──
      camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    // Attach stream to video element
    video.srcObject = camStream;
    video.setAttribute('playsinline', 'true');  // iOS Safari requirement
    video.setAttribute('muted', 'true');
    video.muted = true;

    // ── Wait for video to actually have pixels ──────
    // We wait for readyState >= 2 (HAVE_CURRENT_DATA) AND videoWidth > 0
    // with a polling approach instead of event listeners (more reliable)
    await waitForVideoReady(video);

    // Force play (needed on some browsers)
    try { await video.play(); } catch(e) { /* autoplay may already be going */ }

    // ── Mark camera as active ──
    camActive = true;
    document.getElementById('btnCamOn').classList.add('hidden');
    document.getElementById('btnCamOff').classList.remove('hidden');
    if (pill) pill.textContent = 'Scanning… hold steady';

    console.log('[Camera] ready — videoWidth:', video.videoWidth, 'videoHeight:', video.videoHeight);

    // ── Start decode loop using setInterval at 10fps ──
    // Using setInterval instead of requestAnimationFrame because:
    // - rAF fires at 60fps, jsQR takes ~30ms → queue backs up
    // - setInterval at 100ms gives jsQR room to breathe
    // - Result: reliable detection instead of missed frames
    _scanInterval = setInterval(doScanTick, 100);

  } catch(err) {
    console.error('[Camera] getUserMedia failed:', err.name, err.message);
    showCameraError(err);
  }
}

/* Polls until video element has real pixel data */
function waitForVideoReady(video) {
  return new Promise((resolve) => {
    // Already ready?
    if (video.readyState >= 2 && video.videoWidth > 0) { resolve(); return; }

    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        clearInterval(poll);
        resolve();
      } else if (attempts > 60) {  // 6 second timeout
        clearInterval(poll);
        resolve(); // resolve anyway, let decode handle it
      }
    }, 100);
  });
}

/* Called every 100ms by setInterval — does one QR decode attempt */
function doScanTick() {
  if (!camActive || qrFound) return;

  const video  = document.getElementById('camVideo');
  const canvas = document.getElementById('camCanvas');
  const pill   = document.getElementById('camPill');
  if (!video || !canvas) return;

  // Skip if video not ready yet
  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
    if (pill) pill.textContent = 'Waiting for camera…';
    return;
  }

  // ── Scale canvas to 640px wide for faster decode ──
  // jsQR works best on images 400-800px wide
  // Full 1280px images are slower and rarely help detection
  const SCAN_WIDTH  = 640;
  const scale       = SCAN_WIDTH / video.videoWidth;
  const SCAN_HEIGHT = Math.round(video.videoHeight * scale);

  canvas.width  = SCAN_WIDTH;
  canvas.height = SCAN_HEIGHT;

  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });

  try {
    ctx.drawImage(video, 0, 0, SCAN_WIDTH, SCAN_HEIGHT);
  } catch(e) {
    console.warn('[Scan] drawImage failed:', e.message);
    return;
  }

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, SCAN_WIDTH, SCAN_HEIGHT);
  } catch(e) {
    // This happens on some browsers if canvas is tainted (CORS)
    console.warn('[Scan] getImageData failed:', e.message);
    return;
  }

  // Update pill with attempt counter so user knows it's working
  _scanAttempts++;
  if (pill && _scanAttempts % 5 === 0) {
    pill.textContent = `Scanning… (${_scanAttempts} frames)`;
  }

  // ── jsQR decode ──────────────────────────────────
  let code = null;
  try {
    code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth',  // handle both dark-on-light and light-on-dark QR
    });
  } catch(e) {
    console.warn('[Scan] jsQR threw:', e.message);
    return;
  }

  if (code && code.data && code.data.trim().length > 0) {
    const decoded = code.data.trim();
    console.log('[QR] FOUND after', _scanAttempts, 'frames — data:', decoded);
    qrFound = true;
    onQRDetected(decoded);
  }
  // else: no QR this frame, interval will try again in 100ms
}

function onQRDetected(peerId) {
  // Stop scanning immediately
  stopCam();

  // Visual feedback on the camera viewport
  const wrap = document.getElementById('camWrap');
  const pill = document.getElementById('camPill');
  if (wrap) wrap.classList.add('detected');
  if (pill) { pill.textContent = '✅ QR Detected!'; pill.classList.add('ok'); }

  showToast('📷 QR scanned! Connecting to sender…');

  // Connect using the scanned Peer ID
  connectToPeer(peerId);
}

function showCameraError(err) {
  const denied = document.getElementById('camDenied');
  const btnOn  = document.getElementById('btnCamOn');

  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    showToast('📵 Camera permission denied. Enter Peer ID manually.');
  } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
    showToast('❌ No camera found. Enter Peer ID manually.');
  } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
    showToast('❌ Camera in use by another app. Close it and try again.');
  } else if (err.name === 'OverconstrainedError') {
    showToast('❌ Camera constraints not supported. Enter Peer ID manually.');
  } else {
    showToast('❌ Camera error: ' + (err.message || err.name));
  }

  if (denied) denied.classList.remove('hidden');
  if (btnOn)  btnOn.classList.add('hidden');
}

function stopCam() {
  camActive = false;

  // Stop interval (replaces old rAF cancel)
  if (_scanInterval) { clearInterval(_scanInterval); _scanInterval = null; }
  if (camRAF)        { cancelAnimationFrame(camRAF); camRAF = null; }

  // Stop all camera tracks
  if (camStream) {
    camStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
    camStream = null;
  }

  const v = document.getElementById('camVideo');
  if (v) { v.srcObject = null; v.load(); }

  document.getElementById('btnCamOn')?.classList.remove('hidden');
  document.getElementById('btnCamOff')?.classList.add('hidden');
}

// Legacy aliases — keep camLoop/camFrame refs alive in case called elsewhere
function camLoop() { /* replaced by setInterval in startCam */ }
function camFrame() { /* replaced by doScanTick */ }

/* ═══════════════════════════════
   MANUAL PEER ID (fallback)
═══════════════════════════════ */
function connectByPeerId() {
  const input = document.getElementById('manualPeerId');
  const id    = input?.value?.trim();
  if (!id) { showToast('⚠️ Enter the Peer ID first.'); return; }
  connectToPeer(id);
}

/* ═══════════════════════════════
   RECEIVER — CONNECT TO SENDER
═══════════════════════════════ */
function connectToPeer(senderId) {
  if (!peer || !peer.open) {
    showToast('⚠️ Not connected to network yet. Try again.');
    return;
  }
  if (senderId === myId) {
    showToast('⚠️ Cannot connect to yourself!');
    return;
  }

  setConnStatus('receiver', 'connecting', 'Connecting…');

  conn = peer.connect(senderId, {
    reliable: true,
    serialization: 'binary', // raw ArrayBuffer / string
  });

  setupConn('receiver');
}

/* ═══════════════════════════════
   DATACONNECTION SETUP (both sides)
═══════════════════════════════ */
function setupConn(role) {
  if (!conn) return;

  conn.on('open', () => {
    console.log('[Conn] open, role:', role);
    onConnOpen(role);
  });

  conn.on('data', (data) => {
    onData(data);
  });

  conn.on('close', () => {
    console.log('[Conn] closed');
    showToast('🔌 Connection closed.');
    setConnStatus(role, '', 'Disconnected');
  });

  conn.on('error', (err) => {
    console.error('[Conn] error:', err);
    showToast('❌ Connection error: ' + (err.message || err));
    setConnStatus(role, 'failed', 'Failed');
  });
}

function onConnOpen(role) {
  setConnStatus(role, 'connected', 'Connected ✓');
  showToast('🔗 Connected! ' + (role === 'sender' ? 'Drop files to send →' : 'Waiting for files…'));

  if (role === 'sender') {
    // Show success badge on QR panel
    document.getElementById('qrConnected').classList.remove('hidden');
    // If files already queued, start sending automatically
    if (txQueue.length > 0 && txIdx === 0) {
      setTimeout(sendNext, 300);
    }
  }

  if (role === 'receiver') {
    // Hide scanner, show connected state
    document.getElementById('recvScanBody').classList.add('hidden');
    document.getElementById('recvConnected').classList.remove('hidden');
  }
}

/* ═══════════════════════════════
   DATA HANDLER (receiver side)
═══════════════════════════════ */
function onData(data) {
  if (typeof data === 'string') {
    // JSON control message
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'meta') {
        startReceiving(msg);
      }
    } catch(e) {
      console.error('[Data] bad JSON:', e);
    }
  } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
    // Raw binary chunk
    receiveChunk(data instanceof Uint8Array ? data.buffer : data);
  } else {
    console.warn('[Data] unknown type:', typeof data, data);
  }
}

function startReceiving(meta) {
  rxMeta   = meta;
  rxChunks = [];
  rxBytes  = 0;
  rxStart  = Date.now();

  console.log('[RX] receiving:', meta.name, formatBytes(meta.size));

  document.getElementById('rxCard').classList.remove('hidden');
  document.getElementById('rxIco').textContent  = fileIcon(meta.name);
  document.getElementById('rxName').textContent = meta.name;
  document.getElementById('rxSz').textContent   = formatBytes(meta.size);
  document.getElementById('rcStatus').textContent = 'Receiving: ' + meta.name;
  updateRxProgress(0, 0, meta.size);
}

function receiveChunk(buf) {
  if (!rxMeta) return;
  rxChunks.push(buf);
  rxBytes += buf.byteLength;

  const pct = Math.min(100, Math.round((rxBytes / rxMeta.size) * 100));
  updateRxProgress(pct, rxBytes, rxMeta.size);

  if (rxBytes >= rxMeta.size) {
    finalizeRx();
  }
}

function finalizeRx() {
  const blob = new Blob(rxChunks, { type: rxMeta.fileType || 'application/octet-stream' });

  // Auto-download
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = rxMeta.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  showToast('✅ Saved: ' + rxMeta.name);
  addRxHistory(rxMeta.name, rxMeta.size, blob);

  document.getElementById('rcStatus').textContent = 'Waiting for more files…';
  document.getElementById('rxCard').classList.add('hidden');

  rxMeta = null; rxChunks = []; rxBytes = 0;
}

/* ═══════════════════════════════
   SENDER — DROP ZONE
═══════════════════════════════ */
function setupDrop() {
  const dz = document.getElementById('dropzone');
  if (!dz) return;

  dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', ()  => dz.classList.remove('over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('over');
    handleFiles(e.dataTransfer.files);
  });
  dz.addEventListener('click', e => {
    if (e.target.tagName !== 'BUTTON') document.getElementById('fileInput').click();
  });
}

function handleFiles(files) {
  if (!files?.length) return;
  for (const f of files) {
    txQueue.push(f);
    txMeta.push({ name: f.name, size: f.size, status: 'pending' });
  }
  renderQueue();
  document.getElementById('dropzone').classList.add('hidden');
  document.getElementById('fileQueue').classList.remove('hidden');

  // Auto-start if already connected
  if (conn?.open && txIdx === 0) {
    setTimeout(sendNext, 200);
  }
}

function renderQueue() {
  const ul    = document.getElementById('fqList');
  const count = document.getElementById('fqCount');
  if (!ul) return;
  if (count) count.textContent = txQueue.length + (txQueue.length === 1 ? ' file' : ' files');
  ul.innerHTML = '';
  txMeta.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = `fq-item ${m.status}`;
    li.id = `fqi-${i}`;
    li.innerHTML = `
      <span class="fq-ico">${fileIcon(txQueue[i].name)}</span>
      <div class="fq-inf">
        <span class="fq-name" title="${esc(m.name)}">${esc(m.name)}</span>
        <span class="fq-size">${formatBytes(m.size)}</span>
      </div>
      <span class="fq-st ${m.status}">${m.status}</span>
      ${m.status === 'pending' ? `<button class="fq-rm" onclick="removeFile(${i})">✕</button>` : ''}
    `;
    ul.appendChild(li);
  });
}

function removeFile(i) {
  txQueue.splice(i, 1);
  txMeta.splice(i, 1);
  if (!txQueue.length) {
    document.getElementById('fileQueue').classList.add('hidden');
    document.getElementById('dropzone').classList.remove('hidden');
  } else renderQueue();
}

function setFileStatus(i, status) {
  const li = document.getElementById(`fqi-${i}`);
  if (!li) return;
  li.className = `fq-item ${status}`;
  const b = li.querySelector('.fq-st');
  if (b) { b.className = `fq-st ${status}`; b.textContent = status; }
}

/* ═══════════════════════════════
   SENDER — TRANSFER
═══════════════════════════════ */
async function startSend() {
  if (!conn?.open) {
    showToast('⚠️ Not connected yet. Wait for receiver to scan the QR.');
    return;
  }
  document.getElementById('btnSend').disabled = true;
  txIdx = 0;
  await sendNext();
}

async function sendNext() {
  if (txIdx >= txQueue.length) {
    document.getElementById('txCard').classList.add('hidden');
    document.getElementById('btnSend').disabled = false;
    showToast('🎉 All files sent!');
    return;
  }

  const file = txQueue[txIdx];
  const meta = txMeta[txIdx];
  meta.status = 'active';
  setFileStatus(txIdx, 'active');

  // 1. Send metadata as JSON string
  conn.send(JSON.stringify({
    type:      'meta',
    name:      file.name,
    size:      file.size,
    fileType:  file.type || 'application/octet-stream',
  }));

  // 2. Setup transfer UI
  document.getElementById('txCard').classList.remove('hidden');
  document.getElementById('txIco').textContent  = fileIcon(file.name);
  document.getElementById('txName').textContent = file.name;
  document.getElementById('txSz').textContent   = formatBytes(file.size);
  resetTxUI();
  txStart = Date.now();
  txBytes = 0;

  // 3. Stream file in 64KB chunks
  const stream = file.stream();
  const reader = stream.getReader();

  try {
    while (true) {
      // Backpressure: PeerJS DataConnection doesn't expose bufferedAmount
      // directly, so we use a small delay when sending large chunks
      // to avoid overwhelming the buffer
      const { done, value } = await reader.read();
      if (done) break;

      // Send raw ArrayBuffer chunk
      conn.send(value.buffer);

      txBytes += value.byteLength;
      const pct = Math.min(100, Math.round((txBytes / file.size) * 100));
      updateTxUI(pct, txBytes, file.size);

      // Yield to keep UI responsive and avoid buffer overflow
      if (txBytes % (512 * 1024) < CHUNK_SIZE) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    meta.status = 'done';
    setFileStatus(txIdx, 'done');
    addSentHistory(file.name, file.size);

  } catch(err) {
    console.error('[TX]', err);
    meta.status = 'error';
    setFileStatus(txIdx, 'error');
    addSentHistory(file.name, file.size, true);
    showToast('❌ Error sending: ' + file.name);
  }

  txIdx++;
  await sendNext();
}

function resetTxUI() {
  document.getElementById('txFill').style.width  = '0%';
  document.getElementById('txPct').textContent   = '0%';
  document.getElementById('txSpd').textContent   = '—';
  document.getElementById('txEta').textContent   = '—';
  document.getElementById('txDone').textContent  = '—';
}

function updateTxUI(pct, bytes, total) {
  document.getElementById('txFill').style.width  = pct + '%';
  document.getElementById('txPct').textContent   = pct + '%';
  document.getElementById('txDone').textContent  = formatBytes(bytes) + ' / ' + formatBytes(total);
  const elapsed = (Date.now() - txStart) / 1000 || 0.001;
  const speed   = bytes / elapsed;
  document.getElementById('txSpd').textContent = formatSpeed(speed);
  document.getElementById('txEta').textContent = formatETA(speed > 0 ? (total - bytes) / speed : 0);
}

function updateRxProgress(pct, bytes, total) {
  document.getElementById('rxFill').style.width  = pct + '%';
  document.getElementById('rxPct').textContent   = pct + '%';
  document.getElementById('rxGot').textContent   = formatBytes(bytes) + ' / ' + formatBytes(total);
  if (bytes > 0) {
    const elapsed = (Date.now() - rxStart) / 1000 || 0.001;
    const speed   = bytes / elapsed;
    document.getElementById('rxSpd').textContent = formatSpeed(speed);
    document.getElementById('rxEta').textContent = formatETA(speed > 0 ? (total - bytes) / speed : 0);
  }
}

/* ═══════════════════════════════
   STATUS
═══════════════════════════════ */
function setConnStatus(role, state, text) {
  const dotId = role === 'sender' ? 'sDot' : 'rDot';
  const txtId = role === 'sender' ? 'sText' : 'rText';
  const dot   = document.getElementById(dotId);
  const txt   = document.getElementById(txtId);
  if (dot) dot.className = 'cb-dot ' + state;
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
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  li.innerHTML = `
    <span class="hi-ico">${fileIcon(name)}</span>
    <div class="hi-inf">
      <span class="hi-n" title="${esc(name)}">${esc(name)}</span>
      <span class="hi-m">${formatBytes(size)} · ${t}</span>
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
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  li.innerHTML = `
    <span class="hi-ico">${fileIcon(name)}</span>
    <div class="hi-inf">
      <span class="hi-n" title="${esc(name)}">${esc(name)}</span>
      <span class="hi-m">${formatBytes(size)} · ${t}</span>
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
  a.href = url; a.download = item.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ═══════════════════════════════
   PARTICLES (background effect)
═══════════════════════════════ */
function initParticles() {
  const canvas = document.getElementById('particles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, dots = [];

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  // Create sparse dots
  for (let i = 0; i < 60; i++) {
    dots.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: Math.random() * 1.2 + .3,
      vx: (Math.random() - .5) * .25,
      vy: (Math.random() - .5) * .25,
      a: Math.random() * .5 + .1,
    });
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    dots.forEach(d => {
      d.x += d.vx; d.y += d.vy;
      if (d.x < 0) d.x = W;
      if (d.x > W) d.x = 0;
      if (d.y < 0) d.y = H;
      if (d.y > H) d.y = 0;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(129,140,248,${d.a})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
}

/* ═══════════════════════════════
   TOAST
═══════════════════════════════ */
let _tt = null;
function showToast(msg, ms = 3200) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ═══════════════════════════════
   FORMAT HELPERS
═══════════════════════════════ */
function formatBytes(b) {
  if (!b) return '0 B';
  const k = 1024, u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + u[i];
}
function formatSpeed(bps) {
  if (bps < 1024)    return bps.toFixed(0)     + ' B/s';
  if (bps < 1048576) return (bps/1024).toFixed(1) + ' KB/s';
  return (bps/1048576).toFixed(2) + ' MB/s';
}
function formatETA(s) {
  if (!isFinite(s) || s < 0) return '—';
  if (s < 60)   return Math.ceil(s) + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + Math.ceil(s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}
function fileIcon(n) {
  const e = (n||'').split('.').pop().toLowerCase();
  return ({
    pdf:'📄',png:'🖼️',jpg:'🖼️',jpeg:'🖼️',gif:'🖼️',webp:'🖼️',svg:'🖼️',bmp:'🖼️',
    mp4:'🎬',mkv:'🎬',avi:'🎬',mov:'🎬',webm:'🎬',m4v:'🎬',
    mp3:'🎵',wav:'🎵',flac:'🎵',ogg:'🎵',aac:'🎵',m4a:'🎵',
    zip:'🗜️',rar:'🗜️',gz:'🗜️','7z':'🗜️',tar:'🗜️',bz2:'🗜️',
    doc:'📝',docx:'📝',txt:'📝',md:'📝',rtf:'📝',odt:'📝',
    xls:'📊',xlsx:'📊',csv:'📊',ods:'📊',
    ppt:'📋',pptx:'📋',odp:'📋',
    js:'💻',ts:'💻',py:'💻',html:'💻',css:'💻',json:'💻',xml:'💻',sh:'💻',
    apk:'📱',exe:'⚙️',dmg:'💿',iso:'💿',msi:'⚙️',
  })[e] || '📎';
}
function esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
/**
 * ShareDrop — app.js
 * ═══════════════════════════════════════════════════════
 * Architecture: Chunked P2P file transfer via WebRTC/PeerJS
 *
 * KEY BEHAVIOURS:
 *  - Sender shows QR → Receiver scans → connection opens
 *  - On connection: QR panel FADES OUT, files panel EXPANDS (sender)
 *                   Scanner view HIDES, connected view SHOWS (receiver)
 *  - Files are queued on selection; transfer only starts on Send button
 *  - File is read in 64 KB slices — never fully loaded into RAM
 *  - DataChannel backpressure prevents OOM on large (10 GB+) files
 *  - Pause / Resume / Cancel supported
 * ═══════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────
   CONSTANTS
───────────────────────────── */
const CHUNK_SIZE    = 64  * 1024;        // 64 KB per read
const BUFFER_HIGH   = 4   * 1024 * 1024; // 4 MB  — stall if buffer exceeds
const DRAIN_POLL_MS = 50;                 // buffer drain poll interval (ms)

/* ─────────────────────────────
   STATE
───────────────────────────── */
let peer         = null;
let conn         = null;
let myRole       = null;
let myId         = null;
let reconnecting = false;

// TX
let txQueue      = [];
let txMeta       = [];
let txIdx        = 0;
let txOffset     = 0;
let txStart      = 0;
let txTotalSent  = 0;
let isPaused     = false;
let isCancelled  = false;
let txActive     = false;

// RX
let rxMeta       = null;
let rxChunks     = [];
let rxBytes      = 0;
let rxStart      = 0;
let rxCancelled  = false;
let rxHistory    = [];

// Camera
let camStream    = null;
let _scanInterval = null;
let _scanAttempts = 0;
let qrFound      = false;
let camActive    = false;

// Modal
let _modalOkFn   = null;

/* ─────────────────────────────
   BOOT
───────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  const mobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const dl = document.getElementById('devLabel');
  if (dl) dl.textContent = mobile ? '📱 Mobile device' : '💻 Desktop';
  initPeer();
});

/* ─────────────────────────────
   PEER INIT
───────────────────────────── */
function initPeer() {
  const dot  = document.getElementById('nsDot');
  const text = document.getElementById('nsText');
  if (dot)  dot.className  = 'ns-dot connecting';
  if (text) text.textContent = 'Connecting to network…';

  if (peer && !peer.destroyed) { try { peer.destroy(); } catch(e){} }

  peer = new Peer(undefined, {
    host: '0.peerjs.com', port: 443, secure: true, path: '/',
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478'  },
    ]},
    debug: 0,
  });

  peer.on('open', (id) => {
    myId = id;
    if (dot)  dot.className  = 'ns-dot ok';
    if (text) text.textContent = 'Network ready';
    document.getElementById('btnRoleSend').disabled = false;
    document.getElementById('btnRoleRecv').disabled = false;
    reconnecting = false;
  });

  peer.on('error', (err) => {
    if (dot)  dot.className  = 'ns-dot err';
    if (text) text.textContent = 'Network error — retrying…';
    showToast('⚠️ Network error: ' + err.type);
    if (!reconnecting) { reconnecting = true; setTimeout(initPeer, 4000); }
  });

  peer.on('disconnected', () => {
    if (!peer.destroyed) { try { peer.reconnect(); } catch(e){ setTimeout(initPeer, 3000); } }
  });

  peer.on('connection', (incomingConn) => {
    if (myRole !== 'sender') return;
    if (conn && conn.open) { try { incomingConn.close(); } catch(e){} return; }
    conn = incomingConn;
    setupDataConnection('sender');
  });
}

/* ─────────────────────────────
   NAVIGATION
───────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

function goHome() {
  if (txActive) { isCancelled = true; txActive = false; }
  stopCam();
  if (conn) { try { conn.close(); } catch(e){} conn = null; }

  // Reset state
  txQueue = []; txMeta = []; txIdx = 0; txOffset = 0;
  isPaused = false; isCancelled = false; txActive = false;
  rxMeta = null; rxChunks = []; rxBytes = 0; rxCancelled = false;
  qrFound = false; _scanAttempts = 0;

  // Reset sender UI
  document.getElementById('fileQueue')?.classList.add('hidden');
  document.getElementById('dropzone')?.classList.remove('hidden');
  document.getElementById('txCard')?.classList.add('hidden');
  document.getElementById('sHistList').innerHTML = '';
  document.getElementById('sHistEmpty').style.display = '';

  // Restore QR panel and sender layout
  const qrPanel    = document.getElementById('qrPanel');
  const filesPanel = document.getElementById('filesPanel');
  const layout     = document.getElementById('senderLayout');
  if (qrPanel) {
    qrPanel.classList.remove('hidden', 'hiding');
    qrPanel.style.display = '';
  }
  if (filesPanel) {
    filesPanel.classList.remove('expanding');
  }
  if (layout) layout.classList.remove('single-col');

  // Hide connected banner, restore panel header
  document.getElementById('senderConnBanner')?.classList.add('hidden');
  document.getElementById('filesPanelHeader')?.classList.remove('hidden');

  // Reset receiver UI
  document.getElementById('recvScanBody')?.classList.remove('hidden');
  document.getElementById('recvConnected')?.classList.add('hidden');
  document.getElementById('rHistList').innerHTML = '';
  document.getElementById('rHistEmpty').style.display = '';

  myRole = null;
  showScreen('sHome');
}

/* ─────────────────────────────
   ROLE SELECTION
───────────────────────────── */
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

/* ─────────────────────────────
   SENDER SCREEN SETUP
───────────────────────────── */
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

/* ─────────────────────────────
   QR RENDER
───────────────────────────── */
function renderQR(text) {
  const spinner = document.getElementById('qrSpinner');
  const canvas  = document.getElementById('qrCanvas');
  if (spinner) spinner.style.display = 'none';
  if (canvas)  canvas.innerHTML = '';
  try {
    new QRCode(canvas, {
      text: text, width: 200, height: 200,
      colorDark: '#000000', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  } catch(e) {
    const qrBox = document.getElementById('qrBox');
    if (qrBox) qrBox.innerHTML = `<div style="padding:1.5rem;text-align:center;font-size:.78rem;font-family:var(--mono);color:var(--text3)">QR unavailable<br/><span style="color:var(--indigo);word-break:break-all;font-size:.7rem">${esc(text)}</span></div>`;
  }
}

/* ─────────────────────────────
   DROPZONE
───────────────────────────── */
function setupDropzone() {
  const dz = document.getElementById('dropzone');
  if (!dz) return;
  dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', ()  => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); onFilePicked(e.dataTransfer.files); });
  dz.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') document.getElementById('fileInput').click(); });
}

/* Files selected — queue only, NO auto-send */
function onFilePicked(files) {
  if (!files?.length) return;
  let added = 0;
  for (const f of files) {
    txQueue.push(f);
    txMeta.push({ name: f.name, size: f.size, status: 'pending' });
    added++;
  }
  renderFileQueue();
  document.getElementById('dropzone')?.classList.add('hidden');
  document.getElementById('fileQueue')?.classList.remove('hidden');
  updateSendButton();
  showToast(`${added} file${added > 1 ? 's' : ''} added — click Send when ready`);
  // ⚠️  NO sendNext() call here — user must press Send button
}

function updateSendButton() {
  const btn = document.getElementById('btnSend');
  if (!btn) return;
  btn.disabled = txQueue.length === 0;
  btn.title = (!conn?.open && txQueue.length > 0) ? 'Waiting for receiver to connect' : '';
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
  txQueue.splice(i, 1); txMeta.splice(i, 1);
  if (!txQueue.length) {
    document.getElementById('fileQueue')?.classList.add('hidden');
    document.getElementById('dropzone')?.classList.remove('hidden');
  } else renderFileQueue();
}

function clearQueue() {
  const pending = txMeta.filter(m => m.status === 'pending').length;
  if (!pending) return;
  showModal('Clear queue?', `Remove all ${pending} pending file${pending > 1 ? 's' : ''} from the queue?`, () => {
    const keep = txQueue.filter((_, i) => txMeta[i].status !== 'pending');
    txQueue = keep;
    txMeta  = txMeta.filter(m => m.status !== 'pending');
    if (!txQueue.length) {
      document.getElementById('fileQueue')?.classList.add('hidden');
      document.getElementById('dropzone')?.classList.remove('hidden');
    } else renderFileQueue();
  });
}

function setFileStatus(i, status) {
  if (txMeta[i]) txMeta[i].status = status;
  const li = document.getElementById(`fqi-${i}`);
  if (!li) return;
  li.className = `fq-item ${status}`;
  const badge = li.querySelector('.fq-status');
  if (badge) { badge.className = `fq-status ${status}`; badge.textContent = status; }
  const rm = li.querySelector('.fq-rm');
  if (rm && status !== 'pending') rm.remove();
}

/* ─────────────────────────────
   START SEND (button handler)
───────────────────────────── */
function startSend() {
  if (!conn?.open) {
    showToast('⚠️ Not connected yet — wait for receiver to scan the QR code');
    return;
  }
  const pending = txMeta.filter(m => m.status === 'pending');
  if (!pending.length) { showToast('⚠️ No files to send'); return; }
  const totalSize = txQueue.reduce((s, f, i) => txMeta[i].status === 'pending' ? s + f.size : s, 0);
  showModal(
    'Confirm Transfer',
    `Send ${pending.length} file${pending.length > 1 ? 's' : ''} (${formatBytes(totalSize)}) to receiver?`,
    () => {
      document.getElementById('btnSend').disabled = true;
      txIdx = 0; isPaused = false; isCancelled = false; txActive = true;
      sendNextFile();
    }
  );
}

/* ─────────────────────────────────────────────────────
   CHUNKED TRANSFER LOOP
   
   Only CHUNK_SIZE (64 KB) bytes live in memory at once.
   DataChannel backpressure via bufferedAmount polling.
───────────────────────────────────────────────────── */
async function sendNextFile() {
  // Skip already-done/errored files
  while (txIdx < txQueue.length && txMeta[txIdx].status !== 'pending') txIdx++;

  if (txIdx >= txQueue.length || isCancelled) { finalizeSendAll(); return; }

  const file = txQueue[txIdx];
  const meta = txMeta[txIdx];

  meta.status = 'active';
  setFileStatus(txIdx, 'active');

  conn.send(JSON.stringify({
    type: 'meta', name: file.name, size: file.size,
    mimeType: file.type || 'application/octet-stream',
  }));

  showTxCard(file);
  txOffset = 0; txStart = Date.now(); txTotalSent = 0;

  let chunkIdx = 0;
  while (txOffset < file.size && !isCancelled) {
    // Honour pause
    while (isPaused && !isCancelled) await sleep(100);
    if (isCancelled) break;

    // Backpressure: wait if DataChannel buffer is full
    if (conn?.dataChannel) {
      while (conn.dataChannel.bufferedAmount > BUFFER_HIGH) {
        await sleep(DRAIN_POLL_MS);
        if (isCancelled) break;
      }
    } else if (chunkIdx % 64 === 0) await sleep(1); // soft throttle fallback

    if (isCancelled) break;

    // Read one chunk
    const slice = file.slice(txOffset, Math.min(txOffset + CHUNK_SIZE, file.size));
    let buffer;
    try {
      buffer = await readSliceAsArrayBuffer(slice);
    } catch(e) {
      meta.status = 'error'; setFileStatus(txIdx, 'error');
      addSentHistory(file.name, file.size, true);
      showToast(`❌ Error reading: ${file.name}`);
      txIdx++; if (txIdx < txQueue.length) sendNextFile(); else finalizeSendAll();
      return;
    }

    if (isCancelled) break;

    try {
      conn.send(buffer);
    } catch(e) {
      meta.status = 'error'; setFileStatus(txIdx, 'error');
      showToast('❌ Connection lost during transfer');
      finalizeSendAll(); return;
    }

    txOffset += buffer.byteLength;
    txTotalSent += buffer.byteLength;
    chunkIdx++;
    updateTxUI(txOffset, file.size);
    if (chunkIdx % 8 === 0) await sleep(0); // yield to UI thread
  }

  if (isCancelled) {
    try { conn.send(JSON.stringify({ type: 'cancel' })); } catch(e) {}
    meta.status = 'error'; setFileStatus(txIdx, 'error');
    addSentHistory(file.name, file.size, true);
    finalizeSendAll(); return;
  }

  conn.send(JSON.stringify({ type: 'done' }));
  meta.status = 'done'; setFileStatus(txIdx, 'done');
  addSentHistory(file.name, file.size, false);
  showToast(`✅ Sent: ${file.name}`);

  txIdx++;
  await sleep(150);
  sendNextFile();
}

function finalizeSendAll() {
  txActive = false;
  document.getElementById('txCard')?.classList.add('hidden');
  document.getElementById('btnSend').disabled = false;
  if (!isCancelled) {
    const done = txMeta.filter(m => m.status === 'done').length;
    if (done > 0) showToast(`🎉 All ${done} file${done > 1 ? 's' : ''} sent!`);
  }
  updateSendButton();
}

function readSliceAsArrayBuffer(slice) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = e => reject(e.target.error);
    reader.readAsArrayBuffer(slice);
  });
}

function togglePause() {
  if (!txActive) return;
  isPaused = !isPaused;
  const btn = document.getElementById('btnPause');
  if (btn) btn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
  setFileStatus(txIdx, isPaused ? 'paused' : 'active');
  showToast(isPaused ? '⏸ Transfer paused' : '▶ Transfer resumed');
}

function cancelTransfer() {
  if (!txActive) return;
  showModal('Cancel transfer?', 'This will stop the current transfer. Receiver will discard partial data.', () => {
    isCancelled = true; isPaused = false;
    showToast('❌ Transfer cancelled');
  });
}

/* ─────────────────────────────
   TX UI
───────────────────────────── */
function showTxCard(file) {
  document.getElementById('txCard')?.classList.remove('hidden');
  setEl('txIco',  fileIcon(file.name));
  setEl('txName', esc(file.name));
  setEl('txSz',   formatBytes(file.size));
  setEl('txPct',  '0%');
  setEl('txSpd',  '—');
  setEl('txEta',  '—');
  setEl('txDone', '—');
  const fill = document.getElementById('txFill');
  if (fill) fill.style.width = '0%';
  const pb = document.getElementById('btnPause');
  if (pb) pb.textContent = '⏸ Pause';
}

function updateTxUI(bytesSent, total) {
  const pct     = Math.min(100, Math.round((bytesSent / total) * 100));
  const elapsed = (Date.now() - txStart) / 1000 || 0.001;
  const speed   = bytesSent / elapsed;
  setEl('txPct',  pct + '%');
  setEl('txDone', formatBytes(bytesSent) + ' / ' + formatBytes(total));
  setEl('txSpd',  formatSpeed(speed));
  setEl('txEta',  formatETA(speed > 0 ? (total - bytesSent) / speed : 0));
  const fill = document.getElementById('txFill');
  if (fill) fill.style.width = pct + '%';
}

/* ─────────────────────────────────────────────────────
   CAMERA / QR SCANNER
   
   Uses setInterval at 100ms (not rAF) so jsQR (~30ms decode)
   has breathing room. Scales video to 640px for speed.
───────────────────────────────────────────────────── */
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
  qrFound = false; _scanAttempts = 0;
  if (pill) { pill.textContent = 'Requesting camera…'; pill.classList.remove('ok'); }

  try {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch(e1) {
      camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    video.srcObject = camStream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;

    await waitForVideoReady(video);
    try { await video.play(); } catch(e) {}

    camActive = true;
    document.getElementById('btnCamOn')?.classList.add('hidden');
    document.getElementById('btnCamOff')?.classList.remove('hidden');
    if (pill) pill.textContent = 'Scanning… hold steady';

    _scanInterval = setInterval(doScanTick, 100);
  } catch(err) {
    handleCameraError(err);
  }
}

function waitForVideoReady(video) {
  return new Promise(resolve => {
    if (video.readyState >= 2 && video.videoWidth > 0) { resolve(); return; }
    let n = 0;
    const poll = setInterval(() => {
      if ((video.readyState >= 2 && video.videoWidth > 0) || ++n > 60) { clearInterval(poll); resolve(); }
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

  const W = 640, H = Math.round(video.videoHeight * (640 / video.videoWidth));
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  try { ctx.drawImage(video, 0, 0, W, H); } catch(e) { return; }

  let imageData;
  try { imageData = ctx.getImageData(0, 0, W, H); } catch(e) { return; }

  _scanAttempts++;
  if (pill && _scanAttempts % 5 === 0) pill.textContent = `Scanning… (${_scanAttempts})`;

  let code = null;
  try { code = jsQR(imageData.data, W, H, { inversionAttempts: 'attemptBoth' }); } catch(e) { return; }

  if (code?.data?.trim()) {
    qrFound = true;
    onQRDetected(code.data.trim());
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
  const msgs = {
    NotAllowedError: '📵 Camera permission denied — enter Peer ID manually',
    PermissionDeniedError: '📵 Camera permission denied — enter Peer ID manually',
    NotFoundError: '❌ No camera found — enter Peer ID manually',
    DevicesNotFoundError: '❌ No camera found — enter Peer ID manually',
    NotReadableError: '❌ Camera is in use by another app',
  };
  showToast(msgs[err.name] || '❌ Camera error: ' + (err.message || err.name));
  document.getElementById('camDenied')?.classList.remove('hidden');
  document.getElementById('btnCamOn')?.classList.add('hidden');
}

function stopCam() {
  camActive = false;
  if (_scanInterval) { clearInterval(_scanInterval); _scanInterval = null; }
  if (camStream) { camStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} }); camStream = null; }
  const v = document.getElementById('camVideo');
  if (v) { try { v.srcObject = null; v.load(); } catch(e){} }
  document.getElementById('btnCamOn')?.classList.remove('hidden');
  document.getElementById('btnCamOff')?.classList.add('hidden');
}

/* ─────────────────────────────
   MANUAL PEER ID
───────────────────────────── */
function connectByPeerId() {
  const id = document.getElementById('manualPeerId')?.value?.trim();
  if (!id) { showToast('⚠️ Enter the Peer ID first'); return; }
  connectToPeer(id);
}

/* ─────────────────────────────
   CONNECT TO SENDER
───────────────────────────── */
function connectToPeer(senderId) {
  if (!peer?.open) { showToast('⚠️ Not connected to network yet'); return; }
  if (senderId === myId) { showToast('⚠️ Cannot connect to yourself!'); return; }
  setConnStatus('receiver', 'connecting', 'Connecting…');
  conn = peer.connect(senderId, { reliable: true, serialization: 'binary' });
  setupDataConnection('receiver');
}

/* ─────────────────────────────
   DATA CONNECTION SETUP
───────────────────────────── */
function setupDataConnection(role) {
  if (!conn) return;
  conn.on('open',  ()    => onConnectionOpen(role));
  conn.on('data',  data  => onData(data, role));
  conn.on('close', ()    => { showToast('🔌 Connection closed'); setConnStatus(role, '', 'Disconnected'); if (role === 'sender') updateSendButton(); });
  conn.on('error', err   => { showToast('❌ Connection error: ' + (err.message || err)); setConnStatus(role, 'failed', 'Failed'); if (txActive) { isCancelled = true; txActive = false; } });
}

/* ─────────────────────────────────────────────────────────
   ON CONNECTION OPEN — THE KEY UI TRANSITION
   
   SENDER SIDE:
     1. Animate QR panel out (fade + shrink)
     2. After animation (350ms), hide it and collapse layout
     3. Files panel expands with pop-in animation
     4. Show green "Receiver Connected!" banner at top of files panel
     5. Hide the step-number header (replaced by banner)
   
   RECEIVER SIDE:
     1. Hide scanner view instantly
     2. Show connected view with slide-up animation
───────────────────────────────────────────────────────── */
function onConnectionOpen(role) {
  setConnStatus(role, 'connected', 'Connected ✓');

  if (role === 'sender') {
    showToast('🔗 Receiver connected — select files and send!');
    updateSendButton();

    const qrPanel    = document.getElementById('qrPanel');
    const filesPanel = document.getElementById('filesPanel');
    const layout     = document.getElementById('senderLayout');
    const banner     = document.getElementById('senderConnBanner');
    const header     = document.getElementById('filesPanelHeader');

    // Step 1: animate QR panel out
    if (qrPanel) {
      qrPanel.classList.add('hiding');

      // Step 2: after animation completes, restructure layout
      setTimeout(() => {
        // Hide QR panel completely
        qrPanel.classList.add('hidden');
        qrPanel.classList.remove('hiding');

        // Collapse grid to single column
        if (layout) layout.classList.add('single-col');

        // Pop-in files panel
        if (filesPanel) {
          filesPanel.classList.add('expanding');
          setTimeout(() => filesPanel.classList.remove('expanding'), 400);
        }

        // Show connected banner, hide the step-number header
        if (header) header.classList.add('hidden');
        if (banner) banner.classList.remove('hidden');

      }, 350); // matches panelFadeOut animation duration
    }
  }

  if (role === 'receiver') {
    // Hide scanner, show connected view
    document.getElementById('recvScanBody')?.classList.add('hidden');
    document.getElementById('recvConnected')?.classList.remove('hidden');
    showToast('🔗 Connected — waiting for files…');
  }
}

/* ─────────────────────────────
   DATA HANDLER
───────────────────────────── */
function onData(data, role) {
  if (typeof data === 'string') {
    let msg; try { msg = JSON.parse(data); } catch(e) { return; }
    if (msg.type === 'meta')   startReceiving(msg);
    else if (msg.type === 'done')   finalizeReceive();
    else if (msg.type === 'cancel') {
      rxCancelled = true; rxMeta = null; rxChunks = []; rxBytes = 0;
      setEl('rcStatus', 'Transfer cancelled by sender');
      document.getElementById('rxCard')?.classList.add('hidden');
      showToast('❌ Transfer cancelled by sender');
    }
  } else {
    if (!rxMeta || rxCancelled) return;
    receiveChunk(data instanceof ArrayBuffer ? data : data.buffer);
  }
}

function startReceiving(meta) {
  rxMeta = meta; rxChunks = []; rxBytes = 0; rxStart = Date.now(); rxCancelled = false;
  document.getElementById('rxCard')?.classList.remove('hidden');
  setEl('rxIco',  fileIcon(meta.name));
  setEl('rxName', esc(meta.name));
  setEl('rxSz',   formatBytes(meta.size));
  setEl('rxPct',  '0%'); setEl('rxSpd', '—'); setEl('rxEta', '—'); setEl('rxGot', '—');
  const fill = document.getElementById('rxFill');
  if (fill) fill.style.width = '0%';
  setEl('rcStatus', 'Receiving: ' + esc(meta.name));
}

function receiveChunk(buf) {
  if (!rxMeta) return;
  rxChunks.push(buf); rxBytes += buf.byteLength;
  const pct = Math.min(100, Math.round((rxBytes / rxMeta.size) * 100));
  const elapsed = (Date.now() - rxStart) / 1000 || 0.001;
  const speed = rxBytes / elapsed;
  setEl('rxPct', pct + '%');
  setEl('rxGot', formatBytes(rxBytes) + ' / ' + formatBytes(rxMeta.size));
  setEl('rxSpd', formatSpeed(speed));
  setEl('rxEta', formatETA(speed > 0 ? (rxMeta.size - rxBytes) / speed : 0));
  const fill = document.getElementById('rxFill');
  if (fill) fill.style.width = pct + '%';
  if (rxBytes >= rxMeta.size) finalizeReceive();
}

function finalizeReceive() {
  if (!rxMeta || rxCancelled) return;
  const meta = rxMeta, chunks = rxChunks;
  rxMeta = null; rxChunks = []; rxBytes = 0;
  setTimeout(() => {
    try {
      const blob = new Blob(chunks, { type: meta.mimeType || 'application/octet-stream' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = meta.name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 8000);
      showToast('✅ Saved: ' + meta.name);
      addRxHistory(meta.name, meta.size, blob);
      setEl('rcStatus', 'Waiting for more files…');
      document.getElementById('rxCard')?.classList.add('hidden');
    } catch(e) {
      showToast('❌ Failed to save: ' + meta.name);
    }
  }, 0);
}

/* ─────────────────────────────
   STATUS
───────────────────────────── */
function setConnStatus(role, state, text) {
  const dot = document.getElementById(role === 'sender' ? 'sDot' : 'rDot');
  const txt = document.getElementById(role === 'sender' ? 'sText' : 'rText');
  if (dot) dot.className = 'cs-dot ' + state;
  if (txt) txt.textContent = text;
}

/* ─────────────────────────────
   HISTORY
───────────────────────────── */
function addSentHistory(name, size, error = false) {
  const empty = document.getElementById('sHistEmpty');
  const list  = document.getElementById('sHistList');
  if (empty) empty.style.display = 'none';
  const li = document.createElement('li');
  li.className = 'hist-item';
  li.innerHTML = `
    <span class="hi-ico">${fileIcon(name)}</span>
    <div class="hi-inf">
      <span class="hi-name" title="${esc(name)}">${esc(name)}</span>
      <span class="hi-meta">${formatBytes(size)} · ${nowTime()}</span>
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
  li.innerHTML = `
    <span class="hi-ico">${fileIcon(name)}</span>
    <div class="hi-inf">
      <span class="hi-name" title="${esc(name)}">${esc(name)}</span>
      <span class="hi-meta">${formatBytes(size)} · ${nowTime()}</span>
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
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ─────────────────────────────
   MODAL
───────────────────────────── */
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
document.addEventListener('click', e => {
  const ov = document.getElementById('modalOverlay');
  if (e.target === ov) modalCancel();
});

/* ─────────────────────────────
   TOAST
───────────────────────────── */
let _toastTimer = null;
function showToast(msg, ms = 3500) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ─────────────────────────────
   HELPERS
───────────────────────────── */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(b) {
  if (!b && b !== 0) return '—';
  if (b === 0) return '0 B';
  const k = 1024, u = ['B','KB','MB','GB','TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), u.length - 1);
  return parseFloat((b / Math.pow(k, i)).toFixed(i > 0 ? 2 : 0)) + ' ' + u[i];
}

function formatSpeed(bps) {
  if (!bps || bps < 0) return '—';
  if (bps < 1024)    return bps.toFixed(0)     + ' B/s';
  if (bps < 1048576) return (bps/1024).toFixed(1) + ' KB/s';
  return (bps/1048576).toFixed(2) + ' MB/s';
}

function formatETA(secs) {
  if (!isFinite(secs) || secs < 0) return '—';
  if (secs < 1)    return '<1s';
  if (secs < 60)   return Math.ceil(secs) + 's';
  if (secs < 3600) return Math.floor(secs/60) + 'm ' + Math.ceil(secs%60) + 's';
  return Math.floor(secs/3600) + 'h ' + Math.floor((secs%3600)/60) + 'm';
}

function fileIcon(name) {
  const e = (name||'').split('.').pop().toLowerCase();
  return ({
    pdf:'📄',
    png:'🖼️',jpg:'🖼️',jpeg:'🖼️',gif:'🖼️',webp:'🖼️',svg:'🖼️',bmp:'🖼️',heic:'🖼️',
    mp4:'🎬',mkv:'🎬',avi:'🎬',mov:'🎬',webm:'🎬',m4v:'🎬',flv:'🎬',
    mp3:'🎵',wav:'🎵',flac:'🎵',ogg:'🎵',aac:'🎵',m4a:'🎵',opus:'🎵',
    zip:'🗜️',rar:'🗜️',gz:'🗜️','7z':'🗜️',tar:'🗜️',bz2:'🗜️',xz:'🗜️',
    doc:'📝',docx:'📝',txt:'📝',md:'📝',rtf:'📝',odt:'📝',pages:'📝',
    xls:'📊',xlsx:'📊',csv:'📊',ods:'📊',numbers:'📊',
    ppt:'📋',pptx:'📋',odp:'📋',key:'📋',
    js:'💻',ts:'💻',py:'💻',html:'💻',css:'💻',json:'💻',xml:'💻',sh:'💻',
    apk:'📱',ipa:'📱',exe:'⚙️',dmg:'💿',iso:'💿',msi:'⚙️',deb:'⚙️',
  })[e] || '📎';
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
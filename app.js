/**
 * ShareDrop — app.js (Production v3)
 * ═══════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE NOTE:
 *  • "sender" role = device that SHOWS the QR code (listens for
 *    incoming connections via peer.on('connection'))
 *  • "receiver" role = device that SCANS the QR code (initiates
 *    outgoing connection via peer.connect())
 *
 *  Either device can send files — roles just control who shows QR.
 *
 * KEY FIXES IN THIS VERSION:
 *  1. serialization:'raw' on BOTH sides — no mismatch, no base64 overhead
 *  2. 'raw' gives direct ArrayBuffer passthrough = maximum speed
 *  3. connWasOpen flag — retry popup ONLY fires after a PROVEN stable
 *     connection drops, never during ICE negotiation (no fake errors)
 *  4. Event-driven backpressure via bufferedAmountLowThreshold
 *  5. Multiple STUN servers + iceCandidatePoolSize for faster NAT traversal
 *  6. Bidirectional connection: both roles handled uniformly in setupConn()
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────*/
const CHUNK_SIZE       = 64 * 1024;        // 64 KB — optimal for WebRTC DataChannel
const BUFFER_THRESHOLD = 4 * 1024 * 1024;  // 4 MB — pause sending above this
const BUFFER_RESUME    = 512 * 1024;        // 512 KB — resume sending below this
const DRAIN_INTERVAL   = 10;               // ms fallback poll while draining
const HEARTBEAT_MS     = 20000;            // 20s idle ping interval
const RETRY_AUTO_S     = 10;              // auto-retry countdown (seconds)
const STORAGE_KEY      = 'sharedrop_role';

/* ─────────────────────────────────────────
   STATE
───────────────────────────────────────────*/
let peer            = null;
let conn            = null;
let myRole          = null;   // 'sender' | 'receiver'
let myId            = null;
let reconnecting    = false;
let connWasOpen     = false;  // True only after conn.on('open') fires

// TX
let txQueue         = [];
let txMeta          = [];
let txIdx           = 0;
let txOffset        = 0;
let txStart         = 0;
let txActive        = false;
let isPaused        = false;
let isCancelled     = false;
let txDraining      = false;

// RX
let rxMeta          = null;
let rxChunks        = [];
let rxBytes         = 0;
let rxStart         = 0;
let rxHistory       = [];

// Camera
let camStream       = null;
let _scanInterval   = null;
let _scanAttempts   = 0;
let qrFound         = false;
let camActive       = false;

// Retry
let _retryCountdown = null;
let _retrySecsLeft  = 0;
let _retryRole      = null;

// Modal
let _modalOkFn      = null;

// Heartbeat
let _heartbeatTimer = null;

/* ─────────────────────────────────────────
   BOOT
───────────────────────────────────────────*/
window.addEventListener('DOMContentLoaded', () => {
  const mobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const dl = document.getElementById('devLabel');
  if (dl) dl.textContent = mobile ? '📱 Mobile device' : '💻 Desktop';

  const homeWrap = document.querySelector('.home-wrap');
  if (homeWrap) {
    [...homeWrap.children].forEach((el, i) => {
      el.style.opacity   = '0';
      el.style.transform = 'translateY(24px)';
      setTimeout(() => {
        el.style.transition = 'opacity 0.5s cubic-bezier(0.34,1.56,0.64,1), transform 0.5s cubic-bezier(0.34,1.56,0.64,1)';
        el.style.opacity    = '1';
        el.style.transform  = 'none';
      }, 80 + i * 90);
    });
  }

  initPeer();
});

/* ─────────────────────────────────────────
   PEERJS INIT
───────────────────────────────────────────*/
function initPeer() {
  setNetStatus('connecting', 'Connecting…');

  if (peer && !peer.destroyed) {
    try { peer.destroy(); } catch (e) {}
  }

  peer = new Peer(undefined, {
    host: '0.peerjs.com', port: 443, secure: true, path: '/',
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.stunprotocol.org:3478' },
      ],
      iceCandidatePoolSize: 10,   // pre-gather candidates for faster connect
      iceTransportPolicy: 'all',
    },
    debug: 0,
  });

  peer.on('open', id => {
    myId         = id;
    reconnecting = false;
    setNetStatus('ok', 'Network ready! ✓');
    document.getElementById('btnRoleSend').disabled = false;
    document.getElementById('btnRoleRecv').disabled = false;

    if (_retryRole) {
      const role = _retryRole;
      _retryRole = null;
      hideRetryPopup();
      showToast('🔌 Reconnected!');
      setTimeout(() => chooseRole(role), 600);
    }
  });

  peer.on('error', err => {
    console.warn('[Peer]', err.type, err.message || '');

    if (err.type === 'peer-unavailable') {
      // Remote peer doesn't exist — not a session error
      setConnStatus(myRole || 'receiver', 'failed', 'Peer not found');
      showToast('⚠️ Peer not found — check QR or Peer ID');
      connWasOpen = false;
      return;
    }

    if (!myRole) {
      // Not in a session — silently reconnect
      setNetStatus('err', 'Reconnecting…');
      if (!reconnecting) { reconnecting = true; setTimeout(initPeer, 3000); }
      return;
    }

    // In-session fatal error — only show retry if connection was proven stable
    if (connWasOpen && !txActive) {
      triggerRetryPopup(err.type);
    }
  });

  peer.on('disconnected', () => {
    if (peer.destroyed) return;
    setNetStatus('connecting', 'Reconnecting…');
    try {
      peer.reconnect();
    } catch (e) {
      if (!reconnecting) { reconnecting = true; setTimeout(initPeer, 3000); }
    }
  });

  // Incoming connection — fired when another peer calls peer.connect(myId)
  peer.on('connection', incomingConn => {
    if (!myRole) return;                                  // Not in a session
    if (conn && conn.open) {                              // Already connected
      try { incomingConn.close(); } catch (e) {}
      return;
    }
    conn        = incomingConn;
    connWasOpen = false;
    setupConn();
  });
}

/* ─────────────────────────────────────────
   NET STATUS
───────────────────────────────────────────*/
function setNetStatus(state, text) {
  const dot = document.getElementById('nsDot');
  const txt = document.getElementById('nsText');
  if (dot) dot.className = 'nb-dot ' + state;
  if (txt) txt.textContent = text;
}

/* ─────────────────────────────────────────
   SCREENS
───────────────────────────────────────────*/
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

function goHome() {
  if (txActive)  { isCancelled = true; txActive = false; }
  stopCam();
  stopHeartbeat();
  if (conn) { try { conn.close(); } catch (e) {} conn = null; }

  txQueue = []; txMeta = []; txIdx = 0;
  txOffset = 0; isPaused = false; isCancelled = false; txDraining = false;
  rxMeta = null; rxChunks = []; rxBytes = 0;
  qrFound = false; _scanAttempts = 0;
  myRole = null; connWasOpen = false;

  try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}

  document.getElementById('fileQueue')?.classList.add('hidden');
  document.getElementById('dropzone')?.classList.remove('hidden');
  document.getElementById('txCard')?.classList.add('hidden');
  document.getElementById('recvScanBody')?.classList.remove('hidden');
  document.getElementById('recvConnected')?.classList.add('hidden');
  document.getElementById('rxCard')?.classList.add('hidden');
  document.getElementById('sHistList').innerHTML = '';
  document.getElementById('sHistEmpty').style.display = '';
  document.getElementById('rHistList').innerHTML = '';
  document.getElementById('rHistEmpty').style.display = '';

  resetQRSection();
  showScreen('sHome');
}

function resetQRSection() {
  const qrSection = document.getElementById('qrSection');
  if (qrSection) { qrSection.style.cssText = ''; qrSection.classList.remove('conn-hidden'); }
  const banner = document.getElementById('connSuccessBanner');
  if (banner) { banner.classList.add('hidden'); banner.classList.remove('show-banner'); }
}

/* ─────────────────────────────────────────
   ROLE SELECTION
───────────────────────────────────────────*/
function chooseRole(role) {
  myRole = role;
  try { sessionStorage.setItem(STORAGE_KEY, role); } catch (e) {}

  if (role === 'sender') {
    showScreen('sSender');
    setupSenderScreen();
  } else {
    showScreen('sReceiver');
    setTimeout(startCam, 400);
  }
}

/* ─────────────────────────────────────────
   SENDER SCREEN
───────────────────────────────────────────*/
function setupSenderScreen() {
  if (!myId) { showToast('⚠️ Still connecting…'); return; }
  renderQR(myId);
  const strip = document.getElementById('peerIdStrip');
  if (strip) strip.style.display = '';
  setEl('myPeerIdDisplay', myId);
  setupDropzone();
  setConnStatus('sender', '', 'Waiting for receiver to scan…');
}

function copyPeerId() {
  if (!myId) return;
  navigator.clipboard.writeText(myId).then(() => {
    showToast('📋 Peer ID copied!');
    const btn = document.getElementById('copyBtn');
    if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000); }
  }).catch(() => showToast('Tap and hold to copy manually'));
}

function renderQR(text) {
  const loader = document.getElementById('qrLoader');
  const canvas = document.getElementById('qrCanvas');
  if (loader) loader.style.display = 'none';
  if (canvas) canvas.innerHTML = '';
  try {
    new QRCode(canvas, { text, width: 200, height: 200, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
  } catch (e) {
    if (canvas) canvas.innerHTML = `<div style="padding:1rem;text-align:center;font-size:.75rem;color:#555">QR failed<br/><b style="color:#7B2FF7;font-size:.65rem;word-break:break-all">${esc(text)}</b></div>`;
  }
}

/* ─────────────────────────────────────────
   DROP ZONE
───────────────────────────────────────────*/
function setupDropzone() {
  const dz = document.getElementById('dropzone');
  if (!dz || dz._init) return;
  dz._init = true;
  dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', ()  => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); onFilePicked(e.dataTransfer.files); });
  dz.addEventListener('click', e => { if (e.target.tagName !== 'BUTTON') document.getElementById('fileInput').click(); });
}

function onFilePicked(files) {
  if (!files?.length) return;
  let added = 0;
  for (const f of files) { txQueue.push(f); txMeta.push({ name: f.name, size: f.size, status: 'pending' }); added++; }
  renderQueue();
  document.getElementById('dropzone')?.classList.add('hidden');
  document.getElementById('fileQueue')?.classList.remove('hidden');
  updateSendBtn();
  showToast(`🎉 ${added} file${added > 1 ? 's' : ''} added — hit Send when ready!`);
}

function updateSendBtn() {
  const btn = document.getElementById('btnSend');
  if (!btn) return;
  btn.disabled = !txMeta.some(m => m.status === 'pending');
}

function renderQueue() {
  const ul = document.getElementById('fqList');
  const count = document.getElementById('fqCount');
  const total = document.getElementById('fqTotal');
  if (!ul) return;
  const totalBytes = txQueue.reduce((s, f) => s + f.size, 0);
  if (count) count.textContent = txQueue.length + (txQueue.length === 1 ? ' file' : ' files');
  if (total) total.textContent = '· ' + formatBytes(totalBytes);
  ul.innerHTML = '';
  txMeta.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = `fq-item ${m.status}`; li.id = `fqi-${i}`;
    li.innerHTML = `
      <span class="fq-ico">${fileIcon(txQueue[i]?.name || '')}</span>
      <div class="fq-inf">
        <span class="fq-name" title="${esc(m.name)}">${esc(m.name)}</span>
        <span class="fq-size">${formatBytes(m.size)}</span>
      </div>
      <span class="fq-status ${m.status}">${m.status}</span>
      ${m.status === 'pending' ? `<button class="fq-rm" onclick="removeFile(${i})">✕</button>` : ''}
    `;
    ul.appendChild(li);
  });
  updateSendBtn();
}

function removeFile(i) {
  if (txMeta[i]?.status !== 'pending') return;
  txQueue.splice(i, 1); txMeta.splice(i, 1);
  if (!txQueue.length) { document.getElementById('fileQueue')?.classList.add('hidden'); document.getElementById('dropzone')?.classList.remove('hidden'); }
  else renderQueue();
}

function clearQueue() {
  const pending = txMeta.filter(m => m.status === 'pending').length;
  if (!pending) return;
  showModal('🗑 Clear queue?', `Remove all ${pending} pending file${pending > 1 ? 's' : ''}?`, () => {
    txQueue = txQueue.filter((_, i) => txMeta[i].status !== 'pending');
    txMeta  = txMeta.filter(m => m.status !== 'pending');
    if (!txQueue.length) { document.getElementById('fileQueue')?.classList.add('hidden'); document.getElementById('dropzone')?.classList.remove('hidden'); }
    else renderQueue();
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

/* ─────────────────────────────────────────
   START SEND
───────────────────────────────────────────*/
function startSend() {
  if (!conn?.open) { showToast('⚠️ No receiver connected — they must scan your QR first!'); return; }
  const pending = txMeta.filter(m => m.status === 'pending');
  if (!pending.length) { showToast('⚠️ No files to send!'); return; }
  const totalSize = txQueue.reduce((s, f, i) => txMeta[i].status === 'pending' ? s + f.size : s, 0);
  showModal(
    '🚀 Send Files?',
    `Send <b>${pending.length} file${pending.length > 1 ? 's' : ''}</b> (${formatBytes(totalSize)}) to the receiver?`,
    () => {
      document.getElementById('btnSend').disabled = true;
      txIdx = 0; isPaused = false; isCancelled = false; txActive = true; txDraining = false;
      sendNextFile();
    }
  );
}

/* ─────────────────────────────────────────────────────────────────
   HIGH-PERFORMANCE SEND ENGINE

   • 64 KB chunks — WebRTC DataChannel sweet spot
   • serialization:'raw' on both ends = zero-copy ArrayBuffer
   • Event-driven backpressure (bufferedamountlow event)
   • No artificial delays — only yields every 64 chunks
   • Handles pause/cancel cleanly
─────────────────────────────────────────────────────────────────*/
async function sendNextFile() {
  while (txIdx < txQueue.length && txMeta[txIdx].status !== 'pending') txIdx++;
  if (txIdx >= txQueue.length || isCancelled) { finalizeSendAll(); return; }

  const file = txQueue[txIdx];
  const meta = txMeta[txIdx];
  meta.status = 'active';
  setFileStatus(txIdx, 'active');

  sendControl({ type: 'meta', name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream' });
  showTxCard(file);
  txOffset = 0; txStart = Date.now();

  // Set buffer threshold for event-driven drain
  const dc = conn?.dataChannel;
  if (dc) dc.bufferedAmountLowThreshold = BUFFER_RESUME;

  let uiTick = 0;

  while (txOffset < file.size && !isCancelled) {

    // Handle pause
    if (isPaused) {
      await waitForResume();
      if (isCancelled) break;
    }

    // Backpressure — wait for buffer to drain if full
    if (dc && dc.bufferedAmount > BUFFER_THRESHOLD) {
      txDraining = true;
      await waitForDrain(dc);
      txDraining = false;
      if (isCancelled) break;
    }

    // Read chunk
    const slice = file.slice(txOffset, Math.min(txOffset + CHUNK_SIZE, file.size));
    let buf;
    try { buf = await readSlice(slice); }
    catch (e) {
      meta.status = 'error'; setFileStatus(txIdx, 'error');
      addSentHistory(file.name, file.size, true);
      showToast(`❌ Read error: ${file.name}`);
      txIdx++; sendNextFile(); return;
    }
    if (isCancelled) break;

    // Send raw ArrayBuffer
    try { conn.send(buf); }
    catch (e) {
      meta.status = 'error'; setFileStatus(txIdx, 'error');
      showToast('❌ Connection lost mid-transfer');
      finalizeSendAll(); return;
    }

    txOffset += buf.byteLength;
    uiTick++;

    // Update progress every 4 chunks
    if (uiTick % 4 === 0) updateTxUI(txOffset, file.size);

    // Yield every 64 chunks to keep UI responsive
    if (uiTick % 64 === 0) await yield0();
  }

  updateTxUI(txOffset, file.size);

  if (isCancelled) {
    sendControl({ type: 'cancel' });
    meta.status = 'error'; setFileStatus(txIdx, 'error');
    addSentHistory(file.name, file.size, true);
    finalizeSendAll(); return;
  }

  sendControl({ type: 'done' });
  meta.status = 'done'; setFileStatus(txIdx, 'done');
  addSentHistory(file.name, file.size, false);
  showToast(`✅ Sent: ${file.name}`);
  txIdx++;
  await yield0();
  sendNextFile();
}

function finalizeSendAll() {
  txActive = false; txDraining = false;
  document.getElementById('txCard')?.classList.add('hidden');
  const btn = document.getElementById('btnSend');
  if (btn) btn.disabled = false;
  if (!isCancelled) {
    const done = txMeta.filter(m => m.status === 'done').length;
    if (done > 0) { showToast(`🎉 All ${done} file${done > 1 ? 's' : ''} sent!`); showSuccessFlash(); }
  }
  updateSendBtn();
}

function sendControl(obj) {
  if (!conn?.open) return;
  try { conn.send(JSON.stringify(obj)); } catch (e) {}
}

function waitForResume() {
  return new Promise(resolve => {
    const t = setInterval(() => { if (!isPaused || isCancelled) { clearInterval(t); resolve(); } }, 80);
  });
}

function waitForDrain(dc) {
  return new Promise(resolve => {
    if (dc.readyState !== 'open') { resolve(); return; }
    const onLow = () => { dc.removeEventListener('bufferedamountlow', onLow); clearInterval(poll); resolve(); };
    dc.addEventListener('bufferedamountlow', onLow);
    const poll = setInterval(() => {
      if (dc.bufferedAmount <= BUFFER_RESUME || isCancelled || dc.readyState !== 'open') {
        clearInterval(poll); dc.removeEventListener('bufferedamountlow', onLow); resolve();
      }
    }, DRAIN_INTERVAL);
  });
}

function yield0() { return new Promise(r => setTimeout(r, 0)); }

function readSlice(slice) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result);
    r.onerror = e => rej(e.target.error);
    r.readAsArrayBuffer(slice);
  });
}

function togglePause() {
  if (!txActive) return;
  isPaused = !isPaused;
  const btn = document.getElementById('btnPause');
  if (btn) btn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
  setFileStatus(txIdx, isPaused ? 'paused' : 'active');
  showToast(isPaused ? '⏸ Paused' : '▶ Resumed');
}

function cancelTransfer() {
  if (!txActive) return;
  showModal('❌ Cancel?', 'Stop the current transfer?', () => {
    isCancelled = true; isPaused = false;
    showToast('❌ Transfer cancelled');
  }, 'Cancel Transfer');
}

/* ─────────────────────────────────────────
   TX UI
───────────────────────────────────────────*/
function showTxCard(file) {
  document.getElementById('txCard')?.classList.remove('hidden');
  setEl('txIco',  fileIcon(file.name));
  setEl('txName', esc(file.name));
  setEl('txSz',   formatBytes(file.size));
  setEl('txPct',  '0%'); setEl('txSpd', '—'); setEl('txEta', '—'); setEl('txDone', '—');
  const fill = document.getElementById('txFill');
  if (fill) fill.style.width = '0%';
  const pb = document.getElementById('btnPause');
  if (pb) pb.textContent = '⏸ Pause';
}

function updateTxUI(sent, total) {
  const pct     = Math.min(100, Math.round(sent / total * 100));
  const elapsed = (Date.now() - txStart) / 1000 || 0.001;
  const speed   = sent / elapsed;
  const rem     = speed > 0 ? (total - sent) / speed : 0;
  setEl('txPct',  pct + '%');
  setEl('txDone', formatBytes(sent) + ' / ' + formatBytes(total));
  setEl('txSpd',  formatSpeed(speed));
  setEl('txEta',  formatETA(rem));
  const fill = document.getElementById('txFill');
  if (fill) fill.style.width = pct + '%';
}

/* ─────────────────────────────────────────
   CAMERA / QR SCAN
───────────────────────────────────────────*/
async function startCam() {
  if (camActive) return;
  if (typeof jsQR !== 'function') { showToast('❌ QR scanner not loaded'); showFallback(); return; }

  const pill = document.getElementById('camPill');
  qrFound = false; _scanAttempts = 0;
  if (pill) { pill.textContent = 'Requesting camera…'; pill.classList.remove('ok'); }

  try {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch (e) {
      camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    const video = document.getElementById('camVideo');
    video.srcObject = camStream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    await waitForVideoReady(video);
    try { await video.play(); } catch (e) {}
    camActive = true;
    document.getElementById('btnCamOn')?.classList.add('hidden');
    document.getElementById('btnCamOff')?.classList.remove('hidden');
    if (pill) pill.textContent = 'Scanning… hold steady 🎯';
    _scanInterval = setInterval(doScanTick, 100);
  } catch (err) { handleCamError(err); }
}

function waitForVideoReady(video) {
  return new Promise(resolve => {
    if (video.readyState >= 2 && video.videoWidth > 0) { resolve(); return; }
    let n = 0;
    const poll = setInterval(() => { n++; if ((video.readyState >= 2 && video.videoWidth > 0) || n > 60) { clearInterval(poll); resolve(); } }, 100);
  });
}

function doScanTick() {
  if (!camActive || qrFound) return;
  const video  = document.getElementById('camVideo');
  const canvas = document.getElementById('camCanvas');
  const pill   = document.getElementById('camPill');
  if (!video || !canvas || video.readyState < 2 || video.videoWidth === 0) return;

  const W = 640, H = Math.round(video.videoHeight * (W / video.videoWidth));
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  try { ctx.drawImage(video, 0, 0, W, H); } catch (e) { return; }
  let imageData;
  try { imageData = ctx.getImageData(0, 0, W, H); } catch (e) { return; }

  _scanAttempts++;
  if (pill && _scanAttempts % 5 === 0) pill.textContent = `Scanning… 🔍 (${_scanAttempts})`;

  let code;
  try { code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' }); }
  catch (e) { return; }

  if (code?.data?.trim()) { qrFound = true; onQRFound(code.data.trim()); }
}

function onQRFound(peerId) {
  stopCam();
  const wrap = document.getElementById('camWrap');
  const pill = document.getElementById('camPill');
  if (wrap) wrap.classList.add('detected');
  if (pill) { pill.textContent = '✅ QR Found!'; pill.classList.add('ok'); }
  showToast('📷 QR scanned! Connecting…');
  connectToPeer(peerId);
}

function handleCamError(err) {
  const map = { NotAllowedError: '📵 Camera permission denied', PermissionDeniedError: '📵 Camera permission denied', NotFoundError: '❌ No camera found', DevicesNotFoundError: '❌ No camera found', NotReadableError: '❌ Camera in use' };
  showToast((map[err.name] || '❌ Camera error') + ' — use Peer ID instead');
  showFallback();
}

function showFallback() {
  document.getElementById('camDenied')?.classList.remove('hidden');
  document.getElementById('btnCamOn')?.classList.add('hidden');
}

function stopCam() {
  camActive = false;
  if (_scanInterval) { clearInterval(_scanInterval); _scanInterval = null; }
  if (camStream) { camStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); camStream = null; }
  const v = document.getElementById('camVideo');
  if (v) { try { v.srcObject = null; v.load(); } catch (e) {} }
  document.getElementById('btnCamOn')?.classList.remove('hidden');
  document.getElementById('btnCamOff')?.classList.add('hidden');
}

function connectByPeerId() {
  const id = document.getElementById('manualPeerId')?.value?.trim();
  if (!id) { showToast('⚠️ Enter the Peer ID first!'); return; }
  connectToPeer(id);
}

/* ─────────────────────────────────────────
   CONNECT TO PEER
   Outgoing connection (receiver/scanner).
   CRITICAL: serialization:'raw' must match
   the incoming connection handler — both
   sides use raw for direct ArrayBuffer I/O.
───────────────────────────────────────────*/
function connectToPeer(senderId) {
  if (!peer?.open) { showToast('⚠️ Not connected to network yet'); return; }
  if (senderId === myId) { showToast('⚠️ Cannot connect to yourself!'); return; }
  if (conn?.open) { showToast('⚠️ Already connected!'); return; }

  setConnStatus('receiver', 'connecting', 'Connecting…');
  connWasOpen = false;

  // serialization:'raw' = ArrayBuffer passthrough, zero overhead
  // This MUST match on both sides. PeerJS defaults to 'binary' which
  // base64-encodes everything — 33% size overhead + CPU cost.
  conn = peer.connect(senderId, { reliable: true, serialization: 'raw' });
  setupConn();
}

/* ─────────────────────────────────────────
   SETUP DATA CONNECTION
   Works for both incoming and outgoing.
───────────────────────────────────────────*/
function setupConn() {
  if (!conn) return;

  conn.on('open', () => {
    connWasOpen = true;
    startHeartbeat();
    onConnOpen();
  });

  conn.on('data', data => onData(data));

  conn.on('close', () => {
    stopHeartbeat();
    setConnStatus(myRole, '', 'Disconnected');
    showToast('🔌 Connection closed');
    if (myRole === 'sender') updateSendBtn();

    if (connWasOpen && myRole && !txActive) {
      connWasOpen = false;
      triggerRetryPopup('disconnected');
    }
  });

  conn.on('error', err => {
    console.warn('[Conn] error:', err);
    stopHeartbeat();

    if (!connWasOpen) {
      // Never successfully opened — show simple error, NOT retry popup
      setConnStatus(myRole, 'failed', 'Connect failed');
      showToast('❌ Could not connect — try again');
      return;
    }

    // Was open, now broken
    connWasOpen = false;
    setConnStatus(myRole, 'failed', 'Connection lost');
    if (txActive) { isCancelled = true; txActive = false; }
    if (myRole) triggerRetryPopup('connection-error');
  });
}

/* ─────────────────────────────────────────
   ON CONNECTION OPEN
───────────────────────────────────────────*/
function onConnOpen() {
  setConnStatus(myRole, 'connected', 'Connected ✓');

  if (myRole === 'sender') {
    // We showed the QR, scanner just connected to us
    hideQRSection();
    showToast('🎉 Receiver connected! Add files & hit Send!');
    updateSendBtn();
  } else {
    // We scanned, now connected to QR shower
    document.getElementById('recvScanBody')?.classList.add('hidden');
    document.getElementById('recvConnected')?.classList.remove('hidden');
    showConnectedBanner();
    showToast('🎊 Connected to sender! Waiting for files…');
  }
}

/* ─────────────────────────────────────────
   HEARTBEAT
───────────────────────────────────────────*/
function startHeartbeat() {
  stopHeartbeat();
  _heartbeatTimer = setInterval(() => {
    if (conn?.open && !txActive) sendControl({ type: 'ping' });
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

/* ─────────────────────────────────────────
   QR → CONNECTED TRANSITION
───────────────────────────────────────────*/
function hideQRSection() {
  const qrSection = document.getElementById('qrSection');
  const banner    = document.getElementById('connSuccessBanner');

  if (qrSection) {
    qrSection.style.transition    = 'opacity 0.35s ease, transform 0.35s ease, max-height 0.5s ease, margin 0.35s ease, padding 0.35s ease, border-width 0.35s ease';
    qrSection.style.opacity       = '0';
    qrSection.style.transform     = 'scale(0.93) translateY(-8px)';
    qrSection.style.overflow      = 'hidden';
    setTimeout(() => {
      qrSection.style.maxHeight   = '0px';
      qrSection.style.margin      = '0';
      qrSection.style.padding     = '0';
      qrSection.style.borderWidth = '0';
      qrSection.style.pointerEvents = 'none';
    }, 300);
  }

  if (banner) {
    setTimeout(() => {
      banner.classList.remove('hidden');
      banner.offsetHeight; // force reflow
      banner.classList.add('show-banner');
    }, 450);
  }
}

function showConnectedBanner() {
  const banner = document.getElementById('recvConnectedBanner');
  if (banner) banner.classList.add('animate-in');
}

/* ─────────────────────────────────────────
   SUCCESS FLASH
───────────────────────────────────────────*/
function showSuccessFlash() {
  const flash = document.getElementById('successFlash');
  if (!flash) return;
  flash.classList.remove('hidden', 'flash-out');
  flash.classList.add('flash-in');
  setTimeout(() => {
    flash.classList.add('flash-out');
    setTimeout(() => { flash.classList.remove('flash-in', 'flash-out'); flash.classList.add('hidden'); }, 600);
  }, 2000);
}

/* ─────────────────────────────────────────
   DATA HANDLER
───────────────────────────────────────────*/
function onData(data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    switch (msg.type) {
      case 'meta':   startRx(msg); break;
      case 'done':   finalizeRx(); break;
      case 'cancel':
        rxMeta = null; rxChunks = []; rxBytes = 0;
        setEl('rcStatus', '❌ Cancelled by sender');
        document.getElementById('rxCard')?.classList.add('hidden');
        showToast('❌ Transfer cancelled by sender');
        break;
      case 'ping': break; // heartbeat
      default: break;
    }
    return;
  }

  // Binary chunk
  if (!rxMeta) return;
  if (data instanceof ArrayBuffer) {
    receiveChunk(data);
  } else if (data instanceof Blob) {
    data.arrayBuffer().then(ab => receiveChunk(ab)).catch(() => {});
  } else if (data?.buffer instanceof ArrayBuffer) {
    receiveChunk(data.buffer);
  }
}

/* ─────────────────────────────────────────
   RECEIVE ENGINE
───────────────────────────────────────────*/
function startRx(meta) {
  rxMeta = meta; rxChunks = []; rxBytes = 0; rxStart = Date.now();
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
  rxChunks.push(buf);
  rxBytes += buf.byteLength;
  const pct     = Math.min(100, Math.round(rxBytes / rxMeta.size * 100));
  const elapsed = (Date.now() - rxStart) / 1000 || 0.001;
  const speed   = rxBytes / elapsed;
  setEl('rxPct', pct + '%');
  setEl('rxGot', formatBytes(rxBytes) + ' / ' + formatBytes(rxMeta.size));
  setEl('rxSpd', formatSpeed(speed));
  setEl('rxEta', formatETA(speed > 0 ? (rxMeta.size - rxBytes) / speed : 0));
  const fill = document.getElementById('rxFill');
  if (fill) fill.style.width = pct + '%';
  if (rxBytes >= rxMeta.size) finalizeRx();
}

function finalizeRx() {
  if (!rxMeta) return;
  const meta = rxMeta; const chunks = rxChunks;
  rxMeta = null; rxChunks = []; rxBytes = 0;
  setTimeout(() => {
    try {
      const blob = new Blob(chunks, { type: meta.mimeType || 'application/octet-stream' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = meta.name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast('🎉 Saved: ' + meta.name);
      addRxHistory(meta.name, meta.size, blob);
      setEl('rcStatus', 'Waiting for more files…');
      document.getElementById('rxCard')?.classList.add('hidden');
      showSuccessFlash();
    } catch (e) { showToast('❌ Failed to save: ' + meta.name); }
  }, 0);
}

/* ─────────────────────────────────────────
   CONNECTION STATUS INDICATOR
───────────────────────────────────────────*/
function setConnStatus(role, state, text) {
  const dotId = role === 'sender' ? 'sDot' : 'rDot';
  const txtId = role === 'sender' ? 'sText' : 'rText';
  const dot   = document.getElementById(dotId);
  const txt   = document.getElementById(txtId);
  if (dot) dot.className = 'tc-dot ' + (state || '');
  if (txt) txt.textContent = text;
}

/* ─────────────────────────────────────────
   HISTORY
───────────────────────────────────────────*/
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

/* ─────────────────────────────────────────
   RETRY POPUP
───────────────────────────────────────────*/
function triggerRetryPopup(reason) {
  try { _retryRole = sessionStorage.getItem(STORAGE_KEY) || myRole; } catch (e) { _retryRole = myRole; }

  const overlay = document.getElementById('retryOverlay');
  const desc    = document.getElementById('retryDesc');
  if (!overlay || !overlay.classList.contains('hidden')) return;

  if (desc) {
    const msgs = { 'peer-unavailable': 'The other device is unreachable.', 'connection-error': 'The connection dropped unexpectedly.', 'disconnected': 'Connection was closed.', 'network': 'Network issue detected.' };
    desc.textContent = (msgs[reason] || 'Connection lost.') + ' Tap Retry to reconnect!';
  }

  overlay.classList.remove('hidden');
  _retrySecsLeft = RETRY_AUTO_S;
  updateRetryTimer();
  _retryCountdown = setInterval(() => {
    _retrySecsLeft--;
    updateRetryTimer();
    if (_retrySecsLeft <= 0) { clearInterval(_retryCountdown); _retryCountdown = null; retryConnection(); }
  }, 1000);
}

function updateRetryTimer() {
  const el = document.getElementById('retryTimer');
  if (el) el.textContent = _retrySecsLeft > 0 ? `Auto-retrying in ${_retrySecsLeft}s…` : 'Retrying…';
}

function hideRetryPopup() {
  if (_retryCountdown) { clearInterval(_retryCountdown); _retryCountdown = null; }
  document.getElementById('retryOverlay')?.classList.add('hidden');
}

function retryConnection() {
  hideRetryPopup();
  showToast('🔄 Reconnecting…');
  if (conn) { try { conn.close(); } catch (e) {} conn = null; }
  connWasOpen = false; reconnecting = false;
  initPeer();
}

function retryGoHome() { hideRetryPopup(); _retryRole = null; goHome(); }

/* ─────────────────────────────────────────
   MODAL
───────────────────────────────────────────*/
function showModal(title, body, onOk, okLabel = "Let's Go! 🚀") {
  document.getElementById('modalTitle').textContent        = title;
  document.getElementById('modalBody').innerHTML           = body;
  document.getElementById('modalConfirmBtn').textContent   = okLabel;
  const match = title.match(/\p{Emoji}/u);
  setEl('modalEmoji', match ? match[0] : '🤔');
  _modalOkFn = onOk;
  const overlay = document.getElementById('modalOverlay');
  overlay?.classList.remove('hidden');
  const card = overlay?.querySelector('.modal-card');
  if (card) { card.style.animation = 'none'; card.offsetHeight; card.style.animation = ''; }
}

function modalConfirm() {
  const overlay = document.getElementById('modalOverlay');
  const card    = overlay?.querySelector('.modal-card');
  const exec    = () => { if (_modalOkFn) { _modalOkFn(); _modalOkFn = null; } };
  if (card) { card.style.animation = 'modalExit 0.18s ease forwards'; setTimeout(() => { overlay?.classList.add('hidden'); card.style.animation = ''; exec(); }, 160); }
  else { overlay?.classList.add('hidden'); exec(); }
}

function modalCancel() {
  const overlay = document.getElementById('modalOverlay');
  const card    = overlay?.querySelector('.modal-card');
  if (card) { card.style.animation = 'modalExit 0.18s ease forwards'; setTimeout(() => { overlay?.classList.add('hidden'); card.style.animation = ''; _modalOkFn = null; }, 160); }
  else { overlay?.classList.add('hidden'); _modalOkFn = null; }
}

document.addEventListener('click', e => { if (e.target === document.getElementById('modalOverlay')) modalCancel(); });

/* ─────────────────────────────────────────
   TOAST
───────────────────────────────────────────*/
let _toastTimer   = null;
let _toastQueue   = [];
let _toastRunning = false;

function showToast(msg, ms = 3000) {
  if (_toastQueue.length && _toastQueue[_toastQueue.length - 1].msg === msg) return;
  _toastQueue.push({ msg, ms });
  if (!_toastRunning) _runToast();
}

function _runToast() {
  if (!_toastQueue.length) { _toastRunning = false; return; }
  _toastRunning = true;
  const { msg, ms } = _toastQueue.shift();
  const el = document.getElementById('toast');
  if (!el) { _toastRunning = false; return; }
  el.textContent = msg;
  el.classList.remove('hidden', 'toast-exit');
  el.classList.add('toast-enter');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.remove('toast-enter');
    el.classList.add('toast-exit');
    setTimeout(() => {
      el.classList.add('hidden'); el.classList.remove('toast-exit');
      _toastRunning = false;
      if (_toastQueue.length) setTimeout(_runToast, 80);
    }, 300);
  }, ms);
}

/* ─────────────────────────────────────────
   UTILITIES
───────────────────────────────────────────*/
function setEl(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function nowTime() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function formatBytes(b) {
  if (b == null || isNaN(b)) return '—';
  if (b === 0) return '0 B';
  const k = 1024, u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), 4);
  return parseFloat((b / Math.pow(k, i)).toFixed(i > 0 ? 2 : 0)) + ' ' + u[i];
}

function formatSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(2) + ' MB/s';
}

function formatETA(s) {
  if (!isFinite(s) || s < 0) return '—';
  if (s < 1)    return '<1s';
  if (s < 60)   return Math.ceil(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.ceil(s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

function fileIcon(name) {
  const e = (name || '').split('.').pop().toLowerCase();
  return ({ pdf:'📄', png:'🖼️', jpg:'🖼️', jpeg:'🖼️', gif:'🖼️', webp:'🖼️', svg:'🖼️', bmp:'🖼️', heic:'🖼️', avif:'🖼️',
    mp4:'🎬', mkv:'🎬', avi:'🎬', mov:'🎬', webm:'🎬', m4v:'🎬', flv:'🎬',
    mp3:'🎵', wav:'🎵', flac:'🎵', ogg:'🎵', aac:'🎵', m4a:'🎵', opus:'🎵',
    zip:'🗜️', rar:'🗜️', gz:'🗜️', '7z':'🗜️', tar:'🗜️', bz2:'🗜️',
    doc:'📝', docx:'📝', txt:'📝', md:'📝', rtf:'📝', odt:'📝',
    xls:'📊', xlsx:'📊', csv:'📊', ods:'📊',
    ppt:'📋', pptx:'📋',
    js:'💻', ts:'💻', py:'💻', html:'💻', css:'💻', json:'💻', xml:'💻', sh:'💻',
    apk:'📱', ipa:'📱', exe:'⚙️', msi:'⚙️', dmg:'💿', iso:'💿',
  })[e] || '📎';
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
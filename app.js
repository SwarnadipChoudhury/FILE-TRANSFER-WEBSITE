/**
 * ═══════════════════════════════════════════════════════════
 *  Smart Local Share P2P — app.js
 *  Pure WebRTC DataChannel file transfer (no backend)
 * ═══════════════════════════════════════════════════════════
 *
 *  HOW WEBRTC SIGNALING WORKS HERE:
 *  ─────────────────────────────────
 *  Standard WebRTC needs a "signaling channel" to exchange
 *  connection metadata (SDP offer/answer + ICE candidates).
 *  Most apps use a WebSocket server for this. We eliminate
 *  that dependency with manual copy-paste / QR signaling:
 *
 *  1. Sender calls RTCPeerConnection.createOffer()
 *     → waits for ALL ICE candidates to be gathered (trickle-off)
 *     → Base64-encodes the complete SDP + ICE bundle
 *     → Displays it as a QR code and copyable text
 *
 *  2. Receiver decodes the offer, calls setRemoteDescription(),
 *     then createAnswer(), waits for its own ICE gathering,
 *     Base64-encodes the answer and shows it for copy-paste.
 *
 *  3. Sender pastes the answer, calls setRemoteDescription().
 *     WebRTC's internal DTLS/ICE machinery takes over and
 *     establishes the direct peer-to-peer DataChannel.
 *
 *  STUN servers help both sides discover their public IP/port
 *  so the connection works across different networks (not just LAN).
 *
 *  FILE TRANSFER PROTOCOL:
 *  ───────────────────────
 *  • Sender sends a JSON "meta" message first (name, size, type, totalChunks).
 *  • Then sends ArrayBuffer chunks of CHUNK_SIZE bytes.
 *  • Receiver reassembles chunks into a Blob and triggers download.
 *  • Multiple files are queued and transferred sequentially.
 *  • Backpressure is managed via bufferedAmount polling so we
 *    never overflow the DataChannel buffer on large files.
 */

'use strict';

/* ═══════════════════════════════════════════
   CONFIGURATION
════════════════════════════════════════════ */

/** Chunk size in bytes. 64 KB is a sweet spot for DataChannel
 *  throughput vs memory pressure on both desktop and mobile. */
const CHUNK_SIZE = 64 * 1024; // 64 KB

/** Max bytes allowed in the DataChannel send buffer before we pause.
 *  Chrome's hard limit is 16 MB; we stay well below. */
const BUFFER_HIGH = 4 * 1024 * 1024;  // 4 MB
const BUFFER_LOW  =     512 * 1024;    // 512 KB — resume threshold

/** STUN servers for NAT traversal (public, no cost). */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.stunprotocol.org:3478' },
];

/* ═══════════════════════════════════════════
   STATE
════════════════════════════════════════════ */
let pc         = null;   // RTCPeerConnection
let dc         = null;   // RTCDataChannel
let myRole     = null;   // 'sender' | 'receiver'
let fileQueue  = [];     // Array of File objects (sender)
let queueMeta  = [];     // UI metadata per file
let currentIdx = 0;      // Index into fileQueue being sent

// Receiver reassembly state
let rxMeta     = null;   // Current file metadata from sender
let rxChunks   = [];     // Received ArrayBuffer chunks
let rxReceived = 0;      // Bytes received so far
let rxStart    = 0;      // Transfer start timestamp

// Sender speed tracking
let txStart    = 0;
let txSent     = 0;
let txPaused   = false;  // Backpressure flag

// Transfer history (both roles)
let history    = [];

/* ═══════════════════════════════════════════
   DEVICE DETECTION
════════════════════════════════════════════ */
(function detectDevice() {
  const ua = navigator.userAgent || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  document.getElementById('deviceType').textContent = isMobile ? 'Mobile' : 'Desktop';
  document.getElementById('deviceIcon').textContent = isMobile ? '📱' : '💻';
})();

/* ═══════════════════════════════════════════
   ROLE SELECTION
════════════════════════════════════════════ */
/**
 * Called when user clicks Sender or Receiver card.
 * Hides role selection, shows appropriate step, sets up RTCPeerConnection.
 * @param {'sender'|'receiver'} role
 */
async function chooseRole(role) {
  myRole = role;
  document.getElementById('stepRole').classList.add('hidden');
  setRolePill(role);

  // Initialise peer connection
  initPeerConnection();

  if (role === 'sender') {
    // Sender creates the DataChannel and generates an offer
    createDataChannel();
    await createAndDisplayOffer();
    document.getElementById('stepSenderOffer').classList.remove('hidden');
    // Show the file drop zone once the panel is set
    document.getElementById('dropZone').classList.remove('hidden');
    setupDropZone();
  } else {
    // Receiver waits for offer to be pasted
    document.getElementById('stepReceiverOffer').classList.remove('hidden');
    document.getElementById('receiverWait').classList.remove('hidden');
    // Receiver side DataChannel is set up via ondatachannel event
    setupReceiverDataChannel();
  }
}

/* ═══════════════════════════════════════════
   PEER CONNECTION SETUP
════════════════════════════════════════════ */
/**
 * Creates the RTCPeerConnection with STUN servers.
 * Also sets up connection-state change listeners for UI updates.
 */
function initPeerConnection() {
  if (pc) { pc.close(); }

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // ── ICE gathering state (used for trickle-less signaling) ──
  pc.addEventListener('icegatheringstatechange', () => {
    if (pc.iceGatheringState === 'complete') {
      // All ICE candidates are bundled in the SDP; we can now show it
      if (myRole === 'sender') {
        displayOffer();
      }
    }
  });

  // ── Connection state changes ──
  pc.addEventListener('connectionstatechange', () => {
    const state = pc.connectionState;
    console.log('[WebRTC] connectionState:', state);
    switch (state) {
      case 'connecting':
        setStatus('connecting', 'Connecting…');
        break;
      case 'connected':
        setStatus('connected', 'Connected');
        showToast('🔗 Peer connected!');
        if (myRole === 'receiver') {
          document.getElementById('receiverWait').classList.remove('hidden');
        }
        break;
      case 'disconnected':
      case 'closed':
      case 'failed':
        setStatus('disconnected', 'Disconnected');
        break;
    }
  });

  // ── ICE connection state (secondary indicator) ──
  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'checking') {
      setStatus('connecting', 'Connecting…');
    }
  });
}

/* ═══════════════════════════════════════════
   SENDER — CREATE DATACHANNEL & OFFER
════════════════════════════════════════════ */
/**
 * Sender creates an ordered, reliable DataChannel named 'fileTransfer'.
 */
function createDataChannel() {
  dc = pc.createDataChannel('fileTransfer', { ordered: true });
  dc.binaryType = 'arraybuffer';

  // Configure backpressure threshold so we know when to resume
  dc.bufferedAmountLowThreshold = BUFFER_LOW;

  dc.addEventListener('open', onDataChannelOpen);
  dc.addEventListener('close', () => console.log('[DC] closed'));
  dc.addEventListener('error', (e) => console.error('[DC] error', e));
  dc.addEventListener('message', onDataChannelMessage); // ACKs from receiver
  dc.addEventListener('bufferedamountlow', onBufferLow); // Resume sending
}

/**
 * Creates an RTCPeerConnection offer and waits for ICE gathering to finish.
 * The final offer (with embedded ICE candidates) is then encoded and shown.
 */
async function createAndDisplayOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // ICE gathering is async; displayOffer() is called from icegatheringstatechange
}

/**
 * Called once ICE gathering is complete.
 * Encodes the final SDP, shows a QR code, and fills the textarea.
 */
function displayOffer() {
  const encoded = encodeSignal(pc.localDescription);
  document.getElementById('offerBox').value = encoded;
  generateQR(encoded);
}

/* ═══════════════════════════════════════════
   RECEIVER — PROCESS OFFER & GENERATE ANSWER
════════════════════════════════════════════ */
/**
 * Sets up the receiver to accept a DataChannel created by the sender.
 */
function setupReceiverDataChannel() {
  pc.addEventListener('datachannel', (event) => {
    dc = event.channel;
    dc.binaryType = 'arraybuffer';
    dc.addEventListener('open',    onDataChannelOpen);
    dc.addEventListener('close',   () => console.log('[DC] closed'));
    dc.addEventListener('error',   (e) => console.error('[DC] error', e));
    dc.addEventListener('message', onDataChannelMessage);
    console.log('[DC] receiver got datachannel:', dc.label);
  });
}

/**
 * Called when receiver clicks "Generate Answer".
 * Reads the offer from the textarea, generates an answer,
 * waits for ICE gathering, then shows the answer code.
 */
async function generateAnswer() {
  const offerEncoded = document.getElementById('offerInput').value.trim();
  if (!offerEncoded) { showToast('⚠️ Paste the offer code first.'); return; }

  try {
    const offerDesc = decodeSignal(offerEncoded);
    await pc.setRemoteDescription(offerDesc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Wait for ICE gathering to complete, then display answer
    await waitForIceGathering();
    const encoded = encodeSignal(pc.localDescription);
    document.getElementById('answerBox').value = encoded;
    document.getElementById('answerSection').classList.remove('hidden');
    showToast('✅ Answer generated! Share it with the sender.');
  } catch (err) {
    console.error('[Answer]', err);
    showToast('❌ Invalid offer code.');
  }
}

/**
 * Called when sender clicks "Connect" after pasting the answer.
 */
async function acceptAnswer() {
  const answerEncoded = document.getElementById('answerInput').value.trim();
  if (!answerEncoded) { showToast('⚠️ Paste the answer code first.'); return; }

  try {
    const answerDesc = decodeSignal(answerEncoded);
    await pc.setRemoteDescription(answerDesc);
    showToast('🔄 Connecting to peer…');
  } catch (err) {
    console.error('[AcceptAnswer]', err);
    showToast('❌ Invalid answer code.');
  }
}

/* ═══════════════════════════════════════════
   ICE GATHERING HELPER
════════════════════════════════════════════ */
/**
 * Returns a Promise that resolves when ICE gathering is complete.
 * Allows async/await usage in generateAnswer().
 */
function waitForIceGathering() {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const handler = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', handler);
  });
}

/* ═══════════════════════════════════════════
   SIGNAL ENCODING / DECODING
════════════════════════════════════════════ */
/**
 * Encodes an RTCSessionDescription to a compact Base64 string.
 * @param {RTCSessionDescription} desc
 * @returns {string} Base64 encoded JSON
 */
function encodeSignal(desc) {
  return btoa(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
}

/**
 * Decodes a Base64 string back to an RTCSessionDescription-like object.
 * @param {string} encoded
 * @returns {{ type: string, sdp: string }}
 */
function decodeSignal(encoded) {
  return JSON.parse(atob(encoded));
}

/* ═══════════════════════════════════════════
   QR CODE GENERATION
════════════════════════════════════════════ */
/**
 * Generates a QR code in #qrCode div using the qrcode.js CDN library.
 * @param {string} text — the encoded offer string
 */
function generateQR(text) {
  const container = document.getElementById('qrCode');
  container.innerHTML = '';
  // If the text is too long for a QR code (>2900 chars in QR spec),
  // we show a warning instead of a broken QR
  if (text.length > 2900) {
    container.innerHTML = '<small style="color:#ffaa00;font-size:.7rem;text-align:center;display:block;">⚠️ Code too long for QR.<br>Use copy-paste.</small>';
    return;
  }
  try {
    new QRCode(container, {
      text,
      width: 160, height: 160,
      colorDark: '#000000', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.L,
    });
  } catch (e) {
    container.innerHTML = '<small style="color:#ffaa00">QR unavailable — use copy-paste.</small>';
  }
}

/* ═══════════════════════════════════════════
   DROP ZONE & FILE SELECTION
════════════════════════════════════════════ */
/**
 * Attaches drag-and-drop event listeners to the drop zone element.
 */
function setupDropZone() {
  const zone = document.getElementById('dropZone');

  zone.addEventListener('dragenter', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragover',  (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', (e) => { zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFileSelect(e.dataTransfer.files);
  });

  // Also clicking the zone opens file picker
  zone.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') {
      document.getElementById('fileInput').click();
    }
  });
}

/**
 * Handles file selection from either drag-drop or file input.
 * Adds files to the queue and renders the queue UI.
 * @param {FileList} files
 */
function handleFileSelect(files) {
  if (!files || files.length === 0) return;
  for (const f of files) {
    fileQueue.push(f);
    queueMeta.push({ name: f.name, size: f.size, status: 'pending' });
  }
  renderFileQueue();
  document.getElementById('dropZone').classList.add('hidden');
  document.getElementById('queueWrap').classList.remove('hidden');
}

/**
 * Renders the file queue list in the UI.
 */
function renderFileQueue() {
  const ul = document.getElementById('fileQueue');
  ul.innerHTML = '';
  queueMeta.forEach((meta, idx) => {
    const li = document.createElement('li');
    li.className = `file-item ${meta.status}`;
    li.id = `qi-${idx}`;
    li.innerHTML = `
      <span class="fi-icon">${fileIcon(fileQueue[idx].name)}</span>
      <div class="fi-info">
        <div class="fi-name" title="${esc(meta.name)}">${esc(meta.name)}</div>
        <div class="fi-size">${formatBytes(meta.size)}</div>
      </div>
      <span class="fi-status ${meta.status}">${meta.status}</span>
      ${meta.status === 'pending' ? `<button class="fi-remove" onclick="removeFile(${idx})" title="Remove">✕</button>` : ''}
    `;
    ul.appendChild(li);
  });
}

/**
 * Removes a file from the queue (only before sending starts).
 * @param {number} idx
 */
function removeFile(idx) {
  fileQueue.splice(idx, 1);
  queueMeta.splice(idx, 1);
  if (fileQueue.length === 0) {
    document.getElementById('queueWrap').classList.add('hidden');
    document.getElementById('dropZone').classList.remove('hidden');
  } else {
    renderFileQueue();
  }
}

/* ═══════════════════════════════════════════
   FILE TRANSFER — SENDER SIDE
════════════════════════════════════════════ */
/**
 * Initiates sequential transfer of all files in the queue.
 * Called when user clicks "Send All Files".
 */
async function startTransfer() {
  if (!dc || dc.readyState !== 'open') {
    showToast('⚠️ Not connected. Complete the connection first.');
    return;
  }
  document.getElementById('btnSendAll').disabled = true;
  currentIdx = 0;
  await sendNextFile();
}

/**
 * Sends the file at `currentIdx` in the queue, then advances.
 */
async function sendNextFile() {
  if (currentIdx >= fileQueue.length) {
    // All files done
    document.getElementById('transferCard').classList.add('hidden');
    showToast('🎉 All files sent!');
    return;
  }

  const file = fileQueue[currentIdx];
  const meta = queueMeta[currentIdx];
  meta.status = 'active';
  updateQueueItemStatus(currentIdx, 'active');

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Step 1: Send metadata as JSON string
  const metaMsg = JSON.stringify({
    type:        'meta',
    name:        file.name,
    size:        file.size,
    fileType:    file.type || 'application/octet-stream',
    totalChunks,
  });
  dc.send(metaMsg);

  // Step 2: Show the transfer card
  showTransferCard(file.name, file.size);
  txStart  = Date.now();
  txSent   = 0;
  txPaused = false;

  // Step 3: Stream file in chunks using a ReadableStream
  const stream = file.stream();
  const reader = stream.getReader();
  let chunkIdx = 0;

  /**
   * Inner loop: reads chunks from the file stream and sends them
   * through the DataChannel with backpressure handling.
   */
  const pump = async () => {
    while (true) {
      // Backpressure: if buffer is too full, pause and wait for bufferedamountlow
      if (dc.bufferedAmount > BUFFER_HIGH) {
        txPaused = true;
        await waitForBufferLow();
        txPaused = false;
      }

      const { done, value } = await reader.read();
      if (done) break;

      // value is a Uint8Array chunk from the stream
      // We send it as ArrayBuffer
      dc.send(value.buffer);
      txSent += value.byteLength;
      chunkIdx++;

      // Update progress UI
      const pct = Math.min(100, Math.round((txSent / file.size) * 100));
      updateTransferCard(pct, txSent, file.size);
    }
  };

  try {
    await pump();
    // Mark done
    meta.status = 'done';
    updateQueueItemStatus(currentIdx, 'done');
    addHistory(file.name, file.size, 'sent');
  } catch (err) {
    console.error('[Send]', err);
    meta.status = 'error';
    updateQueueItemStatus(currentIdx, 'error');
    addHistory(file.name, file.size, 'error');
  }

  currentIdx++;
  await sendNextFile();
}

/**
 * Returns a Promise that resolves when the DataChannel
 * fires the `bufferedamountlow` event (buffer drains below BUFFER_LOW).
 */
function waitForBufferLow() {
  return new Promise((resolve) => {
    // Resolved by onBufferLow listener
    dc._bufferLowResolve = resolve;
  });
}

/**
 * Called when the DataChannel's bufferedAmount drops below the threshold.
 * Resumes the paused sender pump.
 */
function onBufferLow() {
  if (dc && dc._bufferLowResolve) {
    const fn = dc._bufferLowResolve;
    dc._bufferLowResolve = null;
    fn();
  }
}

/* ═══════════════════════════════════════════
   FILE TRANSFER — RECEIVER SIDE
════════════════════════════════════════════ */
/**
 * Central message handler for the DataChannel.
 * Processes both JSON control messages (meta) and binary chunks.
 * @param {MessageEvent} event
 */
function onDataChannelMessage(event) {
  if (typeof event.data === 'string') {
    // Control message
    const msg = JSON.parse(event.data);
    if (msg.type === 'meta') {
      // New file incoming
      rxMeta     = msg;
      rxChunks   = [];
      rxReceived = 0;
      rxStart    = Date.now();

      document.getElementById('receiverWait').classList.add('hidden');
      showTransferCard(msg.name, msg.size);
      console.log(`[RX] Receiving: ${msg.name} (${formatBytes(msg.size)})`);
    }
  } else {
    // Binary chunk
    if (!rxMeta) { console.warn('[RX] Got chunk without meta'); return; }

    rxChunks.push(event.data);
    rxReceived += event.data.byteLength;

    const pct = Math.min(100, Math.round((rxReceived / rxMeta.size) * 100));
    updateTransferCard(pct, rxReceived, rxMeta.size);

    // Check if file is complete
    if (rxReceived >= rxMeta.size) {
      finalizeReceivedFile();
    }
  }
}

/**
 * Assembles the received chunks into a Blob and triggers a download.
 */
function finalizeReceivedFile() {
  console.log(`[RX] File complete: ${rxMeta.name}`);
  const blob = new Blob(rxChunks, { type: rxMeta.fileType });

  // Trigger browser download
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = rxMeta.name;
  a.click();

  // Revoke after a short delay to free memory
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  addHistory(rxMeta.name, rxMeta.size, 'received', blob);
  showToast(`✅ Received: ${rxMeta.name}`);

  // Reset receiver state for next file
  rxMeta     = null;
  rxChunks   = [];
  rxReceived = 0;
  document.getElementById('transferCard').classList.add('hidden');
  document.getElementById('receiverWait').classList.remove('hidden');
}

/* ═══════════════════════════════════════════
   DATA CHANNEL OPEN
════════════════════════════════════════════ */
/**
 * Called when the DataChannel is open and ready.
 * Updates UI for both sender and receiver.
 */
function onDataChannelOpen() {
  console.log('[DC] open');
  setStatus('connected', 'Connected');
  showToast('🔗 DataChannel open — ready to transfer!');

  if (myRole === 'sender') {
    document.getElementById('dropZone').classList.remove('hidden');
    document.getElementById('stepSenderOffer').classList.add('hidden');
  }
}

/* ═══════════════════════════════════════════
   TRANSFER CARD UI
════════════════════════════════════════════ */
/**
 * Makes the transfer card visible and initialises it.
 * @param {string} name
 * @param {number} size
 */
function showTransferCard(name, size) {
  document.getElementById('transferCard').classList.remove('hidden');
  document.getElementById('tfFilename').textContent = name;
  document.getElementById('tfSize').textContent     = formatBytes(size);
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressPct').textContent  = '0%';
  document.getElementById('tfSpeed').textContent      = '—';
  document.getElementById('tfETA').textContent        = '—';
  document.getElementById('tfTransferred').textContent = '0 B';
}

/**
 * Updates progress bar, speed, ETA and transferred amount.
 * @param {number} pct       0-100
 * @param {number} bytes     bytes transferred so far
 * @param {number} totalSize total file size in bytes
 */
function updateTransferCard(pct, bytes, totalSize) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressPct').textContent  = pct + '%';
  document.getElementById('tfTransferred').textContent = formatBytes(bytes) + ' / ' + formatBytes(totalSize);

  const elapsed = (Date.now() - (myRole === 'sender' ? txStart : rxStart)) / 1000 || 0.001;
  const speedBps = bytes / elapsed;
  document.getElementById('tfSpeed').textContent = formatSpeed(speedBps);

  const remaining = totalSize - bytes;
  const etaSec    = speedBps > 0 ? remaining / speedBps : 0;
  document.getElementById('tfETA').textContent = formatETA(etaSec);
}

/* ═══════════════════════════════════════════
   STATUS BAR UI
════════════════════════════════════════════ */
/**
 * @param {'connected'|'connecting'|'disconnected'} state
 * @param {string} text
 */
function setStatus(state, text) {
  const dot  = document.getElementById('statusDot');
  const span = document.getElementById('statusText');
  dot.className  = 'status-dot ' + state;
  span.textContent = text;
}

/**
 * Shows the user's current role (Sender/Receiver) as a pill badge.
 * @param {'sender'|'receiver'} role
 */
function setRolePill(role) {
  const pill = document.getElementById('rolePill');
  pill.textContent = role === 'sender' ? 'Sender' : 'Receiver';
  pill.classList.remove('hidden');
}

/**
 * Updates a file queue item's visual status.
 * @param {number} idx
 * @param {'pending'|'active'|'done'|'error'} status
 */
function updateQueueItemStatus(idx, status) {
  const li = document.getElementById(`qi-${idx}`);
  if (!li) return;
  li.className = `file-item ${status}`;
  const badge = li.querySelector('.fi-status');
  if (badge) { badge.className = `fi-status ${status}`; badge.textContent = status; }
}

/* ═══════════════════════════════════════════
   HISTORY
════════════════════════════════════════════ */
/**
 * Adds an entry to the transfer history and renders it.
 * @param {string} name
 * @param {number} size
 * @param {'sent'|'received'|'error'} type
 * @param {Blob} [blob] — only for received files (enables re-download)
 */
function addHistory(name, size, type, blob = null) {
  history.unshift({ name, size, type, blob, time: new Date() });
  renderHistory();
}

/**
 * Renders the transfer history list.
 */
function renderHistory() {
  const empty = document.getElementById('historyEmpty');
  const list  = document.getElementById('historyList');
  list.innerHTML = '';

  if (history.length === 0) { empty.style.display = ''; return; }
  empty.style.display = 'none';

  history.forEach((item, idx) => {
    const li  = document.createElement('li');
    li.className = 'history-item';
    const time = item.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `
      <span class="hi-icon">${fileIcon(item.name)}</span>
      <div class="hi-info">
        <div class="hi-name" title="${esc(item.name)}">${esc(item.name)}</div>
        <div class="hi-meta">${formatBytes(item.size)} · ${time}</div>
      </div>
      <span class="hi-badge ${item.type}">${item.type}</span>
      ${item.blob ? `<button class="hi-download" onclick="reDownload(${idx})">↓ Save</button>` : ''}
    `;
    list.appendChild(li);
  });
}

/**
 * Re-triggers a download for a previously received file.
 * @param {number} idx — index into history array
 */
function reDownload(idx) {
  const item = history[idx];
  if (!item || !item.blob) return;
  const url = URL.createObjectURL(item.blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = item.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/* ═══════════════════════════════════════════
   TOAST
════════════════════════════════════════════ */
let toastTimer = null;
/**
 * Shows a brief notification toast.
 * @param {string} msg
 * @param {number} [duration=3000]
 */
function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

/* ═══════════════════════════════════════════
   COPY TO CLIPBOARD
════════════════════════════════════════════ */
/**
 * Copies the content of a textarea to the clipboard.
 * @param {string} id — textarea element id
 */
function copyText(id) {
  const el = document.getElementById(id);
  if (!el || !el.value) { showToast('Nothing to copy.'); return; }
  navigator.clipboard.writeText(el.value)
    .then(() => showToast('📋 Copied to clipboard!'))
    .catch(() => {
      // Fallback for browsers without clipboard API permission
      el.select();
      document.execCommand('copy');
      showToast('📋 Copied!');
    });
}

/* ═══════════════════════════════════════════
   FORMAT HELPERS
════════════════════════════════════════════ */
/**
 * Human-readable file size.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

/**
 * Human-readable transfer speed.
 * @param {number} bps — bytes per second
 * @returns {string}
 */
function formatSpeed(bps) {
  if (bps < 1024)        return bps.toFixed(0) + ' B/s';
  if (bps < 1048576)     return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(2) + ' MB/s';
}

/**
 * Human-readable estimated time remaining.
 * @param {number} seconds
 * @returns {string}
 */
function formatETA(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60)  return Math.ceil(seconds) + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.ceil(seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

/**
 * Returns an emoji icon based on file extension.
 * @param {string} filename
 * @returns {string}
 */
function fileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    pdf: '📄', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️',
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵',
    zip: '🗜️', rar: '🗜️', gz: '🗜️', '7z': '🗜️',
    doc: '📝', docx: '📝', txt: '📝', md: '📝',
    xls: '📊', xlsx: '📊', csv: '📊',
    ppt: '📋', pptx: '📋',
    js: '💻', ts: '💻', py: '💻', html: '💻', css: '💻',
    apk: '📱', exe: '⚙️', dmg: '💿',
  };
  return map[ext] || '📎';
}

/**
 * HTML-escapes a string to prevent XSS in innerHTML.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

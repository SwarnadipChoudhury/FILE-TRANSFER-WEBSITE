// DropBeam — app.js
// PeerJS for signaling, WebRTC for direct P2P transfer

const CHUNK_SIZE = 64 * 1024; // 64KB

// ===== STATE =====
let peer = null;
let conn = null;
let myPeerId = null;

let pendingFiles = [];
let currentFile = null;
let sendOffset = 0;
let isPaused = false;
let isCancelled = false;
let transferStartTime = 0;

let incomingMeta = null;
let incomingChunks = [];
let incomingReceived = 0;

let transferHistory = [];
let lastReceivedText = "";
let activeTransferEl = null;

let deviceName = localStorage.getItem("dropbeam-name") || guessDeviceName();
let scanInterval = null;
let videoStream = null;

// ===== START =====
document.addEventListener("DOMContentLoaded", () => {
  localStorage.setItem("dropbeam-name", deviceName);
  document.getElementById("device-name-display").textContent = deviceName;
  updateDeviceEmoji();
  initPeer();
  initBackground();

  document.getElementById("file-input").addEventListener("change", (e) => {
    addFilesToQueue([...e.target.files]);
  });

  // Drag and drop
  const dz = document.getElementById("drop-zone");
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag-over");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag-over");
    const files = [];
    const items = [...e.dataTransfer.items];
    const promises = items.map(item => {
      if (item.kind === "file") {
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory) return readDir(entry, files);
        files.push(item.getAsFile());
      }
      return Promise.resolve();
    });
    Promise.all(promises).then(() => addFilesToQueue(files.filter(Boolean)));
  });

  // URL se auto join (QR scan ke baad)
  const params = new URLSearchParams(location.search);
  const roomFromUrl = params.get("room");
  if (roomFromUrl) {
    history.replaceState({}, "", "/");
    setTimeout(() => joinRoom(roomFromUrl), 1200);
  }
});

// ===== PEERJS INIT =====
function initPeer() {
  peer = new Peer({
    host: "0.peerjs.com",
    port: 443,
    secure: true,
    path: "/",
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
      ]
    }
  });

  peer.on("open", (id) => {
    myPeerId = id;
    console.log("My Peer ID:", id);
  });

  // Incoming connection (receiver connects to us)
  peer.on("connection", (connection) => {
    conn = connection;
    setupConnection(conn);
  });

  peer.on("error", (err) => {
    console.error("PeerJS error:", err);
    if (err.type === "peer-unavailable") {
      showToast("Room not found. Check the ID and try again.");
    } else if (err.type === "network") {
      showToast("Network error. Check your internet connection.");
    } else {
      showToast("Connection error: " + err.type);
    }
  });

  peer.on("disconnected", () => {
    showToast("Disconnected. Reconnecting...");
    setTimeout(() => {
      if (peer && !peer.destroyed) peer.reconnect();
    }, 2000);
  });
}

// ===== CONNECTION SETUP =====
function setupConnection(connection) {
  connection.on("open", () => {
    onPeerConnected();
    connection.send(JSON.stringify({
      type: "hello",
      name: deviceName
    }));
  });

  connection.on("data", (data) => {
    handleData(data);
  });

  connection.on("close", () => {
    showToast("Peer disconnected.");
    setTimeout(() => goHome(), 1500);
  });

  connection.on("error", (err) => {
    console.error("Connection error:", err);
    showToast("Transfer error. Please reconnect.");
  });
}

// ===== PEER CONNECTED =====
function onPeerConnected() {
  stopCamera();
  showScreen("transfer");
  showToast("Connected successfully!");
}

// ===== DATA HANDLER =====
function handleData(data) {
  if (data instanceof ArrayBuffer) {
    handleChunk(data);
    return;
  }

  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  switch (msg.type) {
    case "hello":
      document.getElementById("peer-name-display").textContent = msg.name;
      document.getElementById("peer-avatar").textContent =
        /phone|iphone|android/i.test(msg.name) ? "📱" : "💻";
      break;

    case "file-meta":
      incomingMeta = msg;
      document.getElementById("file-request-desc").textContent =
        `"${msg.name}" (${formatBytes(msg.size)})`;
      document.getElementById("file-request-modal").classList.remove("hidden");
      break;

    case "file-accept":
      startSendingChunks();
      break;

    case "file-reject":
      showToast("File was rejected by receiver.");
      pendingFiles.shift();
      updateQueueUI();
      break;

    case "file-done":
      break;

    case "file-cancel":
      showToast("Transfer cancelled by sender.");
      resetIncoming();
      if (activeTransferEl) {
        activeTransferEl.remove();
        activeTransferEl = null;
      }
      break;

    case "clipboard":
      lastReceivedText = msg.text;
      document.getElementById("received-clipboard").textContent = msg.text;
      document.getElementById("copy-received-btn").classList.remove("hidden");
      switchTransferTab("clip");
      showToast("Text received!");
      break;
  }
}

// ===== SCREEN NAV =====
function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById("screen-" + name).classList.add("active");
}

function goHome() {
  cleanup();
  showScreen("home");
}

function goToSend() {
  if (!peer) {
    showToast("Still initializing. Please wait...");
    return;
  }
  if (!myPeerId) {
    showToast("Connecting to server. Please wait...");
    setTimeout(goToSend, 1000);
    return;
  }
  showScreen("send");
  document.getElementById("room-code-display").textContent = myPeerId;
  generateQR(myPeerId);
}

function goToReceive() {
  showScreen("receive");
  setTimeout(() => startScan(), 400);
}

// ===== QR CODE =====
function generateQR(peerId) {
  const container = document.getElementById("qr-container");
  container.innerHTML = "";
  const url = `${location.origin}?room=${peerId}`;
  new QRCode(container, {
    text: url,
    width: 200,
    height: 200,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
}

// ===== QR SCANNER =====
async function startScan() {
  if (videoStream) {
    videoStream.getTracks().forEach(t => t.stop());
  }
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
    const video = document.getElementById("scanner-video");
    video.srcObject = videoStream;
    await video.play();

    const canvas = document.getElementById("scanner-canvas");
    const ctx = canvas.getContext("2d");

    if (scanInterval) clearInterval(scanInterval);
    scanInterval = setInterval(() => {
      if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imgData.data, canvas.width, canvas.height);
      if (code?.data) {
        const match = code.data.match(/room=([A-Za-z0-9\-]+)/);
        if (match) {
          clearInterval(scanInterval);
          stopCamera();
          showToast("QR code scanned!");
          joinRoom(match[1]);
        }
      }
    }, 250);
  } catch (e) {
    showToast("Camera not available. Use Enter ID tab.");
    switchJoinTab("code");
  }
}

function stopCamera() {
  if (videoStream) {
    videoStream.getTracks().forEach(t => t.stop());
    videoStream = null;
  }
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
}

function switchJoinTab(tab) {
  document.getElementById("join-scan").classList.toggle("hidden", tab !== "scan");
  document.getElementById("join-code").classList.toggle("hidden", tab !== "code");
  document.getElementById("tab-scan").classList.toggle("active", tab === "scan");
  document.getElementById("tab-code").classList.toggle("active", tab !== "scan");
  if (tab === "scan") startScan();
  else stopCamera();
}

// ===== JOIN ROOM =====
function joinByCode() {
  const input = document.getElementById("peer-id-input");
  const id = input.value.trim();
  if (!id) {
    showToast("Please enter a Room ID.");
    return;
  }
  joinRoom(id);
}

function joinRoom(peerId) {
  if (!peer) {
    showToast("Please wait, still initializing...");
    return;
  }
  showToast("Connecting...");
  conn = peer.connect(peerId, {
    reliable: true,
    serialization: "none"
  });
  setupConnection(conn);
}

// ===== FILE QUEUE =====
function addFilesToQueue(files) {
  pendingFiles.push(...files);
  updateQueueUI();
}

function updateQueueUI() {
  const queueEl = document.getElementById("file-queue");
  const sendBtn = document.getElementById("send-btn");
  queueEl.innerHTML = "";

  pendingFiles.forEach((f, i) => {
    const el = document.createElement("div");
    el.className = "file-item";
    el.innerHTML = `
      <div class="file-icon">${getFileEmoji(f.name)}</div>
      <div class="file-info">
        <div class="file-name">${escHtml(f.name)}</div>
        <div class="file-size">${formatBytes(f.size)}</div>
      </div>
      <button class="btn btn-ghost small-btn" onclick="removeFile(${i})">✕</button>
    `;
    queueEl.appendChild(el);
  });

  sendBtn.classList.toggle("hidden", pendingFiles.length === 0);
}

function removeFile(i) {
  pendingFiles.splice(i, 1);
  updateQueueUI();
}

function sendFiles() {
  if (!pendingFiles.length) return;
  if (!conn || !conn.open) {
    showToast("Not connected to any peer.");
    return;
  }
  sendNextFile();
}

// ===== SENDING =====
function sendNextFile() {
  if (!pendingFiles.length) {
    showToast("All files sent successfully!");
    return;
  }
  currentFile = pendingFiles[0];
  conn.send(JSON.stringify({
    type: "file-meta",
    name: currentFile.name,
    size: currentFile.size,
    mime: currentFile.type || "application/octet-stream"
  }));
  showToast(`Requesting to send: ${currentFile.name}`);
}

function startSendingChunks() {
  if (!currentFile) return;
  sendOffset = 0;
  isPaused = false;
  isCancelled = false;
  transferStartTime = Date.now();
  activeTransferEl = makeTransferEl(currentFile.name, currentFile.size, true);
  document.getElementById("active-transfers").appendChild(activeTransferEl);
  readAndSend();
}

function readAndSend() {
  if (isCancelled) {
    conn.send(JSON.stringify({ type: "file-cancel" }));
    resetSending();
    return;
  }
  if (isPaused) {
    setTimeout(readAndSend, 200);
    return;
  }
  if (sendOffset >= currentFile.size) {
    conn.send(JSON.stringify({ type: "file-done" }));
    finalizeSend();
    return;
  }

  // Buffer control — don't overflow channel
  if (conn.dataChannel && conn.dataChannel.bufferedAmount > CHUNK_SIZE * 16) {
    setTimeout(readAndSend, 50);
    return;
  }

  const slice = currentFile.slice(sendOffset, sendOffset + CHUNK_SIZE);
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      conn.send(e.target.result);
      sendOffset += e.target.result.byteLength;
      updateProgress(activeTransferEl, sendOffset, currentFile.size);
      setTimeout(readAndSend, 0);
    } catch (err) {
      setTimeout(readAndSend, 500);
    }
  };
  reader.readAsArrayBuffer(slice);
}

function finalizeSend() {
  addHistory("📤 Sent", currentFile.name, currentFile.size);
  showToast(`${currentFile.name} sent successfully!`);

  if (activeTransferEl) {
    activeTransferEl.querySelector(".progress-fill").style.width = "100%";
    activeTransferEl.querySelector(".file-size").textContent = "✅ Sent!";
    setTimeout(() => {
      activeTransferEl?.remove();
      activeTransferEl = null;
    }, 3000);
  }

  pendingFiles.shift();
  currentFile = null;
  updateQueueUI();
  if (pendingFiles.length) setTimeout(sendNextFile, 500);
}

function resetSending() {
  currentFile = null;
  sendOffset = 0;
  if (activeTransferEl) {
    activeTransferEl.remove();
    activeTransferEl = null;
  }
}

// ===== RECEIVING =====
function handleChunk(chunk) {
  if (!incomingMeta) return;
  incomingChunks.push(chunk);
  incomingReceived += chunk.byteLength;
  updateProgress(activeTransferEl, incomingReceived, incomingMeta.size);

  if (incomingReceived >= incomingMeta.size) {
    const blob = new Blob(incomingChunks, { type: incomingMeta.mime });
    downloadFile(blob, incomingMeta.name);
    addHistory("📥 Received", incomingMeta.name, incomingMeta.size);
    showToast(`${incomingMeta.name} received successfully!`);

    if (incomingMeta.mime.startsWith("image/")) showImagePreview(blob);

    if (activeTransferEl) {
      activeTransferEl.querySelector(".progress-fill").style.width = "100%";
      activeTransferEl.querySelector(".file-size").textContent = "✅ Received!";
      setTimeout(() => {
        activeTransferEl?.remove();
        activeTransferEl = null;
      }, 3000);
    }
    resetIncoming();
  }
}

function resetIncoming() {
  incomingMeta = null;
  incomingChunks = [];
  incomingReceived = 0;
}

function acceptFile() {
  document.getElementById("file-request-modal").classList.add("hidden");
  if (!incomingMeta) return;
  conn.send(JSON.stringify({ type: "file-accept" }));
  incomingChunks = [];
  incomingReceived = 0;
  transferStartTime = Date.now();
  activeTransferEl = makeTransferEl(incomingMeta.name, incomingMeta.size, false);
  document.getElementById("active-transfers").appendChild(activeTransferEl);
  switchTransferTab("files");
}

function rejectFile() {
  document.getElementById("file-request-modal").classList.add("hidden");
  conn.send(JSON.stringify({ type: "file-reject" }));
  incomingMeta = null;
  showToast("File rejected.");
}

// ===== DOWNLOAD =====
function downloadFile(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 10000);
}

// ===== IMAGE PREVIEW =====
function showImagePreview(blob) {
  const url = URL.createObjectURL(blob);
  document.getElementById("preview-img").src = url;
  document.getElementById("img-preview-modal").classList.remove("hidden");
}

function closeImagePreview() {
  document.getElementById("img-preview-modal").classList.add("hidden");
}

// ===== PROGRESS UI =====
function makeTransferEl(name, size, isSender) {
  const el = document.createElement("div");
  el.className = "file-item";
  el.style.flexDirection = "column";
  el.style.alignItems = "flex-start";
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;width:100%">
      <div class="file-icon">${getFileEmoji(name)}</div>
      <div class="file-info" style="flex:1">
        <div class="file-name">${escHtml(name)}</div>
        <div class="file-size">
          ${isSender ? "Sending..." : "Receiving..."} · ${formatBytes(size)}
        </div>
      </div>
      ${isSender ? `
        <button class="btn btn-ghost small-btn"
          id="pause-btn" onclick="togglePause(this)">⏸</button>
        <button class="btn btn-ghost small-btn"
          onclick="cancelTransfer()">✕</button>
      ` : ""}
    </div>
    <div class="progress-wrap" style="width:100%">
      <div class="progress-fill" style="width:0%"></div>
    </div>
    <div class="progress-stats">
      <span class="pct">0%</span>
      <span class="spd">—</span>
      <span class="eta">—</span>
    </div>
  `;
  return el;
}

function updateProgress(el, received, total) {
  if (!el) return;
  const pct = Math.min(100, (received / total) * 100);
  el.querySelector(".progress-fill").style.width = pct.toFixed(1) + "%";
  el.querySelector(".pct").textContent = pct.toFixed(0) + "%";
  const elapsed = (Date.now() - transferStartTime) / 1000 || 0.001;
  const speed = received / elapsed;
  const eta = (total - received) / speed;
  el.querySelector(".spd").textContent = formatSpeed(speed);
  el.querySelector(".eta").textContent = "ETA: " + formatTime(eta);
}

function togglePause(btn) {
  isPaused = !isPaused;
  btn.textContent = isPaused ? "▶️" : "⏸";
  showToast(isPaused ? "Transfer paused." : "Transfer resumed.");
}

function cancelTransfer() {
  isCancelled = true;
  showToast("Transfer cancelled.");
}

// ===== CLIPBOARD =====
function sendClipboard() {
  const text = document.getElementById("clipboard-text").value.trim();
  if (!text) { showToast("Please enter some text first."); return; }
  if (!conn || !conn.open) { showToast("Not connected to any peer."); return; }
  conn.send(JSON.stringify({ type: "clipboard", text }));
  showToast("Text sent successfully!");
  document.getElementById("clipboard-text").value = "";
}

function copyReceivedText() {
  navigator.clipboard.writeText(lastReceivedText)
    .then(() => showToast("Copied to clipboard!"));
}

// ===== HISTORY =====
function addHistory(direction, name, size) {
  transferHistory.unshift({
    direction, name, size,
    time: new Date().toLocaleTimeString()
  });
  renderHistory();
}

function renderHistory() {
  const el = document.getElementById("transfer-history");
  if (!transferHistory.length) {
    el.innerHTML = `<p class="hint">No transfers yet.</p>`;
    return;
  }
  el.innerHTML = transferHistory.map(h => `
    <div class="history-item">
      <div style="font-size:1.3rem">${h.direction.split(" ")[0]}</div>
      <div style="flex:1">
        <div style="font-size:0.85rem;font-weight:500;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${escHtml(h.name)}
        </div>
        <div style="font-size:0.72rem;color:var(--text2)">
          ${h.direction} · ${formatBytes(h.size)} · ${h.time}
        </div>
      </div>
    </div>
  `).join("");
}

// ===== TAB SWITCHING =====
function switchTransferTab(tab) {
  ["files", "clip", "hist"].forEach(t => {
    document.getElementById("tcontent-" + t).classList.toggle("hidden", t !== tab);
    document.getElementById("ttab-" + t).classList.toggle("active", t === tab);
  });
}

// ===== MISC =====
function copyRoomCode() {
  navigator.clipboard.writeText(myPeerId)
    .then(() => showToast("Room ID copied! Share it with the receiver."));
}

function toggleTheme() {
  const html = document.documentElement;
  const isLight = html.getAttribute("data-theme") === "light";
  html.setAttribute("data-theme", isLight ? "dark" : "light");
  document.querySelector(".theme-btn").textContent = isLight ? "🌙" : "☀️";
}

function renameDevice() {
  const name = prompt("Enter new device name:", deviceName);
  if (name?.trim()) {
    deviceName = name.trim().slice(0, 24);
    localStorage.setItem("dropbeam-name", deviceName);
    document.getElementById("device-name-display").textContent = deviceName;
    updateDeviceEmoji();
    showToast("Device renamed to: " + deviceName);
  }
}

function updateDeviceEmoji() {
  const ua = navigator.userAgent;
  const isMobile = /iPhone|Android.*Mobile|iPad/i.test(ua);
  document.getElementById("device-emoji").textContent = isMobile ? "📱" : "💻";
}

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android.*Mobile/.test(ua)) return "Android Phone";
  if (/Android/.test(ua)) return "Android Tablet";
  if (/Mac/.test(ua)) return "MacBook";
  if (/Windows/.test(ua)) return "Windows PC";
  return "My Device";
}

function disconnect() {
  cleanup();
  showScreen("home");
  showToast("Disconnected.");
}

function cleanup() {
  stopCamera();
  if (conn) { try { conn.close(); } catch {} conn = null; }
  pendingFiles = [];
  transferHistory = [];
  incomingMeta = null;
  incomingChunks = [];
}

// ===== TOAST =====
function showToast(msg, duration = 3000) {
  const tc = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  tc.appendChild(t);
  setTimeout(() => t.remove(), duration + 400);
}

// ===== HELPERS =====
function formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 ** 2) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(2) + " MB";
  return (b / 1024 ** 3).toFixed(2) + " GB";
}

function formatSpeed(bps) { return formatBytes(bps) + "/s"; }

function formatTime(sec) {
  if (!isFinite(sec) || sec > 3600) return "calculating...";
  if (sec < 60) return Math.ceil(sec) + "s";
  return Math.floor(sec / 60) + "m " + Math.ceil(sec % 60) + "s";
}

function getFileEmoji(name) {
  const ext = name.split(".").pop().toLowerCase();
  const map = {
    jpg:"🖼️", jpeg:"🖼️", png:"🖼️", gif:"🖼️", webp:"🖼️", svg:"🖼️",
    mp4:"🎬", mov:"🎬", avi:"🎬", mkv:"🎬",
    mp3:"🎵", wav:"🎵", flac:"🎵", aac:"🎵",
    pdf:"📄", doc:"📝", docx:"📝",
    xls:"📊", xlsx:"📊", csv:"📊",
    zip:"🗜️", rar:"🗜️", "7z":"🗜️",
    js:"💻", ts:"💻", py:"💻", html:"💻", css:"💻",
  };
  return map[ext] || "📁";
}

function escHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function readDir(entry, files) {
  const reader = entry.createReader();
  return new Promise(resolve => {
    reader.readEntries(async entries => {
      for (const e of entries) {
        if (e.isFile) await new Promise(r => e.file(f => { files.push(f); r(); }));
        else if (e.isDirectory) await readDir(e, files);
      }
      resolve();
    });
  });
}

// ===== BACKGROUND ANIMATION =====
function initBackground() {
  const canvas = document.getElementById("bg-canvas");
  const ctx = canvas.getContext("2d");
  let w, h;

  const resize = () => {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  };
  resize();
  window.addEventListener("resize", resize);

  const dots = Array.from({ length: 55 }, () => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    vx: (Math.random() - 0.5) * 0.4,
    vy: (Math.random() - 0.5) * 0.4,
    r: Math.random() * 1.8 + 0.5,
  }));

  function draw() {
    ctx.clearRect(0, 0, w, h);
    const dark = document.documentElement.getAttribute("data-theme") !== "light";
    const dotClr = dark ? "rgba(108,99,255,0.7)" : "rgba(108,99,255,0.35)";
    const lineClr = dark ? "rgba(108,99,255,0.07)" : "rgba(108,99,255,0.05)";

    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      d.x += d.vx;
      d.y += d.vy;
      if (d.x < 0 || d.x > w) d.vx *= -1;
      if (d.y < 0 || d.y > h) d.vy *= -1;

      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = dotClr;
      ctx.fill();

      for (let j = i + 1; j < dots.length; j++) {
        const q = dots[j];
        const dx = d.x - q.x;
        const dy = d.y - q.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 140) {
          ctx.beginPath();
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = lineClr;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
}
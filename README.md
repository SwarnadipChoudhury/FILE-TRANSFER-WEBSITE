# Smart Local Share P2P

A production-ready, serverless peer-to-peer file transfer app using **WebRTC DataChannels**.  
No backend. No database. No Node.js. Just open `index.html`.

---

## 📁 Folder Structure

```
SmartLocalShare/
├── index.html   ← App shell + UI markup
├── style.css    ← Dark industrial theme + responsive layout
├── app.js       ← All WebRTC + transfer logic (commented)
└── README.md    ← This file
```

---

## 🚀 Quick Start (Local)

1. Download or clone the folder.
2. Open `index.html` in any modern browser (Chrome, Firefox, Edge, Safari).
3. On the second device, open the same `index.html` (or host it — see below).

**No build step. No `npm install`. No server.**

---

## 🔗 How WebRTC Signaling Works Here

Standard WebRTC requires a **signaling channel** to exchange session metadata before establishing a direct connection. Most apps use a WebSocket server. We eliminate that with manual copy-paste / QR:

```
Sender Device                        Receiver Device
──────────────                       ───────────────
createOffer()
  │ (wait for ICE gathering)
  ▼
Encode SDP → Base64
Show as QR / text ────── share ────► Paste offer code
                                     setRemoteDescription(offer)
                                     createAnswer()
                                       │ (wait for ICE gathering)
                                       ▼
                                     Encode SDP → Base64
                         ◄── share ── Show answer text
Paste answer code
setRemoteDescription(answer)
       │
       ▼
  ICE / DTLS handshake (automatic, via STUN)
       │
       ▼
  ✅ Direct P2P DataChannel open
  File chunks stream sender → receiver
```

**Key points:**
- ICE candidates are embedded in the SDP (trickle-less) — only **one** offer/answer exchange needed.
- STUN servers discover public IPs so the connection works across different networks.
- The entire "signaling" is just two Base64 strings — no server needed.

---

## 📦 File Transfer Protocol

| Step | What happens |
|------|-------------|
| 1 | Sender sends a JSON `meta` message: `{ type, name, size, fileType, totalChunks }` |
| 2 | Sender reads the file via `ReadableStream` in 64 KB chunks |
| 3 | Each chunk is sent as an `ArrayBuffer` over the DataChannel |
| 4 | Backpressure: if `bufferedAmount > 4 MB`, sending pauses until `bufferedamountlow` fires |
| 5 | Receiver collects chunks in memory (`rxChunks[]`) and tracks progress |
| 6 | When `rxReceived >= meta.size`, chunks are assembled into a `Blob` and downloaded |
| 7 | Process repeats for the next file in the queue |

---

## 🌐 Hosting on GitHub Pages

1. Create a GitHub repository (e.g. `smart-local-share`).
2. Push all three files (`index.html`, `style.css`, `app.js`) to the `main` branch.
3. Go to **Settings → Pages → Source → Deploy from branch → main / root**.
4. Your app will be live at `https://yourusername.github.io/smart-local-share/`.

Both devices just open that URL — no installation needed.

---

## 🌐 Hosting on Netlify

**Option A — Drag & drop:**
1. Go to [netlify.com](https://netlify.com) and sign in.
2. Drag the `SmartLocalShare/` folder onto the Netlify dashboard.
3. Done — you get a live HTTPS URL instantly.

**Option B — Git deploy:**
1. Push to GitHub (see above).
2. In Netlify → **Add new site → Import from Git** → select your repo.
3. Leave build settings blank (no build command needed).
4. Deploy.

---

## 🔒 Security Notes

- **No data is sent to any server** — all bytes travel directly between the two browsers.
- The signaling strings (offer/answer) contain only connection metadata (IP, port, codec info) — no file data.
- Files are never written to disk on the sender side — they stream directly from the File API.
- Received files exist only in memory until the user saves them via the browser download.

---

## 🧪 Browser Compatibility

| Browser | Desktop | Mobile |
|---------|---------|--------|
| Chrome 90+ | ✅ | ✅ |
| Firefox 90+ | ✅ | ✅ |
| Edge 90+ | ✅ | ✅ |
| Safari 15+ | ✅ | ✅ |

---

## ⚙️ Configuration (in `app.js`)

| Constant | Default | Description |
|----------|---------|-------------|
| `CHUNK_SIZE` | 64 KB | Size of each DataChannel chunk |
| `BUFFER_HIGH` | 4 MB | Pause sending above this bufferedAmount |
| `BUFFER_LOW` | 512 KB | Resume sending below this bufferedAmount |
| `ICE_SERVERS` | Google + Cloudflare STUN | NAT traversal servers |

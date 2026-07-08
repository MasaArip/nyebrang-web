(() => {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    // Free shared TURN (Open Relay Project / Metered.ca) — rate-limited demo credentials.
    // Ganti dengan API key gratis dari metered.ca kalau butuh lebih reliable.
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  const CHUNK_SIZE = 16 * 1024;
  const BUFFERED_THRESHOLD = 1 * 1024 * 1024; // pause sending above 1MB queued

  // ---------- state ----------
  let ws = null;
  let selfId = null;
  let selfName = localStorage.getItem('nyebrang_name') || '';
  let selfDeviceType = detectDeviceType();
  let room = null;
  const peers = new Map();       // id -> { name, deviceType, pc, dc, el }
  const sendQueues = new Map();  // id -> array of File
  const transfers = new Map();   // transferId -> row element + meta

  // ---------- wake lock (cegah layar mati saat transfer) ----------
  let wakeLock = null;
  let activeTransferCount = 0;

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* diabaikan */ }
  }
  function releaseWakeLockIfIdle() {
    if (activeTransferCount <= 0 && wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && activeTransferCount > 0) acquireWakeLock();
  });
  function transferStarted() {
    activeTransferCount++;
    acquireWakeLock();
  }
  function transferEnded() {
    activeTransferCount = Math.max(0, activeTransferCount - 1);
    releaseWakeLockIfIdle();
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const nameModal = $('nameModal');
  const nameInput = $('nameInput');
  const nameSubmit = $('nameSubmit');
  const roomCodeEl = $('roomCode');
  const copyLinkBtn = $('copyLink');
  const qrBtn = $('qrBtn');
  const qrModal = $('qrModal');
  const qrClose = $('qrClose');
  const qrCanvas = $('qrCanvas');
  const radar = $('radar');
  const radarCaption = $('radarCaption');
  const dropzone = $('dropzone');
  const fileInput = $('fileInput');
  const browseBtn = $('browseBtn');
  const peersList = $('peersList');
  const transfersPanel = $('transfersPanel');
  const transfersList = $('transfersList');
  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const targetModal = $('targetModal');
  const targetList = $('targetList');
  const targetCancel = $('targetCancel');
  const selfNode = $('selfNode');
  const selfInitial = $('selfInitial');

  function detectDeviceType() {
    const ua = navigator.userAgent;
    if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Macintosh/.test(ua)) return 'Mac';
    return 'Device';
  }

  function deviceIcon(type) {
    return { iPad: '📱', iPhone: '📱', Android: '🤖', Windows: '🖥️', Mac: '💻' }[type] || '💻';
  }

  function initRoom() {
    const params = new URLSearchParams(location.search);
    let r = params.get('room');
    if (!r) {
      r = Math.random().toString(36).slice(2, 8);
      params.set('room', r);
      history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
    }
    room = r;
    roomCodeEl.textContent = room;
  }

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      statusDot.classList.add('online');
      statusText.textContent = 'Terhubung ke ruang ' + room;
      ws.send(JSON.stringify({ type: 'join', room, name: selfName, deviceType: selfDeviceType }));
    };

    ws.onclose = () => {
      statusDot.classList.remove('online');
      statusText.textContent = 'Terputus, mencoba lagi…';
      setTimeout(connectWS, 2000);
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'joined') {
        selfId = msg.selfId;
        selfInitial.textContent = (selfName || '•').slice(0, 1).toUpperCase();
        msg.peers.forEach((p) => addPeer(p, false));
        layoutPeerNodes();
      } else if (msg.type === 'peer-joined') {
        addPeer(msg.peer, true);
        layoutPeerNodes();
      } else if (msg.type === 'peer-left') {
        removePeer(msg.id);
      } else if (msg.type === 'signal') {
        handleSignal(msg.from, msg.data);
      }
    };
  }

  // ---------- peers UI ----------
  function addPeer(p, maybeInitiate) {
    if (peers.has(p.id)) return;
    peers.set(p.id, { name: p.name, deviceType: p.deviceType, pc: null, dc: null });
    renderPeersList();
    createPeerConnection(p.id, selfId < p.id);
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (peer && peer.pc) peer.pc.close();
    peers.delete(id);
    renderPeersList();
    layoutPeerNodes();
  }

  function renderPeersList() {
    peersList.innerHTML = '';
    if (peers.size === 0) {
      peersList.innerHTML = '<li class="peers-empty">Belum ada device lain. Bagikan link/QR di atas.</li>';
      return;
    }
    for (const [id, p] of peers.entries()) {
      const li = document.createElement('li');
      li.className = 'peer-row';
      li.innerHTML = `<span class="peer-name">${deviceIcon(p.deviceType)} ${escapeHtml(p.name)}</span>
                      <span class="peer-meta">${p.dc && p.dc.readyState === 'open' ? 'siap' : 'menyambung…'}</span>`;
      li.onclick = () => pickFilesFor(id);
      peersList.appendChild(li);
    }
  }

  function layoutPeerNodes() {
    radar.querySelectorAll('.peer-node').forEach((n) => n.remove());
    const ids = Array.from(peers.keys());
    radarCaption.textContent = ids.length === 0
      ? 'Menunggu device lain gabung ke ruang ini…'
      : `${ids.length} device terhubung — tap ikon buat kirim file`;
    const radius = 100;
    ids.forEach((id, i) => {
      const angle = (i / ids.length) * 2 * Math.PI - Math.PI / 2;
      const x = 130 + radius * Math.cos(angle) - 22;
      const y = 130 + radius * Math.sin(angle) - 22;
      const p = peers.get(id);
      const node = document.createElement('div');
      node.className = 'peer-node';
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.textContent = deviceIcon(p.deviceType);
      node.title = p.name;
      node.dataset.peerId = id;
      node.onclick = () => pickFilesFor(id);
      node.ondragover = (e) => { e.preventDefault(); node.classList.add('dropping'); };
      node.ondragleave = () => node.classList.remove('dropping');
      node.ondrop = (e) => {
        e.preventDefault();
        node.classList.remove('dropping');
        if (e.dataTransfer.files.length) queueFiles(id, e.dataTransfer.files);
      };
      radar.appendChild(node);
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- WebRTC ----------
  function createPeerConnection(id, initiate) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = peers.get(id);
    peer.pc = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(id, { kind: 'candidate', candidate: e.candidate });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
        failActiveTransfersFor(id);
        renderPeersList();
      }
    };

    if (initiate) {
      const dc = pc.createDataChannel('file');
      setupDataChannel(id, dc);
      pc.onnegotiationneeded = async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(id, { kind: 'offer', sdp: pc.localDescription });
      };
    } else {
      pc.ondatachannel = (e) => setupDataChannel(id, e.channel);
    }
  }

  async function handleSignal(fromId, data) {
    const peer = peers.get(fromId);
    if (!peer || !peer.pc) return;
    const pc = peer.pc;
    if (data.kind === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(fromId, { kind: 'answer', sdp: pc.localDescription });
    } else if (data.kind === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.kind === 'candidate') {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
    }
  }

  function sendSignal(to, data) {
    ws.send(JSON.stringify({ type: 'signal', to, data }));
  }

  function setupDataChannel(id, dc) {
    dc.binaryType = 'arraybuffer';
    const peer = peers.get(id);
    peer.dc = dc;
    dc.bufferedAmountLowThreshold = 256 * 1024;

    dc.onopen = () => renderPeersList();
    dc.onclose = () => renderPeersList();

    peer.activeSends = peer.activeSends || new Set();

    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'meta') {
          peer.incoming = { id: msg.id, name: msg.name, size: msg.size, mime: msg.mime, received: 0, chunks: [] };
          peer.incoming.rowEl = createTransferRow(msg.id, msg.name, msg.size, false);
          transferStarted();
        } else if (msg.type === 'done' && peer.incoming) {
          const blob = new Blob(peer.incoming.chunks, { type: peer.incoming.mime || 'application/octet-stream' });
          finishTransferRow(peer.incoming.rowEl, blob, peer.incoming.name);
          peer.incoming = null;
          transferEnded();
        }
      } else if (peer.incoming) {
        peer.incoming.chunks.push(ev.data);
        peer.incoming.received += ev.data.byteLength;
        updateTransferProgress(peer.incoming.rowEl, peer.incoming.received, peer.incoming.size);
      }
    };
  }

  function markRowFailed(rowEl) {
    if (!rowEl || rowEl.classList.contains('done')) return;
    rowEl.classList.add('done');
    const actions = rowEl.querySelector('.transfer-actions');
    if (actions) actions.innerHTML = '<span style="color:#F26D6D;font-family:var(--mono);font-size:0.75rem;">terputus — coba kirim ulang</span>';
  }

  function failActiveTransfersFor(id) {
    const peer = peers.get(id);
    if (!peer) return;
    if (peer.incoming) {
      markRowFailed(peer.incoming.rowEl);
      peer.incoming = null;
      transferEnded();
    }
    if (peer.activeSends) {
      peer.activeSends.forEach((rowEl) => { markRowFailed(rowEl); transferEnded(); });
      peer.activeSends.clear();
    }
  }

  // ---------- file sending ----------
  function pickFilesFor(peerId) {
    const peer = peers.get(peerId);
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') {
      alert('Belum tersambung ke device itu, tunggu sebentar lalu coba lagi.');
      return;
    }
    fileInput.onchange = () => {
      if (fileInput.files.length) queueFiles(peerId, fileInput.files);
      fileInput.value = '';
    };
    fileInput.click();
  }

  function chooseTargetThen(files) {
    const openPeers = Array.from(peers.entries()).filter(([, p]) => p.dc && p.dc.readyState === 'open');
    if (openPeers.length === 0) {
      alert('Belum ada device yang tersambung.');
      return;
    }
    if (openPeers.length === 1) {
      queueFiles(openPeers[0][0], files);
      return;
    }
    targetList.innerHTML = '';
    openPeers.forEach(([id, p]) => {
      const li = document.createElement('li');
      li.className = 'target-row';
      li.innerHTML = `<span class="peer-name">${deviceIcon(p.deviceType)} ${escapeHtml(p.name)}</span>`;
      li.onclick = () => { targetModal.hidden = true; queueFiles(id, files); };
      targetList.appendChild(li);
    });
    targetModal.hidden = false;
  }

  async function queueFiles(peerId, fileList) {
    const peer = peers.get(peerId);
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') return;
    for (const file of Array.from(fileList)) {
      await sendFile(peerId, peer.dc, file);
    }
  }

  function sendFile(peerId, dc, file) {
    return new Promise((resolve) => {
      const peer = peers.get(peerId);
      const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
      const rowEl = createTransferRow(id, file.name, file.size, true);
      transferStarted();
      if (peer) { peer.activeSends = peer.activeSends || new Set(); peer.activeSends.add(rowEl); }

      let settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        if (peer && peer.activeSends) peer.activeSends.delete(rowEl);
        transferEnded();
        resolve();
      }

      dc.send(JSON.stringify({ type: 'meta', id, name: file.name, size: file.size, mime: file.type }));

      const reader = file.stream().getReader();
      let sent = 0;

      function sendNext() {
        if (dc.readyState !== 'open') { markRowFailed(rowEl); finish(); return; }
        reader.read().then(({ done, value }) => {
          if (dc.readyState !== 'open') { markRowFailed(rowEl); finish(); return; }
          if (done) {
            dc.send(JSON.stringify({ type: 'done', id }));
            markRowSentDone(rowEl);
            finish();
            return;
          }
          pushChunks(value, 0);
        }).catch(() => { markRowFailed(rowEl); finish(); });
      }

      function pushChunks(buf, offset) {
        while (offset < buf.byteLength) {
          if (dc.readyState !== 'open') { markRowFailed(rowEl); finish(); return; }
          const slice = buf.slice(offset, offset + CHUNK_SIZE);
          if (dc.bufferedAmount > BUFFERED_THRESHOLD) {
            dc.onbufferedamountlow = () => {
              dc.onbufferedamountlow = null;
              pushChunks(buf, offset);
            };
            return;
          }
          dc.send(slice);
          sent += slice.byteLength;
          offset += CHUNK_SIZE;
          updateTransferProgress(rowEl, sent, file.size);
        }
        sendNext();
      }

      sendNext();
    });
  }

  // ---------- transfer rows ----------
  function createTransferRow(id, name, size, isSend) {
    transfersPanel.hidden = false;
    const li = document.createElement('li');
    li.className = 'transfer-row';
    li.innerHTML = `
      <div class="transfer-top">
        <span class="transfer-name">${isSend ? '↑' : '↓'} ${escapeHtml(name)}</span>
        <span class="transfer-size">${formatSize(size)}</span>
      </div>
      <div class="bar-track"><div class="bar-fill"></div></div>
      <div class="transfer-actions"></div>
    `;
    transfersList.prepend(li);
    return li;
  }

  function updateTransferProgress(rowEl, done, total) {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    rowEl.querySelector('.bar-fill').style.width = pct + '%';
  }

  function markRowSentDone(rowEl) {
    rowEl.classList.add('done');
    rowEl.querySelector('.bar-fill').style.width = '100%';
  }

  function finishTransferRow(rowEl, blob, name) {
    rowEl.classList.add('done');
    rowEl.querySelector('.bar-fill').style.width = '100%';
    const url = URL.createObjectURL(blob);
    const actions = rowEl.querySelector('.transfer-actions');
    actions.innerHTML = `<a href="${url}" download="${escapeHtml(name)}">Simpan</a>`;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---------- dropzone / file input wiring ----------
  browseBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => {
    if (fileInput.files.length) chooseTargetThen(fileInput.files);
    fileInput.value = '';
  };

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('drag-over'); });
  });
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length) chooseTargetThen(e.dataTransfer.files);
  });

  // ---------- name modal ----------
  function openNameModal() {
    nameInput.value = selfName;
    nameModal.hidden = false;
    nameModal.style.display = 'flex';
    setTimeout(() => nameInput.focus(), 50);
  }
  function closeNameModal() {
    nameModal.style.display = 'none';
  }
  nameSubmit.onclick = () => {
    const v = nameInput.value.trim();
    selfName = v || (selfDeviceType + '-' + Math.floor(Math.random() * 900 + 100));
    localStorage.setItem('nyebrang_name', selfName);
    closeNameModal();
    boot();
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameSubmit.click(); });

  // ---------- qr modal ----------
  qrBtn.onclick = () => {
    qrModal.hidden = false;
    qrCanvas.innerHTML = '';
    const canvas = document.createElement('canvas');
    QRCode.toCanvas(canvas, location.href, { width: 220, margin: 1 }, (err) => {
      if (!err) {
        qrCanvas.appendChild(canvas);
      } else {
        qrCanvas.innerHTML = '<p style="color:#8A95A6;font-size:0.8rem;">QR gagal dibuat, pakai Salin Link saja.</p>';
        console.error('QR error', err);
      }
    });
  };
  qrClose.onclick = () => { qrModal.hidden = true; };

  copyLinkBtn.onclick = () => {
    navigator.clipboard.writeText(location.href).then(() => {
      copyLinkBtn.textContent = 'Tersalin!';
      setTimeout(() => (copyLinkBtn.textContent = 'Salin link'), 1500);
    });
  };

  targetCancel.onclick = () => { targetModal.hidden = true; };

  // ---------- boot ----------
  function boot() {
    initRoom();
    connectWS();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  if (!selfName) {
    openNameModal();
  } else {
    closeNameModal();
    boot();
  }
})();

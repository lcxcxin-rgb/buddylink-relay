// BuddyLink v1.1.0 - 主应用 JavaScript

// 状态
let ws = null;
let deviceId = null;
let pairCode = null;
let pairCodeExpiry = null;
let isPaired = false;
let sharedSecret = null;
let partnerId = null;
let partnerPublicKey = null;
let myPublicKey = null;
let partnerStatus = 'unknown';
let serverUrl = 'wss://buddylink-relay-2.onrender.com';
let heartbeatInterval = null;
let pairCodeTimerInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
let myName = null;
let myAvatar = null;
let partnerName = null;
let partnerAvatar = null;
let unreadCount = 0;
let isMiniMode = false;

// Tauri API
const tauriApi = window.__TAURI__;

// ========== 初始化 ==========

async function init() {
  if (tauriApi) {
    try {
      serverUrl = await tauriApi.core.invoke('get_server_url');
      const state = await tauriApi.core.invoke('get_app_state');
      isPaired = state.is_paired;
      partnerStatus = state.partner_status;
      deviceId = state.device_id;
      myName = state.my_name;
      myAvatar = state.my_avatar;
      partnerName = state.partner_name;
      partnerAvatar = state.partner_avatar;

      // Update UI with stored profile
      if (myName) document.getElementById('my-name-input').value = myName;
      if (myAvatar) updateMyAvatarDisplay(myAvatar);
      // Always show partner name in paired view - even "对方" is better than blank
      if (partnerName) {
        document.getElementById('partner-name').textContent = partnerName;
      }
      if (partnerAvatar) updatePartnerAvatarDisplay(partnerAvatar);

      if (isPaired) {
        showPairedView();
        loadMessageHistory();
        // Send read receipt for any unread received messages after loading history
        setTimeout(() => sendReadReceiptForLatestMessages(), 1000);
      }
    } catch (e) {
      console.log('Tauri context not ready, using browser mode');
    }
  }

  // 连接 WebSocket
  connectWebSocket();
}

// ========== WebSocket ==========

function connectWebSocket() {
  updateConnectionStatus('连接中...');

  try {
    ws = new WebSocket(serverUrl);

    ws.onopen = () => {
      updateConnectionStatus('已连接', true);
      reconnectAttempts = 0;
      startHeartbeat();

      // Immediately send reconnect with persistent UUID
      sendReconnect();
    };

    ws.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data));
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };

    ws.onclose = () => {
      updateConnectionStatus('已断开', false);
      stopHeartbeat();
      if (reconnectAttempts < MAX_RECONNECT) {
        reconnectAttempts++;
        setTimeout(() => connectWebSocket(), 3000);
      } else {
        updateConnectionStatus('连接失败，请检查服务器', false);
      }
    };

    ws.onerror = () => {
      updateConnectionStatus('连接出错', false);
    };
  } catch (e) {
    updateConnectionStatus('无法连接', false);
  }
}

function sendReconnect() {
  if (tauriApi) {
    tauriApi.core.invoke('get_reconnect_info').then(info => {
      ws.send(JSON.stringify(info));
      console.log('Sent reconnect with persistentUUID:', info.persistentUUID);
    });
  }
}

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat', deviceId }));
    }
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// ========== 消息处理 ==========

function handleMessage(msg) {
  switch (msg.type) {
    case 'assigned_id':
      // This is the temporary ID - we'll replace it after reconnect
      if (!deviceId) {
        deviceId = msg.deviceId;
        if (tauriApi) tauriApi.core.invoke('update_device_id', { id: deviceId });
      }
      break;

    case 'reconnect_ack':
      deviceId = msg.deviceId;

      // IMPORTANT: Don't override local isPaired with server's false value.
      // Server may have restarted and lost pairing state, but our local DB still has it.
      // Only upgrade isPaired to true if server confirms it.
      if (msg.isPaired) {
        isPaired = true;
      }
      // If server says false but we already know we're paired (from local DB),
      // keep our local state - the server will catch up when partner also reconnects.

      // Update partnerId from server if provided
      if (msg.partnerId) {
        partnerId = msg.partnerId;
      }

      // Update partner name/avatar from server if provided
      // (Server sends partner's current info when partner is online)
      if (msg.partnerName) {
        partnerName = msg.partnerName;
        document.getElementById('partner-name').textContent = partnerName;
        if (tauriApi) tauriApi.core.invoke('set_partner_name', { name: partnerName });
      }
      if (msg.partnerAvatar) {
        partnerAvatar = msg.partnerAvatar;
        updatePartnerAvatarDisplay(partnerAvatar);
        if (tauriApi) tauriApi.core.invoke('set_partner_icon', { iconPath: partnerAvatar });
      }

      // If we're paired (from local DB state), ensure paired view is shown
      if (isPaired) {
        showPairedView();
        loadMessageHistory();
        setTimeout(() => sendReadReceiptForLatestMessages(), 1000);
      }

      // Notify Rust about reconnect result (using our local isPaired, not server's)
      if (tauriApi) tauriApi.core.invoke('handle_reconnect_result', {
        deviceId: msg.deviceId,
        isPaired: isPaired,
        partnerId: partnerId || msg.partnerId || null,
      });

      console.log('Reconnect confirmed, paired:', isPaired);
      break;

    case 'pair_code':
      pairCode = msg.code;
      pairCodeExpiry = msg.expiresAt || (Date.now() + 300000);
      document.getElementById('pair-code-display').textContent = pairCode;
      document.getElementById('pair-code-area').classList.remove('hidden');
      document.getElementById('join-pair-area').classList.add('hidden');
      startPairCodeTimer();
      break;

    case 'paired':
      partnerId = msg.partnerId;
      partnerPublicKey = msg.partnerPublicKey;
      partnerName = msg.partnerName || null;
      partnerAvatar = msg.partnerAvatar || null;
      isPaired = true;

      if (tauriApi) {
        tauriApi.core.invoke('handle_pairing_result', {
          partnerId: partnerId,
          partnerPublicKey: partnerPublicKey,
          partnerName: partnerName,
          partnerAvatar: partnerAvatar,
        });
      }

      // Update partner name/avatar display
      if (partnerName) document.getElementById('partner-name').textContent = partnerName;
      if (partnerAvatar) updatePartnerAvatarDisplay(partnerAvatar);

      showPairedView();
      hidePairCodeAreas();
      showToast('配对成功！');
      break;

    case 'pair_error':
      showToast(msg.error || '配对失败');
      break;

    case 'message':
      decryptAndDisplay(msg);
      unreadCount++;
      updateUnreadBadge();
      break;

    case 'poke':
      showPokeAnimation();
      break;

    case 'read_receipt':
      // Partner has read our messages
      if (tauriApi && msg.messageIds) {
        tauriApi.core.invoke('handle_read_receipt', { messageIds: msg.messageIds });
      }
      // Update UI to show read status on messages
      markMessagesAsReadInUI(msg.messageIds);
      break;

    case 'presence':
      updatePartnerStatus(msg.status);
      break;

    case 'profile_update':
      // Partner updated their name or avatar
      if (msg.name) {
        partnerName = msg.name;
        document.getElementById('partner-name').textContent = partnerName;
      }
      if (msg.avatar) {
        partnerAvatar = msg.avatar;
        updatePartnerAvatarDisplay(partnerAvatar);
      }
      if (tauriApi) tauriApi.core.invoke('handle_profile_update', {
        name: msg.name || null,
        avatar: msg.avatar || null,
      });
      showToast('对方更新了资料');
      break;

    case 'unpaired':
      isPaired = false;
      partnerId = null;
      partnerPublicKey = null;
      partnerName = null;
      partnerAvatar = null;
      showNotPairedView();
      if (tauriApi) tauriApi.core.invoke('unpair');
      showToast('对方已取消配对');
      break;

    case 'relay_status':
      if (msg.status === 'delivered') {
        // Message delivered to partner (but not necessarily read)
        updateLastSentMessageStatus('delivered');
      } else if (msg.status === 'partner_offline') {
        showToast('对方当前离线');
      }
      break;
  }
}

// ========== 配对 ==========

function createPairCode() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('未连接服务器');
    return;
  }

  // Save nickname first
  saveNickname();

  if (tauriApi) {
    tauriApi.core.invoke('create_pair').then(msg => {
      myPublicKey = msg.publicKey;
      ws.send(JSON.stringify(msg));
    });
  } else {
    myPublicKey = 'SIM_PK_' + Math.random().toString(36).substring(2, 8);
    ws.send(JSON.stringify({
      type: 'create_pair',
      deviceId: deviceId || '',
      publicKey: myPublicKey,
      name: myName,
      avatar: myAvatar,
    }));
  }
}

function showJoinPair() {
  document.getElementById('join-pair-area').classList.remove('hidden');
  document.getElementById('pair-code-area').classList.add('hidden');
  setTimeout(() => document.getElementById('join-code-input').focus(), 100);
}

function hideJoinPair() {
  document.getElementById('join-pair-area').classList.add('hidden');
}

function joinPair() {
  const code = document.getElementById('join-code-input').value.toUpperCase().trim();
  if (!code || code.length !== 6) {
    showToast('请输入6位配对码');
    return;
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('未连接服务器');
    return;
  }

  // Save nickname first
  saveNickname();

  if (tauriApi) {
    tauriApi.core.invoke('join_pair', { code }).then(msg => {
      myPublicKey = msg.publicKey;
      ws.send(JSON.stringify(msg));
    });
  } else {
    myPublicKey = 'SIM_PK_' + Math.random().toString(36).substring(2, 8);
    ws.send(JSON.stringify({
      type: 'join_pair',
      deviceId: deviceId || '',
      code,
      publicKey: myPublicKey,
      name: myName,
      avatar: myAvatar,
    }));
  }
}

function copyPairCode() {
  if (!pairCode) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(pairCode).then(() => showToast('已复制配对码'));
  } else {
    const tmp = document.createElement('textarea');
    tmp.value = pairCode;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
    showToast('已复制配对码');
  }
}

function startPairCodeTimer() {
  if (pairCodeTimerInterval) clearInterval(pairCodeTimerInterval);
  const timerEl = document.getElementById('pair-code-timer');

  pairCodeTimerInterval = setInterval(() => {
    if (!pairCodeExpiry) return;
    const remaining = Math.max(0, pairCodeExpiry - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')} 后过期`;

    if (remaining <= 0) {
      timerEl.textContent = '配对码已过期';
      clearInterval(pairCodeTimerInterval);
      pairCode = null;
    }
  }, 1000);
}

// ========== 消息发送 ==========

function sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content) return;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('未连接服务器');
    return;
  }

  if (tauriApi) {
    tauriApi.core.invoke('send_encrypted_message', { content }).then(msg => {
      ws.send(JSON.stringify(msg));
      input.value = '';
      input.style.height = 'auto';
      appendMessage('sent', content, msg.messageId, false);
    });
  } else {
    ws.send(JSON.stringify({
      type: 'message', from: deviceId, to: partnerId,
      nonce: 'sim', ciphertext: content, timestamp: Date.now()
    }));
    input.value = '';
    input.style.height = 'auto';
    appendMessage('sent', content);
  }
}

function sendPoke() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('未连接服务器');
    return;
  }

  if (tauriApi) {
    tauriApi.core.invoke('send_poke').then(msg => {
      ws.send(JSON.stringify(msg));
      showToast('戳了对方一下');
    });
  } else {
    ws.send(JSON.stringify({
      type: 'poke', from: deviceId, to: partnerId,
      nonce: 'sim', ciphertext: 'poke', timestamp: Date.now()
    }));
    showToast('戳了对方一下');
  }
}

async function decryptAndDisplay(msg) {
  if (tauriApi) {
    const content = await tauriApi.core.invoke('decrypt_received_message', {
      nonce: msg.nonce, ciphertext: msg.ciphertext
    });

    // Mark as read when user views the message
    appendMessage('received', content);
    if (content === 'poke') {
      showPokeAnimation();
    }

    // Send read receipt for this message
    sendReadReceiptForLatestMessages();
  } else {
    appendMessage('received', msg.ciphertext);
  }
}

// ========== 已读回执 ==========

let lastReceivedMessageIds = [];

function sendReadReceiptForLatestMessages() {
  // Collect unread received message IDs
  const unreadItems = document.querySelectorAll('.message-item.received.unread');
  const ids = [];
  unreadItems.forEach(item => {
    const id = item.dataset.messageId;
    if (id) ids.push(parseInt(id));
    item.classList.remove('unread');
    item.classList.add('read');
  });

  if (ids.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
    if (tauriApi) {
      tauriApi.core.invoke('send_read_receipt', { messageIds: ids }).then(msg => {
        ws.send(JSON.stringify(msg));
      });
    }
  }
}

function markMessagesAsReadInUI(messageIds) {
  if (!messageIds) return;
  messageIds.forEach(id => {
    const item = document.querySelector(`.message-item.sent[data-message-id="${id}"]`);
    if (item) {
      item.classList.add('partner-read');
      const statusEl = item.querySelector('.msg-read-status');
      if (statusEl) statusEl.textContent = '已读';
    }
  });
}

function updateLastSentMessageStatus(status) {
  const sentItems = document.querySelectorAll('.message-item.sent');
  const lastSent = sentItems[sentItems.length - 1];
  if (lastSent) {
    const statusEl = lastSent.querySelector('.msg-read-status');
    if (statusEl && status === 'delivered') {
      statusEl.textContent = '已送达';
    }
  }
}

// ========== 消息渲染 ==========

function appendMessage(direction, content, messageId = null, isRead = false) {
  const list = document.getElementById('message-list');
  const item = document.createElement('div');
  item.className = `message-item ${direction}`;
  if (messageId) item.dataset.messageId = messageId;

  const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  if (content === 'poke') {
    item.innerHTML = `
      <div class="msg-content" style="display:flex;align-items:center;gap:4px">
        <svg width="14" height="14" viewBox="0 0 24 24"><path d="M7 11C7 9 9 7 12 7C15 7 17 9 17 11" stroke="#BA7517" stroke-width="2" fill="none"/><circle cx="9" cy="14" r="1.5" fill="#BA7517"/><circle cx="15" cy="14" r="1.5" fill="#BA7517"/></svg>
        戳了你一下
      </div>
      <div class="msg-time">${timeStr}</div>
    `;
  } else {
    let readStatusHtml = '';
    if (direction === 'sent') {
      readStatusHtml = `<span class="msg-read-status">${isRead ? '已读' : '未读'}</span>`;
      if (isRead) item.classList.add('partner-read');
    } else {
      if (!isRead) {
        item.classList.add('unread');
      }
    }
    item.innerHTML = `<div class="msg-content">${content}</div><div class="msg-meta"><span class="msg-time">${timeStr}</span>${readStatusHtml}</div>`;
  }

  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
}

async function loadMessageHistory() {
  if (tauriApi) {
    try {
      const messages = await tauriApi.core.invoke('get_message_history', { limit: 50 });
      const list = document.getElementById('message-list');
      list.innerHTML = '';
      messages.reverse().forEach(msg => {
        appendMessage(msg.direction, msg.content, msg.id, msg.read);
      });
    } catch (e) {
      console.error('Failed to load history:', e);
    }
  }
}

// ========== 戳一戳动画 ==========

function showPokeAnimation() {
  const overlay = document.getElementById('poke-overlay');
  overlay.classList.remove('hidden');
  setTimeout(() => overlay.classList.add('hidden'), 2000);
}

// ========== 状态更新 ==========

function updatePartnerStatus(status) {
  partnerStatus = status;
  const indicator = document.getElementById('partner-status-indicator');
  const dot = indicator.querySelector('.status-dot');
  const text = indicator.querySelector('.status-text');

  dot.className = 'status-dot ' + status;
  const labels = { online: '在线', offline: '离线', away: '离开', unknown: '未知' };
  text.textContent = labels[status] || status;

  if (tauriApi) tauriApi.core.invoke('update_partner_status', { status });
}

function updateConnectionStatus(text, connected) {
  const bar = document.getElementById('connection-bar');
  const span = document.getElementById('connection-status');
  span.textContent = text;
  bar.className = connected ? 'connected' : 'disconnected';
}

// ========== 视图切换 ==========

function showPairedView() {
  document.getElementById('not-paired').classList.remove('active');
  document.getElementById('not-paired').style.display = 'none';
  document.getElementById('paired').classList.add('active');
  document.getElementById('paired').style.display = 'flex';
}

function showNotPairedView() {
  document.getElementById('paired').classList.remove('active');
  document.getElementById('paired').style.display = 'none';
  document.getElementById('not-paired').classList.add('active');
  document.getElementById('not-paired').style.display = 'flex';
}

function hidePairCodeAreas() {
  document.getElementById('pair-code-area').classList.add('hidden');
  document.getElementById('join-pair-area').classList.add('hidden');
  if (pairCodeTimerInterval) clearInterval(pairCodeTimerInterval);
}

// ========== 头像管理 ==========

function updateMyAvatarDisplay(avatarData) {
  const display = document.getElementById('my-icon-display');
  if (avatarData) {
    // Check if it's base64 image data or a JSON icon spec
    if (avatarData.startsWith('data:image') || avatarData.startsWith('{')) {
      if (avatarData.startsWith('data:image')) {
        display.innerHTML = `<img src="${avatarData}" width="64" height="64" style="border-radius:50%;object-fit:cover">`;
      } else {
        // JSON icon spec (legacy format)
        try {
          const iconData = JSON.parse(avatarData);
          display.innerHTML = `
            <svg width="64" height="64" viewBox="0 0 64 64">
              <defs><filter id="iconShadow2" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.15"/></filter></defs>
              <circle cx="32" cy="32" r="30" fill="${iconData.bg}" stroke="${iconData.stroke}" stroke-width="2" filter="url(#iconShadow2)"/>
              <text x="32" y="36" text-anchor="middle" font-size="22" font-weight="600" fill="${iconData.stroke}">${iconData.label}</text>
            </svg>`;
        } catch (e) { console.error('Invalid icon data:', e); }
      }
    } else {
      // Raw base64 without data:image prefix - add it
      display.innerHTML = `<img src="data:image/png;base64,${avatarData}" width="64" height="64" style="border-radius:50%;object-fit:cover">`;
    }
  }
}

function updatePartnerAvatarDisplay(avatarData) {
  const display = document.getElementById('partner-icon-display');
  if (!avatarData) {
    // Show default placeholder with first letter of partner name
    const initial = partnerName ? partnerName.charAt(0).toUpperCase() : '?';
    display.innerHTML = `
      <svg width="44" height="44" viewBox="0 0 44 44">
        <defs><filter id="partnerShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="2" flood-opacity="0.12"/></filter></defs>
        <circle cx="22" cy="22" r="20" fill="#CECBF6" stroke="#534AB7" stroke-width="2" filter="url(#partnerShadow)"/>
        <text x="22" y="26" text-anchor="middle" font-size="16" font-weight="600" fill="#534AB7">${initial}</text>
      </svg>`;
    return;
  }

  if (avatarData.startsWith('data:image') || avatarData.startsWith('{')) {
    if (avatarData.startsWith('data:image')) {
      display.innerHTML = `<img src="${avatarData}" width="44" height="44" style="border-radius:50%;object-fit:cover">`;
    } else {
      try {
        const iconData = JSON.parse(avatarData);
        display.innerHTML = `
          <svg width="44" height="44" viewBox="0 0 44 44">
            <defs><filter id="partnerShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="2" flood-opacity="0.12"/></filter></defs>
            <circle cx="22" cy="22" r="20" fill="${iconData.bg}" stroke="${iconData.stroke}" stroke-width="2" filter="url(#partnerShadow)"/>
            <text x="22" y="26" text-anchor="middle" font-size="16" font-weight="600" fill="${iconData.stroke}">${iconData.label}</text>
          </svg>`;
      } catch (e) { console.error('Invalid icon data:', e); }
    }
  } else {
    display.innerHTML = `<img src="data:image/png;base64,${avatarData}" width="44" height="44" style="border-radius:50%;object-fit:cover">`;
  }
}

function showIconPicker() {
  const grid = document.getElementById('icon-grid');
  if (grid.children.length === 0) generateIconGrid();
  document.getElementById('icon-picker-panel').classList.remove('hidden');
}

function hideIconPicker() {
  document.getElementById('icon-picker-panel').classList.add('hidden');
}

function generateIconGrid() {
  const grid = document.getElementById('icon-grid');
  const icons = [
    { bg: '#E6F1FB', stroke: '#378ADD', label: 'B' },
    { bg: '#CECBF6', stroke: '#534AB7', label: 'L' },
    { bg: '#EAF3DE', stroke: '#34C759', label: 'G' },
    { bg: '#FAEEDA', stroke: '#FF9F0A', label: 'S' },
    { bg: '#FCEBEB', stroke: '#FF3B30', label: 'R' },
    { bg: '#E1F5EE', stroke: '#30D158', label: 'T' },
    { bg: '#FBEAF0', stroke: '#FF6482', label: 'P' },
    { bg: '#F1EFE8', stroke: '#8E8E93', label: 'M' },
  ];

  icons.forEach(c => {
    const option = document.createElement('div');
    option.className = 'icon-option';
    option.innerHTML = `
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="20" fill="${c.bg}" stroke="${c.stroke}" stroke-width="2"/>
        <text x="22" y="26" text-anchor="middle" font-size="16" font-weight="600" fill="${c.stroke}">${c.label}</text>
      </svg>
    `;
    option.onclick = () => selectIcon(c);
    grid.appendChild(option);
  });
}

function selectIcon(iconData) {
  const iconJson = JSON.stringify(iconData);
  myAvatar = iconJson;
  updateMyAvatarDisplay(iconJson);

  if (tauriApi) {
    tauriApi.core.invoke('set_my_avatar', { avatar: iconJson });
  }

  hideIconPicker();
}

function uploadCustomIcon() {
  if (tauriApi) {
    try {
      const { open } = tauriApi.dialog;
      open({ filters: [{ name: 'Images', extensions: ['png', 'jpg', 'gif', 'svg'] }] }).then(path => {
        if (path) {
          // Read the image file and convert to base64
          // Use Tauri's file system to read the image
          const fs = tauriApi.fs;
          if (fs) {
            fs.readFile(path, { base64: true }).then(base64Data => {
              const mimeType = getMimeTypeFromPath(path);
              const dataUri = `data:${mimeType};base64,${base64Data}`;
              myAvatar = dataUri;
              updateMyAvatarDisplay(dataUri);

              if (tauriApi) {
                tauriApi.core.invoke('set_my_avatar', { avatar: dataUri });
              }

              // Notify partner about avatar change
              notifyProfileUpdate();
              hideIconPicker();
            }).catch(e => {
              console.error('Failed to read image file:', e);
              showToast('图片读取失败');
            });
          } else {
            // Fallback: just show the image from path
            document.getElementById('my-icon-display').innerHTML = `<img src="${path}" width="64" height="64" style="border-radius:50%;object-fit:cover">`;
            tauriApi.core.invoke('set_my_icon', { iconPath: path });
            hideIconPicker();
          }
        }
      });
    } catch (e) {
      showToast('请使用 Tauri 完整版上传图片');
    }
  } else {
    showToast('请在 Tauri 桌面版中使用此功能');
  }
}

function getMimeTypeFromPath(path) {
  const ext = path.split('.').pop().toLowerCase();
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };
  return map[ext] || 'image/png';
}

function notifyProfileUpdate() {
  if (ws && ws.readyState === WebSocket.OPEN && isPaired) {
    if (tauriApi) {
      tauriApi.core.invoke('send_profile_update', { name: myName, avatar: myAvatar }).then(msg => {
        ws.send(JSON.stringify(msg));
      });
    }
  }
}

// ========== 昵称管理 ==========

function saveNickname() {
  const nameInput = document.getElementById('my-name-input');
  if (nameInput && nameInput.value.trim()) {
    myName = nameInput.value.trim();
    if (tauriApi) {
      tauriApi.core.invoke('set_my_name', { name: myName });
    }
  }
}

// ========== 设置 ==========

function showSettings() {
  document.getElementById('settings-panel').classList.remove('hidden');
  if (tauriApi) {
    tauriApi.core.invoke('get_server_url').then(url => {
      document.getElementById('setting-server').value = url;
    });
    tauriApi.core.invoke('get_my_name').then(name => {
      document.getElementById('setting-name').value = name || '';
    });
  } else {
    document.getElementById('setting-server').value = serverUrl;
    document.getElementById('setting-name').value = myName || '';
  }
}

function hideSettings() {
  document.getElementById('settings-panel').classList.add('hidden');
}

function saveSettings() {
  const name = document.getElementById('setting-name').value.trim();
  const url = document.getElementById('setting-server').value.trim();

  if (name) {
    myName = name;
    if (tauriApi) tauriApi.core.invoke('set_my_name', { name });
  }

  if (tauriApi && url) {
    tauriApi.core.invoke('set_server_url', { url });
  }

  if (url && url !== serverUrl) {
    serverUrl = url;
    if (ws) ws.close();
    reconnectAttempts = 0;
    connectWebSocket();
  }

  // Notify partner about name change
  if (name && isPaired) {
    notifyProfileUpdate();
  }

  hideSettings();
  showToast('设置已保存');
}

// ========== 取消配对 ==========

function unpair() {
  if (!confirm('确定要取消配对吗？')) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'unpair', deviceId }));
  }

  if (tauriApi) tauriApi.core.invoke('unpair');

  showNotPairedView();
  showToast('已取消配对');
}

// ========== 窗口控制 ==========

function minimizeWindow() {
  if (tauriApi) {
    try { tauriApi.core.window.getCurrent().hide(); } catch (e) { console.log('Cannot hide window'); }
  }
}

function closeWindow() {
  if (tauriApi) {
    try { tauriApi.core.window.getCurrent().close(); } catch (e) { console.log('Cannot close window'); }
  }
}

// ========== 未读消息小红点 ==========

function updateUnreadBadge() {
  const badge = document.getElementById('unread-badge');
  if (badge) {
    if (unreadCount > 0) {
      badge.classList.remove('hidden');
      badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
    } else {
      badge.classList.add('hidden');
    }
  }
}

function clearUnreadBadge() {
  unreadCount = 0;
  updateUnreadBadge();
}

// ========== Toast 通知 ==========

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.getElementById('app').appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// ========== 事件监听 ==========

document.addEventListener('DOMContentLoaded', () => {
  // Enter 键发送消息
  const msgInput = document.getElementById('message-input');
  if (msgInput) {
    msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    msgInput.addEventListener('input', () => {
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 60) + 'px';
    });
  }

  // Enter 键输入配对码
  const joinInput = document.getElementById('join-code-input');
  if (joinInput) {
    joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); joinPair(); }
    });
    joinInput.addEventListener('input', () => {
      joinInput.value = joinInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    });
  }

  init();
});

// ========== 暴露函数到全局（onclick 需要） ==========
window.createPairCode = createPairCode;
window.showJoinPair = showJoinPair;
window.hideJoinPair = hideJoinPair;
window.joinPair = joinPair;
window.copyPairCode = copyPairCode;
window.sendMessage = sendMessage;
window.sendPoke = sendPoke;
window.showSettings = showSettings;
window.hideSettings = hideSettings;
window.saveSettings = saveSettings;
window.showIconPicker = showIconPicker;
window.hideIconPicker = hideIconPicker;
window.uploadCustomIcon = uploadCustomIcon;
window.unpair = unpair;
window.minimizeWindow = minimizeWindow;
window.closeWindow = closeWindow;
window.saveNickname = saveNickname;
window.notifyProfileUpdate = notifyProfileUpdate;

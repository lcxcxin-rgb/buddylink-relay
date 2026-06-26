const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const { handlePairing } = require('./pairing');
const { handleRelay } = require('./relay');
const { handlePresence } = require('./presence');

const PORT = process.env.PORT || 8443;

const devices = new Map();      // deviceId -> { ws, publicKey, status, partnerId, name, avatar }
const pairCodes = new Map();    // code -> { creatorId, publicKey, expiresAt, name, avatar }
const pairs = new Map();        // deviceId -> partnerId (bidirectional)

// Persistent identity registry - maps persistent UUID to last-known deviceId
// This allows devices to reclaim their identity after reconnect
const identityRegistry = new Map(); // persistentUUID -> { deviceId, partnerId, publicKey, name, avatar }

// Create Express app for health check and CORS
const app = express();

// CORS middleware - allow all origins for BuddyLink clients
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health check endpoint - required by cloud platforms (Render, Railway, Fly.io)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'BuddyLink Relay Server',
    version: '1.1.0',
    uptime: process.uptime(),
    connections: devices.size,
    activePairs: pairs.size / 2  // pairs are bidirectional, so divide by 2
  });
});

// Root endpoint - basic info
app.get('/', (req, res) => {
  res.json({
    service: 'BuddyLink Relay Server',
    version: '1.1.0',
    websocket: `ws://${req.headers.host || 'localhost:' + PORT}`,
    description: 'WebSocket relay server for BuddyLink paired Mac-to-Mac interaction'
  });
});

// Start Express HTTP server
const server = app.listen(PORT, () => {
  console.log(`BuddyLink relay server HTTP listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Create WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server });

console.log(`BuddyLink relay server starting on port ${PORT}`);

wss.on('connection', (ws, req) => {
  const tempId = uuidv4();  // Temporary ID until client sends reconnect with persistent UUID
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`New connection from ${clientIp}, tempId: ${tempId}`);

  const deviceInfo = {
    ws,
    deviceId: tempId,      // Will be replaced by persistent UUID on reconnect
    persistentUUID: null,  // Set by reconnect message
    publicKey: null,
    status: 'online',
    partnerId: null,
    name: null,
    avatar: null,          // base64 encoded avatar data
    lastHeartbeat: Date.now()
  };

  devices.set(tempId, deviceInfo);

  // Send temporary device ID to client
  ws.send(JSON.stringify({
    type: 'assigned_id',
    deviceId: tempId
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleMessage(deviceInfo.deviceId, msg);
    } catch (e) {
      console.error('Invalid message:', e.message);
    }
  });

  ws.on('close', () => {
    const deviceId = deviceInfo.deviceId;
    const persistentUUID = deviceInfo.persistentUUID;

    console.log(`Device ${deviceId} disconnected`);

    // Save identity to registry so device can reclaim on reconnect
    if (persistentUUID) {
      const partnerId = pairs.get(deviceId);
      identityRegistry.set(persistentUUID, {
        deviceId,
        partnerId: partnerId || null,
        publicKey: deviceInfo.publicKey,
        name: deviceInfo.name,
        avatar: deviceInfo.avatar
      });
      console.log(`Saved identity for ${persistentUUID}, partner: ${partnerId}`);
    }

    handlePresence(deviceId, 'offline', devices, pairs);
    devices.delete(deviceId);

    // Clean up pending pair codes
    for (const [code, data] of pairCodes) {
      if (data.creatorId === deviceId) {
        pairCodes.delete(code);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`Device ${deviceInfo.deviceId} error:`, err.message);
  });
});

function handleMessage(deviceId, msg) {
  const device = devices.get(deviceId);
  if (!device) return;

  switch (msg.type) {
    case 'reconnect':
      handleReconnect(deviceId, msg, device);
      break;

    case 'register':
      device.publicKey = msg.publicKey || null;
      console.log(`Device ${deviceId} registered with public key`);
      device.ws.send(JSON.stringify({
        type: 'register_ack',
        success: true
      }));
      break;

    case 'create_pair':
      handlePairing('create', deviceId, msg, devices, pairCodes, pairs);
      break;

    case 'join_pair':
      handlePairing('join', deviceId, msg, devices, pairCodes, pairs);
      break;

    case 'message':
      handleRelay('message', deviceId, msg, devices, pairs);
      break;

    case 'poke':
      handleRelay('poke', deviceId, msg, devices, pairs);
      break;

    case 'read_receipt':
      handleRelay('read_receipt', deviceId, msg, devices, pairs);
      break;

    case 'heartbeat':
      device.lastHeartbeat = Date.now();
      handlePresence(deviceId, 'online', devices, pairs);
      break;

    case 'status_update':
      device.status = msg.status || 'online';
      handlePresence(deviceId, device.status, devices, pairs);
      break;

    case 'unpair':
      handlePairing('unpair', deviceId, msg, devices, pairCodes, pairs);
      break;

    // Profile update - relay name/avatar changes to partner
    case 'profile_update':
      handleProfileUpdate(deviceId, msg, device);
      break;

    default:
      console.warn(`Unknown message type: ${msg.type}`);
  }
}

/**
 * Handle reconnect - device claims its persistent identity
 * This allows pairing relationships to survive app restarts AND server restarts
 *
 * Key change: client now sends partnerId, so server can restore pairing
 * even when server has restarted and lost all in-memory state.
 */
function handleReconnect(tempId, msg, device) {
  const persistentUUID = msg.persistentUUID;

  if (!persistentUUID) {
    console.warn(`Reconnect without persistentUUID from ${tempId}`);
    return;
  }

  // Check if this persistent UUID was previously registered
  const registered = identityRegistry.get(persistentUUID);
  const oldDeviceId = registered ? registered.deviceId : null;

  // Remove old temporary entry
  devices.delete(tempId);

  // If there's an existing device with this persistentUUID still connected, disconnect it
  if (oldDeviceId && devices.has(oldDeviceId)) {
    const oldDevice = devices.get(oldDeviceId);
    if (oldDevice && oldDevice.ws !== device.ws) {
      console.log(`Replacing existing connection for ${persistentUUID}`);
      oldDevice.ws.terminate();
      devices.delete(oldDeviceId);
    }
  }

  // Also check if the persistentUUID itself has an entry (from another connection)
  if (devices.has(persistentUUID)) {
    const existingDevice = devices.get(persistentUUID);
    if (existingDevice && existingDevice.ws !== device.ws) {
      console.log(`Replacing existing connection for persistentUUID ${persistentUUID}`);
      existingDevice.ws.terminate();
      devices.delete(persistentUUID);
    }
  }

  // Use persistent UUID as the new deviceId
  device.deviceId = persistentUUID;
  device.persistentUUID = persistentUUID;
  device.publicKey = msg.publicKey || device.publicKey || (registered ? registered.publicKey : null);
  device.name = msg.name || device.name || (registered ? registered.name : null);
  device.avatar = msg.avatar || device.avatar || (registered ? registered.avatar : null);

  // Register device with persistent UUID
  devices.set(persistentUUID, device);

  // ========== NEW: Restore pairing from client's claim ==========
  const claimedPartnerId = msg.partnerId;  // Client sends its stored partnerId
  let partnerId = null;
  let restoredPairing = false;

  if (claimedPartnerId) {
    // Device claims to be paired with this partnerId
    // Check if partner already has a different pairing (partnered with someone else)
    const partnerExistingPairing = pairs.get(claimedPartnerId);

    if (partnerExistingPairing && partnerExistingPairing !== persistentUUID) {
      // Partner is paired with a DIFFERENT device - our claim is stale
      // The pairing is no longer valid
      console.log(`Pairing claim rejected: ${claimedPartnerId} is paired with ${partnerExistingPairing}, not ${persistentUUID}`);
      restoredPairing = false;
      partnerId = null;
    } else {
      // Claim is valid - set up pairing
      partnerId = claimedPartnerId;
      pairs.set(persistentUUID, partnerId);
      device.partnerId = partnerId;
      restoredPairing = true;

      // If partner is connected, set reverse mapping too
      const partnerDevice = devices.get(partnerId);
      if (partnerDevice && partnerDevice.persistentUUID) {
        // Partner is online - complete the bidirectional pairing
        pairs.set(partnerId, persistentUUID);
        partnerDevice.partnerId = persistentUUID;
        console.log(`Bidirectional pairing restored: ${persistentUUID} <-> ${partnerId}`);

        // Notify partner that we're back online + send our profile
        if (partnerDevice.ws.readyState === 1) {
          partnerDevice.ws.send(JSON.stringify({
            type: 'presence',
            deviceId: persistentUUID,
            status: 'online',
            timestamp: Date.now()
          }));

          // Send our profile update so partner has our latest name/avatar
          if (device.name || device.avatar) {
            partnerDevice.ws.send(JSON.stringify({
              type: 'profile_update',
              deviceId: persistentUUID,
              name: device.name || null,
              avatar: device.avatar || null,
              timestamp: Date.now()
            }));
          }
        }
      } else {
        // Partner not connected yet - provisional pairing (one direction only)
        // When partner later reconnects, they will complete the bidirectional pairing
        console.log(`Provisional pairing: ${persistentUUID} claims ${partnerId} (partner offline)`);
      }
    }
  } else if (registered && registered.partnerId) {
    // No partnerId in reconnect message, but identityRegistry has one
    // (This handles old clients that don't send partnerId yet)
    partnerId = registered.partnerId;
    const partnerExistingPairing = pairs.get(partnerId);

    if (!partnerExistingPairing || partnerExistingPairing === persistentUUID) {
      pairs.set(persistentUUID, partnerId);
      device.partnerId = partnerId;
      restoredPairing = true;

      // Set reverse if partner is online
      const partnerDevice = devices.get(partnerId);
      if (partnerDevice && partnerDevice.persistentUUID) {
        pairs.set(partnerId, persistentUUID);
        partnerDevice.partnerId = persistentUUID;
      }
    }
  } else {
    // Check existing in-memory pairing from previous session (server still running)
    partnerId = pairs.get(persistentUUID);
    if (partnerId) {
      device.partnerId = partnerId;
      restoredPairing = true;
    }
  }

  // Clean up registry entry (no longer needed since device is live)
  identityRegistry.delete(persistentUUID);

  // Collect partner info for reconnect_ack
  let partnerName = null;
  let partnerAvatar = null;
  if (partnerId) {
    const partnerDeviceInfo = devices.get(partnerId);
    if (partnerDeviceInfo) {
      partnerName = partnerDeviceInfo.name || null;
      partnerAvatar = partnerDeviceInfo.avatar || null;
    }
  }

  // Send reconnect confirmation to client
  device.ws.send(JSON.stringify({
    type: 'reconnect_ack',
    deviceId: persistentUUID,
    isPaired: restoredPairing,
    partnerId: partnerId || null,
    partnerName: partnerName,
    partnerAvatar: partnerAvatar
  }));

  console.log(`Device ${persistentUUID} reconnected (was tempId: ${tempId}), paired: ${restoredPairing}, partner: ${partnerId || 'none'}`);
}

/**
 * Handle profile update - relay name/avatar changes to partner
 */
function handleProfileUpdate(deviceId, msg, device) {
  if (msg.name) device.name = msg.name;
  if (msg.avatar) device.avatar = msg.avatar;

  // Relay to partner
  const partnerId = pairs.get(deviceId);
  if (partnerId) {
    const partner = devices.get(partnerId);
    if (partner && partner.ws.readyState === 1) {
      partner.ws.send(JSON.stringify({
        type: 'profile_update',
        deviceId: deviceId,
        name: msg.name || null,
        avatar: msg.avatar || null,
        timestamp: Date.now()
      }));
    }
  }

  console.log(`Device ${deviceId} updated profile: name=${msg.name}, avatar=${msg.avatar ? 'yes' : 'no'}`);
}

// Heartbeat check - remove stale connections every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [deviceId, device] of devices) {
    if (now - device.lastHeartbeat > 90000) { // 90 seconds timeout
      console.log(`Device ${deviceId} heartbeat timeout, disconnecting`);

      // Save identity before removing
      if (device.persistentUUID) {
        const partnerId = pairs.get(deviceId);
        identityRegistry.set(device.persistentUUID, {
          deviceId,
          partnerId: partnerId || null,
          publicKey: device.publicKey,
          name: device.name,
          avatar: device.avatar
        });
      }

      device.ws.terminate();
      handlePresence(deviceId, 'offline', devices, pairs);
      devices.delete(deviceId);
    }
  }

  // Expire old pair codes (5 minute lifetime)
  for (const [code, data] of pairCodes) {
    if (now > data.expiresAt) {
      console.log(`Pair code ${code} expired`);
      pairCodes.delete(code);
    }
  }

  // Clean up stale identity registry entries (older than 24 hours)
  // Note: identityRegistry doesn't have timestamps, but stale entries
  // will be cleaned when the device reconnects or when their partner disconnects
}, 60000);

console.log(`BuddyLink relay server ready`);

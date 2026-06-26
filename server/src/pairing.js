/**
 * Pairing logic - create/join/unpair
 * Updated: exchanges name and avatar during pairing
 */

function generatePairCode() {
  // 6-character alphanumeric code (excludes ambiguous chars like 0/O, 1/I/l)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function handlePairing(action, deviceId, msg, devices, pairCodes, pairs) {
  const device = devices.get(deviceId);
  if (!device) return;

  switch (action) {
    case 'create': {
      // Create a new pair code
      const code = generatePairCode();
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

      pairCodes.set(code, {
        creatorId: deviceId,
        publicKey: device.publicKey || msg.publicKey,
        name: msg.name || device.name || null,       // Store creator's name
        avatar: msg.avatar || device.avatar || null,   // Store creator's avatar
        expiresAt
      });

      console.log(`Device ${deviceId} created pair code: ${code}`);
      device.ws.send(JSON.stringify({
        type: 'pair_code',
        code: code,
        expiresAt: expiresAt
      }));
      break;
    }

    case 'join': {
      const code = msg.code?.toUpperCase();
      const pairData = pairCodes.get(code);

      if (!pairData) {
        device.ws.send(JSON.stringify({
          type: 'pair_error',
          error: '配对密钥不存在或已过期'
        }));
        return;
      }

      if (Date.now() > pairData.expiresAt) {
        pairCodes.delete(code);
        device.ws.send(JSON.stringify({
          type: 'pair_error',
          error: '配对密钥已过期，请重新生成'
        }));
        return;
      }

      if (pairData.creatorId === deviceId) {
        device.ws.send(JSON.stringify({
          type: 'pair_error',
          error: '不能与自己配对'
        }));
        return;
      }

      const creator = devices.get(pairData.creatorId);
      if (!creator) {
        pairCodes.delete(code);
        device.ws.send(JSON.stringify({
          type: 'pair_error',
          error: '对方设备已离线'
        }));
        return;
      }

      // Exchange public keys, names, and avatars
      const joinerPublicKey = device.publicKey || msg.publicKey;
      const creatorPublicKey = pairData.publicKey;
      const joinerName = msg.name || device.name || null;
      const joinerAvatar = msg.avatar || device.avatar || null;
      const creatorName = pairData.name || creator.name || null;
      const creatorAvatar = pairData.avatar || creator.avatar || null;

      if (!joinerPublicKey || !creatorPublicKey) {
        device.ws.send(JSON.stringify({
          type: 'pair_error',
          error: '缺少公钥信息'
        }));
        return;
      }

      // Establish pair
      pairs.set(deviceId, pairData.creatorId);
      pairs.set(pairData.creatorId, deviceId);

      device.partnerId = pairData.creatorId;
      creator.partnerId = deviceId;

      // Notify creator - includes joiner's name and avatar
      creator.ws.send(JSON.stringify({
        type: 'paired',
        partnerId: deviceId,
        partnerPublicKey: joinerPublicKey,
        partnerName: joinerName,
        partnerAvatar: joinerAvatar,
        isInitiator: true
      }));

      // Notify joiner - includes creator's name and avatar
      device.ws.send(JSON.stringify({
        type: 'paired',
        partnerId: pairData.creatorId,
        partnerPublicKey: creatorPublicKey,
        partnerName: creatorName,
        partnerAvatar: creatorAvatar,
        isInitiator: false
      }));

      // Consume pair code
      pairCodes.delete(code);
      console.log(`Pair established: ${pairData.creatorId} <-> ${deviceId}`);
      break;
    }

    case 'unpair': {
      const partnerId = pairs.get(deviceId);
      if (!partnerId) {
        device.ws.send(JSON.stringify({
          type: 'unpair_error',
          error: '当前没有配对关系'
        }));
        return;
      }

      const partner = devices.get(partnerId);
      pairs.delete(deviceId);
      pairs.delete(partnerId);
      device.partnerId = null;

      if (partner) {
        partner.partnerId = null;
        partner.ws.send(JSON.stringify({
          type: 'unpaired',
          reason: '对方已解除配对'
        }));
      }

      device.ws.send(JSON.stringify({
        type: 'unpaired',
        reason: '已解除配对'
      }));

      console.log(`Pair broken: ${deviceId} <-> ${partnerId}`);
      break;
    }
  }
}

module.exports = { handlePairing };

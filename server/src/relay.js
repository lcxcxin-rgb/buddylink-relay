/**
 * Message relay logic - forward encrypted messages between paired devices
 * Updated: supports read_receipt relay
 */

function handleRelay(msgType, fromId, msg, devices, pairs) {
  const fromDevice = devices.get(fromId);
  if (!fromDevice) return;

  // Check pair relationship
  const partnerId = pairs.get(fromId);
  if (!partnerId) {
    fromDevice.ws.send(JSON.stringify({
      type: 'relay_error',
      error: '当前没有配对关系，无法发送消息'
    }));
    return;
  }

  const partnerDevice = devices.get(partnerId);
  if (!partnerDevice || partnerDevice.ws.readyState !== 1) {
    // Partner offline
    fromDevice.ws.send(JSON.stringify({
      type: 'relay_status',
      status: 'partner_offline',
      message: '对方当前离线，消息将在对方上线后重新发送',
      timestamp: Date.now()
    }));
    return;
  }

  // Forward the message to partner
  const relayMsg = {
    type: msgType,
    from: fromId,
    timestamp: msg.timestamp || Date.now()
  };

  // Include message-specific fields
  if (msgType === 'message' || msgType === 'poke') {
    relayMsg.nonce = msg.nonce;
    relayMsg.ciphertext = msg.ciphertext;
  } else if (msgType === 'read_receipt') {
    relayMsg.messageIds = msg.messageIds;  // Array of message IDs that were read
  }

  partnerDevice.ws.send(JSON.stringify(relayMsg));

  // Confirm delivery to sender (only for message and poke, not read_receipt)
  if (msgType === 'message' || msgType === 'poke') {
    fromDevice.ws.send(JSON.stringify({
      type: 'relay_status',
      status: 'delivered',
      timestamp: relayMsg.timestamp
    }));
  }

  console.log(`Relayed ${msgType} from ${fromId} to ${partnerId}`);
}

module.exports = { handleRelay };

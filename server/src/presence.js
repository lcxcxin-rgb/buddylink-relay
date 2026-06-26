/**
 * Presence (online status) tracking and notification
 */

function handlePresence(deviceId, status, devices, pairs) {
  const device = devices.get(deviceId);
  if (!device) return;

  const previousStatus = device.status;
  device.status = status;

  // Only notify partner if status changed
  if (previousStatus !== status) {
    const partnerId = pairs.get(deviceId);
    if (partnerId) {
      const partner = devices.get(partnerId);
      if (partner && partner.ws.readyState === 1) {
        partner.ws.send(JSON.stringify({
          type: 'presence',
          deviceId: deviceId,
          status: status,
          timestamp: Date.now()
        }));
      }
    }
  }

  console.log(`Device ${deviceId} status: ${previousStatus} -> ${status}`);
}

module.exports = { handlePresence };

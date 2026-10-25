/**
 * WYA WebSocket Server
 * Real-time GPS updates for mobile app (<100ms latency target)
 * Port: 3423
 * (c) Universoul LLC | Santa Barbara, CA
 */
const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = parseInt(process.env.WYA_WS_PORT || '3423');

// Connection tracking
const clients = new Map(); // clientId -> {ws, channels, lastPing}
const channels = new Map(); // channelName -> Set of clientIds

let clientIdCounter = 0;

// Create server
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      service: 'wya-websocket',
      clients: clients.size,
      channels: channels.size,
      ts: new Date().toISOString()
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientId = ++clientIdCounter;
  const clientInfo = {
    ws,
    channels: new Set(),
    lastPing: Date.now(),
    ip: req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress
  };
  clients.set(clientId, clientInfo);

  console.log(`[WYA-WS] Client ${clientId} connected from ${clientInfo.ip}`);

  // Send welcome message
  send(ws, { type: 'connected', clientId, ts: new Date().toISOString() });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(clientId, msg);
    } catch (err) {
      console.error(`[WYA-WS] Invalid message from ${clientId}:`, err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[WYA-WS] Client ${clientId} disconnected`);
    // Remove from all channels
    const info = clients.get(clientId);
    if (info) {
      for (const channel of info.channels) {
        channels.get(channel)?.delete(clientId);
      }
    }
    clients.delete(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[WYA-WS] Error from ${clientId}:`, err.message);
  });
});

function handleMessage(clientId, msg) {
  const client = clients.get(clientId);
  if (!client) return;

  client.lastPing = Date.now();

  switch (msg.type) {
    case 'ping':
      send(client.ws, { type: 'pong', ts: new Date().toISOString() });
      break;

    case 'subscribe':
      subscribeToChannel(clientId, msg.channel);
      break;

    case 'unsubscribe':
      unsubscribeFromChannel(clientId, msg.channel);
      break;

    case 'vendor_location':
      // Vendor is broadcasting their location
      broadcastToChannel('vendors', {
        type: 'vendor_location',
        vendor_id: msg.vendor_id,
        lat: msg.lat,
        lng: msg.lng,
        heading: msg.heading,
        speed: msg.speed,
        ts: new Date().toISOString()
      }, clientId);
      break;

    default:
      console.log(`[WYA-WS] Unknown message type: ${msg.type}`);
  }
}

function subscribeToChannel(clientId, channelName) {
  if (!channelName) return;

  const client = clients.get(clientId);
  if (!client) return;

  if (!channels.has(channelName)) {
    channels.set(channelName, new Set());
  }

  channels.get(channelName).add(clientId);
  client.channels.add(channelName);

  send(client.ws, {
    type: 'subscribed',
    channel: channelName,
    ts: new Date().toISOString()
  });

  console.log(`[WYA-WS] Client ${clientId} subscribed to ${channelName}`);
}

function unsubscribeFromChannel(clientId, channelName) {
  if (!channelName) return;

  const client = clients.get(clientId);
  if (!client) return;

  channels.get(channelName)?.delete(clientId);
  client.channels.delete(channelName);

  send(client.ws, {
    type: 'unsubscribed',
    channel: channelName,
    ts: new Date().toISOString()
  });
}

function broadcastToChannel(channelName, message, excludeClientId = null) {
  const channelClients = channels.get(channelName);
  if (!channelClients) return;

  const payload = JSON.stringify(message);
  let sent = 0;

  for (const clientId of channelClients) {
    if (clientId === excludeClientId) continue;

    const client = clients.get(clientId);
    if (client?.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
      sent++;
    }
  }

  return sent;
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Cleanup stale connections every 60s
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 120000; // 2 minutes

  for (const [clientId, client] of clients) {
    if (now - client.lastPing > staleThreshold) {
      console.log(`[WYA-WS] Closing stale connection ${clientId}`);
      client.ws.close();
      clients.delete(clientId);
    }
  }
}, 60000);

// Broadcast function for external use (from wya-app)
function broadcastVendorLocation(vendorId, lat, lng, heading = 0, speed = 0) {
  return broadcastToChannel('vendors', {
    type: 'vendor_location',
    vendor_id: vendorId,
    lat,
    lng,
    heading,
    speed,
    ts: new Date().toISOString()
  });
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WYA-WS] WebSocket server running on port ${PORT}`);
});

module.exports = {
  broadcastVendorLocation,
  broadcastToChannel,
  getClientCount: () => clients.size,
  getChannelCount: () => channels.size
};

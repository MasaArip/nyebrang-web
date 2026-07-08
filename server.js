const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// rooms: Map<roomId, Map<clientId, { ws, name, deviceType }>>
const rooms = new Map();

function genId() {
  return crypto.randomBytes(6).toString('hex');
}

function roomPeerList(room, excludeId) {
  const map = rooms.get(room);
  if (!map) return [];
  const list = [];
  for (const [id, client] of map.entries()) {
    if (id === excludeId) continue;
    list.push({ id, name: client.name, deviceType: client.deviceType });
  }
  return list;
}

function broadcastToRoom(room, msg, excludeId) {
  const map = rooms.get(room);
  if (!map) return;
  const data = JSON.stringify(msg);
  for (const [id, client] of map.entries()) {
    if (id === excludeId) continue;
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(data);
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let selfId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'join') {
      currentRoom = String(msg.room || 'default').slice(0, 64);
      selfId = genId();
      const name = String(msg.name || 'Device').slice(0, 40);
      const deviceType = String(msg.deviceType || 'unknown').slice(0, 20);

      if (!rooms.has(currentRoom)) rooms.set(currentRoom, new Map());
      const map = rooms.get(currentRoom);

      ws.send(JSON.stringify({
        type: 'joined',
        selfId,
        peers: roomPeerList(currentRoom, selfId),
      }));

      map.set(selfId, { ws, name, deviceType });

      broadcastToRoom(currentRoom, {
        type: 'peer-joined',
        peer: { id: selfId, name, deviceType },
      }, selfId);
      return;
    }

    if (msg.type === 'signal' && currentRoom && selfId) {
      const map = rooms.get(currentRoom);
      if (!map) return;
      const target = map.get(msg.to);
      if (target && target.ws.readyState === target.ws.OPEN) {
        target.ws.send(JSON.stringify({
          type: 'signal',
          from: selfId,
          data: msg.data,
        }));
      }
      return;
    }
  });

  ws.on('close', () => {
    if (currentRoom && selfId) {
      const map = rooms.get(currentRoom);
      if (map) {
        map.delete(selfId);
        if (map.size === 0) rooms.delete(currentRoom);
        else broadcastToRoom(currentRoom, { type: 'peer-left', id: selfId });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});

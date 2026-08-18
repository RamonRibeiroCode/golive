// Next.js + WebSocket signaling in a single process.
//   node server.mjs            -> dev,  http
//   node server.mjs --https    -> dev,  https with a self-signed cert (LAN sharing)
//   node server.mjs --prod     -> production (run `npm run build` first)
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const dev = !process.argv.includes('--prod');
const useHttps = process.argv.includes('--https');
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? '0.0.0.0';

process.env.NODE_ENV = dev ? 'development' : 'production';
const { default: next } = await import('next');

const app = next({ dev, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const upgradeHandler = app.getUpgradeHandler();

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

async function tlsOptions() {
  const dir = path.join(process.cwd(), '.certs');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    const { default: selfsigned } = await import('selfsigned');
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      ...lanAddresses().map((ip) => ({ type: 7, ip })),
    ];
    const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames }],
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(keyFile, pems.private);
    writeFileSync(certFile, pems.cert);
    console.log('[tls] self-signed certificate generated in .certs/');
  }
  return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
}

const server = useHttps
  ? createHttpsServer(await tlsOptions(), handle)
  : createHttpServer(handle);

/* ------------------------------- signaling ------------------------------- */
// room -> { host: ws | null, viewers: Map<id, ws> }
const rooms = new Map();

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

const send = (ws, msg) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    room = { host: null, viewers: new Map() };
    rooms.set(name, room);
  }
  return room;
}

function dropEmpty(name) {
  const room = rooms.get(name);
  if (room && !room.host && room.viewers.size === 0) rooms.delete(name);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.meta = null;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      if (ws.meta) return;
      const name = String(msg.room ?? '').slice(0, 64).toUpperCase();
      if (!name) return send(ws, { type: 'error', message: 'sala inválida' });
      const room = getRoom(name);

      if (msg.role === 'host') {
        if (room.host) return send(ws, { type: 'error', message: 'já existe alguém transmitindo nesta sala' });
        ws.meta = { room: name, role: 'host', id: 'host' };
        room.host = ws;
        send(ws, { type: 'joined', id: 'host' });
        // Pick up viewers that were already waiting.
        for (const id of room.viewers.keys()) send(ws, { type: 'peer-join', id });
        for (const viewer of room.viewers.values()) send(viewer, { type: 'host-ready' });
      } else {
        const id = randomUUID();
        ws.meta = { room: name, role: 'viewer', id };
        room.viewers.set(id, ws);
        send(ws, { type: 'joined', id });
        if (room.host) {
          send(ws, { type: 'host-ready' });
          send(room.host, { type: 'peer-join', id });
        } else {
          send(ws, { type: 'no-host' });
        }
      }
      return;
    }

    if (!ws.meta) return;
    const room = rooms.get(ws.meta.room);
    if (!room) return;

    if (msg.type === 'signal') {
      if (ws.meta.role === 'viewer') {
        send(room.host, { type: 'signal', from: ws.meta.id, data: msg.data });
      } else {
        send(room.viewers.get(msg.to), { type: 'signal', from: 'host', data: msg.data });
      }
      return;
    }

    if (msg.type === 'viewers') {
      send(ws, { type: 'viewers', count: room.viewers.size });
    }
  });

  ws.on('close', () => {
    if (!ws.meta) return;
    const { room: name, role, id } = ws.meta;
    const room = rooms.get(name);
    if (!room) return;
    if (role === 'host') {
      room.host = null;
      for (const viewer of room.viewers.values()) send(viewer, { type: 'host-left' });
    } else {
      room.viewers.delete(id);
      send(room.host, { type: 'peer-left', id });
    }
    dropEmpty(name);
  });
});

// Drop half-open connections so viewer counts stay honest.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);
wss.on('close', () => clearInterval(heartbeat));

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    upgradeHandler(req, socket, head);
  }
});

server.listen(port, hostname, () => {
  const scheme = useHttps ? 'https' : 'http';
  console.log(`\n  golive  ${dev ? '(dev)' : '(prod)'}\n`);
  console.log(`  local    ${scheme}://localhost:${port}`);
  for (const ip of lanAddresses()) console.log(`  rede     ${scheme}://${ip}:${port}`);
  if (!useHttps) {
    console.log('\n  Para assistir de outro dispositivo na rede use "npm run dev:https"');
    console.log('  (WebRTC exige contexto seguro fora de localhost).');
  }
  console.log('');
});

/* server/index.js — http 정적 서버 + WebSocket 엔트리 + 매치메이커 연결. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const Matchmaker = require('./matchmaker');
const { C2S, S2C, encode, decode } = require('./protocol');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

// public/ 와 shared/ 하위 파일만 노출
function resolveStatic(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  let file;
  if (rel.startsWith('/shared/')) {
    file = path.join(ROOT, rel);
  } else {
    file = path.join(ROOT, 'public', rel);
  }
  const norm = path.normalize(file);
  const okPublic = norm.startsWith(path.join(ROOT, 'public') + path.sep);
  const okShared = norm.startsWith(path.join(ROOT, 'shared') + path.sep);
  if (!okPublic && !okShared) return null;
  return norm;
}

const matchmaker = new Matchmaker();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(matchmaker.stats()));
    return;
  }
  const file = resolveStatic(req.url);
  if (!file) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let player = null;
  let room = null;

  ws.on('message', (raw) => {
    const msg = decode(raw);
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === C2S.PING) {
      ws.send(encode({ type: S2C.PONG, t: msg.t }));
      return;
    }

    if (msg.type === C2S.JOIN) {
      if (player) return; // 이미 입장됨
      const name = String(msg.name || 'player').slice(0, 16).trim() || 'player';
      const id = crypto.randomUUID();
      room = matchmaker.assign();
      player = room.addPlayer(id, name, ws, msg.loadout);
      console.log(`[join] ${name} (${id.slice(0, 8)}) → ${room.id} (${room.size}/10)`);
      return;
    }

    if (!player || !room) return;

    switch (msg.type) {
      case C2S.INPUT: room.handleInput(player, msg); break;
      case C2S.FIRE_START: room.handleFire(player, 'start', msg); break;
      case C2S.FIRE_RELEASE: room.handleFire(player, 'release', msg); break;
      case C2S.USE_SKILL: room.handleSkill(player, msg); break;
      case C2S.SET_LOADOUT: room.handleSetLoadout(player, msg); break;
    }
  });

  ws.on('close', () => {
    if (player && room) {
      console.log(`[leave] ${player.name} ← ${room.id}`);
      room.removePlayer(player.id);
    }
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`curl.io server listening on http://localhost:${PORT}`);
});

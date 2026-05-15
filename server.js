const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const GRID = 20;
const COLS = 48;
const ROWS = 38;
const PVP_BASE_INTERVAL = 130;
const PVP_BASE_LENGTH = 3;
const PVP_RESPAWN_MS = 5000;
const PVP_GAME_DURATION = 300;
const SPEED_BOOST_DURATION = 3000;
const SPEED_BOOST_MULTIPLIER = 0.55;
const TARGET_FOOD_COUNT = 8;
const ONLINE_MAX_PLAYERS = 4;
const ONLINE_COLORS = ['#00ff66', '#4488ff', '#ff8844', '#ff44cc'];

const FOOD_TYPES = [
  { label: '普通', color: '#ff3333', points: 10, prob: 0.40, lifetime: 10000 },
  { label: '稀有', color: '#ffaa00', points: 30, prob: 0.18, lifetime: 8000 },
  { label: '史诗', color: '#cc44ff', points: 50, prob: 0.05, lifetime: 6000 },
  { label: '护盾', color: '#ffb800', points: 0, prob: 0.10, lifetime: 10000, shield: true },
  { label: '加速果', color: '#ffdd00', points: 5, prob: 0.09, lifetime: 8000, speedBoost: true },
  { label: '炸弹', color: '#ff2222', points: -15, prob: 0.18, lifetime: 12000 }
];

const SKILL_DEFS = {
  shield: { id: 'shield', duration: 10000, cooldown: 120000, maxUses: 2, effect: 'shield' },
  invisibility: { id: 'invisibility', duration: 15000, cooldown: 120000, maxUses: 2, effect: 'invisibility' }
};

const CHARACTERS = {
  default: { id: 'default', skill: null },
  niko: { id: 'niko', skill: 'shield' }
};

const rooms = new Map();

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = urlPath === '/' ? 'snake_game.html' : urlPath.replace(/^\/+/, '');
  const abs = path.join(__dirname, filePath);
  if (!abs.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));

  const ws = createSocketClient(socket);
  socket.on('data', (chunk) => readFrames(ws, chunk));
  socket.on('close', () => leaveRoom(ws));
  socket.on('error', () => leaveRoom(ws));
});

function createSocketClient(socket) {
  return {
    socket,
    id: Math.random().toString(36).slice(2, 10),
    roomId: null,
    playerIndex: -1,
    buffer: Buffer.alloc(0),
    send(data) {
      if (socket.destroyed) return;
      const payload = Buffer.from(JSON.stringify(data));
      let header;
      if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      socket.write(Buffer.concat([header, payload]));
    }
  };
}

function readFrames(ws, chunk) {
  ws.buffer = Buffer.concat([ws.buffer, chunk]);
  while (ws.buffer.length >= 2) {
    const first = ws.buffer[0];
    const second = ws.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (ws.buffer.length < offset + 2) return;
      length = ws.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (ws.buffer.length < offset + 8) return;
      length = Number(ws.buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const maskOffset = masked ? 4 : 0;
    if (ws.buffer.length < offset + maskOffset + length) return;

    let payload = ws.buffer.subarray(offset + maskOffset, offset + maskOffset + length);
    if (masked) {
      const mask = ws.buffer.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
    }
    ws.buffer = ws.buffer.subarray(offset + maskOffset + length);

    if (opcode === 0x8) {
      ws.socket.end();
      leaveRoom(ws);
      return;
    }
    if (opcode !== 0x1) continue;

    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
    handleMessage(ws, msg);
  }
}

function handleMessage(ws, msg) {
  if (msg.type === 'create') return createRoom(ws, msg.roomId);
  if (msg.type === 'join') return joinRoom(ws, msg.roomId);
  const room = rooms.get(ws.roomId);
  if (!room) return;

  const player = room.players[ws.playerIndex];
  if (!player) return;

  if (msg.type === 'setName') {
    player.name = String(msg.name || '').slice(0, 18);
    broadcastPlayerList(room);
  } else if (msg.type === 'setColor') {
    const color = ONLINE_COLORS.includes(msg.color) ? msg.color : player.color;
    const taken = room.players.some((p, i) => i !== ws.playerIndex && p.name && p.color === color);
    if (!taken) player.color = color;
    broadcastPlayerList(room);
  } else if (msg.type === 'setChar') {
    player.char = CHARACTERS[msg.char] ? msg.char : 'default';
    broadcastPlayerList(room);
  } else if (msg.type === 'start') {
    if (ws.playerIndex === 0) startCountdown(room);
  } else if (msg.type === 'dir') {
    if (room.phase !== 'playing') return;
    const dir = msg.dir;
    const opposites = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };
    if (['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(dir) && opposites[dir] !== room.dirs[ws.playerIndex]) {
      room.nextDirs[ws.playerIndex] = dir;
    }
  } else if (msg.type === 'useSkill') {
    useSkill(room, ws.playerIndex);
  } else if (msg.type === 'restart') {
    if (ws.playerIndex === 0) startCountdown(room);
  }
}

function createRoom(ws, requestedId) {
  let roomId = sanitizeRoomId(requestedId) || randomRoomId();
  if (rooms.has(roomId)) {
    send(ws, { type: 'reject', reason: '房间号已被占用，请换一个' });
    return;
  }
  const room = newRoom(roomId);
  rooms.set(roomId, room);
  addPlayer(room, ws);
}

function joinRoom(ws, requestedId) {
  const roomId = sanitizeRoomId(requestedId);
  const room = rooms.get(roomId);
  if (!room) return send(ws, { type: 'reject', reason: '房间不存在或主机已离线' });
  if (room.phase !== 'lobby') return send(ws, { type: 'reject', reason: '游戏已开始' });
  if (room.players.length >= ONLINE_MAX_PLAYERS) return send(ws, { type: 'reject', reason: '房间已满' });
  addPlayer(room, ws);
}

function newRoom(roomId) {
  return {
    id: roomId,
    phase: 'lobby',
    players: [],
    sockets: [],
    snakes: [],
    foods: [],
    scores: [],
    alive: [],
    dirs: [],
    nextDirs: [],
    timeLeft: PVP_GAME_DURATION,
    deadUntil: [],
    deathLen: [],
    shieldUntil: [],
    speedUntil: [],
    lastMove: [],
    skillActive: [],
    skillCooldown: [],
    skillUses: [],
    skillUntil: [],
    gameLoop: null,
    syncLoop: null,
    timerLoop: null,
    countdownLoop: null
  };
}

function addPlayer(room, ws) {
  leaveRoom(ws);
  ws.roomId = room.id;
  ws.playerIndex = room.players.length;
  room.sockets.push(ws);
  room.players.push({
    name: '',
    color: ONLINE_COLORS[ws.playerIndex % ONLINE_COLORS.length],
    char: 'default',
    peerId: ws.id,
    alive: true
  });
  send(ws, { type: 'joined', roomId: room.id, players: publicPlayers(room), playerIndex: ws.playerIndex });
  broadcastPlayerList(room);
}

function leaveRoom(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  const idx = ws.playerIndex;
  room.sockets.splice(idx, 1);
  room.players.splice(idx, 1);
  room.sockets.forEach((sock, i) => { sock.playerIndex = i; });
  ws.roomId = null;
  ws.playerIndex = -1;

  if (room.players.length === 0 || idx === 0) {
    broadcast(room, { type: 'disconnect', message: idx === 0 ? '主机断开连接' : '房间已关闭' });
    closeRoom(room);
    return;
  }

  if (room.phase === 'playing') endGame(room);
  else broadcastPlayerList(room);
}

function closeRoom(room) {
  clearInterval(room.gameLoop);
  clearInterval(room.syncLoop);
  clearInterval(room.timerLoop);
  clearInterval(room.countdownLoop);
  rooms.delete(room.id);
}

function startCountdown(room) {
  const readyPlayers = room.players.filter(p => p.name);
  if (readyPlayers.length < 2) return;
  room.phase = 'countdown';
  let seconds = 3;
  broadcast(room, { type: 'countdown', seconds });
  clearInterval(room.countdownLoop);
  room.countdownLoop = setInterval(() => {
    seconds -= 1;
    broadcast(room, { type: 'countdown', seconds });
    if (seconds <= 0) {
      clearInterval(room.countdownLoop);
      startGame(room);
    }
  }, 1000);
}

function startGame(room) {
  const count = room.players.length;
  room.phase = 'playing';
  room.snakes = Array.from({ length: count }, () => []);
  room.foods = [];
  room.scores = Array(count).fill(0);
  room.alive = Array(count).fill(true);
  room.dirs = Array(count).fill('RIGHT');
  room.nextDirs = Array(count).fill('RIGHT');
  room.deadUntil = Array(count).fill(0);
  room.deathLen = Array(count).fill(0);
  room.shieldUntil = Array(count).fill(0);
  room.speedUntil = Array(count).fill(0);
  room.lastMove = Array(count).fill(Date.now());
  room.skillActive = Array(count).fill(null);
  room.skillCooldown = Array(count).fill(0);
  room.skillUntil = Array(count).fill(0);
  room.skillUses = room.players.map((p) => {
    const skill = CHARACTERS[p.char]?.skill;
    return skill ? SKILL_DEFS[skill].maxUses : 0;
  });
  room.timeLeft = PVP_GAME_DURATION;

  const occupied = new Set();
  for (let i = 0; i < count; i++) {
    const spawned = spawnSnake(PVP_BASE_LENGTH, occupied);
    room.snakes[i] = spawned.snake;
    room.dirs[i] = spawned.dir;
    room.nextDirs[i] = spawned.dir;
    spawned.snake.forEach(s => occupied.add(`${s.x},${s.y}`));
  }
  for (let i = 0; i < TARGET_FOOD_COUNT; i++) spawnFood(room);

  room.sockets.forEach((sock) => {
    send(sock, { type: 'gameStart', players: publicPlayers(room), playerIndex: sock.playerIndex });
  });

  clearInterval(room.gameLoop);
  clearInterval(room.syncLoop);
  clearInterval(room.timerLoop);
  room.gameLoop = setInterval(() => tick(room), 30);
  room.syncLoop = setInterval(() => broadcastState(room), 66);
  room.timerLoop = setInterval(() => {
    if (room.phase !== 'playing') return;
    room.timeLeft -= 1;
    if (room.timeLeft <= 0) endGame(room);
  }, 1000);
  broadcastState(room);
}

function tick(room) {
  if (room.phase !== 'playing') return;
  const now = Date.now();
  checkRespawns(room, now);
  room.foods = room.foods.filter(f => f.expiresAt > now);
  refill(room);
  for (let i = 0; i < room.players.length; i++) {
    if (!room.alive[i] || !room.snakes[i]?.length) continue;
    const interval = room.speedUntil[i] > now ? Math.floor(PVP_BASE_INTERVAL * SPEED_BOOST_MULTIPLIER) : PVP_BASE_INTERVAL;
    if (now - room.lastMove[i] >= interval) {
      room.lastMove[i] = now;
      movePlayer(room, i);
    }
  }
}

function movePlayer(room, i) {
  const snake = room.snakes[i];
  const dir = room.nextDirs[i] || room.dirs[i];
  room.dirs[i] = dir;
  const head = snake[0];
  const nh = { x: head.x, y: head.y };
  if (dir === 'UP') nh.y -= 1;
  if (dir === 'DOWN') nh.y += 1;
  if (dir === 'LEFT') nh.x -= 1;
  if (dir === 'RIGHT') nh.x += 1;

  const now = Date.now();
  const shielded = room.shieldUntil[i] > now || (room.skillUntil[i] > now && room.skillActive[i]?.skillId === 'shield');
  if (nh.x < 0 || nh.x >= COLS || nh.y < 0 || nh.y >= ROWS) {
    if (!shielded) return killPlayer(room, i);
    nh.x = (nh.x + COLS) % COLS;
    nh.y = (nh.y + ROWS) % ROWS;
  }

  const foodIndex = room.foods.findIndex(f => f.x === nh.x && f.y === nh.y);
  const eating = foodIndex !== -1;
  if (!shielded) {
    const selfBody = eating ? snake : snake.slice(0, -1);
    if (selfBody.some(p => p.x === nh.x && p.y === nh.y)) return killPlayer(room, i);
    for (let j = 0; j < room.snakes.length; j++) {
      if (j === i || !room.alive[j]) continue;
      if (room.snakes[j].some(p => p.x === nh.x && p.y === nh.y)) return killPlayer(room, i);
    }
  }

  snake.unshift(nh);
  if (eating) {
    const food = room.foods.splice(foodIndex, 1)[0];
    applyFood(room, i, food.type);
    spawnFood(room);
  } else {
    snake.pop();
  }
}

function applyFood(room, i, ft) {
  const now = Date.now();
  if (ft.shield) room.shieldUntil[i] = now + 5000;
  else if (ft.speedBoost) room.speedUntil[i] = now + SPEED_BOOST_DURATION;
  room.scores[i] = Math.max(0, room.scores[i] + ft.points);
}

function killPlayer(room, i) {
  const len = room.snakes[i].length || PVP_BASE_LENGTH;
  const respawnLen = Math.max(PVP_BASE_LENGTH, PVP_BASE_LENGTH + Math.floor((len - PVP_BASE_LENGTH) / 2));
  room.scores[i] = Math.max(0, Math.floor(room.scores[i] * (respawnLen / len)));
  room.deathLen[i] = len;
  room.deadUntil[i] = Date.now() + PVP_RESPAWN_MS;
  room.alive[i] = false;
  room.snakes[i] = [];
}

function checkRespawns(room, now) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.deadUntil[i] && now >= room.deadUntil[i] && !room.alive[i]) {
      const occupied = occupiedCells(room);
      const len = PVP_BASE_LENGTH + Math.floor((room.deathLen[i] - PVP_BASE_LENGTH) / 2);
      const spawned = spawnSnake(Math.max(PVP_BASE_LENGTH, len), occupied);
      room.snakes[i] = spawned.snake;
      room.dirs[i] = spawned.dir;
      room.nextDirs[i] = spawned.dir;
      room.alive[i] = true;
      room.deadUntil[i] = 0;
      room.lastMove[i] = now;
    }
  }
}

function useSkill(room, i) {
  const skillId = CHARACTERS[room.players[i]?.char]?.skill;
  const skill = skillId ? SKILL_DEFS[skillId] : null;
  const now = Date.now();
  if (!skill || room.skillUses[i] <= 0 || room.skillCooldown[i] > now || room.skillUntil[i] > now) return;
  room.skillUses[i] -= 1;
  room.skillActive[i] = { skillId: skill.effect, until: now + skill.duration };
  room.skillUntil[i] = now + skill.duration;
  room.skillCooldown[i] = now + skill.cooldown;
}

function spawnSnake(minLen, occupied) {
  const dirs = [
    { dir: 'RIGHT', bdx: -1, bdy: 0 },
    { dir: 'LEFT', bdx: 1, bdy: 0 },
    { dir: 'DOWN', bdx: 0, bdy: -1 },
    { dir: 'UP', bdx: 0, bdy: 1 }
  ];
  const candidates = [];
  for (let x = 1; x < COLS - 1; x++) {
    for (let y = 1; y < ROWS - 1; y++) {
      for (const dc of dirs) {
        const snake = [];
        let ok = true;
        for (let i = 0; i < minLen; i++) {
          const sx = x + dc.bdx * i;
          const sy = y + dc.bdy * i;
          if (sx < 0 || sx >= COLS || sy < 0 || sy >= ROWS || occupied.has(`${sx},${sy}`)) ok = false;
          snake.push({ x: sx, y: sy });
        }
        if (ok) candidates.push({ snake, dir: dc.dir });
      }
    }
  }
  return candidates[Math.floor(Math.random() * candidates.length)] || { snake: [{ x: 5, y: 5 }], dir: 'RIGHT' };
}

function spawnFood(room) {
  const occupied = occupiedCells(room);
  const free = [];
  for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) {
    if (!occupied.has(`${x},${y}`)) free.push({ x, y });
  }
  if (!free.length) return;
  const pos = free[Math.floor(Math.random() * free.length)];
  const type = pickFood();
  room.foods.push({ x: pos.x, y: pos.y, type, expiresAt: Date.now() + type.lifetime });
}

function refill(room) {
  while (room.foods.length < TARGET_FOOD_COUNT) spawnFood(room);
}

function pickFood() {
  let r = Math.random();
  let acc = 0;
  for (const ft of FOOD_TYPES) {
    acc += ft.prob;
    if (r < acc) return ft;
  }
  return FOOD_TYPES[0];
}

function occupiedCells(room) {
  const s = new Set();
  room.snakes.forEach(snake => snake.forEach(p => s.add(`${p.x},${p.y}`)));
  room.foods.forEach(f => s.add(`${f.x},${f.y}`));
  return s;
}

function endGame(room) {
  room.phase = 'over';
  clearInterval(room.gameLoop);
  clearInterval(room.syncLoop);
  clearInterval(room.timerLoop);
  const maxScore = Math.max(...room.scores);
  const winners = room.scores.map((s, i) => s === maxScore ? i : -1).filter(i => i !== -1);
  broadcast(room, {
    type: 'gameOver',
    scores: [...room.scores],
    winnerIdx: winners.length === 1 ? winners[0] : -1,
    tied: winners.length !== 1
  });
}

function broadcastState(room) {
  if (room.phase !== 'playing') return;
  broadcast(room, {
    type: 'state',
    snakes: room.snakes,
    foods: room.foods,
    scores: room.scores,
    alive: room.alive,
    shieldUntil: room.shieldUntil,
    speedUntil: room.speedUntil,
    deadUntil: room.deadUntil,
    skillActive: room.skillActive,
    skillCooldown: room.skillCooldown,
    skillUses: room.skillUses,
    skillUntil: room.skillUntil,
    timeLeft: room.timeLeft
  });
}

function broadcastPlayerList(room) {
  room.sockets.forEach((sock) => {
    send(sock, { type: 'playerList', players: publicPlayers(room), playerIndex: sock.playerIndex });
  });
}

function publicPlayers(room) {
  return room.players.map(p => ({
    name: p.name,
    color: p.color,
    char: p.char,
    peerId: p.peerId
  }));
}

function broadcast(room, msg) {
  room.sockets.forEach(sock => send(sock, msg));
}

function send(ws, msg) {
  ws.send(msg);
}

function sanitizeRoomId(id) {
  const cleaned = String(id || '').trim().replace(/[^\w-]/g, '').slice(0, 24);
  return cleaned || '';
}

function randomRoomId() {
  let id;
  do {
    id = Math.random().toString(36).slice(2, 8);
  } while (rooms.has(id));
  return id;
}

server.listen(PORT, () => {
  console.log(`Snake server running at http://localhost:${PORT}`);
});

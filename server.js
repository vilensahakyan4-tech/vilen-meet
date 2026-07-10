const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const users = new Map();
const sessions = new Map();
const contacts = new Map();
const meetings = new Map();
const roomMessages = new Map();
const roomFiles = new Map();

loadLocalEnv();

function loadLocalEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function safeMeetingCode(value = '') {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

function makeMeetingCode() {
  return `meet-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    login: user.login,
    createdAt: user.createdAt
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
}

function currentUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = sessions.get(token);
  return userId ? users.get(userId) : null;
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) {
    const error = new Error('auth required');
    error.status = 401;
    throw error;
  }
  return user;
}

async function createMeteredRoom(roomName) {
  const appName = process.env.METERED_APP_NAME;
  const secretKey = process.env.METERED_SECRET_KEY;

  if (!appName || !secretKey) {
    const error = new Error('Metered credentials are missing');
    error.status = 503;
    throw error;
  }

  const endpoint = `https://${appName}.metered.live/api/v1/room?secretKey=${encodeURIComponent(secretKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomName,
      privacy: 'public',
      autoJoin: true,
      showInviteBox: false,
      enableChat: true,
      enableScreenSharing: true,
      joinVideoOn: true,
      joinAudioOn: true,
      endMeetingAfterNoActivityInSec: 300,
      ejectAfterElapsedTimeInSec: 4 * 60 * 60,
      deleteOnExp: true,
      expireUnixSec: Math.floor(Date.now() / 1000) + 24 * 60 * 60
    })
  });

  if (!response.ok && response.status !== 409) {
    const error = new Error('Metered room creation failed');
    error.status = 502;
    throw error;
  }

  return `https://${appName}.metered.live/${roomName}`;
}

function buildMeetingResponse(req, meeting) {
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  return {
    code: meeting.code,
    title: meeting.title,
    ownerId: meeting.ownerId || null,
    roomURL: meeting.roomURL,
    joinURL: `${origin}/room.html?code=${encodeURIComponent(meeting.code)}`,
    callURL: `${origin}/call.html?code=${encodeURIComponent(meeting.code)}&room=${encodeURIComponent(meeting.roomURL)}`
  };
}

async function getOrCreateMeeting(req, body = {}, owner = null) {
  const code = safeMeetingCode(body.code) || makeMeetingCode();
  const title = String(body.title || 'VILEN Meet').trim().slice(0, 80) || 'VILEN Meet';

  if (meetings.has(code)) return buildMeetingResponse(req, meetings.get(code));

  const roomURL = await createMeteredRoom(`vilen-${code}`);
  const meeting = {
    code,
    title,
    roomURL,
    ownerId: owner?.id || null,
    createdAt: Date.now()
  };
  meetings.set(code, meeting);
  if (!roomMessages.has(code)) roomMessages.set(code, []);
  if (!roomFiles.has(code)) roomFiles.set(code, []);
  return buildMeetingResponse(req, meeting);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
      const name = String(body.name || body.login || 'Пользователь').trim().slice(0, 60);
      const password = String(body.password || '');
      if (login.length < 3) return json(res, 400, { error: 'login is too short' });
      if (password.length < 4) return json(res, 400, { error: 'password is too short' });
      if ([...users.values()].some(user => user.login === login)) return json(res, 409, { error: 'login already exists' });

      const user = {
        id: crypto.randomUUID(),
        login,
        name,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString()
      };
      users.set(user.id, user);
      contacts.set(user.id, new Set());
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, user.id);
      return json(res, 201, { token, user: publicUser(user) });
    }

    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const login = String(body.login || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = [...users.values()].find(item => item.login === login);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return json(res, 401, { error: 'wrong login or password' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, user.id);
      return json(res, 200, { token, user: publicUser(user) });
    }

    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const user = currentUser(req);
      return json(res, 200, { user: user ? publicUser(user) : null });
    }

    if (url.pathname === '/api/my/rooms' && req.method === 'GET') {
      const user = requireUser(req);
      const items = [...meetings.values()]
        .filter(meeting => meeting.ownerId === user.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(meeting => buildMeetingResponse(req, meeting));
      return json(res, 200, { items });
    }

    if (url.pathname === '/api/users/search' && req.method === 'GET') {
      const user = requireUser(req);
      const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
      if (query.length < 2) return json(res, 200, { items: [] });
      const items = [...users.values()]
        .filter(item => item.id !== user.id)
        .filter(item => item.login.includes(query) || item.name.toLowerCase().includes(query))
        .slice(0, 12)
        .map(publicUser);
      return json(res, 200, { items });
    }

    if (url.pathname === '/api/my/contacts' && req.method === 'GET') {
      const user = requireUser(req);
      const ids = contacts.get(user.id) || new Set();
      const items = [...ids].map(id => users.get(id)).filter(Boolean).map(publicUser);
      return json(res, 200, { items });
    }

    if (url.pathname === '/api/my/contacts' && req.method === 'POST') {
      const user = requireUser(req);
      const body = await readBody(req);
      const targetId = String(body.userId || '');
      const target = users.get(targetId);
      if (!target || target.id === user.id) return json(res, 404, { error: 'user not found' });
      if (!contacts.has(user.id)) contacts.set(user.id, new Set());
      contacts.get(user.id).add(target.id);
      return json(res, 201, { contact: publicUser(target) });
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, { status: 'ok', app: 'VILEN Meet' });
    }

    if (url.pathname === '/api/meetings' && req.method === 'POST') {
      const user = currentUser(req);
      const body = await readBody(req);
      const existed = body.code && meetings.has(safeMeetingCode(body.code));
      return json(res, existed ? 200 : 201, await getOrCreateMeeting(req, body, user));
    }

    if (url.pathname === '/api/rooms' && req.method === 'POST') {
      const user = currentUser(req);
      const body = await readBody(req);
      const existed = body.code && meetings.has(safeMeetingCode(body.code));
      return json(res, existed ? 200 : 201, await getOrCreateMeeting(req, body, user));
    }

    if ((url.pathname === '/api/meetings' || url.pathname === '/api/rooms') && req.method === 'GET') {
      const code = safeMeetingCode(url.searchParams.get('code'));
      const meeting = meetings.get(code);
      if (!meeting) return json(res, 404, { error: 'meeting not found' });
      return json(res, 200, buildMeetingResponse(req, meeting));
    }

    const roomApi = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/(messages|files)$/);
    if (roomApi) {
      const code = safeMeetingCode(roomApi[1]);
      const kind = roomApi[2];
      if (!meetings.has(code)) return json(res, 404, { error: 'room not found' });

      if (kind === 'messages') {
        if (!roomMessages.has(code)) roomMessages.set(code, []);
        if (req.method === 'GET') {
          return json(res, 200, { items: roomMessages.get(code) });
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const text = String(body.text || '').trim().slice(0, 1200);
          if (!text) return json(res, 400, { error: 'message is empty' });
          const item = {
            id: crypto.randomUUID(),
            author: String(body.author || 'Гость').trim().slice(0, 60) || 'Гость',
            text,
            createdAt: new Date().toISOString()
          };
          const items = roomMessages.get(code);
          items.push(item);
          if (items.length > 200) items.splice(0, items.length - 200);
          return json(res, 201, item);
        }
      }

      if (kind === 'files') {
        if (!roomFiles.has(code)) roomFiles.set(code, []);
        if (req.method === 'GET') {
          return json(res, 200, { items: roomFiles.get(code) });
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const name = String(body.name || 'file').trim().slice(0, 120);
          const dataUrl = String(body.dataUrl || '');
          if (!dataUrl.startsWith('data:') || dataUrl.length > 2_800_000) {
            return json(res, 400, { error: 'file is too large or invalid' });
          }
          const item = {
            id: crypto.randomUUID(),
            name,
            size: Number(body.size || 0),
            type: String(body.type || 'application/octet-stream').slice(0, 120),
            dataUrl,
            author: String(body.author || 'Гость').trim().slice(0, 60) || 'Гость',
            createdAt: new Date().toISOString()
          };
          const items = roomFiles.get(code);
          items.push(item);
          if (items.length > 50) items.splice(0, items.length - 50);
          return json(res, 201, item);
        }
      }

      return json(res, 405, { error: 'method not allowed' });
    }

    const requestedPath = url.pathname === '/'
      ? 'index.html'
      : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let filePath = path.join(PUBLIC, requestedPath);
    if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC, 'index.html');
    }

    res.writeHead(200, {
      'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    json(res, error.status || 500, { error: error.message || 'server error' });
  }
});

setInterval(() => {
  const old = Date.now() - 24 * 60 * 60 * 1000;
  for (const [code, meeting] of meetings) {
    if (meeting.createdAt < old) meetings.delete(code);
  }
}, 60 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`VILEN Meet running: http://localhost:${PORT}`);
});

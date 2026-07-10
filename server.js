const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const meetings = new Map();

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
    roomURL: meeting.roomURL,
    joinURL: `${origin}/call.html?code=${encodeURIComponent(meeting.code)}&room=${encodeURIComponent(meeting.roomURL)}`
  };
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
    if (url.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, { status: 'ok', app: 'VILEN Meet' });
    }

    if (url.pathname === '/api/meetings' && req.method === 'POST') {
      const body = await readBody(req);
      const code = safeMeetingCode(body.code) || makeMeetingCode();
      const title = String(body.title || 'VILEN Meet').trim().slice(0, 80) || 'VILEN Meet';

      if (meetings.has(code)) {
        return json(res, 200, buildMeetingResponse(req, meetings.get(code)));
      }

      const roomURL = await createMeteredRoom(`vilen-${code}`);
      const meeting = {
        code,
        title,
        roomURL,
        createdAt: Date.now()
      };
      meetings.set(code, meeting);
      return json(res, 201, buildMeetingResponse(req, meeting));
    }

    if (url.pathname === '/api/meetings' && req.method === 'GET') {
      const code = safeMeetingCode(url.searchParams.get('code'));
      const meeting = meetings.get(code);
      if (!meeting) return json(res, 404, { error: 'meeting not found' });
      return json(res, 200, buildMeetingResponse(req, meeting));
    }

    let filePath = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
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

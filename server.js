const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 4500;
const INHOUSE_SERVER_URL = (process.env.INHOUSE_SERVER_URL || '').replace(/\/+$/, '');
const BOT_API_URL = (process.env.BOT_API_URL || '').replace(/\/+$/, '');

// Railway Volume 또는 환경변수로 DATA_DIR 결정 (배포해도 데이터 유지)
const IS_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (IS_RAILWAY && fs.existsSync('/data')) return '/data';
  return path.join(__dirname, 'data');
}
const DATA_DIR = resolveDataDir();
console.log(`[DATA] DATA_DIR: ${DATA_DIR}`);

// ── 배팅 밸런스 상수 ──
const BET_MAX      = 20;    // 1판 최대 배팅 포인트
const BET_MAX_MULT = 2.0;   // 배당 상한 (풀 쏠려도 최대 2배)
const BET_RAKE     = 0.10;  // 하우스 수수료 10% → 실질 최대 1.8x

// ── Data files ──
const VIEWERS_FILE    = path.join(DATA_DIR, 'viewers.json');
const BETTING_FILE    = path.join(DATA_DIR, 'betting.json');
const SHOP_FILE       = path.join(DATA_DIR, 'shop.json');
const TIMING_WIN_FILE = path.join(DATA_DIR, 'timing-winner.json');
const POSTS_FILE      = path.join(DATA_DIR, 'posts.json');
const COMMENTS_FILE   = path.join(DATA_DIR, 'comments.json');
const FEED_FILE       = path.join(DATA_DIR, 'feed.json');

// data/ 디렉토리 자동 생성 (Railway 배포 시 없으면 크래시 방지)
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
if (!fs.existsSync(POSTS_FILE))    writeJSON(POSTS_FILE,    { posts: [] });
if (!fs.existsSync(COMMENTS_FILE)) writeJSON(COMMENTS_FILE, {});
if (!fs.existsSync(FEED_FILE))     writeJSON(FEED_FILE,     { items: [] });

const POINT_LOG_CHANNEL = process.env.POINT_LOG_CHANNEL_ID || '1519309432394219583';
const BOT_API_SECRET_VIEWER = process.env.BOT_API_SECRET || '';

// ── 피드 헬퍼 ──
function addFeed(kind, viewer, data) {
  try {
    const feed = readJSON(FEED_FILE, { items: [] });
    feed.items.unshift({ kind, viewer, at: Date.now(), ...data });
    feed.items = feed.items.slice(0, 50); // 최대 50개 유지
    writeJSON(FEED_FILE, feed);
    broadcast({ type: 'feed_update', items: feed.items.slice(0, 10) });
  } catch {}
}

const ADMIN_SECRET          = process.env.ADMIN_SECRET;
if (!ADMIN_SECRET) { console.error('[SECURITY] ADMIN_SECRET 환경변수 미설정 — 서버를 시작할 수 없습니다'); process.exit(1); }
const VIEWER_SERVER_SECRET  = process.env.VIEWER_SERVER_SECRET  || 'davido-admin';
const SESSION_SECRET        = process.env.SESSION_SECRET        || 'davido-timing-secret';

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── Initial data ──
if (!fs.existsSync(VIEWERS_FILE))  writeJSON(VIEWERS_FILE,  {});
if (!fs.existsSync(BETTING_FILE))  writeJSON(BETTING_FILE, {
  status: 'idle',     // 'idle' | 'open' | 'locked' | 'ended'
  blueTeam: { name: '블루팀', members: [] },
  redTeam:  { name: '레드팀', members: [] },
  bets: {},           // { viewerName: { team: 'blue'|'red', amount: number } }
  result: null,       // 'blue' | 'red' | null
  startedAt: null,
  lockedAt: null,
});
if (!fs.existsSync(SHOP_FILE)) writeJSON(SHOP_FILE, {
  items: [
    { id: 'priority', name: '선참권',  desc: '다음 내전 팀 배치 선택 우선권', price: 120, stock: -1, icon: '⭐', rarity: 'common'   },
    { id: 'no_ban',   name: '노밴권',  desc: '다음 내전 밴 페이즈 면제',       price: 240, stock: -1, icon: '🛡️', rarity: 'uncommon' },
    { id: 'all_day',  name: '종일권',  desc: '당일 모든 내전 참가 가능',       price: 460, stock: -1, icon: '🌙', rarity: 'rare'     },
    { id: 'extend',   name: '연장권',  desc: '내전 1판 추가 연장',             price: 600, stock: -1, icon: '⚡', rarity: 'epic'     },
  ]
});

// ── 파일 기반 세션 (Railway Volume에 저장 → 배포해도 로그인 유지) ──
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
if (!fs.existsSync(SESSIONS_FILE)) writeJSON(SESSIONS_FILE, {});

// 인메모리 세션 캐시 (파일 I/O 최소화)
let _sessions = readJSON(SESSIONS_FILE, {});

function makeSessionToken(name, chzzkUid = '', ip = '') {
  const token = crypto.randomBytes(32).toString('hex');
  _sessions[token] = { name, chzzkUid, ip, createdAt: Date.now() };
  // 오래된 세션 정리 (1년 이상)
  const cutoff = Date.now() - 365 * 24 * 3600 * 1000;
  let dirty = false;
  for (const k of Object.keys(_sessions)) {
    if (_sessions[k].createdAt < cutoff) { delete _sessions[k]; dirty = true; }
  }
  writeJSON(SESSIONS_FILE, _sessions);
  return token;
}

function getSessionName(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/vsession=([a-f0-9]{64})/);
  if (!m) return null;
  const session = _sessions[m[1]];
  return session ? session.name : null;
}

function deleteSession(token) {
  delete _sessions[token];
  writeJSON(SESSIONS_FILE, _sessions);
}

// ── Viewer helpers ──
function getViewer(name) {
  const viewers = readJSON(VIEWERS_FILE, {});
  if (!viewers[name]) viewers[name] = { name, points: 0, bets: 0, wins: 0, purchases: [] };
  const v = viewers[name];
  // 피로도 초기화 (필드 없으면 기본값)
  if (v.fatigue === undefined) v.fatigue = 100;
  // 매일 자정 KST 자동 30 회복
  const today = new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  if (v.fatigueResetDate !== today) {
    v.fatigue = 100; // 매일 자정 완전 충전
    v.fatigueResetDate = today;
  }
  return { viewers, viewer: v };
}
function saveViewer(viewers) { writeJSON(VIEWERS_FILE, viewers); }

// ── 피로도 헬퍼 ──
const FATIGUE_MAX = 100;
const FATIGUE_COST = { timing: 5, ms: 2, crash: 10 };

function checkFatigue(name, cost) {
  const { viewers, viewer } = getViewer(name);
  const cur = viewer.fatigue ?? FATIGUE_MAX;
  if (cur < cost) return { ok: false, fatigue: cur, error: `피로도가 부족합니다 (필요 ${cost}, 보유 ${cur}) — 상점에서 회복 아이템을 구매하세요` };
  viewer.fatigue = cur - cost;
  saveViewer(viewers);
  return { ok: true, fatigue: viewer.fatigue };
}

function recoverFatigue(name, amount) {
  const { viewers, viewer } = getViewer(name);
  viewer.fatigue = Math.min(FATIGUE_MAX, (viewer.fatigue ?? 0) + amount);
  saveViewer(viewers);
  return viewer.fatigue;
}

app.get('/api/fatigue', (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  const { viewer } = getViewer(name);
  res.json({ ok: true, fatigue: viewer.fatigue ?? FATIGUE_MAX, max: FATIGUE_MAX, cost: FATIGUE_COST });
});

// ── Broadcast ──
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── 보안 경고 ──
if (!process.env.SESSION_SECRET) console.warn('[SECURITY] SESSION_SECRET 환경변수 미설정 — Railway Variables에 추가하세요');
if (!process.env.VIEWER_SERVER_SECRET) console.warn('[SECURITY] VIEWER_SERVER_SECRET 환경변수 미설정');

// ── 인메모리 레이트 리미터 ──
const rlStore = new Map();
function rl(key, limit, windowSec) {
  const now = Date.now(), win = windowSec * 1000;
  let rec = rlStore.get(key);
  if (!rec || now > rec.reset) rec = { count: 0, reset: now + win };
  rec.count++;
  rlStore.set(key, rec);
  return rec.count <= limit;
}
// 10분마다 만료된 항목 정리
setInterval(() => { const now = Date.now(); for (const [k,v] of rlStore) if (now > v.reset + 60000) rlStore.delete(k); }, 600000);

function getIp(req) { return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(); }

// ── Middleware ──
app.use(express.json({ limit: '20mb' })); // 이미지 base64 포함
// 보안 헤더
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; " +
    "media-src 'self' https:; " +
    "frame-src https://www.youtube.com https://clips.twitch.tv https://player.twitch.tv; " +
    "connect-src 'self' wss:;"
  );
  next();
});
// 전체 IP 레이트 리밋 (분당 300회)
app.use((req, res, next) => {
  if (req.method !== 'GET' && !rl('ip:' + getIp(req), 300, 60)) return res.status(429).json({ ok: false, error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ── 치지직 채팅 인증 ──
const pendingAuth = {}; // { TOKEN: { name:null, createdAt, expiresAt } }

function cleanPending() {
  const now = Date.now();
  Object.keys(pendingAuth).forEach(k => { if (pendingAuth[k].expiresAt < now) delete pendingAuth[k]; });
}

// 임시 코드 발급
app.get('/api/auth/pending', async (req, res) => {
  cleanPending();
  const ip = getClientIp(req);

  // IP 밴 즉시 차단
  if (ip && _banned.ips.includes(ip)) return res.json({ ok: false, status: 'banned' });

  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const token = Array.from({length:5}, ()=>CHARS[Math.floor(Math.random()*CHARS.length)]).join('');
  pendingAuth[token] = { name: null, ip, createdAt: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000 };
  res.json({ ok: true, token });
});

// 프론트가 2초마다 폴링
app.get('/api/auth/poll/:token', async (req, res) => {
  const p = pendingAuth[req.params.token?.toUpperCase()];
  if (!p || p.expiresAt < Date.now()) return res.json({ ok: false, status: 'expired' });
  if (!p.name) return res.json({ ok: false, status: 'pending' });
  // 확인 완료 → 세션 발급
  const name = p.name;
  const chzzkUid = p.chzzkUid || '';
  const ip = p.ip || getClientIp(req);

  // IP 밴 재확인
  if (isBanned(null, null, ip)) {
    delete pendingAuth[req.params.token.toUpperCase()];
    return res.json({ ok: false, status: 'expired' }); // 조용히 만료 처리
  }

  // VPN/프록시 탐지 (비동기, 결과 기다림)
  const vpnCheck = await checkVpn(ip);
  if (vpnCheck.isVpn) {
    console.log(`[auth] VPN/프록시 감지 차단: ${name} @ ${ip} (proxy:${vpnCheck.proxy} hosting:${vpnCheck.hosting})`);
    delete pendingAuth[req.params.token.toUpperCase()];
    return res.json({ ok: false, status: 'expired' }); // 조용히 만료 처리
  }

  delete pendingAuth[req.params.token.toUpperCase()];
  const sessionToken = makeSessionToken(name, chzzkUid, ip);
  const { viewers, viewer } = getViewer(name);
  saveViewer(viewers);
  res.setHeader('Set-Cookie', `vsession=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${10 * 365 * 24 * 3600}`);
  res.json({ ok: true, status: 'confirmed', viewer });
});

// 봇이 채팅 감지 후 호출
// 사칭 방지용 예약 닉네임 목록
const RESERVED_NAMES = (process.env.RESERVED_NAMES || '다비도,관리자,admin,ADMIN,운영자,davido')
  .split(',').map(s => s.trim().toLowerCase());

// ── 밴 시스템 (닉네임 + Chzzk UID + IP) ──
const BANNED_FILE = path.join(DATA_DIR, 'banned.json');
if (!fs.existsSync(BANNED_FILE)) writeJSON(BANNED_FILE, { names: [], uids: [], ips: [] });
let _banned = (() => {
  const d = readJSON(BANNED_FILE, { names: [], uids: [], ips: [] });
  if (Array.isArray(d)) return { names: d, uids: [], ips: [] };
  return { names: d.names || [], uids: d.uids || [], ips: d.ips || [] };
})();

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || '';
}

function saveBanned() { writeJSON(BANNED_FILE, _banned); }

function isBanned(name, uid, ip) {
  if (name && _banned.names.includes(name)) return true;
  if (uid  && _banned.uids.includes(uid))   return true;
  if (ip   && _banned.ips.includes(ip))     return true;
  return false;
}

function banUser(name, uid, ip) {
  if (name && !_banned.names.includes(name)) _banned.names.push(name);
  if (uid  && !_banned.uids.includes(uid))   _banned.uids.push(uid);
  if (ip   && !_banned.ips.includes(ip))     _banned.ips.push(ip);
  saveBanned();
  for (const [t, s] of Object.entries(_sessions)) {
    const sName = typeof s === 'string' ? s : s?.name;
    if (sName === name) delete _sessions[t];
  }
  writeJSON(SESSIONS_FILE, _sessions);
}

function unbanUser(name) {
  _banned.names = _banned.names.filter(n => n !== name);
  saveBanned();
}

function unbanIp(ip) {
  _banned.ips = _banned.ips.filter(i => i !== ip);
  saveBanned();
}

function kickUser(name) {
  for (const [t, s] of Object.entries(_sessions)) {
    if ((typeof s === 'string' ? s : s?.name) === name) delete _sessions[t];
  }
  writeJSON(SESSIONS_FILE, _sessions);
}

// VPN/프록시 탐지 (ip-api.com 무료)
async function checkVpn(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.')) return { isVpn: false };
  try {
    const r = await Promise.race([
      getJson(`http://ip-api.com/json/${ip}?fields=status,proxy,hosting,query`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))
    ]);
    return { isVpn: !!(r.proxy || r.hosting), proxy: r.proxy, hosting: r.hosting };
  } catch { return { isVpn: false }; }
}

// ── 관리자 확인 미들웨어 ──
function requireAdmin(req, res, next) {
  const name = getSessionName(req);
  const admins = (process.env.ADMIN_NICKNAMES || '다비도').split(',').map(s => s.trim());
  if (!name || !admins.includes(name)) return res.status(403).json({ ok: false, error: '관리자 권한 필요' });
  next();
}

// ── 관리자 API: 유저 목록 ──
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const nameMap = {};
  for (const [t, s] of Object.entries(_sessions)) {
    const name = typeof s === 'string' ? s : s?.name;
    const uid  = typeof s === 'object' ? (s?.chzzkUid || '') : '';
    const ip   = typeof s === 'object' ? (s?.ip || '') : '';
    const createdAt = typeof s === 'object' ? s?.createdAt : 0;
    if (!name) continue;
    if (!nameMap[name]) nameMap[name] = { name, uid, ip, sessions: 0, lastSeen: 0, banned: isBanned(name, uid, ip) };
    nameMap[name].sessions++;
    if (createdAt > nameMap[name].lastSeen) { nameMap[name].lastSeen = createdAt; nameMap[name].ip = ip; }
  }
  const users = Object.values(nameMap).sort((a, b) => b.lastSeen - a.lastSeen);
  res.json({ ok: true, users, banned: _banned.names, bannedUids: _banned.uids, bannedIps: _banned.ips });
});

// ── 관리자 API: 킥 (세션 삭제, 재로그인 가능) ──
app.post('/api/admin/kick', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ ok: false, error: 'name 필요' });
  kickUser(name);
  res.json({ ok: true, message: `${name} 세션 삭제됨` });
});

// ── 관리자 API: 밴 (닉네임 + UID + IP 동시) ──
app.post('/api/admin/ban', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ ok: false, error: 'name 필요' });
  const sess = Object.values(_sessions).find(s => (typeof s === 'object' ? s?.name : s) === name);
  const uid = sess?.chzzkUid || '';
  const ip  = sess?.ip || '';
  banUser(name, uid, ip);
  res.json({ ok: true, message: `${name} 밴됨`, uid: uid ? uid.slice(0,8)+'...' : '없음', ip: ip || '없음' });
});

// ── 관리자 API: IP 단독 밴 ──
app.post('/api/admin/ban-ip', requireAdmin, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.json({ ok: false, error: 'ip 필요' });
  if (!_banned.ips.includes(ip)) { _banned.ips.push(ip); saveBanned(); }
  res.json({ ok: true, message: `${ip} IP 밴됨` });
});

// ── 관리자 API: IP 언밴 ──
app.post('/api/admin/unban-ip', requireAdmin, (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.json({ ok: false, error: 'ip 필요' });
  unbanIp(ip);
  res.json({ ok: true, message: `${ip} IP 밴 해제됨` });
});

// ── 관리자 API: 언밴 ──
app.post('/api/admin/unban', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ ok: false, error: 'name 필요' });
  unbanUser(name);
  res.json({ ok: true, message: `${name} 밴 해제됨` });
});

app.post('/api/auth/confirm', (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: '권한 없음' });
  const { token, name } = req.body;
  if (!token || !name) return res.json({ ok: false, error: 'token, name 필요' });

  // 예약 닉네임 사칭 차단
  const nameLower = name.trim().toLowerCase();
  if (RESERVED_NAMES.some(r => nameLower === r || nameLower.includes(r))) {
    return res.json({ ok: false, error: '사용할 수 없는 닉네임입니다' });
  }

  const key = token.toUpperCase();
  const p = pendingAuth[key];
  if (!p) return res.json({ ok: false, error: '코드 없음 또는 만료' });
  if (p.expiresAt < Date.now()) { delete pendingAuth[key]; return res.json({ ok: false, error: '코드 만료' }); }

  const chzzkUid = (req.body.chzzkUid || '').trim();

  // 밴 유저: 닉네임 OR UID 중 하나라도 밴되면 조용히 무시 (타임아웃)
  if (isBanned(name.trim(), chzzkUid)) {
    return res.json({ ok: true, message: '인증 완료' });
  }

  p.name = name.trim();
  p.chzzkUid = chzzkUid; // 세션에 UID 저장
  res.json({ ok: true, message: `${name} 인증 완료` });
});

// ── Auth: login (nickname only for now) ──
// ── 로컬 개발용 빠른 로그인 (localhost 에서만 동작) ──
app.get('/dev-login', (req, res) => {
  const host = req.headers.host || '';
  if (!host.startsWith('localhost') && !host.startsWith('127.')) {
    return res.status(403).send('로컬에서만 사용 가능');
  }
  const name = req.query.name || '다비도';
  const token = makeSessionToken(name);
  res.setHeader('Set-Cookie', `vsession=${token}; Path=/; Max-Age=${10*365*24*3600}`);
  res.redirect('/');
});

// /api/login 비활성화 — 치지직 인증(auth/confirm)만 허용, 직접 닉네임 입력은 사칭 방지를 위해 차단
app.post('/api/login', (req, res) => {
  return res.status(403).json({ ok: false, error: '직접 로그인은 지원하지 않습니다. 치지직 채팅 인증을 이용해주세요.' });
});

app.post('/api/logout', (req, res) => {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/vsession=([a-f0-9]{64})/);
  if (m) deleteSession(m[1]);
  res.setHeader('Set-Cookie', 'vsession=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

function postJson(url, payload, extraHeaders) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ...(extraHeaders||{}) },
      timeout: 8000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('parse_error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// 디스코드 포인트 로그 전송 (postJson 이후에 위치)
function sendPointLog(nickname, delta, afterPts, reason) {
  if (!BOT_API_URL || !BOT_API_SECRET_VIEWER) return;
  const sign = delta >= 0 ? '+' : '';
  const emoji = delta >= 0 ? '🟢' : '🔴';
  const src = '시청자사이트';
  const content = `${emoji} [${src}] **${nickname}** ${sign}${delta}P → ${afterPts}P${reason ? `  |  ${reason}` : ''}`;
  postJson(`${BOT_API_URL}/api/send-channel-message`, {
    secret: BOT_API_SECRET_VIEWER,
    channelId: POINT_LOG_CHANNEL,
    content
  }).catch(e => console.warn('[POINT_LOG]', e.message));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('parse')); } });
    }).on('error', reject);
  });
}

// ── Viewer info ──
app.get('/api/me', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false });
  const { viewers, viewer } = getViewer(name);
  if (!readJSON(VIEWERS_FILE, {})[name]) saveViewer(viewers); // 배포 후 파일 초기화 시 재등록
  let inhousePoints = null;
  if (INHOUSE_SERVER_URL) {
    try {
      const data = await getJson(`${INHOUSE_SERVER_URL}/api/viewer-points?nickname=${encodeURIComponent(name)}`);
      if (data.ok) inhousePoints = data.points;
    } catch {}
  }
  res.json({ ok: true, viewer, inhousePoints });
});

// ── Betting ──
app.get('/api/bet/status', (req, res) => {
  res.json(readJSON(BETTING_FILE, {}));
});

app.post('/api/bet/place', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  const { team, amount } = req.body;
  if (!['blue','red'].includes(team)) return res.json({ ok: false, error: '잘못된 팀' });
  const amt = parseInt(amount);
  if (!amt || amt < 1)  return res.json({ ok: false, error: '최소 1포인트' });
  if (amt > BET_MAX)    return res.json({ ok: false, error: `최대 ${BET_MAX}p까지 배팅 가능` });

  const betting = readJSON(BETTING_FILE, {});
  if (betting.status !== 'open') return res.json({ ok: false, error: '배팅 시간이 아닙니다' });
  if (betting.bets[name]) return res.json({ ok: false, error: '이미 배팅했습니다' });

  // 인하우스 DB에서 실제 포인트 차감
  if (!INHOUSE_SERVER_URL) return res.json({ ok: false, error: '서버 연결 오류' });
  try {
    const dr = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-deduct`,
      { nickname: name, amount: amt },
      { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
    if (!dr.ok) return res.json({ ok: false, error: dr.error || '포인트 부족' });
  } catch(e) { return res.json({ ok: false, error: e.message }); }

  betting.bets[name] = { team, amount: amt };
  writeJSON(BETTING_FILE, betting);
  broadcast({ type: 'bet_update', bets: betting.bets, status: betting.status });
  addFeed('bet', name, { team, amount: amt, reason: `${team === 'blue' ? '🔵 블루' : '🔴 레드'}팀에 ${amt}P 배팅` });
  res.json({ ok: true });
});

// ── 배팅 자동 마감 타이머 ──
const BET_DURATION_MS = 3 * 60 * 1000; // 3분
let betAutoLockTimer = null;
function clearBetTimer() { if (betAutoLockTimer) { clearTimeout(betAutoLockTimer); betAutoLockTimer = null; } }
function startBetTimer() {
  clearBetTimer();
  betAutoLockTimer = setTimeout(() => {
    const betting = readJSON(BETTING_FILE, {});
    if (betting.status === 'open') {
      betting.status = 'locked';
      betting.lockedAt = Date.now();
      writeJSON(BETTING_FILE, betting);
      broadcast({ type: 'bet_update', ...betting });
      console.log('[BET] 3분 경과 → 배팅 자동 마감');
    }
  }, BET_DURATION_MS);
}

// ── Admin: betting control ──
app.post('/api/admin/bet', async (req, res) => {
  const { action, blueTeam, redTeam, result } = req.body;
  const secret = req.headers['x-admin-secret'];
  if (secret !== (ADMIN_SECRET)) return res.status(403).json({ ok: false });

  const betting = readJSON(BETTING_FILE, {});

  if (action === 'open') {
    betting.status = 'open';
    betting.bets = {};
    betting.result = null;
    betting.blueTeam = blueTeam || betting.blueTeam;
    betting.redTeam  = redTeam  || betting.redTeam;
    betting.startedAt = Date.now();
    betting.betDeadline = Date.now() + BET_DURATION_MS; // 마감 시각
    betting.lockedAt = null;
    startBetTimer();
  } else if (action === 'lock') {
    betting.status = 'locked';
    betting.lockedAt = Date.now();
  } else if (action === 'resolve') {
    betting.status = 'ended';
    betting.result = result; // 'blue' | 'red'
    // 배당 계산: 풀 기반 배당, 상한 BET_MAX_MULT, 하우스 수수료 BET_RAKE 차감
    const blueTot = Object.values(betting.bets).filter(b=>b.team==='blue').reduce((s,b)=>s+b.amount,0);
    const redTot  = Object.values(betting.bets).filter(b=>b.team==='red').reduce((s,b)=>s+b.amount,0);
    const totalPool = blueTot + redTot;
    const winnerPool = result === 'blue' ? blueTot : redTot;
    // 인하우스 DB에 당첨 포인트 지급 (병렬)
    const grantPromises = Object.entries(betting.bets)
      .filter(([, b]) => b.team === result)
      .map(async ([n, b]) => {
        const rawMult = totalPool / (winnerPool || 1);
        const mult = Math.min(rawMult, BET_MAX_MULT);
        const gain = Math.floor(b.amount * mult * (1 - BET_RAKE));
        betting.bets[n].payout = gain;
        if (INHOUSE_SERVER_URL && gain > 0) {
          try {
            await postJson(`${INHOUSE_SERVER_URL}/api/viewer-grant`,
              { nickname: n, amount: gain },
              { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
          } catch(e) { console.error('[BET] 당첨 지급 실패:', n, gain, e.message); }
        }
      });
    await Promise.all(grantPromises);
  } else if (action === 'ended') {
    betting.status = 'ended';
    betting.result = null;
    clearBetTimer();
  } else if (action === 'idle') {
    betting.status = 'idle';
    clearBetTimer();
  }

  writeJSON(BETTING_FILE, betting);
  broadcast({ type: 'bet_update', ...betting });
  res.json({ ok: true, betting });
});

// ── Admin: give points (인하우스 DB 연동) ──
app.post('/api/admin/points', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== ADMIN_SECRET) return res.status(403).json({ ok: false });
  const { name, delta } = req.body;
  if (!INHOUSE_SERVER_URL) return res.json({ ok: false, error: 'INHOUSE_SERVER_URL 미설정' });
  try {
    const endpoint = delta > 0 ? 'viewer-grant' : 'viewer-deduct';
    const r = await postJson(`${INHOUSE_SERVER_URL}/api/${endpoint}`,
      { nickname: name, amount: Math.abs(delta) },
      { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
    if (!r.ok) return res.json({ ok: false, error: r.error });
    broadcast({ type: 'points_update', name, points: r.points });
    res.json({ ok: true, points: r.points });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── Shop ──
app.get('/api/shop', (req, res) => {
  res.json(readJSON(SHOP_FILE, { items: [] }));
});

app.post('/api/shop/buy', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  const { itemId } = req.body;

  const shopData = readJSON(SHOP_FILE, { items: [] });
  const item = shopData.items.find(i => i.id === itemId);
  if (!item) return res.json({ ok: false, error: '아이템 없음' });
  if (item.stock === 0) return res.json({ ok: false, error: '품절' });
  if (!INHOUSE_SERVER_URL) return res.json({ ok: false, error: 'INHOUSE_SERVER_URL 미설정' });

  try {
    // 인하우스 서버에서 포인트 차감 + 보관함봇 추가
    const r = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-shop-buy`, {
      nickname: name, itemName: item.name, price: item.price
    }, { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });

    if (!r.ok) return res.json({ ok: false, error: r.error || '구매 실패' });

    // 스톡 감소
    if (item.stock > 0) { item.stock--; writeJSON(SHOP_FILE, shopData); }
    broadcast({ type: 'shop_update', items: shopData.items });
    addFeed('shop', name, { item: item.name, price: item.price, reason: `🛒 ${item.name} 구매 (-${item.price}P)` });
    res.json({ ok: true, points: r.points, item });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── Inhouse Snapshot (for index_5 dashboard) ──
const ANN_FILE = path.join(DATA_DIR, 'announcements.json');
if (!fs.existsSync(ANN_FILE)) writeJSON(ANN_FILE, { items: [] });

app.get('/api/inhouse/snapshot', (req, res) => {
  const viewers  = readJSON(VIEWERS_FILE, {});
  const betting  = readJSON(BETTING_FILE, {});

  const viewers_total = Object.keys(viewers).length;
  const ranking = [];

  // 실시간 피드: feed.json에서 최근 10개
  const feed = readJSON(FEED_FILE, { items: [] }).items.slice(0, 10);

  // 내전 상태
  const inhouse = {
    status: betting.status || 'idle',
    blueTeam: betting.blueTeam || { name: '블루팀', members: [] },
    redTeam:  betting.redTeam  || { name: '레드팀',  members: [] },
  };

  res.json({ ok: true, viewers_total, ranking, feed, vote: null, inhouse });
});

// ── 타이밍 복권 ──
const timingSessions = new Map(); // sessionId → { targetMs, startedAt, name, date }

function getTodayKST() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
}
function getDailyTargetMs() {
  const today = getTodayKST();
  const hash = crypto.createHmac('sha256', SESSION_SECRET).update('timing-' + today).digest('hex');
  return (parseInt(hash.slice(0, 8), 16) % 19000) + 1000; // 1.00 ~ 19.99초
}
// 당첨자 조회 — 인하우스 서버 우선 (3초 타임아웃), fallback 로컬
async function getTimingWinner() {
  if (INHOUSE_SERVER_URL) {
    try {
      const d = await Promise.race([
        getJson(`${INHOUSE_SERVER_URL}/api/viewer-timing-winner`),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000))
      ]);
      if (d && d.date === getTodayKST()) return d.winner || null;
      return null;
    } catch {}
  }
  try {
    const saved = readJSON(TIMING_WIN_FILE, {});
    return saved.date === getTodayKST() ? (saved.winner || null) : null;
  } catch { return null; }
}

// 당첨자 저장 — 인하우스 서버 + 로컬 동시
// 이중 당첨 방지용 인메모리 락
let timingWinnerSaving = false;

async function saveTimingWinner(date, winner) {
  const data = { date, winner };
  writeJSON(TIMING_WIN_FILE, data); // 로컬 백업
  if (INHOUSE_SERVER_URL) {
    try {
      await postJson(`${INHOUSE_SERVER_URL}/api/viewer-timing-winner`, data,
        { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
    } catch {}
  }
}

app.get('/api/game/timing/state', async (req, res) => {
  try {
    const targetMs = getDailyTargetMs();
    const winner = await getTimingWinner();
    res.json({ ok: true, targetMs, status: winner ? 'won' : 'open', winner, date: getTodayKST() });
  } catch(e) {
    console.error('[TIMING STATE]', e.message);
    try { res.json({ ok: true, targetMs: getDailyTargetMs(), status: 'open', winner: null, date: getTodayKST() }); }
    catch { res.json({ ok: true, targetMs: 10000, status: 'open', winner: null, date: getTodayKST() }); }
  }
});

app.post('/api/game/timing/start', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  if (await getTimingWinner()) return res.json({ ok: false, error: '오늘은 이미 당첨자가 나왔습니다!' });
  if (!INHOUSE_SERVER_URL) return res.json({ ok: false, error: 'INHOUSE_SERVER_URL 미설정' });
  try {
    // 포인트 차감 먼저 (실패 시 레이트리밋 카운트 소모 안 됨)
    const r = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-deduct`,
      { nickname: name, amount: 1, reason: '⏱ 타이밍 복권 도전 (-1P)' },
      { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
    if (!r.ok) return res.json({ ok: false, error: r.error || '포인트 부족' });
    // 포인트 차감 성공 후에만 레이트리밋 체크
    if (!rl(`timing-day:${name}`, 50, 86400)) {
      // 이미 차감됐으므로 환불
      postJson(`${INHOUSE_SERVER_URL}/api/viewer-grant`, { nickname: name, amount: 1, reason: '⏱ 타이밍 복권 환불' }, { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' }).catch(()=>{});
      return res.status(429).json({ ok: false, error: '오늘 도전 횟수를 초과했습니다 (하루 50회)' });
    }
    if (!rl(`timing-min:${name}`, 5, 60)) {
      postJson(`${INHOUSE_SERVER_URL}/api/viewer-grant`, { nickname: name, amount: 1 }, { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' }).catch(()=>{});
      return res.status(429).json({ ok: false, error: '너무 빠르게 시도하고 있습니다. 잠시 후 다시 시도하세요.' });
    }
    const sessionId = crypto.randomBytes(16).toString('hex');
    const startedAt = Date.now();
    timingSessions.set(sessionId, { targetMs: getDailyTargetMs(), startedAt, name, date: getTodayKST() });
    setTimeout(() => timingSessions.delete(sessionId), 30000);
    addFeed('game', name, { reason: '⏱ 타이밍 복권 도전 (-1P)' });
    res.json({ ok: true, sessionId, startedAt, points: r.points });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/game/timing/press', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  const { sessionId } = req.body;
  const session = timingSessions.get(sessionId);
  if (!session || session.name !== name) return res.json({ ok: false, error: '세션 만료' });
  timingSessions.delete(sessionId);
  if (session.date !== getTodayKST()) return res.json({ ok: true, won: false, error: '날짜가 바뀌었습니다' });
  // 이중 당첨 방지: 락 확인 + getTimingWinner 동시 체크
  if (timingWinnerSaving) return res.json({ ok: true, won: false, diff: 0, targetMs: session.targetMs, elapsed: 0, error: '이미 당첨자 있음' });
  if (await getTimingWinner()) return res.json({ ok: true, won: false, diff: 0, targetMs: session.targetMs, elapsed: 0, error: '이미 당첨자 있음' });
  const elapsed = Date.now() - session.startedAt;
  const diff = Math.abs(elapsed - session.targetMs);
  if (diff <= 5) { // ±0.005초 (5ms)
    timingWinnerSaving = true;
    let newPoints = null;
    try {
      const r = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-grant`,
        { nickname: name, amount: 100, reason: '⏱ 타이밍 복권 당첨! (+100P)' },
        { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
      if (r.ok) newPoints = r.points;
      else console.error('[TIMING] 100P 지급 실패:', name, r.error);
    } catch(e) { console.error('[TIMING] 100P 지급 오류:', name, e.message); }
    const winner = { name, hitMs: elapsed, diff, at: Date.now() };
    await saveTimingWinner(getTodayKST(), winner);
    timingWinnerSaving = false;
    broadcast({ type: 'timing_won', winner, targetMs: session.targetMs });
    addFeed('jackpot', name, { prize: 100, reason: `🏆 타이밍 복권 당첨! (+100P)` });
    return res.json({ ok: true, won: true, diff, elapsed, targetMs: session.targetMs, prize: 100, points: newPoints });
  }
  return res.json({ ok: true, won: false, diff, elapsed, targetMs: session.targetMs });
});

// 인하우스 팀 라인업 프록시
app.get('/api/inhouse-lineup', async (req, res) => {
  if (!INHOUSE_SERVER_URL) return res.json({ ok: false, blue: [], red: [] });
  try {
    const data = await getJson(`${INHOUSE_SERVER_URL}/api/inhouse-db`);
    const toNames = arr => (arr || []).map(p => (p.name || p.chzzk || '?').replace(/#.+$/, '').trim());
    res.json({ ok: true, blue: toNames(data.curBlue), red: toNames(data.curRed) });
  } catch(e) { res.json({ ok: false, blue: [], red: [], error: e.message }); }
});

// 포인트 랭킹 — 인하우스 DB에서 가져오기 (별도 엔드포인트, 타임아웃 3초)
app.get('/api/ranking', async (req, res) => {
  if (!INHOUSE_SERVER_URL) return res.json({ ok: false, ranking: [] });
  try {
    const db = await Promise.race([
      getJson(`${INHOUSE_SERVER_URL}/api/inhouse-db`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);
    if (!Array.isArray(db.viewers)) return res.json({ ok: false, ranking: [] });
    const ranking = db.viewers
      .map(v => ({ name: (v.name || '').replace(/#.+$/, '').trim(), points: Math.max(0, Number(v.pass) || 0) }))
      .filter(v => v.name && v.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, 30);
    res.json({ ok: true, ranking });
  } catch(e) { res.json({ ok: false, ranking: [], error: e.message }); }
});

// ── Announcements — Bot에서 직접 가져오기 (메인 대시보드용, 최대 10개) ──
app.get('/api/announcements', async (req, res) => {
  if (BOT_API_URL) {
    try {
      const data = await getJson(`${BOT_API_URL}/api/announcements?limit=10`);
      if (data.ok) return res.json({ ok: true, items: (data.items || []).slice(0, 10) });
    } catch {}
  }
  // fallback: 로컬 파일
  const ann = readJSON(ANN_FILE, { items: [] });
  res.json({ ok: true, items: ann.items || [] });
});

app.post('/api/admin/announce', (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== 'davido-admin') return res.status(403).json({ ok: false });
  const { title, body, prize, msg_id } = req.body;
  if (!title) return res.json({ ok: false, error: '제목 필요' });
  const ann = readJSON(ANN_FILE, { items: [] });
  ann.items.unshift({ title, body: body || '', prize: prize || '', at: Date.now(), msg_id: msg_id || null });
  ann.items = ann.items.slice(0, 10);
  writeJSON(ANN_FILE, ann);
  res.json({ ok: true });
});

// Discord 메시지 삭제 시 해당 공지 제거
app.post('/api/admin/announcements/delete', (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== (process.env.VIEWER_SERVER_SECRET || 'davido-admin')) return res.status(403).json({ ok: false });
  const { msg_id } = req.body;
  if (!msg_id) return res.json({ ok: false, error: 'msg_id 필요' });
  const ann = readJSON(ANN_FILE, { items: [] });
  const before = ann.items.length;
  ann.items = ann.items.filter(it => String(it.msg_id) !== String(msg_id));
  writeJSON(ANN_FILE, ann);
  res.json({ ok: true, removed: before - ann.items.length });
});

// 봇 시작 시 공지 일괄 복원 (기존 항목 교체)
app.post('/api/admin/announcements/reset', (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== (process.env.VIEWER_SERVER_SECRET || 'davido-admin')) return res.status(403).json({ ok: false });
  const items = Array.isArray(req.body) ? req.body : [];
  writeJSON(ANN_FILE, { items: items.slice(0, 10) });
  res.json({ ok: true, count: items.length });
});

// ── 커뮤니티 게시판 ──
const BOARDS = ['free', 'recommend', 'inquiry'];

app.get('/api/posts', async (req, res) => {
  const { board, page = 1 } = req.query;
  if (board === 'notice') {
    // 공지사항 = 봇 API에서 직접 (커뮤니티는 전체, 메인은 10개)
    const annLimit = req.query.limit || 100;
    if (!BOT_API_URL) return res.json({ ok: true, posts: [], total: 0 });
    try {
      const d = await Promise.race([
        getJson(`${BOT_API_URL}/api/announcements?limit=${annLimit}`),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000))
      ]);
      const posts = (d.items || []).map(it => ({
        id: it.msg_id || String(it.at),
        board: 'notice', title: it.title || '공지', content: it.body || '',
        author: '관리자', createdAt: it.at, readonly: true,
      }));
      return res.json({ ok: true, posts, total: posts.length });
    } catch { return res.json({ ok: true, posts: [], total: 0 }); }
  }
  const data = readJSON(POSTS_FILE, { posts: [] });
  let posts = data.posts;
  if (board) posts = posts.filter(p => p.board === board);

  // 문의게시판: 관리자는 전체, 일반 유저는 본인 글만
  if (board === 'inquiry') {
    const name = getSessionName(req);
    const adminNames = (process.env.ADMIN_NICKNAMES || '다비도').split(',').map(s => s.trim());
    const isAdmin = name && adminNames.includes(name);
    if (!isAdmin) {
      posts = name ? posts.filter(p => p.author === name) : [];
    }
  }

  posts = posts.sort((a, b) => b.createdAt - a.createdAt);
  const PAGE = 15;
  const total = posts.length;
  res.json({ ok: true, posts: posts.slice((page-1)*PAGE, page*PAGE), total, page: Number(page) });
});

app.post('/api/posts', (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  // 분당 2회, 하루 20회 제한
  if (!rl(`post-min:${name}`, 2, 60)) return res.status(429).json({ ok: false, error: '너무 빠르게 게시글을 작성하고 있습니다. 잠시 후 다시 시도하세요.' });
  if (!rl(`post-day:${name}`, 20, 86400)) return res.status(429).json({ ok: false, error: '오늘 게시글 작성 한도를 초과했습니다 (하루 20개).' });
  const { board, title, content } = req.body;
  if (!BOARDS.includes(board)) return res.json({ ok: false, error: '잘못된 게시판' });
  if (!title?.trim()) return res.json({ ok: false, error: '제목을 입력하세요' });
  if (!content?.trim() && !(req.body.images?.length)) return res.json({ ok: false, error: '내용을 입력하세요' });
  if (title.length > 100) return res.json({ ok: false, error: '제목 100자 이내' });
  if ((content||'').length > 3000) return res.json({ ok: false, error: '내용 3000자 이내' });
  // 이미지 검증
  const images = (req.body.images || [])
    .filter(img => typeof img === 'string' && /^data:image\/(jpeg|jpg|png|gif|webp|bmp);base64,/.test(img) && img.length < 4 * 1024 * 1024)
    .slice(0, 5);
  const isHtml = !!req.body.isHtml;
  // HTML 콘텐츠 서버 정제 (XSS 방지)
  const rawContent = (content || '').slice(0, 30000);
  const safeContent = isHtml ? rawContent
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe(?!\s+src="https:\/\/(www\.youtube\.com|clips\.twitch\.tv|player\.twitch\.tv))[\s\S]*?>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, 'blocked:')
    .replace(/<(object|embed|applet|meta|link|base)[^>]*>/gi, '')
    : rawContent;
  const data = readJSON(POSTS_FILE, { posts: [] });
  const post = { id: crypto.randomBytes(8).toString('hex'), board, title: title.trim().slice(0, 100), content: safeContent.trim(), isHtml, images, author: name, createdAt: Date.now() };
  data.posts.unshift(post);
  data.posts = data.posts.slice(0, 1000);
  writeJSON(POSTS_FILE, data);
  res.json({ ok: true, post });
});

app.put('/api/posts/:id', (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.status(401).json({ ok: false });
  const { title, content, isHtml } = req.body;
  if (!title?.trim()) return res.json({ ok: false, error: '제목을 입력하세요' });
  const data = readJSON(POSTS_FILE, { posts: [] });
  const post = data.posts.find(p => p.id === req.params.id && p.author === name);
  if (!post) return res.status(403).json({ ok: false, error: '수정 권한 없음' });
  const safeContent = isHtml ? (content||'')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, 'blocked:') : (content||'');
  post.title = title.trim().slice(0, 100);
  post.content = safeContent.trim().slice(0, 30000);
  post.isHtml = !!isHtml;
  post.updatedAt = Date.now();
  writeJSON(POSTS_FILE, data);
  res.json({ ok: true, post });
});

app.delete('/api/posts/:id', (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.status(401).json({ ok: false });
  const data = readJSON(POSTS_FILE, { posts: [] });
  const idx = data.posts.findIndex(p => p.id === req.params.id && p.author === name);
  if (idx < 0) return res.status(403).json({ ok: false, error: '삭제 권한 없음' });
  data.posts.splice(idx, 1);
  writeJSON(POSTS_FILE, data);
  res.json({ ok: true });
});

// ── 지뢰찾기 (완전 서버사이드 — 클라이언트 조작 불가) ──
const msSessions = new Map(); // sessionId → game state

function calcMsPayout(session) {
  const k = session.revealed.size;
  const rawMult = k > 0 ? 1 + (k * session.mineCount) / (session.total * 0.8) : 1.0;
  return Math.floor(session.bet * Math.min(4.0, Math.max(1.0, rawMult)));
}

async function msGrantPayout(name, payout) {
  if (payout < 1) return null;
  if (!INHOUSE_SERVER_URL) { console.error('[GRANT] INHOUSE_SERVER_URL 미설정 — 포인트 미지급:', name, payout); return null; }
  try {
    const r = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-grant`,
      { nickname: name, amount: payout, reason: `💣 지뢰찾기 성공 (+${payout}P)` },
      { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
    if (r.ok) { addFeed('game', name, { reason: `💣 지뢰찾기 성공 (+${payout}P)` }); return r.points; }
  } catch {}
  return null;
}

app.post('/api/game/ms/start', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  const mineCount = Math.max(3, Math.min(7, parseInt(req.body.mineCount) || 5));
  const TOTAL = 25;
  if (!INHOUSE_SERVER_URL) return res.json({ ok: false, error: 'INHOUSE_SERVER_URL 미설정' });
  try {
    // 포인트 차감 먼저 (포인트 없으면 레이트리밋 소모 없음)
    const dr = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-deduct`,
      { nickname: name, amount: 1, reason: '💣 지뢰찾기 시작 (-1P)' },
      { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
    if (!dr.ok) return res.json({ ok: false, error: dr.error || '포인트 부족' });
    // 포인트 차감 성공 후 레이트리밋 (포인트 없으면 카운트 소모 안 됨)
    if (!rl(`ms-min:${name}`, 20, 60)) {
      postJson(`${INHOUSE_SERVER_URL}/api/viewer-grant`, { nickname: name, amount: 1 }, { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' }).catch(()=>{});
      return res.status(429).json({ ok: false, error: '너무 빠릅니다. 잠시 후 다시 시도하세요.' });
    }
    // 지뢰 위치 서버에서 생성 — 클라이언트에 절대 안 보냄
    const mineSet = new Set();
    while (mineSet.size < mineCount) mineSet.add(Math.floor(Math.random() * TOTAL));
    const sessionId = crypto.randomBytes(16).toString('hex');
    msSessions.set(sessionId, { name, mineSet, revealed: new Set(), bet: 1, mineCount, total: TOTAL, alive: true, cashed: false });
    setTimeout(() => msSessions.delete(sessionId), 30 * 60 * 1000);
    res.json({ ok: true, sessionId, total: TOTAL, mineCount, points: dr.points });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/game/ms/reveal', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  const { sessionId, cellIdx } = req.body;
  const s = msSessions.get(sessionId);
  if (!s || s.name !== name) return res.json({ ok: false, error: '세션 없음' });
  if (!s.alive || s.cashed) return res.json({ ok: false, error: '게임 종료됨' });
  const idx = parseInt(cellIdx);
  if (isNaN(idx) || idx < 0 || idx >= s.total || s.revealed.has(idx)) return res.json({ ok: false, error: '잘못된 셀' });
  if (s.mineSet.has(idx)) {
    s.alive = false;
    msSessions.delete(sessionId);
    return res.json({ ok: true, hit: true, mines: [...s.mineSet] });
  }
  s.revealed.add(idx);
  const payout = calcMsPayout(s);
  const safeLeft = s.total - s.mineCount - s.revealed.size;
  if (safeLeft === 0) { // 전부 열면 자동 정산
    s.cashed = true; msSessions.delete(sessionId);
    const pts = await msGrantPayout(name, payout);
    return res.json({ ok: true, hit: false, autoWin: true, payout, mines: [...s.mineSet], points: pts });
  }
  res.json({ ok: true, hit: false, payout, safeLeft, revealedCount: s.revealed.size });
});

app.post('/api/game/ms/cashout', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  const { sessionId } = req.body;
  const s = msSessions.get(sessionId);
  if (!s || s.name !== name) return res.json({ ok: false, error: '세션 없음' });
  if (!s.alive || s.cashed) return res.json({ ok: false, error: '게임 종료됨' });
  if (s.revealed.size === 0) return res.json({ ok: false, error: '최소 1칸 이상 열어야 합니다' });
  s.cashed = true; msSessions.delete(sessionId);
  const payout = calcMsPayout(s);
  const pts = await msGrantPayout(name, payout);
  res.json({ ok: true, payout, mines: [...s.mineSet], points: pts });
});

// ── 댓글 API ──
app.get('/api/comments/:postId', (req, res) => {
  const all = readJSON(COMMENTS_FILE, {});
  res.json({ ok: true, comments: all[req.params.postId] || [] });
});

app.post('/api/comments/:postId', (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  if (!rl(`cmt-min:${name}`, 5, 60)) return res.status(429).json({ ok: false, error: '너무 빠릅니다. 잠시 후 다시 시도하세요.' });
  const content = String(req.body.content || '').trim().slice(0, 500);
  if (!content) return res.json({ ok: false, error: '내용을 입력하세요' });
  const all = readJSON(COMMENTS_FILE, {});
  const postId = req.params.postId;
  if (!all[postId]) all[postId] = [];
  const comment = { id: crypto.randomBytes(8).toString('hex'), author: name, content, createdAt: Date.now(), replies: [] };
  all[postId].push(comment);
  writeJSON(COMMENTS_FILE, all);
  res.json({ ok: true, comment });
});

app.post('/api/comments/:postId/:commentId/reply', (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  if (!rl(`cmt-min:${name}`, 5, 60)) return res.status(429).json({ ok: false, error: '너무 빠릅니다.' });
  const content = String(req.body.content || '').trim().slice(0, 500);
  if (!content) return res.json({ ok: false, error: '내용을 입력하세요' });
  const all = readJSON(COMMENTS_FILE, {});
  const comments = all[req.params.postId] || [];
  const comment = comments.find(c => c.id === req.params.commentId);
  if (!comment) return res.json({ ok: false, error: '댓글 없음' });
  const reply = { id: crypto.randomBytes(8).toString('hex'), author: name, content, createdAt: Date.now() };
  comment.replies.push(reply);
  all[req.params.postId] = comments;
  writeJSON(COMMENTS_FILE, all);
  res.json({ ok: true, reply });
});

app.delete('/api/comments/:postId/:commentId', (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.status(401).json({ ok: false });
  const all = readJSON(COMMENTS_FILE, {});
  const comments = all[req.params.postId] || [];
  const idx = comments.findIndex(c => c.id === req.params.commentId && c.author === name);
  if (idx < 0) return res.status(403).json({ ok: false, error: '삭제 권한 없음' });
  comments.splice(idx, 1);
  all[req.params.postId] = comments;
  writeJSON(COMMENTS_FILE, all);
  res.json({ ok: true });
});

app.delete('/api/comments/:postId/:commentId/:replyId', (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.status(401).json({ ok: false });
  const all = readJSON(COMMENTS_FILE, {});
  const comments = all[req.params.postId] || [];
  const comment = comments.find(c => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ ok: false });
  const ri = comment.replies.findIndex(r => r.id === req.params.replyId && r.author === name);
  if (ri < 0) return res.status(403).json({ ok: false, error: '삭제 권한 없음' });
  comment.replies.splice(ri, 1);
  all[req.params.postId] = comments;
  writeJSON(COMMENTS_FILE, all);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
// 배당 폭발 (CRASH) 게임 — 서버 루프
// ══════════════════════════════════════════════════════════
const CRASH_BET_MIN     = 10;
const CRASH_BET_MAX     = 30;
const CRASH_BETTING_SEC = 7;

let crash = {
  phase: 'betting', roundId: 0, crashAt: 1.00, startTime: 0,
  betEndAt: 0, mult: 1.00, bets: {}, history: [],
  tickTimer: null, phaseTimer: null,
};

function genCrashPoint() {
  const r = crypto.randomBytes(4).readUInt32BE() / 0xFFFFFFFF;
  if (r < 0.20) return 1.00;
  return Math.round(Math.min(0.90 / (1 - r), 15) * 100) / 100;
}
function crashMult(ms) { return Math.round(Math.pow(Math.E, 0.0001 * ms) * 100) / 100; }

function crashBroadcast(extra = {}) {
  broadcast({
    type: 'crash_state', phase: crash.phase, roundId: crash.roundId,
    mult: crash.mult, betEndAt: crash.betEndAt, history: crash.history,
    players: Object.entries(crash.bets).map(([n, b]) => ({
      name: n, cashedOut: b.cashedOut, cashMult: b.cashedOut ? b.cashMult : null,
    })), ...extra,
  });
}

function startBetting() {
  crash.phase = 'betting'; crash.roundId += 1;
  crash.crashAt = genCrashPoint(); crash.bets = {}; crash.mult = 1.00;
  crash.betEndAt = Date.now() + CRASH_BETTING_SEC * 1000;
  crashBroadcast();
  crash.phaseTimer = setTimeout(startRunning, CRASH_BETTING_SEC * 1000);
}

function startRunning() {
  crash.phase = 'running'; crash.startTime = Date.now();
  crashBroadcast();
  crash.tickTimer = setInterval(() => {
    const elapsed = Date.now() - crash.startTime;
    crash.mult = crashMult(elapsed);
    if (crash.mult >= crash.crashAt) {
      crash.mult = crash.crashAt; clearInterval(crash.tickTimer); endRound();
    } else { crashBroadcast(); }
  }, 100);
}

function endRound() {
  crash.phase = 'crashed';
  Object.entries(crash.bets).forEach(([n, b]) => {
    if (!b.cashedOut) addFeed('crash', n, { mult: crash.crashAt, gain: 0, bet: b.amount, reason: `💥 배당폭발 폭발 ${crash.crashAt}x (-${b.amount}P)` });
  });
  crash.history.unshift({ mult: crash.crashAt, roundId: crash.roundId });
  if (crash.history.length > 20) crash.history.pop();
  crashBroadcast({ crashed: true });
  crash.phaseTimer = setTimeout(startBetting, 4000);
}

app.post('/api/game/crash/bet', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  if (crash.phase !== 'betting') return res.json({ ok: false, error: '베팅 시간이 아닙니다' });
  if (crash.bets[name]) return res.json({ ok: false, error: '이미 베팅했습니다' });
  const amount = parseInt(req.body.amount || 0);
  if (amount < CRASH_BET_MIN || amount > CRASH_BET_MAX) return res.json({ ok: false, error: `베팅: ${CRASH_BET_MIN}~${CRASH_BET_MAX}p` });
  // 피로도 체크
  const fg = checkFatigue(name, FATIGUE_COST.crash);
  if (!fg.ok) return res.json({ ok: false, error: fg.error, fatigue: fg.fatigue });
  if (!INHOUSE_SERVER_URL) { recoverFatigue(name, FATIGUE_COST.crash); return res.json({ ok: false, error: '서버 연결 안됨' }); }
  try {
    const dr = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-deduct`,
      { nickname: name, amount, reason: `💥 배당폭발 베팅 (-${amount}P)` },
      { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
    if (!dr.ok) { recoverFatigue(name, FATIGUE_COST.crash); return res.json({ ok: false, error: dr.error || '포인트 부족' }); }
    const { viewers, viewer } = getViewer(name); viewer.points = dr.points; saveViewer(viewers);
    crash.bets[name] = { amount, cashedOut: false, cashMult: null };
    crashBroadcast();
    res.json({ ok: true, viewer, roundId: crash.roundId, fatigue: fg.fatigue });
  } catch(e) { recoverFatigue(name, FATIGUE_COST.crash); res.json({ ok: false, error: e.message }); }
});

app.post('/api/game/crash/cashout', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  if (crash.phase !== 'running') return res.json({ ok: false, error: '게임 진행 중이 아닙니다' });
  const bet = crash.bets[name];
  if (!bet) return res.json({ ok: false, error: '이번 판 베팅 없음' });
  if (bet.cashedOut) return res.json({ ok: false, error: '이미 현금화함' });
  const mult = crash.mult; const gain = Math.floor(bet.amount * mult);
  bet.cashedOut = true; bet.cashMult = mult;
  if (!INHOUSE_SERVER_URL) return res.json({ ok: false, error: '서버 연결 안됨' });
  try {
    const gr = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-grant`,
      { nickname: name, amount: gain, reason: `💥 배당폭발 ${mult.toFixed(2)}x 현금화 (+${gain}P)` },
      { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
    const { viewers, viewer } = getViewer(name); if (gr.ok) viewer.points = gr.points; saveViewer(viewers);
    addFeed('crash', name, { mult, gain, bet: bet.amount, reason: `💥 배당폭발 ${mult.toFixed(2)}x 현금화 (+${gain}P)` });
    crashBroadcast(); res.json({ ok: true, mult, gain, viewer });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/game/crash/state', (req, res) => {
  res.json({
    phase: crash.phase, roundId: crash.roundId, mult: crash.mult,
    betEndAt: crash.betEndAt, history: crash.history,
    players: Object.entries(crash.bets).map(([n, b]) => ({
      name: n, cashedOut: b.cashedOut, cashMult: b.cashedOut ? b.cashMult : null,
    })),
  });
});

// ── 피로도 회복 아이템 구매 처리 ──
app.post('/api/fatigue/recover', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  const { itemId } = req.body;
  const recoveryItems = {
    'fatigue_sm':  { name: '피로도 회복제 (소)', amount: 30,  price: 60  },
    'fatigue_lg':  { name: '피로도 회복제 (대)', amount: 70,  price: 130 },
    'fatigue_full':{ name: '피로도 완전 회복',   amount: 100, price: 180 },
  };
  const item = recoveryItems[itemId];
  if (!item) return res.json({ ok: false, error: '아이템 없음' });
  if (!INHOUSE_SERVER_URL) return res.json({ ok: false, error: 'INHOUSE_SERVER_URL 미설정' });
  try {
    const r = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-deduct`,
      { nickname: name, amount: item.price, reason: `🧪 ${item.name} 구매 (-${item.price}P)` },
      { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
    if (!r.ok) return res.json({ ok: false, error: r.error || '포인트 부족' });
    const newFatigue = recoverFatigue(name, item.amount);
    const { viewers, viewer } = getViewer(name); viewer.points = r.points; saveViewer(viewers);
    addFeed('shop', name, { reason: `🧪 ${item.name} 사용 (피로도 +${item.amount})` });
    res.json({ ok: true, fatigue: newFatigue, points: r.points });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── WebSocket ──
wss.on('connection', (ws) => {
  const betting = readJSON(BETTING_FILE, {});
  const shop    = readJSON(SHOP_FILE, { items: [] });
  const feed    = readJSON(FEED_FILE, { items: [] }).items.slice(0, 10);
  // 연결 즉시 현재 상태 전송 (재연결 후 피드 복원)
  ws.send(JSON.stringify({ type: 'init', betting, shop }));
  ws.send(JSON.stringify({ type: 'feed_update', items: feed }));
  ws.send(JSON.stringify({
    type: 'crash_state', phase: crash.phase, roundId: crash.roundId,
    mult: crash.mult, betEndAt: crash.betEndAt, history: crash.history,
    players: Object.entries(crash.bets).map(([n, b]) => ({
      name: n, cashedOut: b.cashedOut, cashMult: b.cashedOut ? b.cashMult : null,
    })),
  }));
});

server.listen(PORT, () => {
  console.log(`davido-viewer server on :${PORT}`);
  startBetting(); // 배당폭발 게임 루프 시작
  // 서버 시작 시 봇에 공지 동기화 요청
  if (BOT_API_URL) {
    setTimeout(() => {
      const url = new URL(`${BOT_API_URL}/api/sync-announcements`);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(url, { method: 'POST', headers: { 'Content-Length': '0' } }, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => console.log('[ANNOUNCE] 시작 시 동기화:', raw.slice(0, 80)));
      });
      req.on('error', e => console.log('[ANNOUNCE] 봇 동기화 요청 실패:', e.message));
      req.end();
    }, 5000); // 봇 준비 대기
  }
});

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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const INHOUSE_SERVER_URL = (process.env.INHOUSE_SERVER_URL || '').replace(/\/+$/, '');
const BOT_API_URL = (process.env.BOT_API_URL || '').replace(/\/+$/, '');

// ── 배팅 밸런스 상수 ──
const BET_MAX      = 20;    // 1판 최대 배팅 포인트
const BET_MAX_MULT = 2.0;   // 배당 상한 (풀 쏠려도 최대 2배)
const BET_RAKE     = 0.10;  // 하우스 수수료 10% → 실질 최대 1.8x

// ── Data files ──
const VIEWERS_FILE    = path.join(DATA_DIR, 'viewers.json');
const BETTING_FILE    = path.join(DATA_DIR, 'betting.json');
const SHOP_FILE       = path.join(DATA_DIR, 'shop.json');
const TIMING_WIN_FILE = path.join(DATA_DIR, 'timing-winner.json');

// data/ 디렉토리 자동 생성 (Railway 배포 시 없으면 크래시 방지)
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ── 서명 기반 stateless 세션 (배포해도 로그인 유지) ──
const SESSION_SECRET = process.env.SESSION_SECRET || 'davido-viewer-secret-2025';

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
    { id: 'priority', name: '선참권',  desc: '다음 내전 팀 배치 선택 우선권', price: 60,  stock: -1, icon: '⭐', rarity: 'common'   },
    { id: 'no_ban',   name: '노밴권',  desc: '다음 내전 밴 페이즈 면제',       price: 120, stock: -1, icon: '🛡️', rarity: 'uncommon' },
    { id: 'all_day',  name: '종일권',  desc: '당일 모든 내전 참가 가능',       price: 230, stock: -1, icon: '🌙', rarity: 'rare'     },
    { id: 'extend',   name: '연장권',  desc: '내전 1판 추가 연장',             price: 300, stock: -1, icon: '⚡', rarity: 'epic'     },
  ]
});

// ── Session helpers (stateless signed token) ──
// 토큰 형식: base64(name + ":" + hmac_hex)
function makeSessionToken(name) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(name).digest('hex');
  return Buffer.from(name + ':' + sig).toString('base64');
}
function getSessionName(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/vsession=([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const sep = decoded.lastIndexOf(':');
    if (sep < 0) return null;
    const name = decoded.slice(0, sep);
    const sig  = decoded.slice(sep + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(name).digest('hex');
    return sig === expected ? name : null;
  } catch { return null; }
}

// ── Viewer helpers ──
function getViewer(name) {
  const viewers = readJSON(VIEWERS_FILE, {});
  if (!viewers[name]) viewers[name] = { name, points: 0, bets: 0, wins: 0, purchases: [] };
  return { viewers, viewer: viewers[name] };
}
function saveViewer(viewers) { writeJSON(VIEWERS_FILE, viewers); }

// ── Broadcast ──
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 치지직 채팅 인증 ──
const pendingAuth = {}; // { TOKEN: { name:null, createdAt, expiresAt } }

function cleanPending() {
  const now = Date.now();
  Object.keys(pendingAuth).forEach(k => { if (pendingAuth[k].expiresAt < now) delete pendingAuth[k]; });
}

// 임시 코드 발급
app.get('/api/auth/pending', (req, res) => {
  cleanPending();
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const token = Array.from({length:5}, ()=>CHARS[Math.floor(Math.random()*CHARS.length)]).join(''); // 5자리 (e.g. PK7X9)
  pendingAuth[token] = { name: null, createdAt: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000 };
  res.json({ ok: true, token });
});

// 프론트가 2초마다 폴링
app.get('/api/auth/poll/:token', (req, res) => {
  const p = pendingAuth[req.params.token?.toUpperCase()];
  if (!p || p.expiresAt < Date.now()) return res.json({ ok: false, status: 'expired' });
  if (!p.name) return res.json({ ok: false, status: 'pending' });
  // 확인 완료 → 세션 발급
  const name = p.name;
  delete pendingAuth[req.params.token.toUpperCase()];
  const sessionToken = makeSessionToken(name);
  const { viewers, viewer } = getViewer(name);
  saveViewer(viewers);
  res.setHeader('Set-Cookie', `vsession=${sessionToken}; Path=/; HttpOnly; Max-Age=${10 * 365 * 24 * 3600}`);
  res.json({ ok: true, status: 'confirmed', viewer });
});

// 봇이 채팅 감지 후 호출
app.post('/api/auth/confirm', (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== 'davido-admin') return res.status(403).json({ ok: false, error: '권한 없음' });
  const { token, name } = req.body;
  if (!token || !name) return res.json({ ok: false, error: 'token, name 필요' });
  const key = token.toUpperCase();
  const p = pendingAuth[key];
  if (!p) return res.json({ ok: false, error: '코드 없음 또는 만료' });
  if (p.expiresAt < Date.now()) { delete pendingAuth[key]; return res.json({ ok: false, error: '코드 만료' }); }
  p.name = name.trim();
  res.json({ ok: true, message: `${name} 인증 완료` });
});

// ── Auth: login (nickname only for now) ──
app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2 || name.trim().length > 16)
    return res.json({ ok: false, error: '닉네임은 2~16자로 입력해주세요' });
  const n = name.trim();
  const token = makeSessionToken(n);
  const { viewers, viewer } = getViewer(n);
  saveViewer(viewers);
  res.setHeader('Set-Cookie', `vsession=${token}; Path=/; HttpOnly; Max-Age=${30*24*3600}`);
  res.json({ ok: true, viewer });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'vsession=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

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

app.post('/api/bet/place', (req, res) => {
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

  const { viewers, viewer } = getViewer(name);
  if (viewer.points < amt) return res.json({ ok: false, error: '포인트 부족' });

  viewer.points -= amt;
  viewer.bets++;
  betting.bets[name] = { team, amount: amt };
  saveViewer(viewers);
  writeJSON(BETTING_FILE, betting);

  broadcast({ type: 'bet_update', bets: betting.bets, status: betting.status });
  res.json({ ok: true, viewer });
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
app.post('/api/admin/bet', (req, res) => {
  const { action, blueTeam, redTeam, result } = req.body;
  const secret = req.headers['x-admin-secret'];
  if (secret !== (process.env.ADMIN_SECRET || 'davido-admin')) return res.status(403).json({ ok: false });

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
    const viewers = readJSON(VIEWERS_FILE, {});
    const blueTot = Object.values(betting.bets).filter(b=>b.team==='blue').reduce((s,b)=>s+b.amount,0);
    const redTot  = Object.values(betting.bets).filter(b=>b.team==='red').reduce((s,b)=>s+b.amount,0);
    const totalPool = blueTot + redTot;
    const winnerPool = result === 'blue' ? blueTot : redTot;
    Object.entries(betting.bets).forEach(([n, b]) => {
      if (b.team === result) {
        const rawMult = totalPool / (winnerPool || 1);          // 풀 기반 배당
        const mult    = Math.min(rawMult, BET_MAX_MULT);        // 상한 적용
        const gain    = Math.floor(b.amount * mult * (1 - BET_RAKE)); // 수수료 차감
        if (!viewers[n]) viewers[n] = { name: n, points: 0, bets: 0, wins: 0, purchases: [] };
        viewers[n].points += gain;
        viewers[n].wins++;
        betting.bets[n].payout = gain;
      }
    });
    writeJSON(VIEWERS_FILE, viewers);
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

// ── Admin: give points ──
app.post('/api/admin/points', (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== (process.env.ADMIN_SECRET || 'davido-admin')) return res.status(403).json({ ok: false });
  const { name, delta } = req.body;
  const { viewers, viewer } = getViewer(name);
  viewer.points = Math.max(0, (viewer.points || 0) + delta);
  saveViewer(viewers);
  broadcast({ type: 'points_update', name, points: viewer.points });
  res.json({ ok: true, viewer });
});

// ── Shop ──
app.get('/api/shop', (req, res) => {
  res.json(readJSON(SHOP_FILE, { items: [] }));
});

app.post('/api/shop/buy', (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  const { itemId } = req.body;

  const shopData = readJSON(SHOP_FILE, { items: [] });
  const item = shopData.items.find(i => i.id === itemId);
  if (!item) return res.json({ ok: false, error: '아이템 없음' });
  if (item.stock === 0) return res.json({ ok: false, error: '품절' });

  const { viewers, viewer } = getViewer(name);
  if (viewer.points < item.price) return res.json({ ok: false, error: '포인트 부족' });

  viewer.points -= item.price;
  viewer.purchases.push({ itemId, itemName: item.name, at: Date.now() });
  if (item.stock > 0) item.stock--;

  saveViewer(viewers);
  writeJSON(SHOP_FILE, shopData);
  broadcast({ type: 'shop_update', items: shopData.items });
  res.json({ ok: true, viewer, item });
});

// ══════════ MINI GAMES ══════════

// ── Card utilities (Blackjack) ──
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function createDeck(n=4){const d=[];for(let i=0;i<n;i++)for(const s of SUITS)for(const r of RANKS)d.push({r,s});return shuffle([...d])}
function shuffle(a){const b=[...a];for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]]}return b}
function cVal(c){if(['J','Q','K'].includes(c.r))return 10;if(c.r==='A')return 11;return parseInt(c.r)}
function hVal(hand){let v=0,a=0;for(const c of hand){v+=cVal(c);if(c.r==='A')a++}while(v>21&&a>0){v-=10;a--}return v}
const bjSessions={};

// ── Slot utilities ──
const SL_SYM=['🍒','🍋','🔔','⭐','💎','7️⃣'];
const SL_W  =[35,28,20,12,4,1];
const SL_PAY={'7️⃣7️⃣7️⃣':10,'💎💎💎':6,'⭐⭐⭐':4,'🔔🔔🔔':3,'🍋🍋🍋':2.5,'🍒🍒🍒':2};
function pickSym(){let r=Math.random()*100;for(let i=0;i<SL_SYM.length;i++){r-=SL_W[i];if(r<=0)return SL_SYM[i]}return SL_SYM[0]}
function slotPayout(reels,bet){
  const k=reels.join('');
  if(SL_PAY[k]) return Math.floor(bet*SL_PAY[k]);
  const[a,b,c]=reels;if(a===b||b===c||a===c) return Math.floor(bet*1.3);
  return 0;
}

// ── Roulette utilities ──
const RL_RED=new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const RL_ORDER=[0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];

// ── Slots ──
app.post('/api/game/slots',(req,res)=>{
  const name=getSessionName(req);if(!name)return res.json({ok:false,error:'로그인 필요'});
  const bet=parseInt(req.body.bet);
  if(!bet||bet<1||bet>BET_MAX)return res.json({ok:false,error:`1~${BET_MAX}p 배팅`});
  const{viewers,viewer}=getViewer(name);
  if(viewer.points<bet)return res.json({ok:false,error:'포인트 부족'});
  const reels=[pickSym(),pickSym(),pickSym()];
  const payout=slotPayout(reels,bet);
  viewer.points=Math.max(0,viewer.points-bet+payout);
  saveViewer(viewers);
  broadcast({type:'points_update',name,points:viewer.points});
  res.json({ok:true,reels,payout,net:payout-bet,viewer,jackpot:reels.join('')==='7️⃣7️⃣7️⃣'});
});

// ── Blackjack ──
app.post('/api/game/bj/start',(req,res)=>{
  const name=getSessionName(req);if(!name)return res.json({ok:false,error:'로그인 필요'});
  if(bjSessions[name])return res.json({ok:false,error:'진행 중인 게임 있음'});
  const bet=parseInt(req.body.bet);
  if(!bet||bet<1||bet>BET_MAX)return res.json({ok:false,error:`1~${BET_MAX}p 배팅`});
  const{viewers,viewer}=getViewer(name);
  if(viewer.points<bet)return res.json({ok:false,error:'포인트 부족'});
  viewer.points-=bet;saveViewer(viewers);
  const deck=createDeck(4);
  const ph=[deck.pop(),deck.pop()],dh=[deck.pop(),deck.pop()];
  const pv=hVal(ph),dv=hVal(dh);
  if(pv===21){
    const bj=dv===21;const pay=bj?bet:Math.floor(bet*2.5);
    viewer.points+=pay;saveViewer(viewers);
    broadcast({type:'points_update',name,points:viewer.points});
    return res.json({ok:true,state:'over',ph,dh,pv,dv,result:bj?'push':'blackjack',pay,viewer});
  }
  bjSessions[name]={deck,ph,dh,bet,doubled:false};
  broadcast({type:'points_update',name,points:viewer.points});
  res.json({ok:true,state:'playing',ph,dh_show:[dh[0]],pv,viewer,canDouble:viewer.points>=bet});
});

app.post('/api/game/bj/action',(req,res)=>{
  const name=getSessionName(req);if(!name)return res.json({ok:false,error:'로그인 필요'});
  const sess=bjSessions[name];if(!sess)return res.json({ok:false,error:'게임 없음'});
  const{action}=req.body;
  const{viewers,viewer}=getViewer(name);
  if(action==='double'){
    if(viewer.points<sess.bet)return res.json({ok:false,error:'포인트 부족'});
    viewer.points-=sess.bet;sess.bet*=2;sess.doubled=true;
  }
  if(action==='hit'||action==='double'){
    sess.ph.push(sess.deck.pop());
    const pv=hVal(sess.ph);
    if(pv>21||sess.doubled){
      if(pv>21){
        delete bjSessions[name];saveViewer(viewers);
        broadcast({type:'points_update',name,points:viewer.points});
        return res.json({ok:true,state:'over',ph:sess.ph,dh:sess.dh,pv,dv:hVal(sess.dh),result:'bust',pay:0,viewer});
      }
      return doStand(name,sess,viewers,viewer,res);
    }
    saveViewer(viewers);broadcast({type:'points_update',name,points:viewer.points});
    return res.json({ok:true,state:'playing',ph:sess.ph,dh_show:[sess.dh[0]],pv,viewer,canDouble:false});
  }
  if(action==='stand') return doStand(name,sess,viewers,viewer,res);
  res.json({ok:false,error:'unknown'});
});

function doStand(name,sess,viewers,viewer,res){
  while(hVal(sess.dh)<17)sess.dh.push(sess.deck.pop());
  const pv=hVal(sess.ph),dv=hVal(sess.dh);
  let result,pay;
  if(dv>21||pv>dv){result='win';pay=Math.floor(sess.bet*1.9);}
  else if(pv===dv){result='push';pay=sess.bet;}
  else{result='lose';pay=0;}
  viewer.points+=pay;saveViewer(viewers);delete bjSessions[name];
  broadcast({type:'points_update',name,points:viewer.points});
  res.json({ok:true,state:'over',ph:sess.ph,dh:sess.dh,pv,dv,result,pay,viewer});
}

// ── Roulette ──
app.post('/api/game/roulette',(req,res)=>{
  const name=getSessionName(req);if(!name)return res.json({ok:false,error:'로그인 필요'});
  const{bets}=req.body;
  if(!bets||!bets.length)return res.json({ok:false,error:'배팅 필요'});
  const totalBet=bets.reduce((s,b)=>s+parseInt(b.amount||0),0);
  if(totalBet<1||totalBet>BET_MAX)return res.json({ok:false,error:`총 배팅 1~${BET_MAX}p`});
  const{viewers,viewer}=getViewer(name);
  if(viewer.points<totalBet)return res.json({ok:false,error:'포인트 부족'});
  viewer.points-=totalBet;
  const result=Math.floor(Math.random()*37);
  const color=result===0?'green':RL_RED.has(result)?'red':'black';
  const wheelIdx=RL_ORDER.indexOf(result);
  let payout=0;
  bets.forEach(b=>{
    const a=parseInt(b.amount||0);
    if(b.type==='number'&&parseInt(b.value)===result)payout+=Math.floor(a*35*0.9);
    if(b.type==='color'&&b.value===color&&color!=='green')payout+=Math.floor(a*1.8);
    if(b.type==='parity'&&result!==0){
      if(b.value==='odd'&&result%2===1)payout+=Math.floor(a*1.8);
      if(b.value==='even'&&result%2===0)payout+=Math.floor(a*1.8);
    }
    if(b.type==='dozen'&&result>0&&parseInt(b.value)===Math.ceil(result/12))payout+=Math.floor(a*2.7);
  });
  viewer.points+=payout;saveViewer(viewers);
  broadcast({type:'points_update',name,points:viewer.points});
  res.json({ok:true,result,color,wheelIdx,payout,net:payout-totalBet,viewer});
});

// ── Inhouse Snapshot (for index_5 dashboard) ──
const ANN_FILE = path.join(DATA_DIR, 'announcements.json');
if (!fs.existsSync(ANN_FILE)) writeJSON(ANN_FILE, { items: [] });

app.get('/api/inhouse/snapshot', (req, res) => {
  const viewers  = readJSON(VIEWERS_FILE, {});
  const betting  = readJSON(BETTING_FILE, {});

  const viewers_total = Object.keys(viewers).length;
  const ranking = [];

  // 실시간 피드: 최근 배팅 내역
  const feed = [];
  if (betting.bets) {
    Object.entries(betting.bets).slice(-6).reverse().forEach(([viewer, b]) => {
      feed.push({ kind: 'bet', viewer, amount: b.amount, reason: `${b.team === 'blue' ? '블루' : '레드'}팀 배팅`, at: Date.now() });
    });
  }

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
function getTimingWinner() {
  const saved = readJSON(TIMING_WIN_FILE, {});
  if (saved.date !== getTodayKST()) return null;
  return saved.winner || null;
}

app.get('/api/game/timing/state', (req, res) => {
  const targetMs = getDailyTargetMs();
  const winner = getTimingWinner();
  res.json({ ok: true, targetMs, status: winner ? 'won' : 'open', winner, date: getTodayKST() });
});

app.post('/api/game/timing/start', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  if (getTimingWinner()) return res.json({ ok: false, error: '오늘은 이미 당첨자가 나왔습니다!' });
  if (!INHOUSE_SERVER_URL) return res.json({ ok: false, error: 'INHOUSE_SERVER_URL 미설정' });
  try {
    const r = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-deduct`,
      { nickname: name, amount: 1 },
      { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
    if (!r.ok) return res.json({ ok: false, error: r.error || '포인트 부족' });
    const sessionId = crypto.randomBytes(16).toString('hex');
    const startedAt = Date.now();
    timingSessions.set(sessionId, { targetMs: getDailyTargetMs(), startedAt, name, date: getTodayKST() });
    setTimeout(() => timingSessions.delete(sessionId), 30000);
    res.json({ ok: true, sessionId, startedAt, points: r.points });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/game/timing/press', async (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false, error: '로그인 필요' });
  const { sessionId } = req.body;
  const session = timingSessions.get(sessionId);
  if (!session || session.name !== name) return res.json({ ok: false, error: '세션 만료' });
  timingSessions.delete(sessionId);
  if (session.date !== getTodayKST()) return res.json({ ok: true, won: false, error: '날짜가 바뀌었습니다' });
  if (getTimingWinner()) return res.json({ ok: true, won: false, diff: 0, targetMs: session.targetMs, elapsed: 0, error: '이미 당첨자 있음' });
  const elapsed = Date.now() - session.startedAt;
  const diff = Math.abs(elapsed - session.targetMs);
  if (diff <= 10) { // ±0.01초 (표시 숫자 정확 일치)
    let newPoints = null;
    try {
      const r = await postJson(`${INHOUSE_SERVER_URL}/api/viewer-grant`,
        { nickname: name, amount: 100 },
        { 'x-viewer-secret': VIEWER_SERVER_SECRET || 'davido-admin' });
      if (r.ok) newPoints = r.points;
    } catch {}
    const winner = { name, hitMs: elapsed, diff, at: Date.now() };
    writeJSON(TIMING_WIN_FILE, { date: getTodayKST(), winner });
    broadcast({ type: 'timing_won', winner, targetMs: session.targetMs });
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
      .slice(0, 10);
    res.json({ ok: true, ranking });
  } catch(e) { res.json({ ok: false, ranking: [], error: e.message }); }
});

// ── Announcements — Bot에서 직접 가져오기 (파일 저장 없음) ──
app.get('/api/announcements', async (req, res) => {
  if (BOT_API_URL) {
    try {
      const data = await getJson(`${BOT_API_URL}/api/announcements`);
      if (data.ok) return res.json({ ok: true, items: data.items || [] });
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

// ── WebSocket ──
wss.on('connection', (ws) => {
  const betting = readJSON(BETTING_FILE, {});
  const shop = readJSON(SHOP_FILE, { items: [] });
  ws.send(JSON.stringify({ type: 'init', betting, shop }));
});

server.listen(PORT, () => {
  console.log(`davido-viewer server on :${PORT}`);
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

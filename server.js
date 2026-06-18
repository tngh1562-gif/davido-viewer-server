const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 4500;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// ── 배팅 밸런스 상수 ──
const BET_MAX      = 20;    // 1판 최대 배팅 포인트
const BET_MAX_MULT = 2.0;   // 배당 상한 (풀 쏠려도 최대 2배)
const BET_RAKE     = 0.10;  // 하우스 수수료 10% → 실질 최대 1.8x

// ── Data files ──
const VIEWERS_FILE  = path.join(DATA_DIR, 'viewers.json');
const BETTING_FILE  = path.join(DATA_DIR, 'betting.json');
const SHOP_FILE     = path.join(DATA_DIR, 'shop.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── Initial data ──
if (!fs.existsSync(VIEWERS_FILE))  writeJSON(VIEWERS_FILE,  {});
if (!fs.existsSync(SESSIONS_FILE)) writeJSON(SESSIONS_FILE, {});
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

// ── Session helpers ──
const sessions = readJSON(SESSIONS_FILE, {});
function saveSession(token, name) {
  sessions[token] = { name, createdAt: Date.now() };
  writeJSON(SESSIONS_FILE, sessions);
}
function getSessionName(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/vsession=([^;]+)/);
  if (!m) return null;
  const s = sessions[m[1]];
  return s ? s.name : null;
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

// ── Auth: login (nickname only for now) ──
app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2 || name.trim().length > 16)
    return res.json({ ok: false, error: '닉네임은 2~16자로 입력해주세요' });
  const n = name.trim();
  const token = crypto.randomBytes(32).toString('hex');
  saveSession(token, n);
  const { viewers, viewer } = getViewer(n);
  saveViewer(viewers);
  res.setHeader('Set-Cookie', `vsession=${token}; Path=/; HttpOnly; Max-Age=${30*24*3600}`);
  res.json({ ok: true, viewer });
});

app.post('/api/logout', (req, res) => {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/vsession=([^;]+)/);
  if (m) { delete sessions[m[1]]; writeJSON(SESSIONS_FILE, sessions); }
  res.setHeader('Set-Cookie', 'vsession=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

// ── Viewer info ──
app.get('/api/me', (req, res) => {
  const name = getSessionName(req);
  if (!name) return res.json({ ok: false });
  const { viewer } = getViewer(name);
  res.json({ ok: true, viewer });
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
    betting.lockedAt = null;
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
  } else if (action === 'idle') {
    betting.status = 'idle';
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

// ── WebSocket ──
wss.on('connection', (ws) => {
  const betting = readJSON(BETTING_FILE, {});
  const shop = readJSON(SHOP_FILE, { items: [] });
  ws.send(JSON.stringify({ type: 'init', betting, shop }));
});

server.listen(PORT, () => console.log(`davido-viewer server on :${PORT}`));

#!/usr/bin/env node
// K-POP 노래 맞추기 멀티플레이 서버 (외부 패키지 없음)
// 실행: node server.js   (브라우저 자동 열기: node server.js --open)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const Q = require('./js/quiz-core.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(ROOT, 'data', 'custom.json');
const { esc, shuffle, ERA_LABEL, MODE_LABEL } = Q;

// ───── 데이터 ─────
function loadWindowScript(rel) {
  try {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel, timeout: 1000 });
    return sandbox.window;
  } catch (e) {
    console.error(`[!] ${rel} 읽기 실패: ${e.message}`);
    return {};
  }
}
const W = loadWindowScript('js/songs.js');
const db = Q.buildDB(W.SONGS || [], W.ARTIST_ALIASES || {});

function readCustomStore() {
  try { const v = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function writeCustomStore(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}
function customList() {
  const fileQ = loadWindowScript('js/custom.js').CUSTOM_QUESTIONS; // 서버 재시작 없이 수정 반영
  return Q.normalizeCustom([...(Array.isArray(fileQ) ? fileQ : []), ...readCustomStore()]);
}

// ───── 방 ─────
const NOSLASH = new Set(['시작', '힌트', '패스', '스킵', '포기', '점수', '순위', '종료', '그만', '도움말', '명령어']);
const MEDALS = ['🥇', '🥈', '🥉'];
const rooms = new Map();
function getRoom(raw) {
  const name = String(raw || '').replace(/[^\w가-힣-]/g, '').slice(0, 20) || 'lobby';
  if (!rooms.has(name)) rooms.set(name, new Room(name));
  return rooms.get(name);
}

class Room {
  constructor(name) {
    this.name = name;
    this.players = new Map(); // 비밀 id → { id, pub, name, conns, leaveT }
    this.history = [];
    this.set = { mode: '초성', era: 'all', artist: null, time: 40 };
    this.g = null;
    this.emptyT = null;
  }

  // 전송
  send(res, ev) { res.write(`data: ${JSON.stringify(ev)}\n\n`); }
  broadcast(ev) {
    if (ev.t === 'msg' || ev.t === 'chat') {
      this.history.push(ev);
      if (this.history.length > 100) this.history.shift();
    }
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const p of this.players.values()) for (const r of p.conns) r.write(data);
  }
  bot(html) { this.broadcast({ t: 'msg', who: 'bot', html, ts: Date.now() }); }
  sys(html) { this.broadcast({ t: 'msg', who: 'sys', html, ts: Date.now() }); }
  chat(p, text, mark) { this.broadcast({ t: 'chat', pid: p.pub, name: p.name, text, mark, ts: Date.now() }); }
  timer(remain) { this.broadcast({ t: 'timer', remain }); }
  online() { return [...this.players.values()].filter((p) => p.conns.size > 0); }
  pushPlayers() { this.broadcast({ t: 'players', list: this.online().map((p) => ({ name: p.name })) }); }

  uniqueName(raw, selfId) {
    const base = String(raw || '').replace(/[\u0000-\u001f<>&"']/g, '').replace(/\s+/g, ' ').trim().slice(0, 12) || '익명';
    let n = base, i = 2;
    while ([...this.players.values()].some((p) => p.id !== selfId && p.name === n)) n = base + i++;
    return n;
  }

  // 입장 / 퇴장
  join(id, name, res) {
    clearTimeout(this.emptyT);
    let p = this.players.get(id);
    if (!p) {
      p = { id, pub: Math.random().toString(36).slice(2, 9), name: this.uniqueName(name, id), conns: new Set(), leaveT: null };
      this.players.set(id, p);
    }
    const announce = p.conns.size === 0 && !p.leaveT; // 잠깐 끊겼다 다시 붙은 건 조용히
    clearTimeout(p.leaveT);
    p.leaveT = null;
    p.conns.add(res);
    this.send(res, { t: 'hello', you: p.pub, name: p.name, room: this.name, history: this.history });
    const g = this.g;
    this.send(res, { t: 'timer', remain: g && g.q && !g.locked && g.tl ? g.remain : null });
    if (!this.history.length) {
      this.bot(`안녕하세요! 🎵 <b>K-POP 노래 맞추기</b> 멀티 방이에요.<br>아이돌 노래 <b>${db.songs.length}곡</b> (${db.minYear}~${db.maxYear}) 중에서 문제가 나와요.<br>제일 먼저 맞힌 사람이 점수를 가져가요!<br><br>▶ <code>/시작</code> 게임 시작 · 📖 <code>/도움말</code> 명령어`);
    }
    if (announce) this.sys(`👋 ${esc(p.name)}님이 들어왔어요`);
    this.pushPlayers();
  }
  leave(id, res) {
    const p = this.players.get(id);
    if (!p) return;
    p.conns.delete(res);
    if (p.conns.size) return;
    p.leaveT = setTimeout(() => {
      p.leaveT = null;
      if (p.conns.size) return;
      this.players.delete(id);
      this.sys(`${esc(p.name)}님이 나갔어요`);
      this.pushPlayers();
      if (!this.players.size) this.onEmpty();
    }, 6000);
  }
  onEmpty() {
    this.stopGame();
    this.emptyT = setTimeout(() => { if (!this.players.size) rooms.delete(this.name); }, 30 * 60 * 1000);
  }

  // 채팅 처리
  message(id, raw) {
    const p = this.players.get(id);
    if (!p || !p.conns.size) return;
    const text = String(raw || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300);
    if (!text) return;
    const isSlash = /^[\/!]/.test(text);
    const m = text.replace(/^[\/!]\s*/, '').match(/^(\S+)\s*([\s\S]*)$/);
    const cmd = m ? m[1] : '';
    const arg = m ? m[2].trim() : '';
    const g = this.g;

    if (!isSlash && g && g.q && !g.locked) {
      const r = Q.checkAnswer(text, g.q, g.qMode, db.aliases);
      if (r.ok) { this.chat(p, text, 'ok'); return this.correct(p); }
      if (!NOSLASH.has(cmd)) {
        this.chat(p, text, 'wrong');
        if (r.close) this.bot(`🤏 ${esc(p.name)}님 아까워요! 거의 맞았어요`);
        return;
      }
    }
    this.chat(p, text, null);
    if (isSlash || NOSLASH.has(cmd)) this.run(p, cmd, arg);
  }

  run(p, cmd, arg) {
    switch (cmd.toLowerCase()) {
      case '도움말': case '명령어': case 'help': case '?': return this.bot(Q.helpHTML(true));
      case '시작': case 'start': case 'go': return this.start(p, arg);
      case '힌트': case 'hint': case 'h': return this.hint(false);
      case '패스': case '스킵': case '포기': case '넘기기': case 'pass': case 'skip': return this.pass(p);
      case '점수': case '순위': case '스코어': case 'score': return this.scoreboard();
      case '종료': case '그만': case '끝': case 'stop': case 'end':
        return this.g ? this.finish(true, p) : this.bot('진행 중인 게임이 없어요.');
      case '모드': case 'mode': return this.setMode(arg);
      case '연대': case '시대': case 'era': return this.setEra(arg);
      case '가수': case 'artist': return this.setArtist(arg);
      case '시간': case 'time': return this.setTime(arg);
      case '추가': case 'add': return this.addCustom(p, arg);
      case '내문제': case '목록': return this.listCustom();
      case '내문제삭제': case '삭제': return this.delCustom(arg);
      case '통계': case '곡수': return this.bot(Q.statsHTML(db, customList().length));
      case '누구': case '접속자': case '멤버': return this.bot(`👥 접속 중 (${this.online().length}명)<br>${this.online().map((x) => esc(x.name)).join(', ')}`);
      case '닉네임': case '이름': return this.rename(p, arg);
      case '기록': case '랭킹': return this.bot('멀티에서는 게임이 끝날 때 순위가 나와요. 진행 중이면 <code>/순위</code>');
      case '위장': case '테마': case '청소': case '지우기': case 'clear': return; // 각자 화면에서 처리
      default: return this.bot(`모르는 명령어예요: <code>/${esc(cmd)}</code> · <code>/도움말</code> 참고`);
    }
  }

  // ───── 게임 ─────
  pool() { return this.set.mode === '가사' ? customList() : Q.filterPool(db, this.set); }

  start(p, arg) {
    if (this.g) return this.bot('이미 게임이 진행 중이에요! 그만하려면 <code>/종료</code>');
    let n = arg === '' ? 10 : parseInt(arg, 10);
    if (isNaN(n) || n < 0) n = 10;
    n = Math.min(n, 999);
    const pool = this.pool();
    if (!pool.length) {
      if (this.set.mode === '가사') return this.bot('가사 문제가 아직 없어요 😢<br><code>/추가 제목 | 가수 | 연도 | 가사</code> 로 먼저 추가해주세요.');
      return this.bot('조건에 맞는 노래가 없어요. <code>/연대 전체</code> 또는 <code>/가수</code> 로 필터를 풀어보세요.');
    }
    this.g = { limit: n, deck: shuffle(pool.slice()), q: null, qMode: null, qNo: 0, hints: 0, locked: true, remain: 0, tl: 0, timer: null, nextT: null, scores: new Map(), lastWinner: null, streak: 0 };
    const filter = this.set.mode === '가사' ? '' : `<br>연대: ${ERA_LABEL[this.set.era]}${this.set.artist ? ' · 가수: ' + esc(this.set.artist) : ''}`;
    this.bot(`🎮 <b>${esc(p.name)}</b>님이 게임을 시작했어요!<br>모드: <b>${MODE_LABEL[this.set.mode]}</b><br>문제 수: <b>${n ? n + '문제' : '무한'}</b> · 제한시간: <b>${this.set.time ? this.set.time + '초' : '없음'}</b>${filter} <span style="opacity:.7">(${pool.length}곡 중 출제)</span>`);
    this.g.nextT = setTimeout(() => this.next(), 1500);
  }

  next() {
    const g = this.g;
    if (!g) return;
    g.nextT = null;
    if (g.limit && g.qNo >= g.limit) return this.finish(false);
    if (!g.deck.length) g.deck = shuffle(this.pool().slice());
    if (!g.deck.length) return this.finish(false);
    g.q = g.deck.pop();
    g.qNo++;
    g.hints = 0;
    g.qMode = this.set.mode === '랜덤' ? (Math.random() < 0.5 ? '초성' : '가수') : this.set.mode;
    this.bot(Q.questionHTML(g.q, g.qMode, `문제 ${g.qNo}${g.limit ? ' / ' + g.limit : ''}`));
    g.locked = false;
    this.startTimer();
  }

  startTimer() {
    const g = this.g;
    clearInterval(g.timer);
    g.tl = this.set.time;
    if (!g.tl) return this.timer(null);
    g.remain = g.tl;
    this.timer(g.remain);
    g.timer = setInterval(() => this.tick(), 1000);
  }
  stopTimer() {
    if (this.g) { clearInterval(this.g.timer); this.g.timer = null; }
    this.timer(null);
  }
  tick() {
    const g = this.g;
    if (!g || g.locked) return;
    g.remain--;
    this.timer(g.remain);
    if (g.remain === Math.floor(g.tl / 2) && g.hints === 0 && g.tl >= 20) this.hint(true);
    if (g.remain === 10 && g.tl > 15) this.bot('⏰ <b>10초</b> 남았어요!');
    if (g.remain <= 0) this.timeout();
  }

  hint(auto) {
    const g = this.g;
    if (!g || !g.q || g.locked) { if (!auto) this.bot('지금은 풀고 있는 문제가 없어요. <code>/시작</code> 으로 시작!'); return; }
    if (g.hints >= 3) return this.bot('힌트를 모두 썼어요 🙅 모르겠으면 <code>/패스</code>');
    g.hints++;
    this.bot(`💡 ${auto ? '자동 ' : ''}힌트 ${g.hints}/3<br>${Q.hintText(g.q, g.qMode, g.hints, db.byArtist)}`);
  }

  correct(p) {
    const g = this.g;
    g.locked = true;
    this.stopTimer();
    g.streak = g.lastWinner === p.id ? g.streak + 1 : 1;
    g.lastWinner = p.id;
    const pts = Q.points(g.hints, g.streak);
    const s = g.scores.get(p.id) || { name: p.name, score: 0, correct: 0 };
    s.name = p.name;
    s.score += pts.total;
    s.correct++;
    g.scores.set(p.id, s);
    this.bot(`🎉 <b>${esc(p.name)}</b>님 정답! +${pts.total}점${pts.bonus ? ` (🔥 ${g.streak}연속 +${pts.bonus})` : ''}${Q.card(g.q)}`);
    this.scheduleNext(2000);
  }
  timeout() {
    const g = this.g;
    if (!g || g.locked) return;
    g.locked = true;
    this.stopTimer();
    g.lastWinner = null;
    g.streak = 0;
    this.bot(`⌛ 시간 초과! 아무도 못 맞혔어요. 정답은…${Q.card(g.q)}`);
    this.scheduleNext(2200);
  }
  pass(p) {
    const g = this.g;
    if (!g || !g.q || g.locked) return this.bot('지금은 넘길 문제가 없어요.');
    g.locked = true;
    this.stopTimer();
    g.lastWinner = null;
    g.streak = 0;
    this.bot(`⏭ ${esc(p.name)}님이 패스했어요. 정답은…${Q.card(g.q)}`);
    this.scheduleNext(2000);
  }
  scheduleNext(ms) {
    clearTimeout(this.g.nextT);
    this.g.nextT = setTimeout(() => this.next(), ms);
  }

  ranking() {
    const list = [...this.g.scores.values()].sort((a, b) => b.score - a.score || b.correct - a.correct);
    if (!list.length) return '아직 아무도 못 맞혔어요 😅';
    return list.map((s, i) => `${MEDALS[i] || `${i + 1}.`} <b>${esc(s.name)}</b> ${s.score}점 (${s.correct}개)`).join('<br>');
  }
  scoreboard() {
    if (!this.g) return this.bot('진행 중인 게임이 없어요. <code>/시작</code> 으로 시작!');
    this.bot(`📊 현재 순위 (문제 ${this.g.qNo}${this.g.limit ? ' / ' + this.g.limit : ''})<br>${this.ranking()}`);
  }
  finish(manual, p) {
    const g = this.g;
    this.stopTimer();
    clearTimeout(g.nextT);
    if (manual && g.q && !g.locked) this.bot(`${p ? esc(p.name) + '님이 게임을 끝냈어요. ' : ''}이번 문제 정답은…${Q.card(g.q)}`);
    const top = [...g.scores.values()].sort((a, b) => b.score - a.score)[0];
    this.bot(`🏁 <b>게임 종료!</b> (총 ${g.qNo}문제)<br><br>${this.ranking()}${top ? `<br><br>👑 오늘의 케이팝 왕: <b>${esc(top.name)}</b>` : ''}<br><br>다시 하려면 <code>/시작</code>`);
    this.g = null;
  }
  stopGame() {
    if (!this.g) return;
    clearInterval(this.g.timer);
    clearTimeout(this.g.nextT);
    this.g = null;
  }

  // ───── 설정 ─────
  guard(what) {
    if (this.g) { this.bot(`게임 중에는 ${what} 변경이 안 돼요. <code>/종료</code> 후에 바꿔주세요.`); return true; }
    return false;
  }
  setMode(arg) {
    const key = Q.parseMode(arg);
    if (key === null) return this.bot(`현재 모드: <b>${MODE_LABEL[this.set.mode]}</b><br><code>/모드 초성</code> · <code>/모드 가수</code> · <code>/모드 가사</code> · <code>/모드 랜덤</code>`);
    if (!key) return this.bot('모드는 <b>초성 · 가수 · 가사 · 랜덤</b> 중에서 골라주세요.');
    if (this.guard('모드')) return;
    this.set.mode = key;
    const extra = key === '가사' ? `<br>등록된 가사 문제 ${customList().length}개` : '';
    this.bot(`✅ 모드 변경: <b>${MODE_LABEL[key]}</b>${extra}`);
  }
  setEra(arg) {
    const key = Q.parseEra(arg);
    if (key === null) return this.bot(`현재 연대: <b>${ERA_LABEL[this.set.era]}</b><br><code>/연대 90</code> · <code>/연대 00</code> · <code>/연대 10</code> · <code>/연대 20</code> · <code>/연대 전체</code>`);
    if (!key) return this.bot('연대는 90 · 00 · 10 · 20 · 전체 중 하나로 입력해주세요.');
    if (this.guard('연대')) return;
    this.set.era = key;
    this.bot(`✅ 연대: <b>${ERA_LABEL[key]}</b> (${Q.filterPool(db, this.set).length}곡)`);
  }
  setArtist(arg) {
    if (this.guard('가수 필터')) return;
    if (!arg) { this.set.artist = null; return this.bot(`✅ 가수 필터 해제 (${Q.filterPool(db, this.set).length}곡)`); }
    const hit = Q.findArtist(db, arg);
    if (!hit.length) return this.bot(`'${esc(arg)}' 가수를 찾지 못했어요 🤔`);
    if (hit.length > 1) return this.bot(`여러 가수가 있어요: ${hit.map((h) => `<code>${esc(h)}</code>`).join(' ')}`);
    this.set.artist = hit[0];
    this.bot(`✅ 가수: <b>${esc(hit[0])}</b> (${Q.filterPool(db, this.set).length}곡)`);
  }
  setTime(arg) {
    if (arg === '') return this.bot(`현재 제한시간: <b>${this.set.time ? this.set.time + '초' : '무제한'}</b> · 예) <code>/시간 30</code>, <code>/시간 0</code>`);
    let t = parseInt(arg, 10);
    if (isNaN(t) || t < 0) return this.bot('숫자로 입력해주세요. 예) <code>/시간 30</code>');
    if (t > 0) t = Math.max(10, Math.min(300, t));
    this.set.time = t;
    this.bot(`✅ 제한시간: <b>${t ? t + '초' : '무제한'}</b>${this.g ? ' (다음 문제부터 적용)' : ''}`);
  }
  addCustom(p, arg) {
    const item = Q.parseCustomArg(arg);
    if (!item) return this.bot('형식: <code>/추가 제목 | 가수 | 연도 | 가사</code>');
    const list = readCustomStore();
    if (list.length >= 500) return this.bot('가사 문제가 너무 많아요 (최대 500개).');
    item.by = p.name;
    list.push(item);
    writeCustomStore(list);
    this.bot(`✅ ${esc(p.name)}님이 가사 문제를 추가했어요 (총 ${list.length}개)<br><code>/모드 가사</code> 로 풀 수 있어요.`);
  }
  listCustom() {
    const list = readCustomStore();
    if (!list.length) return this.bot('채팅으로 추가한 가사 문제가 없어요.<br><code>/추가 제목 | 가수 | 연도 | 가사</code>');
    // 정답이 보이면 안 되니까 제목은 초성으로만
    this.bot(`📝 가사 문제 ${list.length}개<br>${list.map((q, i) => `${i + 1}. ${esc(Q.choMask(String(q.title)))} (추가: ${esc(q.by || '?')})`).join('<br>')}<br><br>삭제: <code>/내문제삭제 번호</code>`);
  }
  delCustom(arg) {
    const list = readCustomStore();
    const i = parseInt(arg, 10) - 1;
    if (isNaN(i) || i < 0 || i >= list.length) return this.bot('삭제할 번호를 확인해주세요. <code>/내문제</code> 로 목록 보기');
    list.splice(i, 1);
    writeCustomStore(list);
    this.bot(`🗑 ${i + 1}번 문제를 삭제했어요.`);
  }
  rename(p, arg) {
    if (!arg) return this.bot(`지금 닉네임: <b>${esc(p.name)}</b> · 바꾸려면 <code>/닉네임 새이름</code>`);
    const old = p.name;
    p.name = this.uniqueName(arg, p.id);
    if (this.g && this.g.scores.has(p.id)) this.g.scores.get(p.id).name = p.name;
    for (const r of p.conns) this.send(r, { t: 'name', name: p.name });
    this.sys(`${esc(old)} → <b>${esc(p.name)}</b> 닉네임 변경`);
    this.pushPlayers();
  }
}

// ───── HTTP ─────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (!(pathname === '/index.html' || pathname.startsWith('/css/') || pathname.startsWith('/js/'))) return notFound(res);
  let file;
  try { file = path.normalize(path.join(ROOT, decodeURIComponent(pathname))); } catch (e) { return notFound(res); }
  if (!file.startsWith(ROOT + path.sep)) return notFound(res);
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
function notFound(res) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

function readBody(req, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/ping') return json(res, 200, { ok: true, songs: db.songs.length });

  if (p === '/api/events' && req.method === 'GET') {
    const id = String(url.searchParams.get('id') || '');
    if (!/^[\w-]{6,40}$/.test(id)) return json(res, 400, { error: 'bad id' });
    const room = getRoom(url.searchParams.get('room'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    room.join(id, url.searchParams.get('name'), res);
    const hb = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(hb); room.leave(id, res); });
    return;
  }

  if (p === '/api/send' && req.method === 'POST') {
    return readBody(req, 4096, (body) => {
      let data;
      try { data = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const room = rooms.get(String(data.room || '').replace(/[^\w가-힣-]/g, '').slice(0, 20) || 'lobby');
      if (room) {
        try { room.message(String(data.id || ''), data.text); } catch (e) { console.error('[!] 메시지 처리 오류:', e); }
      }
      res.writeHead(204);
      res.end();
    });
  }

  if (req.method === 'GET') return serveStatic(res, p);
  notFound(res);
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n[!] ${PORT}번 포트를 이미 쓰고 있어요. 서버가 이미 켜져 있는지 확인하거나 다른 포트로 실행하세요:\n    set PORT=3001 && node server.js\n`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log('');
  console.log('  🎵 K-POP 노래 맞추기 멀티 서버 실행 중');
  console.log('');
  console.log(`  내 컴퓨터     : http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  친구한테 공유 : http://${ip}:${PORT}`));
  console.log('');
  console.log('  · 친구도 같은 와이파이 / 같은 사내망이어야 해요');
  console.log('  · 방 나누기: 주소 뒤에 ?room=방이름');
  console.log('  · 끄려면 이 창에서 Ctrl+C');
  console.log('');
  if (process.argv.includes('--open') && process.platform === 'win32') {
    require('child_process').exec(`start "" "http://localhost:${PORT}"`);
  }
});

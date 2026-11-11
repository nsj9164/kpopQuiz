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
const EXTRA = loadWindowScript('js/songs-extra.js').SONGS_EXTRA || []; // tools/build-songs.js 로 만든 추가 곡
const db = Q.buildDB([...(W.SONGS || []), ...EXTRA], W.ARTIST_ALIASES || {}, W.ARTIST_EN || {});

// LRCLIB 가사 불러오기 (서버 메모리에 캐시, 7초 넘으면 포기)
async function fetchJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'kpop-quiz/1.0 (https://github.com/nsj9164/kpopQuiz)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
const getLyrics = Q.makeLyricsFetcher(fetchJSON, db);
const idols = Q.buildIdols(loadWindowScript('js/idols.js').IDOLS);           // 얼굴 퀴즈 (tools/build-idols.js)
const covers = Q.buildCovers(db, loadWindowScript('js/covers.js').COVERS);   // 자켓 퀴즈 (tools/build-covers.js)

// 끝말잇기 사전 (표준국어대사전 명사)
const WC = require('./js/wordchain-core.js');
const wcDict = WC.build(loadWindowScript('js/words.js').WORD_DICT);
if (!wcDict.size) console.error('[!] 끝말잇기 사전(js/words.js)이 비어 있어요');
const getDiscography = Q.makeDiscographyFetcher(fetchJSON, db); // 노래 릴레이용 (iTunes)

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
    this.set = { mode: '가사', era: 'all', artist: null, time: 40, turnTime: 20, wcTime: 20 }; // turnTime: 릴레이 한 사람 차례 시간, wcTime: 끝말잇기 한 턴
    this.g = null;
    this.wc = null; // 끝말잇기
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
    const g = this.g, w = this.wc;
    this.send(res, { t: 'timer', remain: g && !g.locked && g.tl ? g.remain : w && !w.locked && w.time ? w.remain : null });
    if (g && g.img) this.send(res, Object.assign({ t: 'img' }, g.img));
    if (!this.history.length) {
      this.bot(`안녕하세요! 🎵 <b>K-POP 노래 맞추기</b> 멀티 방이에요.<br>아이돌 노래 <b>${db.songs.length}곡</b> (${db.minYear}~${db.maxYear}) 중에서 문제가 나와요.<br>제일 먼저 맞힌 사람이 점수를 가져가요!<br><br>▶ <code>/시작</code> 게임 시작 · 📖 <code>/도움말</code> 명령어`);
    }
    if (announce) this.sys(`👋 ${esc(p.name)}님이 들어왔어요${g && g.mode === '릴레이' ? ' (다음 라운드부터 순서에 들어가요)' : ''}`);
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
      if (!this.players.size) return this.onEmpty();
      const g = this.g;
      if (g && g.r && !g.locked && g.r.turn === id) this.relayOut('🚪 나갔어요');
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
    if (g) { g.idle = 0; if (g.r) g.r.active = true; } // 누가 뭐라도 치면 자리에 사람이 있는 것

    if (!isSlash && this.wc) return this.wcMessage(p, text, cmd, arg);
    // 릴레이: 자기 차례인 사람이 친 채팅만 채점
    if (!isSlash && g && g.r && !g.locked && g.r.turn === p.id && !NOSLASH.has(cmd)) return this.relayAnswer(p, text);
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
    if (this.wc && this.wcRun(p, cmd)) return;
    switch (cmd.toLowerCase()) {
      case '도움말': case '명령어': case 'help': case '?': return this.bot(Q.helpHTML(true));
      case '끝말잇기': case '끝말': case 'wc': case 'wordchain': return this.wcStart(p, arg);
      case '시작': case 'start': case 'go':
        if (/^끝말/.test(arg)) return this.wcStart(p, arg.replace(/^끝말(잇기)?\s*/, ''));
        return this.start(p, arg);
      case '힌트': case 'hint': case 'h': return this.g && this.g.r ? this.relayHint(p) : this.hint(false);
      case '패스': case '스킵': case '포기': case '넘기기': case 'pass': case 'skip': return this.g && this.g.r ? this.relayPass(p) : this.pass(p);
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
      case '통계': case '곡수': return this.bot(Q.statsHTML(db, customList().length, idols.length, covers.length));
      case '누구': case '접속자': case '멤버': return this.bot(`👥 접속 중 (${this.online().length}명)<br>${this.online().map((x) => esc(x.name)).join(', ')}`);
      case '닉네임': case '이름': return this.rename(p, arg);
      case '기록': case '랭킹': return this.bot('멀티에서는 게임이 끝날 때 순위가 나와요. 진행 중이면 <code>/순위</code>');
      case '위장': case '테마': case '청소': case '지우기': case 'clear': return; // 각자 화면에서 처리
      default: return this.bot(`모르는 명령어예요: <code>/${esc(cmd)}</code> · <code>/도움말</code> 참고`);
    }
  }

  // ───── 게임 ─────
  // 가사 모드: 수록곡(가사는 LRCLIB 에서) + 직접 추가한 가사 문제
  pool() { return Q.poolFor(this.set.mode, { db, idols, covers, custom: this.set.mode === '가사' ? customList() : [] }, this.set); }
  // 사진 문제 (얼굴·자켓): 에디터 이미지 탭으로 보내기. g.img = 지금 상태 (늦게 들어온 사람한테도 보냄)
  img(ev) {
    const g = this.g;
    if (ev.close) { if (g) g.img = null; return this.broadcast({ t: 'img', close: true }); }
    if (!g || (!ev.src && !g.img)) return;
    g.img = ev.src ? Object.assign({}, ev) : Object.assign(g.img, ev);
    this.broadcast(Object.assign({ t: 'img' }, ev));
  }
  isImage() { return !!this.g && Q.IMAGE_MODES.has(this.g.qMode); }
  updateStage() {
    const g = this.g;
    if (!this.isImage() || g.locked) return;
    const st = Q.imageStage(g.hints, g.remain, g.tl);
    if (st !== g.stage) { g.stage = st; this.img({ blur: Q.BLUR[st] }); }
  }
  reveal() {
    if (this.isImage() && this.g.img) this.img({ reveal: true, blur: 0, credit: this.g.q.credit });
  }
  preload(g) {
    if (g.prep) g.prep.then((it) => { if (this.g === g && it && it.q && it.q.img) this.broadcast({ t: 'img', preload: it.q.img }); }, () => {});
  }
  prepare(g) {
    return Q.prepareQuestion({
      mode: g.mode,
      takeSong: () => { if (!g.deck.length) g.deck = shuffle(this.pool().slice()); return g.deck.pop() || null; },
      getLyrics,
    });
  }

  start(p, arg) {
    if (this.g) return this.bot('이미 게임이 진행 중이에요! 그만하려면 <code>/종료</code>');
    if (this.wc) return this.bot('끝말잇기 중이에요! 노래 퀴즈를 하려면 <code>/종료</code> 후에 <code>/시작</code>');
    if (this.set.mode === '릴레이') return this.relayStart(p, arg);
    let n = arg === '' ? 0 : parseInt(arg, 10); // 숫자 없으면 무제한 (/종료 로 끝)
    if (isNaN(n) || n < 0) n = 0;
    n = Math.min(n, 999);
    const pool = this.pool();
    if (!pool.length) return this.bot('조건에 맞는 노래가 없어요. <code>/연대 전체</code> 또는 <code>/가수</code> 로 필터를 풀어보세요.');
    const g = this.g = { mode: this.set.mode, limit: n, deck: shuffle(pool.slice()), q: null, qMode: null, qNo: 0, hints: 0, locked: true, remain: 0, tl: 0, timer: null, nextT: null, scores: new Map(), lastWinner: null, streak: 0, prep: null, warnedOffline: false, idle: 0 };
    g.prep = this.prepare(g); // 첫 문제 가사 미리 불러오기
    this.preload(g);
    this.img({ close: true });
    const filter = `<br>연대: ${ERA_LABEL[this.set.era]}${this.set.artist ? ' · 가수: ' + esc(this.set.artist) : ''}`;
    this.bot(`🎮 <b>${esc(p.name)}</b>님이 게임을 시작했어요!<br>모드: <b>${MODE_LABEL[this.set.mode]}</b><br>문제 수: <b>${n ? n + '문제' : '무한'}</b> · 제한시간: <b>${this.set.time ? this.set.time + '초' : '없음'}</b>${filter} <span style="opacity:.7">(${pool.length}${this.set.mode === '얼굴' ? '명' : this.set.mode === '자켓' ? '장' : '곡'} 중 출제)</span>`);
    g.nextT = setTimeout(() => this.next(), 1500);
  }

  async next() {
    const g = this.g;
    if (!g) return;
    if (g.mode === '릴레이') return this.relayRound();
    g.nextT = null;
    if (g.limit && g.qNo >= g.limit) return this.finish(false);
    const p = g.prep || this.prepare(g);
    g.prep = null;
    const slow = setTimeout(() => { if (this.g === g) this.bot('🔎 가사 불러오는 중…'); }, 1200);
    let item = null;
    try { item = await p; } catch (e) { item = null; }
    clearTimeout(slow);
    if (this.g !== g) return; // 기다리는 사이 게임이 끝남
    if (!item) return this.finish(false);
    if (item.fallback === 'offline' && !g.warnedOffline) {
      g.warnedOffline = true;
      this.bot('⚠ 가사 서버(LRCLIB)에 연결이 안 돼요. 연결될 때까지 초성 퀴즈로 낼게요.');
    } else if (item.fallback === 'notfound') {
      this.bot('가사를 찾지 못한 곡이라 이번 문제는 초성 퀴즈로 낼게요.');
    }
    g.q = item.q;
    g.qMode = item.mode;
    g.qNo++;
    g.hints = 0;
    g.stage = 0;
    this.bot(Q.questionHTML(g.q, g.qMode, `문제 ${g.qNo}${g.limit ? ' / ' + g.limit : ''}`, g.qNo));
    if (this.isImage()) this.img({ file: Q.imageFile(g.qNo), src: g.q.img, blur: Q.BLUR[0], credit: g.q.credit });
    g.locked = false;
    this.startTimer();
    if (!g.limit || g.qNo < g.limit) { g.prep = this.prepare(g); this.preload(g); } // 다음 문제 미리 준비
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
    this.updateStage();
    if (g.remain === Math.floor(g.tl / 2) && g.hints === 0 && g.tl >= 20) this.hint(true);
    if (g.remain === 10 && g.tl > 15) this.bot('⏰ <b>10초</b> 남았어요!');
    if (g.remain <= 0) this.timeout();
  }

  hint(auto) {
    const g = this.g;
    if (!g || !g.q || g.locked) { if (!auto) this.bot('지금은 풀고 있는 문제가 없어요. <code>/시작</code> 으로 시작!'); return; }
    if (g.hints >= 3) return this.bot('힌트를 모두 썼어요 🙅 모르겠으면 <code>/패스</code>');
    g.hints++;
    this.updateStage();
    this.bot(`💡 ${auto ? '자동 ' : ''}힌트 ${g.hints}/3<br>${Q.hintText(g.q, g.qMode, g.hints, db.byArtist)}`);
  }

  correct(p) {
    const g = this.g;
    g.locked = true;
    this.stopTimer();
    g.streak = g.lastWinner === p.id ? g.streak + 1 : 1;
    g.lastWinner = p.id;
    const pts = Q.points(this.isImage() ? g.stage : g.hints, g.streak);
    this.reveal();
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
    this.reveal();
    this.bot(`⌛ 시간 초과! 아무도 못 맞혔어요. 정답은…${Q.card(g.q)}`);
    // 아무도 아무것도 안 치고 3문제 연속 시간 초과 = 다들 자리 비움 → 끝
    if (++g.idle >= 3) { this.bot('😴 3문제 연속으로 아무도 입력이 없어서 게임을 끝낼게요.'); return this.finish(false); }
    this.scheduleNext(2200);
  }
  pass(p) {
    const g = this.g;
    if (!g || !g.q || g.locked) return this.bot('지금은 넘길 문제가 없어요.');
    g.locked = true;
    this.stopTimer();
    g.lastWinner = null;
    g.streak = 0;
    this.reveal();
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
    const unit = this.g.mode === '릴레이' ? '라운드' : '문제';
    this.bot(`📊 현재 순위 (${unit} ${this.g.qNo}${this.g.limit ? ' / ' + this.g.limit : ''})<br>${this.ranking()}`);
  }
  finish(manual, p) {
    const g = this.g;
    this.stopTimer();
    clearTimeout(g.nextT);
    if (manual && g.q && !g.locked) this.bot(`${p ? esc(p.name) + '님이 게임을 끝냈어요. ' : ''}이번 문제 정답은…${Q.card(g.q)}`);
    const top = [...g.scores.values()].sort((a, b) => b.score - a.score)[0];
    if (g.img) this.img({ close: true });
    this.bot(`🏁 <b>게임 종료!</b> (총 ${g.qNo}${g.mode === '릴레이' ? '라운드' : '문제'})<br><br>${this.ranking()}${top ? `<br><br>👑 오늘의 케이팝 왕: <b>${esc(top.name)}</b>` : ''}<br><br>다시 하려면 <code>/시작</code>`);
    this.g = null;
  }
  stopGame() {
    if (this.wc) { clearInterval(this.wc.timer); clearTimeout(this.wc.nextT); this.wc = null; }
    if (!this.g) return;
    clearInterval(this.g.timer);
    clearTimeout(this.g.nextT);
    this.g = null;
    this.broadcast({ t: 'img', close: true });
  }

  // ───── 끝말잇기 ─────
  // 제일 먼저 이은 사람이 글자 수만큼 점수. 같은 사람 연속 X (혼자 있을 땐 OK)
  // 아무도 못 이으면 마지막에 이은 사람 +5, 한방단어도 +5
  wcStart(p, arg) {
    if (this.g) return this.bot('노래 퀴즈가 진행 중이에요. <code>/종료</code> 후에 시작해주세요.');
    if (this.wc) return this.bot('이미 끝말잇기 중이에요! 그만하려면 <code>/종료</code>');
    if (!wcDict.size) return this.bot('⚠ 끝말잇기 사전(js/words.js)을 못 읽었어요.');
    let t = arg === '' ? this.set.wcTime : parseInt(arg, 10);
    if (isNaN(t) || t < 0) t = 20;
    if (t > 0) t = Math.max(5, Math.min(120, t));
    this.set.wcTime = t;
    this.wc = { need: '', used: new Set(), time: t, remain: 0, timer: null, nextT: null, locked: true, last: null, idle: 0, hinted: false, count: 0, scores: new Map() };
    this.bot(`🎮 <b>${esc(p.name)}</b>님이 끝말잇기를 시작했어요!<br>${WC.rulesHTML(true, t)}`);
    this.wc.nextT = setTimeout(() => this.wcBot(WC.startWord(wcDict, this.wc.used), '첫 단어는…'), 1200);
  }
  // 봇이 단어를 내고 다음 턴 시작
  wcBot(word, lead) {
    const w = this.wc;
    if (!w) return;
    w.used.add(word);
    w.need = WC.lastOf(word);
    w.last = null;
    w.hinted = false;
    this.bot(`${lead ? lead + '<br>' : ''}${WC.wordHTML(word, wcDict.kind.get(word), '멜로디봇')}`);
    this.wcTurn();
  }
  wcTurn() {
    const w = this.wc;
    w.locked = false;
    clearInterval(w.timer);
    if (!w.time) return this.timer(null);
    w.remain = w.time;
    this.timer(w.remain);
    w.timer = setInterval(() => {
      if (!this.wc || w.locked) return;
      w.remain--;
      this.timer(w.remain);
      if (w.remain === 5 && w.time > 8) this.bot('⏰ <b>5초</b>!');
      if (w.remain <= 0) this.wcTimeout();
    }, 1000);
  }
  wcPause() {
    const w = this.wc;
    w.locked = true;
    clearInterval(w.timer);
    w.timer = null;
    this.timer(null);
  }
  wcAdd(p, pts, word) {
    const s = this.wc.scores.get(p.id) || { name: p.name, score: 0, words: 0 };
    s.name = p.name;
    s.score += pts;
    if (word) s.words++;
    this.wc.scores.set(p.id, s);
  }
  wcMessage(p, text, cmd, arg) {
    const w = this.wc;
    const r = w.locked ? null : WC.check(wcDict, text, w.need, w.used);
    if (r && r.ok) {
      if (w.last === p.id && this.online().length > 1) {
        this.chat(p, text, 'wrong');
        return this.bot(`🙅 ${esc(p.name)}님은 방금 이었어요. 다른 사람 차례!`);
      }
      this.chat(p, text, 'ok');
      return this.wcAccept(p, r);
    }
    if (NOSLASH.has(cmd)) { this.chat(p, text, null); return this.run(p, cmd, arg); }
    if (!r || !r.attempt) return this.chat(p, text, null); // 그냥 채팅
    this.chat(p, text, 'wrong');
    this.bot(`${esc(p.name)}님, ${WC.reasonText(r, w.need)}`);
  }
  wcAccept(p, r) {
    const w = this.wc;
    this.wcPause();
    w.used.add(r.word);
    w.count++;
    w.idle = 0;
    const pts = r.word.length;
    const tag = WC.KIND_LABEL[r.kind] ? ` <span class="wc-tag">${WC.KIND_LABEL[r.kind]}</span>` : '';
    if (r.killer) {
      this.wcAdd(p, pts + 5, true);
      this.bot(`💥 <b>한방단어!</b> ${esc(p.name)}님 +${pts + 5}점${tag}<br>${WC.needLabel(WC.lastOf(r.word))}(으)로 시작하는 단어가 사전에 없어요. 새 단어로 갈게요!`);
      w.nextT = setTimeout(() => this.wcBot(WC.startWord(wcDict, w.used), '새 단어는…'), 2000);
      return;
    }
    this.wcAdd(p, pts, true);
    w.need = WC.lastOf(r.word);
    w.last = p.id;
    w.hinted = false;
    this.bot(`✅ <b>${esc(p.name)}</b> +${pts}점${tag} · 다음 글자: <b>${WC.needLabel(w.need)}</b>`);
    this.wcTurn();
  }
  wcTimeout() {
    const w = this.wc;
    if (!w || w.locked) return;
    this.wcPause();
    const lastP = w.last && this.players.get(w.last);
    let lead;
    if (lastP) {
      this.wcAdd(lastP, 5, false);
      lead = `⌛ 아무도 못 이었어요! 마지막 <b>${esc(lastP.name)}</b>님 +5점`;
    } else {
      if (++w.idle >= 2) return this.wcFinish(null, '아무도 안 이어서 끝낼게요 😴');
      lead = '⌛ 아무도 못 이었네요.';
    }
    const next = WC.botPick(wcDict, w.need, w.used, 0);
    w.nextT = setTimeout(() => next ? this.wcBot(next, `${lead} 제가 이을게요`) : this.wcBot(WC.startWord(wcDict, w.used), `${lead} 새 단어는…`), 800);
  }
  wcRun(p, cmd) {
    const w = this.wc;
    switch (cmd.toLowerCase()) {
      case '힌트': case 'hint': case 'h': {
        if (w.locked) { this.bot('지금은 힌트를 볼 수 없어요.'); return true; }
        if (w.hinted) { this.bot('이번 글자 힌트는 이미 나왔어요 🙅'); return true; }
        const h = WC.hintWord(wcDict, w.need, w.used);
        w.hinted = true;
        this.bot(h ? `💡 힌트: <span class="cho-inline">${esc(WC.mask(h))}</span> (${h.length}글자)` : '음… 저도 생각나는 단어가 없어요 😅');
        return true;
      }
      case '패스': case '스킵': case '포기': case '넘기기': case 'pass': case 'skip': {
        if (w.locked) return true;
        this.wcPause();
        const next = WC.botPick(wcDict, w.need, w.used, 0);
        const lead = `⏭ ${esc(p.name)}님이 패스했어요.`;
        w.nextT = setTimeout(() => next ? this.wcBot(next, `${lead} 제가 이을게요`) : this.wcBot(WC.startWord(wcDict, w.used), `${lead} 새 단어는…`), 500);
        return true;
      }
      case '점수': case '순위': case '스코어': case 'score':
        this.bot(`📊 끝말잇기 순위 (${w.count}단어째)<br>${this.wcRanking()}`);
        return true;
      case '종료': case '그만': case '끝': case 'stop': case 'end':
        this.wcFinish(p);
        return true;
      case '시작': case 'start': case 'go':
        this.bot('끝말잇기 중이에요! 노래 퀴즈를 하려면 <code>/종료</code> 후에 <code>/시작</code>');
        return true;
      default: return false;
    }
  }
  wcRanking() {
    const list = [...this.wc.scores.values()].sort((a, b) => b.score - a.score || b.words - a.words);
    if (!list.length) return '아직 아무도 못 이었어요 😅';
    return list.map((s, i) => `${MEDALS[i] || `${i + 1}.`} <b>${esc(s.name)}</b> ${s.score}점 (${s.words}단어)`).join('<br>');
  }
  wcFinish(p, why) {
    const w = this.wc;
    clearInterval(w.timer);
    clearTimeout(w.nextT);
    this.timer(null);
    const top = [...w.scores.values()].sort((a, b) => b.score - a.score)[0];
    this.bot(`🏁 <b>끝말잇기 끝!</b>${p ? ` (${esc(p.name)}님이 끝냈어요)` : ''}${why ? ' ' + why : ''}<br>이어진 단어 ${w.count}개<br><br>${this.wcRanking()}${top ? `<br><br>👑 오늘의 단어왕: <b>${esc(top.name)}</b>` : ''}<br><br>다시 하려면 <code>/끝말잇기</code>`);
    this.wc = null;
  }

  // ───── 노래 릴레이 (가수 보고 노래 쭉 적기, 돌아가면서 한 곡씩) ─────
  // g.r = { d: 노래 목록, order: 순서(id), names, alive: 안 탈락한 사람, used: 나온 곡, turn: 지금 차례, strikes, hinted }
  relayArtists() {
    const cnt = new Map();
    Q.filterPool(db, this.set).forEach((s) => cnt.set(s.artist, (cnt.get(s.artist) || 0) + 1));
    const all = [...cnt.keys()];
    // 뒤에서부터 뽑으니까 수록곡 많은(유명한) 가수를 뒤에
    return [...shuffle(all.filter((a) => cnt.get(a) < 3)), ...shuffle(all.filter((a) => cnt.get(a) >= 3))];
  }
  relayPrepare(g) {
    if (!g.deck.length) g.deck = this.relayArtists();
    const artist = g.deck.pop();
    return artist ? getDiscography(artist) : Promise.resolve(null);
  }
  relayStart(p, arg) {
    let n = arg === '' ? 0 : parseInt(arg, 10); // 숫자 없으면 무제한 (/종료 로 끝)
    if (isNaN(n) || n < 0) n = 0;
    n = Math.min(n, 99);
    const deck = this.relayArtists();
    if (!deck.length) return this.bot('조건에 맞는 가수가 없어요. <code>/연대 전체</code> 또는 <code>/가수</code> 로 필터를 풀어보세요.');
    const g = this.g = { mode: '릴레이', limit: n, deck, qNo: 0, r: null, locked: true, remain: 0, tl: 0, timer: null, nextT: null, scores: new Map(), prep: null, warnedOffline: false, idle: 0 };
    g.prep = this.relayPrepare(g); // 첫 가수 노래 목록 미리 불러오기
    const tt = this.set.turnTime;
    this.bot(`🎮 <b>${esc(p.name)}</b>님이 게임을 시작했어요!<br>모드: <b>${MODE_LABEL['릴레이']}</b> · <b>${n ? n + '라운드' : '무한'}</b> · 한 사람 차례 <b>${tt ? tt + '초' : '무제한'}</b>` +
      `<br><br>📢 규칙<br>· 가수 이름이 나오면 <b>순서대로</b> 그 가수 노래를 하나씩 적어요<br>· 대표곡 10점 · 수록곡 5점 · 이미 나온 노래는 안 돼요` +
      `<br>· 3번 틀리거나 시간이 지나면 <b>탈락</b> (<code>/패스</code> = 포기)<br>· 마지막까지 살아남으면 +10점 · <code>/힌트</code> 는 자기 차례에 1번 (맞히면 3점)`);
    g.nextT = setTimeout(() => this.relayRound(), 2500);
  }

  async relayRound() {
    const g = this.g;
    if (!g) return;
    g.nextT = null;
    if (g.limit && g.qNo >= g.limit) return this.finish(false);
    let order = this.online().map((x) => x.id);
    if (!order.length) return this.finish(false);
    const prep = g.prep || this.relayPrepare(g);
    g.prep = null;
    const slow = setTimeout(() => { if (this.g === g) this.bot('🔎 노래 목록 불러오는 중…'); }, 1200);
    let d = null;
    try { d = await prep; } catch (e) { d = null; }
    clearTimeout(slow);
    if (this.g !== g) return; // 기다리는 사이 게임이 끝남
    if (!d || !d.songs.length) return this.finish(false);
    if (!d.api && !g.warnedOffline) {
      g.warnedOffline = true;
      this.bot('⚠ iTunes에서 노래 목록을 못 받아왔어요. 이번 라운드는 내장 목록에 있는 곡만 정답으로 인정돼요.');
    }
    order = this.online().map((x) => x.id).filter((id) => order.includes(id)); // 기다리는 사이 나간 사람 빼기
    if (!order.length) return this.finish(false);
    const k = g.qNo % order.length; // 라운드마다 첫 순서 바꾸기
    order = [...order.slice(k), ...order.slice(0, k)];
    g.qNo++;
    g.r = { d, order, names: new Map(order.map((id) => [id, this.players.get(id).name])), alive: new Set(order), used: new Set(), turn: null, strikes: 0, hinted: false };
    const names = order.map((id) => esc(g.r.names.get(id))).join(' → ');
    this.bot(`<div class="q-head">🎤 라운드 ${g.qNo}${g.limit ? ' / ' + g.limit : ''} · 노래 릴레이</div><div class="q-title">${esc(d.artist)}</div><div class="q-meta">이 가수 노래를 돌아가면서 하나씩! · 순서: ${names}</div>`);
    g.locked = false;
    this.relayTurn(order[0], '');
    if (!g.limit || g.qNo < g.limit) g.prep = this.relayPrepare(g); // 다음 가수 미리 준비
  }

  relayTurn(id, prefix) {
    const g = this.g, r = g.r;
    r.turn = id;
    r.strikes = 0;
    r.hinted = false;
    g.tl = this.set.turnTime;
    this.bot(`${prefix}👉 <b>${esc(r.names.get(id))}</b>님 차례!${g.tl ? ` (${g.tl}초)` : ''}`);
    clearInterval(g.timer);
    g.timer = null;
    if (!g.tl) return this.timer(null);
    g.remain = g.tl;
    this.timer(g.remain);
    g.timer = setInterval(() => this.relayTick(), 1000);
  }
  relayTick() {
    const g = this.g;
    if (!g || !g.r || g.locked) return;
    g.remain--;
    this.timer(g.remain);
    if (g.remain <= 0) this.relayOut('⌛ 시간 초과!');
  }
  scoreOf(id, name) {
    const s = this.g.scores.get(id) || { name, score: 0, correct: 0 };
    s.name = (this.players.get(id) || {}).name || s.name;
    this.g.scores.set(id, s);
    return s;
  }

  relayAnswer(p, text) {
    const g = this.g, r = g.r;
    const res = Q.relayCheck(text, r.d);
    if (res.song && !r.used.has(res.song)) {
      this.chat(p, text, 'ok');
      r.used.add(res.song);
      const pts = r.hinted ? 3 : res.song.core ? 10 : 5;
      const s = this.scoreOf(p.id, p.name);
      s.score += pts;
      s.correct++;
      return this.relayNext(`✅ <b>${esc(res.song.title)}</b> +${pts}점${res.song.core ? '' : ' (수록곡)'}<br>`);
    }
    this.chat(p, text, 'wrong');
    if (res.song) return this.bot(`🔁 <b>${esc(res.song.title)}</b>은(는) 이미 나왔어요! 다른 노래로`);
    if (res.close) return this.bot('🤏 비슷한 제목의 곡이 있어요! 다시 써보세요');
    r.strikes++;
    if (r.strikes >= 3) return this.relayOut('❌ 3번 틀렸어요!');
    this.bot(`❌ ${esc(r.d.artist)} 노래 목록에 없어요 (${r.strikes}/3)`);
  }
  relayHint(p) {
    const g = this.g, r = g.r;
    if (!r || g.locked) return this.bot('지금은 진행 중인 차례가 없어요.');
    if (r.turn !== p.id) return this.bot(`힌트는 자기 차례에만 쓸 수 있어요. 지금은 <b>${esc(r.names.get(r.turn))}</b>님 차례!`);
    if (r.hinted) return this.bot('이번 차례 힌트는 이미 썼어요 🙅');
    const left = r.d.songs.filter((s) => !r.used.has(s));
    const pool = left.filter((s) => s.core).length ? left.filter((s) => s.core) : left;
    if (!pool.length) return this.bot('남은 노래가 없어요!');
    r.hinted = true;
    this.bot(`💡 힌트: <span class="cho-inline">${esc(Q.artistMask(Q.pick(pool).title, true))}</span> (맞히면 3점)`);
  }
  relayPass(p) {
    const g = this.g, r = g.r;
    if (!r || g.locked) return this.bot('지금은 진행 중인 차례가 없어요.');
    if (r.turn !== p.id) return this.bot(`패스는 자기 차례에만 할 수 있어요. 지금은 <b>${esc(r.names.get(r.turn))}</b>님 차례!`);
    this.relayOut('🏳 포기!');
  }
  // 지금 차례인 사람 탈락
  relayOut(why) {
    const g = this.g, r = g.r;
    r.alive.delete(r.turn);
    this.relayNext(`${why} 💥 <b>${esc(r.names.get(r.turn))}</b>님 탈락<br>`);
  }
  // 다음 차례로 넘기기 (남은 사람이 없으면 라운드 끝)
  relayNext(prefix) {
    const g = this.g, r = g.r;
    for (const id of r.alive) if (!this.players.has(id)) r.alive.delete(id); // 방을 나간 사람
    const left = r.order.filter((id) => r.alive.has(id));
    if (!left.length || (r.order.length >= 2 && left.length === 1) || r.used.size >= r.d.songs.length) return this.relayEnd(prefix, left);
    const i = r.order.indexOf(r.turn);
    let next = null;
    for (let k = 1; k <= r.order.length && !next; k++) {
      const id = r.order[(i + k) % r.order.length];
      if (r.alive.has(id)) next = id;
    }
    this.relayTurn(next, prefix);
  }
  relayEnd(prefix, left) {
    const g = this.g, r = g.r;
    g.locked = true;
    this.stopTimer();
    left.forEach((id) => { this.scoreOf(id, r.names.get(id)).score += 10; });
    const used = [...r.used].map((s) => esc(s.title));
    const missed = r.d.songs.filter((s) => s.core && !r.used.has(s)).slice(0, 6).map((s) => esc(s.title));
    let html = `${prefix}<br>🏁 <b>라운드 ${g.qNo} 끝!</b> (${esc(r.d.artist)})`;
    if (left.length) html += `<br>🏆 끝까지 살아남은 사람: <b>${left.map((id) => esc(r.names.get(id))).join(', ')}</b> +10점`;
    html += `<br>나온 노래 ${used.length}곡${used.length ? ': ' + used.join(' · ') : ''}`;
    if (missed.length) html += `<br>안 나온 대표곡: ${missed.join(' · ')}`;
    html += `<br><span style="opacity:.7">정답으로 인정되는 곡 ${r.d.songs.length}곡${r.d.api ? ' (iTunes 기준)' : ' (내장 목록)'}</span>`;
    this.bot(html);
    g.r = null;
    clearTimeout(g.nextT);
    // 한 라운드 내내 아무도 안 치고 전부 시간 초과 = 다들 자리 비움 → 끝
    if (!r.active) { this.bot('😴 한 라운드 동안 아무도 입력이 없어서 게임을 끝낼게요.'); return this.finish(false); }
    g.nextT = setTimeout(() => this.relayRound(), 4000);
  }
  setTurnTime(arg) {
    if (arg === '') return this.bot(`릴레이 한 사람 차례 시간: <b>${this.set.turnTime ? this.set.turnTime + '초' : '무제한'}</b> · 예) <code>/시간 15</code>, <code>/시간 0</code>`);
    let t = parseInt(arg, 10);
    if (isNaN(t) || t < 0) return this.bot('숫자로 입력해주세요. 예) <code>/시간 15</code>');
    if (t > 0) t = Math.max(5, Math.min(120, t));
    this.set.turnTime = t;
    this.bot(`✅ 릴레이 한 사람 차례: <b>${t ? t + '초' : '무제한'}</b>${this.g ? ' (다음 차례부터 적용)' : ''}`);
  }

  // ───── 설정 ─────
  guard(what) {
    if (this.g) { this.bot(`게임 중에는 ${what} 변경이 안 돼요. <code>/종료</code> 후에 바꿔주세요.`); return true; }
    return false;
  }
  setMode(arg) {
    const key = Q.parseMode(arg);
    if (key === null) return this.bot(`현재 모드: <b>${MODE_LABEL[this.set.mode]}</b><br><code>/모드 초성</code> · <code>/모드 가수</code> · <code>/모드 가사</code> · <code>/모드 랜덤</code> · <code>/모드 릴레이</code><br><code>/모드 얼굴</code> 사진 보고 아이돌 이름 · <code>/모드 자켓</code> 앨범 자켓 보고 타이틀곡`);
    if (!key) return this.bot('모드는 <b>초성 · 가수 · 가사 · 랜덤 · 얼굴 · 자켓 · 릴레이</b> 중에서 골라주세요.');
    if (this.guard('모드')) return;
    this.set.mode = key;
    const extra = key === '가사' ? '<br>가사는 LRCLIB에서 불러와요'
      : key === '얼굴' ? `<br>📸 각자 에디터에 사진이 흐릿하게 열리고 점점 선명해져요. 빨리 맞힐수록 점수 ↑ (${idols.length}명)<br>이름은 예명·본명·영어 다 OK · 사진: 위키미디어 공용`
      : key === '자켓' ? `<br>💿 각자 에디터에 앨범 자켓이 흐릿하게 열리고 점점 선명해져요. 그 앨범 타이틀곡 제목을 맞히면 정답 (${covers.length}장)`
      : key === '릴레이' ? `<br>가수 이름이 나오면 돌아가면서 그 가수 노래를 하나씩 적어요.<br>한 사람 차례: <b>${this.set.turnTime ? this.set.turnTime + '초' : '무제한'}</b> (<code>/시간</code> 으로 변경) · <code>/시작</code> = 무제한 (<code>/종료</code> 로 끝), <code>/시작 3</code> = 3라운드`
      : '';
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
    if (this.set.mode === '릴레이') return this.setTurnTime(arg);
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

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

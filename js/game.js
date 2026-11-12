// 채팅창 + 혼자 하기 게임 로직 (멀티 모드에서는 multi.js 가 채팅창을 넘겨받음)
(function () {
  'use strict';
  const Q = window.QuizCore;
  const { esc, pick, ERA_LABEL, MODE_LABEL } = Q;
  const $ = (s) => document.querySelector(s);
  const elChat = $('#chat'), elMsgs = $('#chat-msgs'), elInput = $('#chat-input'), elTimer = $('#chat-timer');
  const BOT = '멜로디봇';
  const AVATAR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 17.5a2.5 2.5 0 1 1-2.5-2.5c.5 0 1 .1 1.5.4V5l11-2v12.5a2.5 2.5 0 1 1-2.5-2.5c.5 0 1 .1 1.5.4V6.4l-9 1.7z"/></svg>';

  const store = {
    get(k, d) { try { const v = localStorage.getItem('kq.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('kq.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const db = Q.buildDB([...window.SONGS, ...(window.SONGS_EXTRA || [])], window.ARTIST_ALIASES, window.ARTIST_EN);
  const customList = () => Q.normalizeCustom([...(Array.isArray(window.CUSTOM_QUESTIONS) ? window.CUSTOM_QUESTIONS : []), ...store.get('custom', [])]);
  const idols = Q.buildIdols(window.IDOLS);           // 얼굴 퀴즈 (위키미디어 공용 사진)
  const covers = Q.buildCovers(db, window.COVERS);    // 자켓 퀴즈 (iTunes 앨범 아트)
  const VSimg = (ev) => { if (window.VS && window.VS.image) window.VS.image(ev); };
  const seen = Q.makeSeen(store.get('seen', [])); // 예전에 나온 문제 (다음 게임에서 안 나온 문제부터 내려고)

  // LRCLIB 에서 가사 불러오기 (7초 넘으면 포기)
  function fetchJSON(url) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl && setTimeout(() => ctrl.abort(), 7000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(() => clearTimeout(t));
  }
  const getLyrics = Q.makeLyricsFetcher(fetchJSON, db);

  // ───── 상태 ─────
  const S = {
    running: false,
    mode: Q.MODES.includes(store.get('mode', '가사')) && store.get('mode', '가사') !== '릴레이' ? store.get('mode', '가사') : '가사',
    era: ERA_LABEL[store.get('era', 'all')] ? store.get('era', 'all') : 'all',
    artist: db.byArtist.has(store.get('artist', null)) ? store.get('artist', null) : null,
    timeLimit: store.get('time', 40),
    limit: 10, deck: [], q: null, qMode: null, qNo: 0,
    correct: 0, score: 0, streak: 0, bestStreak: 0, hints: 0,
    locked: true, timer: null, remain: 0, paused: false, nextT: null,
    runId: 0, prep: null, warnedOffline: false,
    stage: 0, imgErrors: 0, // 사진 문제: 흐림 단계, 연속으로 사진을 못 불러온 횟수
  };
  const isImage = () => Q.IMAGE_MODES.has(S.qMode);

  // ───── 메시지 출력 ─────
  const timeStr = (ts) => new Date(ts || Date.now()).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  function colorOf(name) {
    let h = 0;
    for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360}, 45%, 42%)`;
  }
  // who: bot | me | other | sys,  opts: { ts, name, sender }
  function addMsg(who, html, opts = {}) {
    const last = elMsgs.lastElementChild;
    const t = timeStr(opts.ts);
    const sender = opts.sender || who;
    const el = document.createElement('div');
    el.className = 'msg ' + who;
    el.dataset.t = t;
    el.dataset.sender = sender;
    if (who === 'bot' || who === 'other') {
      const name = who === 'bot' ? BOT : String(opts.name || '?');
      if (last && last.dataset.sender === sender && last.dataset.t === t) el.classList.add('cont');
      const av = who === 'bot' ? `<div class="avatar">${AVATAR}</div>` : `<div class="avatar" style="background:${colorOf(name)}">${esc([...name][0] || '?')}</div>`;
      el.innerHTML = `${av}<div class="mbody"><div class="name">${esc(name)}</div><div class="row"><div class="bubble" data-name="${esc(name)}">${html}</div><span class="mark"></span><span class="time">${t}</span></div></div>`;
    } else if (who === 'me') {
      el.innerHTML = `<div class="row"><span class="mark"></span><span class="time">${t}</span><div class="bubble">${html}</div></div>`;
    } else {
      el.innerHTML = `<div class="sys">${html}</div>`;
    }
    elMsgs.appendChild(el);
    while (elMsgs.children.length > 400) elMsgs.firstElementChild.remove();
    elMsgs.scrollTop = elMsgs.scrollHeight;
    if ((who === 'bot' || who === 'other') && window.VS) window.VS.notifyChat();
    return el;
  }
  let chain = Promise.resolve();
  let gen = 0; // 멀티로 넘어가면 증가 → 대기 중인 혼자 하기 메시지 취소
  function say(html, delay = 320) {
    const g = gen;
    chain = chain.then(() => new Promise((r) => setTimeout(() => { if (g === gen) addMsg('bot', html); r(); }, delay)));
    return chain;
  }
  const sys = (html) => addMsg('sys', html);

  // ───── 타이머 ─────
  function setTimerText(text, warn) { elTimer.textContent = text || ''; elTimer.classList.toggle('warn', !!warn); }
  function renderTimer() {
    if (!S.running || !S.timeLimit || S.locked) return setTimerText('');
    setTimerText(S.paused ? '⏸ paused' : `⏱ ${S.remain}s`, S.remain <= 10 && !S.paused);
  }
  function stopTimer() { clearInterval(S.timer); S.timer = null; renderTimer(); }
  function startTimer() {
    stopTimer();
    if (!S.timeLimit) return;
    S.remain = S.timeLimit;
    renderTimer();
    S.timer = setInterval(tick, 1000);
  }
  function tick() {
    if (S.paused || S.locked) return;
    S.remain--;
    renderTimer();
    updateStage();
    if (S.remain === Math.floor(S.timeLimit / 2) && S.hints === 0 && S.timeLimit >= 20) hint(true);
    if (S.remain === 10 && S.timeLimit > 15) say('⏰ <b>10초</b> 남았어요!', 0);
    if (S.remain <= 0) { stopTimer(); timeout(); }
  }

  // ───── 게임 진행 ─────
  const modeLabel = () => MODE_LABEL[S.mode];
  function filterLabel() {
    return '연대: ' + ERA_LABEL[S.era] + (S.artist ? ' · 가수: ' + esc(S.artist) : '');
  }
  // 가사 모드: 수록곡(가사는 LRCLIB 에서) + 직접 추가한 가사 문제 / 얼굴·자켓: 사진 목록
  const pool = () => Q.poolFor(S.mode, { db, idols, covers, custom: S.mode === '가사' ? customList() : [] }, S);
  // 사진 흐림: 시간이 지나거나 힌트를 쓸수록 선명해짐
  function updateStage() {
    if (!isImage() || S.locked) return;
    const st = Q.imageStage(S.hints, S.remain, S.timeLimit);
    if (st !== S.stage) { S.stage = st; VSimg({ blur: Q.BLUR[st] }); }
  }
  function takeSong() {
    if (!S.deck.length) S.deck = Q.orderDeck(pool(), seen);
    return S.deck.pop() || null;
  }
  const prepare = () => Q.prepareQuestion({ mode: S.mode, takeSong, getLyrics });

  function start(arg) {
    if (S.running) return say('이미 게임이 진행 중이에요! 그만하려면 <code>/종료</code>');
    let n = arg === '' ? 0 : parseInt(arg, 10); // 숫자 없으면 무제한 (/종료 로 끝)
    if (isNaN(n) || n < 0) n = 0;
    n = Math.min(n, 999);
    const p = pool();
    const fresh = Q.countFresh(p, seen);
    if (!p.length) return say('조건에 맞는 노래가 없어요. <code>/연대 전체</code> 또는 <code>/가수</code> 로 필터를 풀어보세요.');
    S.runId++;
    Object.assign(S, { running: true, limit: n, deck: Q.orderDeck(p, seen), qNo: 0, correct: 0, score: 0, streak: 0, bestStreak: 0, q: null, locked: true, prep: null, idle: 0 });
    S.prep = prepare(); // 첫 문제 가사 미리 불러오기
    preload(S.prep);
    VSimg({ close: true });
    say(`🎮 <b>게임 시작!</b><br>모드: <b>${modeLabel()}</b><br>문제 수: <b>${n ? n + '문제' : '무한'}</b> · 제한시간: <b>${S.timeLimit ? S.timeLimit + '초' : '없음'}</b>` +
      `${filterLabel() ? '<br>' + filterLabel() : ''} <span style="opacity:.7">(${p.length}${S.mode === '얼굴' ? '명' : S.mode === '자켓' ? '장' : '곡'} 중 출제${fresh < p.length ? `, 아직 안 나온 문제 ${fresh}개 먼저` : ''})</span>`);
    S.nextT = setTimeout(next, 900);
  }

  async function next() {
    S.nextT = null;
    if (!S.running) return;
    if (S.limit && S.qNo >= S.limit) return finish(false);
    const run = S.runId;
    const p = S.prep || prepare();
    S.prep = null;
    const slow = setTimeout(() => { if (S.running && S.runId === run) say('🔎 가사 불러오는 중…', 0); }, 1200);
    let item = null;
    try { item = await p; } catch (e) { item = null; }
    clearTimeout(slow);
    if (!S.running || S.runId !== run) return;
    if (!item) return finish(false);
    if (item.fallback === 'offline' && !S.warnedOffline) {
      S.warnedOffline = true;
      say('⚠ 가사 서버(LRCLIB)에 연결이 안 돼요. 연결될 때까지 초성 퀴즈로 낼게요.', 0);
    } else if (item.fallback === 'notfound') {
      say('가사를 찾지 못한 곡이라 이번 문제는 초성 퀴즈로 낼게요.', 0);
    }
    const q = item.q;
    seen.add(Q.seenKey(q));
    store.set('seen', seen.list());
    Object.assign(S, { q, qMode: item.mode, hints: 0, locked: true, stage: 0 });
    S.qNo++;
    const no = `문제 ${S.qNo}${S.limit ? ' / ' + S.limit : ''}`;
    const qNo = S.qNo;
    say(Q.questionHTML(q, S.qMode, no, qNo), 250).then(() => {
      if (!S.running || S.q !== q) return;
      if (isImage()) VSimg({ file: Q.imageFile(qNo), src: q.img, blur: Q.BLUR[0], credit: q.credit });
      S.locked = false;
      startTimer();
    });
    if (!S.limit || S.qNo < S.limit) preload(S.prep = prepare()); // 다음 문제 미리 준비
  }

  function hint(auto) {
    if (!S.running || !S.q || S.locked) { if (!auto) say('지금은 풀고 있는 문제가 없어요. <code>/시작</code> 으로 시작!'); return; }
    if (S.hints >= 3) return say('힌트를 모두 썼어요 🙅 모르겠으면 <code>/패스</code>');
    S.hints++;
    updateStage();
    say(`💡 ${auto ? '자동 ' : ''}힌트 ${S.hints}/3<br>${Q.hintText(S.q, S.qMode, S.hints, db.byArtist)}`, auto ? 0 : 250);
  }

  const answerCard = (r) => Q.revealCard(S.q, S.qMode, r);
  function correct(r) {
    S.locked = true;
    stopTimer();
    S.correct++;
    S.streak++;
    S.bestStreak = Math.max(S.bestStreak, S.streak);
    const pts = Q.points(isImage() ? S.stage : S.hints, S.streak);
    reveal();
    S.score += pts.total;
    store.set('lifetime', store.get('lifetime', 0) + 1);
    const cheers = ['🎉 정답!', '👏 정답이에요!', '✨ 딩동댕!', '💯 정답!', '🔥 맞았어요!'];
    say(`<b>${pick(cheers)}</b> +${pts.total}점${pts.bonus ? ` (🔥 ${S.streak}연속 보너스 +${pts.bonus})` : ''}${answerCard(r)}`, 200);
    scheduleNext(1700);
  }
  function timeout() {
    if (!S.running || S.locked) return;
    S.locked = true;
    S.streak = 0;
    reveal();
    say(`⌛ 시간 초과! 정답은…${answerCard()}`, 0);
    // 아무것도 안 치고 3문제 연속 시간 초과 = 자리 비움 → 끝
    if (++S.idle >= 3) { say('😴 3문제 연속으로 입력이 없어서 게임을 끝낼게요.', 0); return finish(false); }
    scheduleNext(2000);
  }
  function pass() {
    if (!S.running || !S.q || S.locked) return say('지금은 넘길 문제가 없어요.');
    S.locked = true;
    stopTimer();
    S.streak = 0;
    reveal();
    say(`⏭ 패스! 정답은…${answerCard()}`, 200);
    scheduleNext(1800);
  }
  function reveal() {
    if (!isImage()) return;
    S.imgErrors = 0;
    VSimg({ reveal: true, credit: S.q && S.q.credit });
  }
  // 다음 사진 미리 받아두기
  function preload(p) {
    if (p && p.then) p.then((it) => { if (it && it.q && it.q.img) VSimg({ preload: it.q.img }); }, () => {});
  }
  // 사진을 못 불러오면 그 문제는 건너뜀 (3번 연속이면 끝)
  window.addEventListener('imageerror', (e) => {
    if (!S.running || !isImage() || S.locked || !S.q || S.q.img !== e.detail) return;
    S.locked = true;
    stopTimer();
    if (++S.imgErrors >= 3) {
      say('⚠ 사진 서버에 연결이 안 돼요. 인터넷 연결을 확인해주세요.', 0);
      return finish(false);
    }
    say('⚠ 사진을 못 불러와서 다음 문제로 넘어갈게요.', 0);
    S.qNo--;
    scheduleNext(800);
  });
  function scheduleNext(ms) { clearTimeout(S.nextT); S.nextT = setTimeout(next, ms); }

  function finish(manual) {
    stopTimer();
    clearTimeout(S.nextT);
    if (manual && S.q && !S.locked) say(`이번 문제 정답은…${answerCard()}`, 100);
    const played = S.qNo;
    S.running = false;
    S.runId++;
    S.prep = null;
    VSimg({ close: true });
    S.q = null;
    S.locked = true;
    renderTimer();
    const best = store.get('best', null);
    let rec = '';
    if (played > 0 && (!best || S.score > best.score)) {
      store.set('best', { score: S.score, correct: S.correct, played, date: new Date().toLocaleDateString('ko-KR') });
      if (S.score > 0) rec = '<br>🏆 <b>최고 기록 갱신!</b>';
    }
    const rate = played ? Math.round((S.correct / played) * 100) : 0;
    say(`🏁 <b>게임 종료!</b><br>정답 <b>${S.correct}</b> / ${played} (${rate}%)<br>점수 <b>${S.score}점</b> · 최고 연속 ${S.bestStreak}회<br>등급: ${Q.grade(rate)}${rec}<br><br>다시 하려면 <code>/시작</code>`, 300);
  }

  // ───── 끝말잇기 (봇이랑 1:1) ─────
  const WC = window.WordChain;
  let dict = null, dictLoading = null;
  // 사전(2.9MB)은 처음 끝말잇기 할 때만 불러옴
  function loadDict() {
    if (dict) return Promise.resolve(dict);
    if (!dictLoading) {
      dictLoading = new Promise((resolve, reject) => {
        if (window.WORD_DICT) return resolve();
        const s = document.createElement('script');
        s.src = 'js/words.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      }).then(() => (dict = WC.build(window.WORD_DICT))).catch((e) => { dictLoading = null; throw e; });
    }
    return dictLoading;
  }
  const W = { running: false, need: '', used: new Set(), words: 0, score: 0, hints: 0, time: 20, remain: 0, timer: null, locked: true, runId: 0 };

  function wcRenderTimer() {
    if (!W.running || !W.time || W.locked) return setTimerText('');
    setTimerText(S.paused ? '⏸ paused' : `⏱ ${W.remain}s`, W.remain <= 5 && !S.paused);
  }
  function wcStopTimer() { clearInterval(W.timer); W.timer = null; wcRenderTimer(); }
  function wcStartTimer() {
    wcStopTimer();
    if (!W.time) return;
    W.remain = W.time;
    wcRenderTimer();
    W.timer = setInterval(() => {
      if (S.paused || W.locked) return;
      W.remain--;
      wcRenderTimer();
      if (W.remain === 5 && W.time > 8) say('⏰ <b>5초</b>!', 0);
      if (W.remain <= 0) { wcStopTimer(); wcFinish('timeout'); }
    }, 1000);
  }

  async function wcStart(arg) {
    if (S.running) return say('노래 퀴즈가 진행 중이에요. <code>/종료</code> 후에 시작해주세요.');
    if (W.running) return say('이미 끝말잇기 중이에요! 그만하려면 <code>/종료</code>');
    let t = arg === '' ? store.get('wctime', 20) : parseInt(arg, 10);
    if (isNaN(t) || t < 0) t = 20;
    if (t > 0) t = Math.max(5, Math.min(120, t));
    store.set('wctime', t);
    const run = ++W.runId;
    Object.assign(W, { running: true, need: '', used: new Set(), words: 0, score: 0, hints: 0, time: t, locked: true });
    if (!dict) say('📕 사전 불러오는 중…', 0);
    try { await loadDict(); } catch (e) {
      W.running = false;
      return say('⚠ 사전 파일(js/words.js)을 못 불러왔어요.');
    }
    if (W.runId !== run) return;
    say(WC.rulesHTML(false, t) + `<br><span style="opacity:.7">(사전 단어 ${dict.size.toLocaleString()}개)</span>`);
    wcBot(WC.startWord(dict, W.used), '제가 먼저 할게요!');
  }
  function wcBot(word, lead) {
    const run = W.runId;
    W.used.add(word);
    W.need = WC.lastOf(word);
    say(`${lead ? lead + '<br>' : ''}${WC.wordHTML(word, dict.kind.get(word))}`, 350).then(() => {
      if (W.running && W.runId === run) { W.locked = false; wcStartTimer(); }
    });
  }
  function wcPlayer(r) {
    W.locked = true;
    wcStopTimer();
    W.used.add(r.word);
    W.words++;
    W.score += r.word.length;
    const tag = WC.KIND_LABEL[r.kind];
    if (r.killer) {
      say(`💥 <b>한방단어!</b>${tag ? ` (${tag})` : ''}<br>${WC.needLabel(WC.lastOf(r.word))}(으)로 시작하는 단어가 사전에 없어요… 제가 졌어요 😵`, 300);
      return wcFinish('win');
    }
    const run = W.runId;
    // 10턴 넘어가면 봇도 가끔 한방단어로 공격
    const attack = W.words >= 10 ? Math.min(0.05 + (W.words - 10) * 0.02, 0.3) : 0;
    setTimeout(() => {
      if (!W.running || W.runId !== run) return;
      const next = WC.botPick(dict, WC.lastOf(r.word), W.used, attack);
      if (!next) {
        say(`😵 ${WC.needLabel(WC.lastOf(r.word))}(으)로 시작하는 단어가 생각이 안 나요… 제가 졌어요!`, 0);
        return wcFinish('win');
      }
      wcBot(next, tag ? `📕 ${tag}로 사전에 있는 단어네요. 인정!` : '');
    }, 500);
  }
  function wcHint() {
    if (!W.running || W.locked) return say('지금은 힌트를 볼 수 없어요.');
    if (W.hints >= 3) return say('힌트는 한 판에 3번까지예요 🙅');
    const w = WC.hintWord(dict, W.need, W.used);
    if (!w) return say('음… 저도 생각나는 단어가 없어요 😅');
    W.hints++;
    say(`💡 힌트 ${W.hints}/3: <span class="cho-inline">${esc(WC.mask(w))}</span> (${w.length}글자)`, 200);
  }
  function wcFinish(why) {
    const example = why !== 'win' && W.need && dict ? WC.hintWord(dict, W.need, W.used) : null;
    wcStopTimer();
    W.running = false;
    W.locked = true;
    W.runId++;
    setTimerText('');
    const head = {
      win: '🏆 <b>승리!</b> 봇을 이겼어요!',
      timeout: '⌛ <b>시간 초과!</b> 제가 이겼어요 😎',
      giveup: '🏳 포기했어요. 제가 이겼어요 😎',
      stop: '끝말잇기를 끝냈어요.',
    }[why];
    const ex = example ? `<br>이런 단어가 있었어요: <b>${esc(example)}</b>` : '';
    const best = store.get('wcbest', null);
    let rec = '';
    if (W.words > 0 && (!best || W.words > best.words)) {
      store.set('wcbest', { words: W.words, score: W.score, date: new Date().toLocaleDateString('ko-KR') });
      rec = '<br>🏆 <b>최고 기록 갱신!</b>';
    }
    say(`${head}${ex}<br><br>🔤 내가 이은 단어 <b>${W.words}</b>개 · 점수 <b>${W.score}점</b>${rec}<br>다시 하려면 <code>/끝말잇기</code>`, 400);
  }
  function wcRun(cmd) {
    switch (cmd.toLowerCase()) {
      case '힌트': case 'hint': case 'h': wcHint(); return true;
      case '패스': case '스킵': case '포기': case '넘기기': case 'pass': case 'skip': if (!W.locked) { W.locked = true; wcFinish('giveup'); } return true;
      case '점수': case '순위': case '스코어': case 'score': say(`🔤 지금까지 <b>${W.words}</b>개 · <b>${W.score}점</b> · 힌트 ${W.hints}/3`); return true;
      case '종료': case '그만': case '끝': case 'stop': case 'end': wcFinish('stop'); return true;
      case '시작': case 'start': case 'go': say('끝말잇기 중이에요! 노래 퀴즈를 하려면 <code>/종료</code> 후에 <code>/시작</code>'); return true;
      default: return false;
    }
  }
  function wcInput(t, meEl, cmd) {
    if (W.locked) return; // 봇 차례
    const r = WC.check(dict, t, W.need, W.used);
    if (r.ok) { meEl.classList.add('ok'); return wcPlayer(r); }
    if (NOSLASH.has(cmd) && wcRun(cmd)) return;
    meEl.classList.add('wrong');
    say(WC.reasonText(r, W.need), 150);
  }

  // ───── 명령어 ─────
  function score() {
    if (!S.running) return say('진행 중인 게임이 없어요. <code>/시작</code> 으로 시작!');
    say(`📊 현재 <b>${S.score}점</b><br>정답 ${S.correct} / ${S.qNo} · 🔥 연속 ${S.streak} (최고 ${S.bestStreak})`);
  }
  function guardRunning(what) {
    if (S.running) { say(`게임 중에는 ${what} 변경이 안 돼요. <code>/종료</code> 후에 바꿔주세요.`); return true; }
    return false;
  }
  function setMode(arg) {
    const key = Q.parseMode(arg);
    if (key === null) return say(`현재 모드: <b>${modeLabel()}</b><br><code>/모드 초성</code> · <code>/모드 가수</code> · <code>/모드 가사</code> · <code>/모드 랜덤</code><br><code>/모드 부르기</code> 제목 보고 가사 한 소절 적기<br><code>/모드 얼굴</code> 사진 보고 아이돌 이름 · <code>/모드 자켓</code> 앨범 자켓 보고 타이틀곡`);
    if (!key) return say('모드는 <b>초성 · 가수 · 가사 · 랜덤 · 부르기 · 얼굴 · 자켓</b> 중에서 골라주세요.');
    if (key === '릴레이') return say('🎤 노래 릴레이는 친구랑 돌아가면서 하는 <b>멀티 전용</b> 모드예요.<br><b>start.bat</b> 으로 실행해서 멀티 방에서 해주세요.');
    if (guardRunning('모드')) return;
    S.mode = key;
    store.set('mode', key);
    const extra = key === '가사' ? '<br>가사는 LRCLIB에서 불러와요 (인터넷 연결 필요)'
      : key === '부르기' ? `<br>🎙 ${Q.SING_HELP}<br>가사는 LRCLIB에서 불러와요 (인터넷 연결 필요)`
      : key === '얼굴' ? `<br>📸 에디터에 사진이 흐릿하게 열리고 점점 선명해져요. 빨리 맞힐수록 점수 ↑ (${idols.length}명)<br>이름은 예명·본명·영어 다 OK · 사진: 위키미디어 공용`
      : key === '자켓' ? `<br>💿 에디터에 앨범 자켓이 흐릿하게 열리고 점점 선명해져요. 그 앨범 타이틀곡 제목을 맞히면 정답 (${covers.length}장)`
      : '';
    say(`✅ 모드 변경: <b>${modeLabel()}</b>${extra}`);
  }
  function setEra(arg) {
    const key = Q.parseEra(arg);
    if (key === null) return say(`현재 연대: <b>${ERA_LABEL[S.era]}</b><br><code>/연대 90</code> · <code>/연대 00</code> · <code>/연대 10</code> · <code>/연대 20</code> · <code>/연대 전체</code>`);
    if (!key) return say('연대는 90 · 00 · 10 · 20 · 전체 중 하나로 입력해주세요.');
    if (guardRunning('연대')) return;
    S.era = key;
    store.set('era', key);
    say(`✅ 연대: <b>${ERA_LABEL[key]}</b> (${pool().length}곡)`);
  }
  function setArtist(arg) {
    if (guardRunning('가수 필터')) return;
    if (!arg) { S.artist = null; store.set('artist', null); return say(`✅ 가수 필터 해제 (${pool().length}곡)`); }
    const hit = Q.findArtist(db, arg);
    if (!hit.length) return say(`'${esc(arg)}' 가수를 찾지 못했어요 🤔`);
    if (hit.length > 1) return say(`여러 가수가 있어요: ${hit.map((h) => `<code>${esc(h)}</code>`).join(' ')}`);
    S.artist = hit[0];
    store.set('artist', hit[0]);
    say(`✅ 가수: <b>${esc(hit[0])}</b> (${db.byArtist.get(hit[0]).length}곡)${S.era !== 'all' ? `<br>연대 필터(${ERA_LABEL[S.era]})도 함께 적용돼요 → ${pool().length}곡` : ''}`);
  }
  function setTime(arg) {
    if (arg === '') return say(`현재 제한시간: <b>${S.timeLimit ? S.timeLimit + '초' : '무제한'}</b> · 예) <code>/시간 30</code>, <code>/시간 0</code>`);
    let t = parseInt(arg, 10);
    if (isNaN(t) || t < 0) return say('숫자로 입력해주세요. 예) <code>/시간 30</code>');
    if (t > 0) t = Math.max(10, Math.min(300, t));
    S.timeLimit = t;
    store.set('time', t);
    say(`✅ 제한시간: <b>${t ? t + '초' : '무제한'}</b>${S.running ? ' (다음 문제부터 적용)' : ''}`);
  }
  function addCustom(arg) {
    const item = Q.parseCustomArg(arg);
    if (!item) return say('형식: <code>/추가 제목 | 가수 | 연도 | 가사</code><br>가사는 직접 입력한 한 소절이면 돼요.');
    const list = store.get('custom', []);
    list.push(item);
    store.set('custom', list);
    say(`✅ 가사 문제 추가! (내 문제 ${list.length}개)<br><code>/모드 가사</code> 로 풀 수 있어요.`);
  }
  function listCustom() {
    const fileN = Array.isArray(window.CUSTOM_QUESTIONS) ? window.CUSTOM_QUESTIONS.length : 0;
    const list = store.get('custom', []);
    if (!list.length && !fileN) return say('추가한 가사 문제가 없어요.<br><code>/추가 제목 | 가수 | 연도 | 가사</code>');
    const rows = list.map((q, i) => `${i + 1}. <b>${esc(q.title)}</b> - ${esc(q.artist)}`).join('<br>');
    say(`📝 내 가사 문제${fileN ? ` (custom.js 파일 ${fileN}개 별도)` : ''}<br>${rows || '(채팅으로 추가한 문제 없음)'}${list.length ? '<br><br>삭제: <code>/내문제삭제 번호</code>' : ''}`);
  }
  function delCustom(arg) {
    const list = store.get('custom', []);
    const i = parseInt(arg, 10) - 1;
    if (isNaN(i) || i < 0 || i >= list.length) return say('삭제할 번호를 확인해주세요. <code>/내문제</code> 로 목록 보기');
    const [q] = list.splice(i, 1);
    store.set('custom', list);
    say(`🗑 삭제: ${esc(q.title)}`);
  }
  function record() {
    const b = store.get('best', null);
    const w = store.get('wcbest', null);
    say(`🏆 최고 기록: ${b ? `<b>${b.score}점</b> (정답 ${b.correct}/${b.played}, ${esc(b.date)})` : '아직 없음'}<br>누적 정답: <b>${store.get('lifetime', 0)}</b>개` +
      `<br>🔤 끝말잇기 최고: ${w ? `<b>${w.words}</b>개 이어감 (${w.score}점, ${esc(w.date)})` : '아직 없음'}`);
  }
  function syncButtons() {
    $('#btn-stealth').classList.toggle('on', elChat.classList.contains('stealth'));
    $('#btn-theme').classList.toggle('on', elChat.classList.contains('kakao'));
  }
  function toggleClass(cls, key, label) {
    const on = elChat.classList.toggle(cls);
    store.set(key, on);
    syncButtons();
    sys(`${label} ${on ? 'ON' : 'OFF'}`);
  }
  function clearChat() { elMsgs.innerHTML = ''; sys('대화를 지웠어요'); }

  // 내 화면에만 적용되는 명령 (멀티에서도 서버로 안 보냄)
  function runLocal(cmd) {
    switch (cmd) {
      case '위장': toggleClass('stealth', 'stealth', '🕶 위장 모드'); return true;
      case '테마': toggleClass('kakao', 'kakao', '🎨 메신저 테마'); return true;
      case '청소': case '지우기': case 'clear': clearChat(); return true;
      default: return false;
    }
  }

  const NOSLASH = new Set(['시작', '힌트', '패스', '스킵', '포기', '점수', '순위', '종료', '그만', '도움말', '명령어']);
  function run(cmd, arg) {
    if (runLocal(cmd)) return;
    if (W.running && wcRun(cmd)) return;
    switch (cmd.toLowerCase()) {
      case '도움말': case '명령어': case 'help': case '?': return say(Q.helpHTML(false));
      case '끝말잇기': case '끝말': case 'wc': case 'wordchain': return wcStart(arg);
      case '시작': case 'start': case 'go':
        if (/^끝말/.test(arg)) return wcStart(arg.replace(/^끝말(잇기)?\s*/, ''));
        return start(arg);
      case '힌트': case 'hint': case 'h': return hint(false);
      case '패스': case '스킵': case '포기': case '넘기기': case 'pass': case 'skip': return pass();
      case '점수': case '순위': case '스코어': case 'score': return score();
      case '종료': case '그만': case '끝': case 'stop': case 'end':
        return S.running ? finish(true) : say('진행 중인 게임이 없어요.');
      case '모드': case 'mode': return setMode(arg);
      case '연대': case '시대': case 'era': return setEra(arg);
      case '가수': case 'artist': return setArtist(arg);
      case '시간': case 'time': return setTime(arg);
      case '추가': case 'add': return addCustom(arg);
      case '내문제': case '목록': return listCustom();
      case '내문제삭제': case '삭제': return delCustom(arg);
      case '기록': case '랭킹': return record();
      case '통계': case '곡수': return say(Q.statsHTML(db, customList().length, idols.length, covers.length));
      default: return say(`모르는 명령어예요: <code>/${esc(cmd)}</code> · <code>/도움말</code> 참고`);
    }
  }

  function handle(raw) {
    const t = raw.trim();
    if (!t) return;
    const meEl = addMsg('me', esc(t));
    S.idle = 0; // 뭐라도 치면 자리에 있는 것
    const isSlash = /^[\/!]/.test(t);
    const m = t.replace(/^[\/!]\s*/, '').match(/^(\S+)\s*([\s\S]*)$/);
    const cmd = m ? m[1] : '';
    const arg = m ? m[2].trim() : '';

    if (!isSlash && W.running) return wcInput(t, meEl, cmd);
    if (!isSlash && S.running && S.q && !S.locked) {
      const r = Q.checkAnswer(t, S.q, S.qMode, db.aliases);
      if (r.ok) { meEl.classList.add('ok'); return correct(r); }
      if (!NOSLASH.has(cmd)) {
        meEl.classList.add('wrong');
        const miss = Q.missText(r, S.qMode);
        if (miss) say(miss, 150);
        return;
      }
    }
    if (isSlash || NOSLASH.has(cmd)) return run(cmd, arg);
    if (S.running) return; // 문제 넘어가는 중에 친 채팅은 무시
    say(pick(['게임하려면 <code>/시작</code> 을 입력해주세요 🎵', '<code>/시작</code> 하면 바로 문제 나가요!', '명령어가 궁금하면 <code>/도움말</code> 🙂']));
  }

  // ───── 입력창 ─────
  let sendHandler = handle;
  const history = [];
  let hIdx = -1;
  function autosize() { elInput.style.height = '34px'; elInput.style.height = Math.min(120, elInput.scrollHeight) + 'px'; }
  function send() {
    const v = elInput.value;
    if (!v.trim()) return;
    history.push(v);
    if (history.length > 50) history.shift();
    hIdx = -1;
    elInput.value = '';
    autosize();
    sendHandler(v);
  }
  elInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter 중복 방지
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'ArrowUp' && !elInput.value.includes('\n') && history.length) {
      e.preventDefault();
      hIdx = hIdx < 0 ? history.length - 1 : Math.max(0, hIdx - 1);
      elInput.value = history[hIdx];
    } else if (e.key === 'ArrowDown' && hIdx >= 0) {
      e.preventDefault();
      hIdx = hIdx + 1 >= history.length ? -1 : hIdx + 1;
      elInput.value = hIdx < 0 ? '' : history[hIdx];
    }
  });
  elInput.addEventListener('input', autosize);
  $('#chat-send').addEventListener('click', () => { send(); elInput.focus(); });
  document.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { sendHandler(b.dataset.cmd); elInput.focus(); }));
  $('#btn-stealth').addEventListener('click', () => runLocal('위장'));
  $('#btn-theme').addEventListener('click', () => runLocal('테마'));
  $('#btn-clear').addEventListener('click', () => runLocal('청소'));

  // 채팅 숨기면 타이머 일시정지 (혼자 하기만)
  window.addEventListener('chatvisibility', (e) => { S.paused = !e.detail; if (S.running) renderTimer(); if (W.running) wcRenderTimer(); });

  // ───── multi.js 에서 쓰는 채팅창 API ─────
  window.Chat = {
    addMsg, sys, runLocal,
    clear() { elMsgs.innerHTML = ''; },
    setHandler(fn) { sendHandler = fn || handle; },
    setTimer: setTimerText,
    setSub(label, count, title) {
      if (label != null) $('#chat-label').textContent = label;
      if (count != null) $('#chat-count').textContent = count;
      if (title != null) $('#chat-count').title = title;
    },
    stopSolo() {
      gen++;
      stopTimer();
      clearTimeout(S.nextT);
      S.runId++;
      Object.assign(S, { running: false, q: null, locked: true, prep: null });
      VSimg({ close: true });
      wcStopTimer();
      Object.assign(W, { running: false, locked: true, runId: W.runId + 1 });
      setTimerText('');
    },
  };

  // ───── 시작 화면 ─────
  if (store.get('stealth', false)) elChat.classList.add('stealth');
  if (store.get('kakao', false)) elChat.classList.add('kakao');
  syncButtons();
  if (window.VS && !window.VS.isChatVisible()) S.paused = true;
  $('#chat-count').textContent = `${db.songs.length}곡`;
  sys(new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }));
  say(`안녕하세요! 🎵 <b>K-POP 노래 맞추기</b> 봇이에요.<br>${db.minYear}년 1세대부터 ${db.maxYear}년 최신곡까지 아이돌 노래 <b>${db.songs.length}곡</b>이 들어 있어요.`, 150);
  say(`▶ <code>/시작</code> 게임 시작<br>📖 <code>/도움말</code> 명령어 보기<br>🙈 <kbd>Esc</kbd> 누르면 채팅이 숨겨져요<br><br>현재 설정: ${modeLabel()} · ${ERA_LABEL[S.era]}${S.artist ? ' · ' + esc(S.artist) : ''} · ${S.timeLimit ? S.timeLimit + '초' : '시간 무제한'}` +
    (location.protocol === 'file:' ? '<br><br>👥 친구랑 같이 하려면 <b>start.bat</b> 으로 실행하세요.' : ''), 350);
})();

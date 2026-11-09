// 채팅창 + 혼자 하기 게임 로직 (멀티 모드에서는 multi.js 가 채팅창을 넘겨받음)
(function () {
  'use strict';
  const Q = window.QuizCore;
  const { esc, pick, shuffle, ERA_LABEL, MODE_LABEL } = Q;
  const $ = (s) => document.querySelector(s);
  const elChat = $('#chat'), elMsgs = $('#chat-msgs'), elInput = $('#chat-input'), elTimer = $('#chat-timer');
  const BOT = '멜로디봇';
  const AVATAR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 17.5a2.5 2.5 0 1 1-2.5-2.5c.5 0 1 .1 1.5.4V5l11-2v12.5a2.5 2.5 0 1 1-2.5-2.5c.5 0 1 .1 1.5.4V6.4l-9 1.7z"/></svg>';

  const store = {
    get(k, d) { try { const v = localStorage.getItem('kq.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('kq.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const db = Q.buildDB(window.SONGS, window.ARTIST_ALIASES);
  const customList = () => Q.normalizeCustom([...(Array.isArray(window.CUSTOM_QUESTIONS) ? window.CUSTOM_QUESTIONS : []), ...store.get('custom', [])]);

  // ───── 상태 ─────
  const S = {
    running: false,
    mode: Q.MODES.includes(store.get('mode', '초성')) ? store.get('mode', '초성') : '초성',
    era: ERA_LABEL[store.get('era', 'all')] ? store.get('era', 'all') : 'all',
    artist: db.byArtist.has(store.get('artist', null)) ? store.get('artist', null) : null,
    timeLimit: store.get('time', 40),
    limit: 10, deck: [], q: null, qMode: null, qNo: 0,
    correct: 0, score: 0, streak: 0, bestStreak: 0, hints: 0,
    locked: true, timer: null, remain: 0, paused: false, nextT: null,
  };

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
    if (S.remain === Math.floor(S.timeLimit / 2) && S.hints === 0 && S.timeLimit >= 20) hint(true);
    if (S.remain === 10 && S.timeLimit > 15) say('⏰ <b>10초</b> 남았어요!', 0);
    if (S.remain <= 0) { stopTimer(); timeout(); }
  }

  // ───── 게임 진행 ─────
  const modeLabel = () => MODE_LABEL[S.mode];
  function filterLabel() {
    if (S.mode === '가사') return '';
    return '연대: ' + ERA_LABEL[S.era] + (S.artist ? ' · 가수: ' + esc(S.artist) : '');
  }
  const pool = () => (S.mode === '가사' ? customList() : Q.filterPool(db, S));

  function start(arg) {
    if (S.running) return say('이미 게임이 진행 중이에요! 그만하려면 <code>/종료</code>');
    let n = arg === '' ? 10 : parseInt(arg, 10);
    if (isNaN(n) || n < 0) n = 10;
    n = Math.min(n, 999);
    const p = pool();
    if (!p.length) {
      if (S.mode === '가사') return say('가사 문제가 아직 없어요 😢<br><code>/추가 제목 | 가수 | 연도 | 가사</code> 로 먼저 추가하거나<br>js/custom.js 파일에 적어주세요.');
      return say('조건에 맞는 노래가 없어요. <code>/연대 전체</code> 또는 <code>/가수</code> 로 필터를 풀어보세요.');
    }
    Object.assign(S, { running: true, limit: n, deck: shuffle(p.slice()), qNo: 0, correct: 0, score: 0, streak: 0, bestStreak: 0, q: null, locked: true });
    say(`🎮 <b>게임 시작!</b><br>모드: <b>${modeLabel()}</b><br>문제 수: <b>${n ? n + '문제' : '무한'}</b> · 제한시간: <b>${S.timeLimit ? S.timeLimit + '초' : '없음'}</b>` +
      `${filterLabel() ? '<br>' + filterLabel() : ''} <span style="opacity:.7">(${p.length}곡 중 출제)</span>`);
    S.nextT = setTimeout(next, 900);
  }

  function next() {
    S.nextT = null;
    if (!S.running) return;
    if (S.limit && S.qNo >= S.limit) return finish(false);
    if (!S.deck.length) S.deck = shuffle(pool().slice());
    if (!S.deck.length) return finish(false);
    const q = S.deck.pop();
    Object.assign(S, { q, hints: 0, locked: true });
    S.qNo++;
    S.qMode = S.mode === '랜덤' ? (Math.random() < 0.5 ? '초성' : '가수') : S.mode;
    const no = `문제 ${S.qNo}${S.limit ? ' / ' + S.limit : ''}`;
    say(Q.questionHTML(q, S.qMode, no), 250).then(() => {
      if (S.running && S.q === q) { S.locked = false; startTimer(); }
    });
  }

  function hint(auto) {
    if (!S.running || !S.q || S.locked) { if (!auto) say('지금은 풀고 있는 문제가 없어요. <code>/시작</code> 으로 시작!'); return; }
    if (S.hints >= 3) return say('힌트를 모두 썼어요 🙅 모르겠으면 <code>/패스</code>');
    S.hints++;
    say(`💡 ${auto ? '자동 ' : ''}힌트 ${S.hints}/3<br>${Q.hintText(S.q, S.qMode, S.hints, db.byArtist)}`, auto ? 0 : 250);
  }

  function correct() {
    S.locked = true;
    stopTimer();
    S.correct++;
    S.streak++;
    S.bestStreak = Math.max(S.bestStreak, S.streak);
    const pts = Q.points(S.hints, S.streak);
    S.score += pts.total;
    store.set('lifetime', store.get('lifetime', 0) + 1);
    const cheers = ['🎉 정답!', '👏 정답이에요!', '✨ 딩동댕!', '💯 정답!', '🔥 맞았어요!'];
    say(`<b>${pick(cheers)}</b> +${pts.total}점${pts.bonus ? ` (🔥 ${S.streak}연속 보너스 +${pts.bonus})` : ''}${Q.card(S.q)}`, 200);
    scheduleNext(1700);
  }
  function timeout() {
    if (!S.running || S.locked) return;
    S.locked = true;
    S.streak = 0;
    say(`⌛ 시간 초과! 정답은…${Q.card(S.q)}`, 0);
    scheduleNext(2000);
  }
  function pass() {
    if (!S.running || !S.q || S.locked) return say('지금은 넘길 문제가 없어요.');
    S.locked = true;
    stopTimer();
    S.streak = 0;
    say(`⏭ 패스! 정답은…${Q.card(S.q)}`, 200);
    scheduleNext(1800);
  }
  function scheduleNext(ms) { clearTimeout(S.nextT); S.nextT = setTimeout(next, ms); }

  function finish(manual) {
    stopTimer();
    clearTimeout(S.nextT);
    if (manual && S.q && !S.locked) say(`이번 문제 정답은…${Q.card(S.q)}`, 100);
    const played = S.qNo;
    S.running = false;
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
    if (key === null) return say(`현재 모드: <b>${modeLabel()}</b><br><code>/모드 초성</code> · <code>/모드 가수</code> · <code>/모드 가사</code> · <code>/모드 랜덤</code>`);
    if (!key) return say('모드는 <b>초성 · 가수 · 가사 · 랜덤</b> 중에서 골라주세요.');
    if (guardRunning('모드')) return;
    S.mode = key;
    store.set('mode', key);
    let extra = '';
    if (key === '가사') {
      const n = customList().length;
      extra = n ? `<br>등록된 가사 문제 ${n}개` : '<br>아직 가사 문제가 없어요. <code>/추가 제목 | 가수 | 연도 | 가사</code> 로 추가해주세요.';
    }
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
    say(`🏆 최고 기록: ${b ? `<b>${b.score}점</b> (정답 ${b.correct}/${b.played}, ${esc(b.date)})` : '아직 없음'}<br>누적 정답: <b>${store.get('lifetime', 0)}</b>개`);
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
    switch (cmd.toLowerCase()) {
      case '도움말': case '명령어': case 'help': case '?': return say(Q.helpHTML(false));
      case '시작': case 'start': case 'go': return start(arg);
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
      case '통계': case '곡수': return say(Q.statsHTML(db, customList().length));
      default: return say(`모르는 명령어예요: <code>/${esc(cmd)}</code> · <code>/도움말</code> 참고`);
    }
  }

  function handle(raw) {
    const t = raw.trim();
    if (!t) return;
    const meEl = addMsg('me', esc(t));
    const isSlash = /^[\/!]/.test(t);
    const m = t.replace(/^[\/!]\s*/, '').match(/^(\S+)\s*([\s\S]*)$/);
    const cmd = m ? m[1] : '';
    const arg = m ? m[2].trim() : '';

    if (!isSlash && S.running && S.q && !S.locked) {
      const r = Q.checkAnswer(t, S.q, S.qMode, db.aliases);
      if (r.ok) { meEl.classList.add('ok'); return correct(); }
      if (!NOSLASH.has(cmd)) {
        meEl.classList.add('wrong');
        if (r.close) say('🤏 아까워요! 거의 맞았어요', 150);
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
  window.addEventListener('chatvisibility', (e) => { S.paused = !e.detail; if (S.running) renderTimer(); });

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
      Object.assign(S, { running: false, q: null, locked: true });
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

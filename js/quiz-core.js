// 혼자 하기(브라우저)와 멀티 서버(Node)가 같이 쓰는 퀴즈 공통 로직
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.QuizCore = core;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ───── 문자열 / 한글 ─────
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const isHangul = (c) => { const k = c.charCodeAt(0); return k >= 0xac00 && k <= 0xd7a3; };
  const choOf = (c) => CHO[Math.floor((c.charCodeAt(0) - 0xac00) / 588)];
  const hasLatin = (s) => /[A-Za-z]/.test(s);
  const hasHangul = (s) => /[가-힣]/.test(s);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const norm = (s) => String(s || '').toLowerCase().normalize('NFC').replace(/[^0-9a-z가-힣]/g, '');
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // 제목 초성 (revealFirst: 첫 글자 공개)
  function choMask(s, revealFirst) {
    let first = true;
    return [...s].map((c) => {
      if (isHangul(c)) { if (revealFirst && first) { first = false; return c; } first = false; return choOf(c); }
      if (/[A-Za-z]/.test(c)) { first = false; return '＿'; }
      return c;
    }).join('');
  }
  // 가수 이름 초성
  function artistMask(a, revealFirst) {
    let first = true;
    return [...a].map((c) => {
      if (isHangul(c)) { if (revealFirst && first) { first = false; return c; } first = false; return choOf(c); }
      if (/[A-Za-z0-9]/.test(c)) { if (revealFirst && first) { first = false; return c; } first = false; return '＿'; }
      return c;
    }).join('');
  }
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0]; dp[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[b.length];
  }

  // ───── 연대 / 모드 ─────
  const eraKey = (y) => (y < 2000 ? '90' : y < 2010 ? '00' : y < 2020 ? '10' : '20');
  const ERA_LABEL = { '90': '90년대', '00': '2000년대', '10': '2010년대', '20': '2020년대', all: '전체' };
  const eraLabel = (y) => (y ? ERA_LABEL[eraKey(y)] : '연도 미상');
  const MODES = ['초성', '가수', '가사', '랜덤'];
  const MODE_LABEL = { 초성: '초성 퀴즈', 가수: '가수 맞추기', 가사: '가사 퀴즈 (내 문제)', 랜덤: '랜덤 (초성+가수)' };

  // null = 값 없음(현재 설정 보여주기), undefined = 잘못된 값
  function parseMode(arg) {
    const m = String(arg || '').replace(/퀴즈|모드|맞추기/g, '').trim();
    if (!m) return null;
    return MODES.find((x) => x === m) || { chosung: '초성', artist: '가수', lyric: '가사', lyrics: '가사', random: '랜덤', 제목: '초성' }[m.toLowerCase()];
  }
  function parseEra(arg) {
    const a = String(arg || '').replace(/년대|년|s$/g, '').trim();
    if (!a) return null;
    return { '90': '90', '1990': '90', '00': '00', '2000': '00', '10': '10', '2010': '10', '20': '20', '2020': '20', '전체': 'all', all: 'all' }[a];
  }

  // ───── 데이터 ─────
  function buildDB(raw, aliases) {
    const songs = (raw || []).map((r, i) => ({ id: i, title: r[0], reading: r[1] || r[0], artist: r[2], year: r[3], alias: r[4] || [] }));
    const byArtist = new Map();
    songs.forEach((s) => { if (!byArtist.has(s.artist)) byArtist.set(s.artist, []); byArtist.get(s.artist).push(s); });
    const years = songs.map((s) => s.year);
    return { songs, byArtist, aliases: aliases || {}, minYear: Math.min(...years), maxYear: Math.max(...years) };
  }
  function filterPool(db, opt) {
    let p = db.songs;
    if (opt.era && opt.era !== 'all') p = p.filter((s) => eraKey(s.year) === opt.era);
    if (opt.artist) p = p.filter((s) => s.artist === opt.artist);
    return p;
  }
  function artistAnswers(a, aliases) { return [...new Set([a, ...((aliases || {})[a] || [])].map(norm).filter(Boolean))]; }
  function findArtist(db, arg) {
    const n = norm(arg);
    const names = [...db.byArtist.keys()];
    let hit = names.filter((a) => artistAnswers(a, db.aliases).includes(n));
    if (!hit.length) hit = names.filter((a) => artistAnswers(a, db.aliases).some((x) => x.includes(n)));
    return hit;
  }
  function songAnswers(s) {
    const list = [s.title, s.reading, s.title.replace(/\(.*?\)/g, ''), s.reading.replace(/\(.*?\)/g, ''), ...(s.alias || [])];
    const inner = (s.title.match(/\(([^)]*)\)/) || [])[1];
    if (inner) list.push(inner);
    return [...new Set(list.map(norm).filter(Boolean))];
  }
  function normalizeCustom(list) {
    return (list || [])
      .filter((q) => q && q.title && q.lyric)
      .map((q) => ({ title: String(q.title), reading: String(q.reading || q.title), artist: String(q.artist || '알 수 없음'), year: +q.year || 0, alias: Array.isArray(q.alias) ? q.alias : [], lyric: String(q.lyric), custom: true }));
  }
  // "제목 | 가수 | 연도 | 가사" 파싱
  function parseCustomArg(arg) {
    const parts = String(arg).split('|').map((s) => s.trim());
    const lyric = parts.slice(3).join('|').trim();
    if (parts.length < 4 || !parts[0] || !lyric) return null;
    return { title: parts[0].slice(0, 80), artist: (parts[1] || '알 수 없음').slice(0, 40), year: parseInt(parts[2], 10) || 0, lyric: lyric.slice(0, 300) };
  }

  // ───── 문제 / 정답 / 힌트 ─────
  function titleKind(t) {
    const main = t.replace(/\(.*?\)/g, '');
    if (hasLatin(main) && hasHangul(main)) return '한글+영어 제목';
    if (hasLatin(main)) return '영어 제목 (한글 발음 초성)';
    return '한글 제목';
  }
  function checkAnswer(text, q, mode, aliases) {
    const n = norm(text);
    if (!n) return { ok: false, close: false };
    const answers = mode === '가수' ? artistAnswers(q.artist, aliases) : songAnswers(q);
    if (answers.includes(n)) return { ok: true, close: false };
    const close = answers.some((a) => a.length >= 3 && lev(n, a) <= (a.length >= 7 ? 2 : 1));
    return { ok: false, close };
  }
  function questionHTML(q, mode, no) {
    if (mode === '가수') {
      return `<div class="q-head">🎤 ${no} · 가수 맞추기</div><div class="q-title">「${esc(q.title)}」</div><div class="q-meta">📅 ${q.year}년 · 이 노래를 부른 가수는?</div>`;
    }
    if (mode === '가사') {
      return `<div class="q-head">📝 ${no} · 가사 퀴즈</div><div class="q-lyric">${esc(q.lyric)}</div><div class="q-meta">${q.year ? '📅 ' + eraLabel(q.year) + ' · ' : ''}이 노래의 제목은?</div>`;
    }
    return `<div class="q-head">🎵 ${no} · 초성 퀴즈</div><div class="q-cho">${esc(choMask(q.reading))}</div><div class="q-meta">📅 ${eraLabel(q.year)} · ${titleKind(q.title)}</div>`;
  }
  function hintText(q, mode, n, byArtist) {
    if (mode === '가수') {
      const others = ((byArtist && byArtist.get(q.artist)) || []).filter((s) => s !== q && norm(s.title) !== norm(q.title));
      if (n === 1) return others.length ? `같은 가수의 다른 곡: <b>${esc(pick(others).title)}</b>` : `가수 이름 ${[...q.artist.replace(/\s/g, '')].length}글자`;
      if (n === 2) return `가수 초성: <span class="cho-inline">${esc(artistMask(q.artist))}</span>`;
      return `첫 글자: <span class="cho-inline">${esc(artistMask(q.artist, true))}</span>`;
    }
    if (mode === '가사') {
      if (n === 1) return `제목 초성: <span class="cho-inline">${esc(choMask(q.reading))}</span>`;
      if (n === 2) return `가수: <b>${esc(q.artist)}</b>`;
      return `첫 글자: <span class="cho-inline">${esc(choMask(q.reading, true))}</span>`;
    }
    if (n === 1) return `가수 초성: <span class="cho-inline">${esc(artistMask(q.artist))}</span> · ${q.year}년 발매`;
    if (n === 2) return `가수: <b>${esc(q.artist)}</b>`;
    return `첫 글자: <span class="cho-inline">${esc(choMask(q.reading, true))}</span>`;
  }
  const card = (q) => `<div class="card"><div class="ct">${esc(q.title)}</div><div class="ca">${esc(q.artist)}${q.year ? ' · ' + q.year : ''}</div></div>`;
  // 힌트 0~3개 → 10/7/5/3점, 3연속부터 보너스
  function points(hints, streak) {
    const base = [10, 7, 5, 3][Math.min(hints, 3)];
    const bonus = streak >= 3 ? Math.min((streak - 2) * 2, 10) : 0;
    return { base, bonus, total: base + bonus };
  }
  function grade(rate) {
    return rate >= 90 ? '케이팝 고인물 👑' : rate >= 70 ? '찐팬 인정 💖' : rate >= 40 ? '좀 듣는 편 🎧' : '노래방 입문자 🎤';
  }

  // ───── 안내 문구 ─────
  function helpHTML(multi) {
    const rows = [
      ['/시작 [n]', '게임 시작 (기본 10문제, 0=무한)'],
      ['/힌트', '힌트 (최대 3개, 쓸수록 점수↓)'],
      ['/패스', '이번 문제 넘기기'],
      [multi ? '/순위' : '/점수', multi ? '현재 순위 보기' : '현재 점수 보기'],
      ['/종료', '게임 끝내기'],
      ['/모드 이름', '초성 · 가수 · 가사 · 랜덤'],
      ['/연대 값', '90 · 00 · 10 · 20 · 전체'],
      ['/가수 이름', '특정 가수만 (비우면 해제)'],
      ['/시간 초', '제한시간 (0 = 무제한)'],
      ['/추가 …', '제목 | 가수 | 연도 | 가사'],
      ['/내문제', '추가한 가사 문제 목록'],
    ];
    if (multi) rows.push(['/누구', '접속한 사람 보기'], ['/닉네임 이름', '닉네임 바꾸기'], ['/통계', '수록곡 통계']);
    else rows.push(['/기록 · /통계', '최고 기록 · 수록곡 통계']);
    rows.push(['/위장 · /테마', '로그처럼 보이기 · 말풍선 테마'], ['/청소', '대화 지우기 (내 화면만)']);
    const tail = multi
      ? '<br>정답은 그냥 채팅으로! 제일 먼저 맞힌 사람이 점수를 가져가요.<br>시작·힌트·패스·순위·종료는 <code>/</code> 없이 쳐도 돼요.<br>🙈 <kbd>Esc</kbd> 채팅 숨기기 (멀티에서는 타이머가 계속 가요)'
      : '<br>정답은 그냥 채팅으로 치면 돼요 (띄어쓰기·대소문자 무시, 영어/한글 둘 다 OK).<br>시작·힌트·패스·점수·종료는 <code>/</code> 없이 쳐도 돼요.<br>🙈 <kbd>Esc</kbd> 채팅 숨기기 (숨기면 타이머 일시정지)';
    return `📖 <b>명령어</b><div class="help">${rows.map(([a, b]) => `<code>${esc(a)}</code><span>${esc(b)}</span>`).join('')}</div>${tail}`;
  }
  function statsHTML(db, customCount) {
    const cnt = { '90': 0, '00': 0, '10': 0, '20': 0 };
    db.songs.forEach((s) => cnt[eraKey(s.year)]++);
    const top = [...db.byArtist.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5).map(([a, l]) => `${esc(a)} ${l.length}`).join(' · ');
    return `📚 수록곡 <b>${db.songs.length}곡</b> · 가수 ${db.byArtist.size}팀 (${db.minYear}~${db.maxYear})<br>90년대 ${cnt['90']} · 2000년대 ${cnt['00']} · 2010년대 ${cnt['10']} · 2020년대 ${cnt['20']}<br>많이 나오는 가수: ${top}<br>가사 문제: ${customCount}개`;
  }

  return {
    CHO, isHangul, choOf, esc, norm, pick, shuffle, lev, choMask, artistMask,
    eraKey, ERA_LABEL, eraLabel, MODES, MODE_LABEL, parseMode, parseEra,
    buildDB, filterPool, artistAnswers, findArtist, songAnswers, normalizeCustom, parseCustomArg,
    titleKind, checkAnswer, questionHTML, hintText, card, points, grade, helpHTML, statsHTML,
  };
});

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
  const MODES = ['초성', '가수', '가사', '랜덤', '부르기', '얼굴', '자켓', '릴레이']; // 릴레이는 멀티 전용
  const MODE_LABEL = {
    초성: '초성 퀴즈', 가수: '가수 맞추기', 가사: '가사 퀴즈', 랜덤: '랜덤 (가사+초성+가수)', 부르기: '노래 부르기 (제목 보고 가사 한 소절)',
    얼굴: '얼굴 퀴즈 (사진 보고 아이돌 이름)', 자켓: '자켓 퀴즈 (앨범 자켓 보고 타이틀곡)', 릴레이: '노래 릴레이 (가수 보고 노래 쭉 적기)',
  };
  const IMAGE_MODES = new Set(['얼굴', '자켓']);

  // null = 값 없음(현재 설정 보여주기), undefined = 잘못된 값
  function parseMode(arg) {
    const m = String(arg || '').replace(/퀴즈|모드|맞추기|\s/g, '');
    if (!m) return null;
    return MODES.find((x) => x === m) || {
      chosung: '초성', artist: '가수', lyric: '가사', lyrics: '가사', random: '랜덤', 제목: '초성',
      sing: '부르기', 노래부르기: '부르기', 노래방: '부르기', 떼창: '부르기', 가사쓰기: '부르기', 가사적기: '부르기', 소절: '부르기', 부르기퀴즈: '부르기',
      relay: '릴레이', 노래릴레이: '릴레이', 쭉적기: '릴레이', 노래쭉적기: '릴레이', 노래적기: '릴레이',
      face: '얼굴', 사진: '얼굴', 아이돌: '얼굴', 멤버: '얼굴', 얼굴보고: '얼굴',
      cover: '자켓', jacket: '자켓', album: '자켓', 재킷: '자켓', 앨범: '자켓', 커버: '자켓', 앨범자켓: '자켓', 앨범재킷: '자켓', 앨범커버: '자켓', 타이틀곡: '자켓',
    }[m.toLowerCase()];
  }
  function parseEra(arg) {
    const a = String(arg || '').replace(/년대|년|s$/g, '').trim();
    if (!a) return null;
    return { '90': '90', '1990': '90', '00': '00', '2000': '00', '10': '10', '2010': '10', '20': '20', '2020': '20', '전체': 'all', all: 'all' }[a];
  }

  // ───── 데이터 ─────
  function buildDB(raw, aliases, enNames) {
    const songs = (raw || []).map((r, i) => ({ id: i, title: r[0], reading: r[1] || r[0], artist: r[2], year: r[3], alias: r[4] || [] }));
    const byArtist = new Map();
    songs.forEach((s) => { if (!byArtist.has(s.artist)) byArtist.set(s.artist, []); byArtist.get(s.artist).push(s); });
    const years = songs.map((s) => s.year);
    return { songs, byArtist, aliases: aliases || {}, en: enNames || {}, minYear: Math.min(...years), maxYear: Math.max(...years) };
  }
  function filterPool(db, opt) {
    let p = db.songs;
    if (opt.era && opt.era !== 'all') p = p.filter((s) => eraKey(s.year) === opt.era);
    if (opt.artist) p = p.filter((s) => s.artist === opt.artist);
    return p;
  }
  // 얼굴 퀴즈: idols.js 의 [이름, 가수(여럿이면 |), 사진, 정답 표기, 출처]
  function buildIdols(rows) {
    return (rows || []).map((r, i) => {
      const groups = String(r[1]).split('|');
      const answers = [...new Set([norm(r[0]), ...(r[3] || [])])].filter(Boolean);
      // 보여줄 소속 = 본인 이름인 솔로 활동 빼고 ("정국" → 방탄소년단). 없으면 솔로 가수
      const shown = groups.filter((g) => !answers.includes(norm(g)));
      return {
        id: 'i' + i, title: r[0], reading: r[0], artist: shown.join(' · ') || '솔로 가수', solo: shown.length ? null : groups[0],
        groups, img: r[2], answers, credit: r[4] ? '사진: ' + r[4] + ' · Wikimedia Commons' : '',
      };
    });
  }
  // 자켓 퀴즈: covers.js 의 [곡 제목, 가수, 이미지 주소, 같은 앨범의 다른 곡] → 수록곡에 이미지 붙이기
  function buildCovers(db, rows) {
    const find = (t, a) => (db.byArtist.get(a) || []).find((s) => s.title === t);
    const out = [];
    (rows || []).forEach((r) => {
      const s = find(r[0], r[1]);
      if (!s) return;
      const others = (r[3] || []).map((t) => find(t, r[1])).filter(Boolean);
      const answers = [...new Set([s, ...others].flatMap(songAnswers))];
      out.push(Object.assign({}, s, { img: 'https://' + r[2] + '/600x600bb.jpg', answers, also: others.map((x) => x.title), credit: '앨범 아트: iTunes' }));
    });
    return out;
  }
  // 모드별 출제 목록. sets = { db, idols, covers, custom }
  function poolFor(mode, sets, opt) {
    if (mode === '얼굴') return (sets.idols || []).filter((q) => !opt.artist || q.groups.includes(opt.artist));
    if (mode === '자켓') return filterPool({ songs: sets.covers || [] }, opt);
    const p = filterPool(sets.db, opt);
    return mode === '가사' ? [...p, ...(sets.custom || [])] : p;
  }
  // ───── 이미 나온 문제 기억하기 (안 나온 문제부터 내려고) ─────
  const seenKey = (q) => (q.groups ? '얼굴:' : '') + q.title + '|' + q.artist;
  // saved: 예전에 나온 순서대로 키 목록 (오래된 것 먼저). 최근 max 개까지만 기억
  function makeSeen(saved, max) {
    const limit = max || 5000;
    const order = new Map();
    let n = 0;
    (Array.isArray(saved) ? saved : []).forEach((k) => order.set(String(k), n++));
    return {
      add(k) { order.delete(k); order.set(k, n++); if (order.size > limit) order.delete(order.keys().next().value); },
      rank(k) { return order.has(k) ? order.get(k) : -1; }, // -1 = 안 나옴, 클수록 최근
      list() { return [...order.keys()]; },
    };
  }
  // 출제 순서 (뒤에서부터 뽑음): 안 나온 문제를 섞어서 먼저, 나온 문제는 오래전에 나온 것부터
  function orderDeck(list, seen, keyOf, arrangeFresh) {
    const key = keyOf || seenKey;
    const fresh = [], old = [];
    for (const x of list) (seen.rank(key(x)) < 0 ? fresh : old).push(x);
    old.sort((a, b) => seen.rank(key(b)) - seen.rank(key(a)));
    return [...old, ...(arrangeFresh || shuffle)(fresh)];
  }
  const countFresh = (list, seen, keyOf) => list.filter((x) => seen.rank((keyOf || seenKey)(x)) < 0).length;

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
    if (mode === '부르기') return singCheck(text, q);
    const n = norm(text);
    if (!n) return { ok: false, close: false };
    const answers = mode === '가수' ? artistAnswers(q.artist, aliases) : q.answers || songAnswers(q);
    if (answers.includes(n)) return { ok: true, close: false };
    const close = answers.some((a) => a.length >= 3 && lev(n, a) <= (a.length >= 7 ? 2 : 1));
    return { ok: false, close };
  }
  // 사진 문제는 에디터에 이미지 탭으로 띄움 (회사 프로젝트 스크린샷인 척)
  const imageFile = (no) => `docs/screenshots/capture_${String(no).padStart(2, '0')}.png`;
  const BLUR = [20, 12, 6, 2]; // 단계별 흐림 (px), 정답 공개 = 0
  // 흐림 단계: 힌트 수 또는 지난 시간 (제한시간을 4등분) 중 큰 쪽. 단계가 오를수록 점수 ↓
  function imageStage(hints, remain, tl) {
    const byTime = tl ? Math.floor(((tl - remain) / tl) * 4) : 0;
    return Math.max(0, Math.min(3, Math.max(hints, byTime)));
  }
  function questionHTML(q, mode, no, qNo) {
    if (mode === '얼굴' || mode === '자켓') {
      const file = imageFile(qNo || 1).split('/').pop();
      const ask = mode === '얼굴' ? '이 사람은 누구?' : '이 앨범의 타이틀곡은?';
      return `<div class="q-head">${mode === '얼굴' ? '📸' : '💿'} ${no} · ${mode === '얼굴' ? '얼굴 퀴즈' : '자켓 퀴즈'}</div><div class="q-title">${ask}</div><div class="q-meta">🖼 에디터의 <code>${esc(file)}</code> 탭을 보세요 · 점점 선명해져요${mode === '자켓' && q.year ? ' · 📅 ' + eraLabel(q.year) : ''}</div>`;
    }
    if (mode === '가수') {
      return `<div class="q-head">🎤 ${no} · 가수 맞추기</div><div class="q-title">「${esc(q.title)}」</div><div class="q-meta">📅 ${q.year}년 · 이 노래를 부른 가수는?</div>`;
    }
    if (mode === '부르기') {
      return `<div class="q-head">🎙 ${no} · 노래 부르기</div><div class="q-title">「${esc(q.title)}」</div><div class="q-meta">${esc(q.artist)}${q.year ? ' · ' + q.year + '년' : ''} · 이 노래 가사 한 소절을 적어주세요 (아무 부분이나, 한글 6글자 이상)</div>`;
    }
    if (mode === '가사') {
      return `<div class="q-head">📝 ${no} · 가사 퀴즈</div><div class="q-lyric">${esc(q.lyric)}</div><div class="q-meta">${q.year ? '📅 ' + eraLabel(q.year) + ' · ' : ''}이 노래의 제목은?${q.src ? ` <span style="opacity:.6">· 가사 출처 ${esc(q.src)}</span>` : ''}</div>`;
    }
    return `<div class="q-head">🎵 ${no} · 초성 퀴즈</div><div class="q-cho">${esc(choMask(q.reading))}</div><div class="q-meta">📅 ${eraLabel(q.year)} · ${titleKind(q.title)}</div>`;
  }
  function hintText(q, mode, n, byArtist) {
    if (mode === '얼굴') {
      const len = [...q.title.replace(/\s/g, '')].length;
      if (q.solo) { // 솔로는 가수 이름 = 정답이라 대표곡으로
        const songs = (byArtist && byArtist.get(q.solo)) || [];
        if (n === 1) return `솔로 가수 · 이름 ${len}글자`;
        if (n === 2) return songs.length ? `대표곡: <b>${esc(songs[0].title)}</b>` : `이름 초성: <span class="cho-inline">${esc(artistMask(q.title))}</span>`;
      }
      if (n === 1) return `소속 초성: <span class="cho-inline">${esc(artistMask(q.artist))}</span> · 이름 ${len}글자`;
      if (n === 2) return `소속: <b>${esc(q.artist)}</b>`;
      return `이름 첫 글자: <span class="cho-inline">${esc(artistMask(q.title, true))}</span>`;
    }
    if (mode === '가수') {
      const others = ((byArtist && byArtist.get(q.artist)) || []).filter((s) => s !== q && norm(s.title) !== norm(q.title));
      if (n === 1) return others.length ? `같은 가수의 다른 곡: <b>${esc(pick(others).title)}</b>` : `가수 이름 ${[...q.artist.replace(/\s/g, '')].length}글자`;
      if (n === 2) return `가수 초성: <span class="cho-inline">${esc(artistMask(q.artist))}</span>`;
      return `첫 글자: <span class="cho-inline">${esc(artistMask(q.artist, true))}</span>`;
    }
    if (mode === '부르기') { // 후렴 한 줄: 초성 → 앞 절반 → 전체
      const h = q.sing.hook;
      if (n === 1) return `이 소절 어때요? <span class="cho-inline">${esc(singMask(h, 0))}</span>`;
      if (n === 2) return `<span class="cho-inline">${esc(singMask(h, 0.5))}</span>`;
      return `그대로 따라 적어보세요: <span class="q-lyric-inline">${esc(h)}</span>`;
    }
    if (mode === '가사') {
      if (n === 1) return q.lyricNext ? `다음 소절: <span class="q-lyric-inline">${esc(q.lyricNext)}</span>` : `가수 초성: <span class="cho-inline">${esc(artistMask(q.artist))}</span>`;
      if (n === 2) return `가수: <b>${esc(q.artist)}</b>${q.year ? ' · ' + q.year + '년' : ''}`;
      return `제목 초성: <span class="cho-inline">${esc(choMask(q.reading))}</span>`;
    }
    if (n === 1) return `가수 초성: <span class="cho-inline">${esc(artistMask(q.artist))}</span> · ${q.year}년 발매`;
    if (n === 2) return `가수: <b>${esc(q.artist)}</b>`;
    return `첫 글자: <span class="cho-inline">${esc(choMask(q.reading, true))}</span>`;
  }
  const card = (q) => `<div class="card"><div class="ct">${esc(q.title)}</div><div class="ca">${esc(q.artist)}${q.year ? ' · ' + q.year : ''}</div></div>`;
  // 정답 공개 카드. 노래 부르기는 맞힌 소절 + 다음 소절, 못 맞혔으면 후렴 한 줄을 같이 보여줌
  function revealCard(q, mode, r) {
    if (mode !== '부르기' || !q.sing) return card(q);
    if (r && r.lines) {
      return `${card(q)}<div class="q-lyric">${esc(r.lines.join('\n'))}</div>${r.next ? `<div class="q-meta">♪ 다음 소절: <span class="q-lyric-inline">${esc(r.next)}</span></div>` : ''}`;
    }
    return `${card(q)}<div class="q-meta">이런 소절이 있었어요</div><div class="q-lyric">${esc(q.sing.hook)}</div>`;
  }
  // 틀렸을 때 안내 (없으면 ''). name: 멀티에서 누구한테 하는 말인지
  function missText(r, mode, name) {
    const who = name ? `${esc(name)}님 ` : '';
    if (r.why === 'short') return `🤏 ${who}맞는 가사예요! 조금만 더 길게 적어주세요 (한글 6글자 이상)`;
    if (r.why === 'title') return `🎙 ${who}제목 말고 <b>가사</b>를 더 적어주세요 (제목 빼고 한글 6글자 이상)`;
    if (r.close) return `🤏 ${who}아까워요! ${mode === '부르기' ? '가사가 조금 달라요' : '거의 맞았어요'}`;
    return '';
  }
  // 힌트 0~3개 → 10/7/5/3점, 3연속부터 보너스
  function points(hints, streak) {
    const base = [10, 7, 5, 3][Math.min(hints, 3)];
    const bonus = streak >= 3 ? Math.min((streak - 2) * 2, 10) : 0;
    return { base, bonus, total: base + bonus };
  }
  function grade(rate) {
    return rate >= 90 ? '케이팝 고인물 👑' : rate >= 70 ? '찐팬 인정 💖' : rate >= 40 ? '좀 듣는 편 🎧' : '노래방 입문자 🎤';
  }

  // ───── 가사 (LRCLIB) ─────
  const LRCLIB_SEARCH = 'https://lrclib.net/api/search?q=';

  // 가사 텍스트 → 문제로 쓸 수 있는 줄 목록 ([Chorus] 같은 표시는 제외)
  function lyricLines(plain) {
    return String(plain || '').split(/\r?\n/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s && !/^[\[(（].*[\])）]$/.test(s) && !/^(verse|chorus|hook|bridge|pre-chorus|intro|outro|rap)\b/i.test(s));
  }
  // 줄 안에 들어간 제목을 ♪♪♪ 로 가림
  function maskTitle(line, song) {
    const parts = [song.title.replace(/\(.*?\)/g, '').trim(), song.reading.replace(/\(.*?\)/g, '').trim(), ...(song.alias || [])]
      .filter((p) => p && p.length >= 2)
      .sort((a, b) => b.length - a.length);
    let out = line;
    for (const p of parts) {
      let src = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
      if (/^[\w\s'&.-]+$/.test(p)) src = `\\b${src}\\b`;
      out = out.replace(new RegExp(src, 'gi'), '♪♪♪');
    }
    return out.slice(0, 90);
  }
  // 문제용 4줄(안 되면 3줄) + 힌트용 다음 줄 고르기 (가능하면 제목이 안 들어간 곳으로)
  const SNIPPET_LINES = [4, 3];
  function pickSnippet(plain, song) {
    const lines = lyricLines(plain);
    if (lines.length < 6) return null;
    const ans = songAnswers(song).filter((a) => a.length >= 2);
    const hasTitle = (l) => { const n = norm(l); return ans.some((a) => n.includes(a)); };
    const preferHangul = lines.some((l) => /[가-힣]/.test(l));
    const ok = (i, n) => {
      const w = lines.slice(i, i + n);
      if (w.length < n) return false;
      if (new Set(w.map(norm)).size < n - 1) return false; // 같은 줄만 반복되는 곳은 X
      if (w.join('').length < 6 * n) return false;
      if (w.some(hasTitle)) return false;
      if (preferHangul && !/[가-힣]/.test(w.join(''))) return false;
      return true;
    };
    const make = (i, n) => ({
      text: lines.slice(i, i + n).map((l) => maskTitle(l, song)).join('\n'),
      next: lines[i + n] ? maskTitle(lines[i + n], song) : null,
    });
    const order = shuffle([...Array(lines.length).keys()]);
    for (const n of SNIPPET_LINES) {
      const i = order.find((k) => ok(k, n));
      if (i !== undefined) return make(i, n);
    }
    // 제목이 안 들어간 구간이 없으면 아무 데나 (제목은 ♪♪♪ 로 가림)
    const n = SNIPPET_LINES[0];
    return make(Math.floor(Math.random() * (lines.length - n + 1)), n);
  }
  // ───── 노래 부르기: 제목 보고 가사 한 소절 적기 ─────
  // 가사 길이 점수: 한글 1글자 = 2, 영어·숫자 1글자 = 1. 12점(한글 6글자, 영어 12글자) 이상이어야 인정
  const SING_MIN = 12;
  const SING_HELP = '제목이 나오면 그 노래 가사를 아무 소절이나 채팅으로 적으면 정답! (띄어쓰기 무시, 한글 6글자 이상, 길게 쓰면 오타 조금 OK)';
  const lyricWeight = (n) => [...n].reduce((s, c) => s + (isHangul(c) ? 2 : 1), 0);
  const distinctChars = (n) => new Set(n).size;
  // 제목 표기를 빼고 남은 부분 (제목만 치는 건 가사로 안 침)
  function withoutTitle(n, titles) {
    let rest = n;
    for (const t of titles) rest = rest.split(t).join('');
    return rest;
  }
  // 이 정도면 가사 한 소절로 인정: 충분히 길고, "oh oh oh" 같은 반복이 아님
  const singEnough = (n, titles) => lyricWeight(withoutTitle(n, titles)) >= SING_MIN && distinctChars(n) >= 4;

  // 긴 문자열 t 안에서 p 와 가장 비슷한 부분 찾기 (오타 허용 부분 문자열 검색) → { d: 고쳐야 할 글자 수, end }
  function fuzzyFind(p, t) {
    const exact = t.indexOf(p);
    if (exact >= 0) return { d: 0, end: exact + p.length };
    const m = p.length;
    let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
    for (let i = 0; i <= m; i++) prev[i] = i;
    let best = m, end = 0;
    for (let j = 1; j <= t.length; j++) {
      cur[0] = 0; // 가사 어디서 시작해도 됨
      const tc = t[j - 1];
      for (let i = 1; i <= m; i++) cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (p[i - 1] === tc ? 0 : 1));
      if (cur[m] < best) { best = cur[m]; end = j; }
      [prev, cur] = [cur, prev];
    }
    return { d: best, end };
  }

  // 한국어 가사를 영어 알파벳 발음으로 적은 것 (modudeul miwohaneura…) → 한글로 쳐서는 못 맞힘
  const ROMAJA = /\b(neol|naega|nega|neoui|neon|neowa|neoreul|uri|urin|urineun|saranghae|sarang|geu|geuge|geureon|jigeum|ije|hamkke|maeum|gateun|dasi|eotteoke|hajiman|mwo|jeongmal|nareul|naneun|naui|modu|gachi|haru|eodiseo|eonjena|kkeut|kkum|nunmul|baby\s+nan)\b/gi;
  function isRomanized(lines) {
    const text = lines.join(' ');
    if (hasHangul(text)) return false;
    const hits = text.match(ROMAJA) || [];
    return hits.length >= 6 && new Set(hits.map((h) => h.toLowerCase())).size >= 3;
  }
  // 추임새만 있는 줄 (oh yeah na na) 은 힌트로 안 씀
  const FILLER = /^(oh+|ooh+|ah+|uh+|eh+|ay+|yeah|yea|na|la|da|hey|ho|woo+|whoa|baby|uh-huh|mm+|hmm+|yo)$/i;
  const meaningfulWords = (l) => l.split(/[\s,.!?~-]+/).filter((w) => w && !FILLER.test(w)).length;

  // LRCLIB 가사 → 채점용 데이터. 못 쓰는 가사면 null
  function buildSing(plain, song) {
    const lines = lyricLines(plain);
    if (lines.length < 6 || isRomanized(lines)) return null;
    const titles = songAnswers(song).filter((a) => a.length >= 2).sort((a, b) => b.length - a.length);
    // 줄을 이어 붙인 전체 가사 (줄바꿈 걸쳐 적어도 OK). 괄호 속 추임새 "(oh yeah)" 를 뺀 버전도 같이
    const texts = [lines, lines.map((l) => l.replace(/\([^)]*\)/g, ' '))].map((ls) => {
      let text = '';
      const starts = ls.map((l) => { const s = text.length; text += norm(l); return s; });
      return { text, starts };
    });
    // 힌트·정답 공개용 소절: 가장 많이 반복되는 줄 (후렴), 한글 가사면 한글 줄 우선
    const count = new Map();
    lines.forEach((l) => { const k = norm(l); count.set(k, (count.get(k) || 0) + 1); });
    const preferHangul = lines.some((l) => hasHangul(l));
    const clean = (l) => l.replace(/\s*\([^)]*\)\s*/g, ' ').trim(); // 추임새 괄호는 빼고 보여줌
    const good = lines.filter((l) => {
      const c = clean(l);
      return c.length <= 60 && singEnough(norm(c), titles) && (!preferHangul || hasHangul(c)) && (hasHangul(c) || meaningfulWords(c) >= 3);
    });
    if (!good.length) return null;
    const top = Math.max(...good.map((l) => count.get(norm(l))));
    const hook = clean(pick(good.filter((l) => count.get(norm(l)) === top)));
    return { lines, texts, titles, hook };
  }

  // 노래 부르기 채점 → { ok, close, why: 'short'|'title', lines: 맞힌 소절, next: 다음 소절 }
  function singCheck(text, q) {
    const sg = q.sing;
    const n = norm(text).slice(0, 150);
    if (!n || !sg) return { ok: false, close: false };
    const enough = singEnough(n, sg.titles);
    const hits = sg.texts.map((v) => Object.assign(fuzzyFind(n, v.text), { v }));
    const best = hits.reduce((a, b) => (b.d < a.d ? b : a));
    if (!enough) {
      if (best.d > 0) return { ok: false, close: false }; // 그냥 잡담
      // 가사에 있는 말이긴 한데 너무 짧거나 제목만 침
      return { ok: false, close: false, why: withoutTitle(n, sg.titles).length < n.length ? 'title' : 'short' };
    }
    const allowed = Math.floor(n.length / 8); // 8글자마다 오타 1개 허용
    if (best.d > allowed) return { ok: false, close: best.d <= allowed + Math.max(1, Math.floor(n.length / 5)) };
    // 맞힌 위치 → 원래 가사 줄 (최대 3줄) + 다음 줄
    const lineAt = (pos) => { let i = 0; while (i + 1 < best.v.starts.length && best.v.starts[i + 1] <= pos) i++; return i; };
    const a = lineAt(Math.max(0, best.end - n.length)), b = Math.min(lineAt(best.end - 1), a + 2);
    return { ok: true, close: false, lines: sg.lines.slice(a, b + 1), next: sg.lines[b + 1] || null };
  }

  // 힌트용 가리기: 앞쪽 ratio 만큼 단어는 보여주고, 나머지는 한글 초성 / 영어 첫 글자만
  function singMask(line, ratio) {
    const words = line.split(/\s+/);
    const show = Math.ceil(words.length * (ratio || 0));
    return words.map((w, i) => (i < show ? w : [...w].map((c, k) => {
      if (isHangul(c)) return choOf(c);
      if (/[A-Za-z]/.test(c)) return k === 0 || !/[A-Za-z]/.test(w[k - 1]) ? c : '_';
      return c;
    }).join(''))).join(' ');
  }

  // 검색 결과 중 이 노래가 맞는 것 고르기 (제목·가수 일치, 한글 가사 우선)
  function chooseLyrics(results, song, db) {
    if (!Array.isArray(results)) return null;
    const titles = songAnswers(song);
    const arts = [...artistAnswers(song.artist, db.aliases), norm((db.en || {})[song.artist])].filter((a) => a && a.length >= 2);
    let best = null, bestScore = -1;
    for (const r of results) {
      if (!r || r.instrumental || !r.plainLyrics) continue;
      const t = norm(String(r.trackName || '').replace(/\(.*?\)/g, '')) || norm(r.trackName);
      const a = norm(r.artistName);
      const tOk = titles.some((x) => x === t || (x.length >= 3 && t.length >= 2 && (t.includes(x) || x.includes(t))));
      const aOk = arts.some((x) => a.includes(x) || (a.length >= 2 && x.includes(a)));
      if (!tOk || !aOk) continue;
      const n = lyricLines(r.plainLyrics).length;
      if (n < 6) continue;
      const score = (titles.includes(t) ? 3 : 1) + (/[가-힣]/.test(r.plainLyrics) ? 2 : 0) + Math.min(n, 60) / 60;
      if (score > bestScore) { bestScore = score; best = r.plainLyrics; }
    }
    return best;
  }
  // fetchJSON(url) → Promise<json>. 네트워크 오류면 throw, 못 찾으면 null 반환
  function makeLyricsFetcher(fetchJSON, db) {
    const cache = new Map();
    return async function getLyrics(song) {
      const key = song.title + '|' + song.artist;
      if (cache.has(key)) return cache.get(key);
      const main = song.title.replace(/\(.*?\)/g, '').trim() || song.title;
      const en = (db.en || {})[song.artist];
      const queries = [...new Set([
        en && `${main} ${en}`,
        `${main} ${song.artist}`,
        en && song.reading !== song.title && `${song.reading} ${en}`,
      ].filter(Boolean))];
      let found = null;
      for (const q of queries) {
        found = chooseLyrics(await fetchJSON(LRCLIB_SEARCH + encodeURIComponent(q)), song, db);
        if (found) break;
      }
      cache.set(key, found);
      if (cache.size > 800) cache.delete(cache.keys().next().value);
      return found;
    };
  }
  // 다음 문제 준비. o = { mode, takeSong(), getLyrics(song) }
  async function prepareQuestion(o) {
    const mode = o.mode === '랜덤' ? pick(['가사', '초성', '가수']) : o.mode;
    if (mode !== '가사' && mode !== '부르기') { const s = o.takeSong(); return s ? { q: s, mode } : null; }
    let netErr = 0;
    for (let i = 0; i < 8; i++) {
      const s = o.takeSong();
      if (!s) return null;
      if (s.lyric) { if (mode === '가사') return { q: s, mode: '가사' }; continue; } // 직접 추가한 가사 문제
      let plain = null;
      try { plain = await o.getLyrics(s); } catch (e) {
        if (++netErr >= 2) return { q: s, mode: '초성', fallback: 'offline' };
        continue;
      }
      if (mode === '부르기') {
        const sing = plain && buildSing(plain, s);
        if (sing) return { q: Object.assign({}, s, { sing, src: 'LRCLIB' }), mode: '부르기' };
        continue;
      }
      const snip = plain && pickSnippet(plain, s);
      if (snip) return { q: Object.assign({}, s, { lyric: snip.text, lyricNext: snip.next, src: 'LRCLIB' }), mode: '가사' };
    }
    const s = o.takeSong();
    return s ? { q: s, mode: '초성', fallback: 'notfound' } : null;
  }

  // ───── 노래 릴레이: 가수 노래 목록 (iTunes) ─────
  const ITUNES = 'https://itunes.apple.com/';
  // 괄호 안이 이런 표기면 다른 제목이 아니라 버전 표시
  const VERSION_RE = /\b(feat|ft|with|prod|live|inst|instrumental|mr|remix|mix|ver|version|edit|acoustic|demo|sped|slowed|remaster(ed)?|karaoke|radio|english|japanese|chinese|korean|extended|original|bonus|from|ost|alternate|solo)\b|버전|라이브|리믹스/i;

  // 곡 제목 → { keys: 같은 곡 판단용, extra: 추가로 인정할 표기 }
  function titleVariants(t) {
    const keys = new Set(), extra = new Set();
    const base = String(t).replace(/\s*[(\[（【][^)\]）】]*[)\]）】]/g, '').trim() || String(t); // (feat. …) (Live) [Remix] 빼기
    const head = base.split(/\s+[-–—]\s+/)[0]; // "전사의 후예 - 폭력시대" → "전사의 후예"
    [base, head].forEach((s) => { const n = norm(s); if (n) keys.add(n); });
    for (const m of String(t).matchAll(/[(\[]([^)\]]+)[)\]]/g)) if (!VERSION_RE.test(m[1])) extra.add(norm(m[1])); // "너랑 나 (YOU&I)"
    if (hasHangul(head) && hasLatin(head)) { // "스물셋 Twenty-Three" → 스물셋 / twentythree
      extra.add(norm(head.replace(/[^가-힣\s]/g, '')));
      extra.add(norm(head.replace(/[가-힣]/g, '')));
    }
    return { keys: [...keys], extra: [...extra].filter((x) => x.length >= 2 && !keys.has(x)) };
  }

  // local: songs.js 의 이 가수 곡들 (대표곡), tracks: iTunes 곡 결과 (한국 스토어 먼저)
  function buildDiscography(local, tracks) {
    const songs = [], byKey = new Map(), byTrack = new Map();
    function add(title, keys, extra, core, trackId) {
      let s = (trackId != null && byTrack.get(trackId)) || keys.map((k) => byKey.get(k)).find(Boolean);
      if (!s) { s = { title, core: false }; songs.push(s); }
      if (core && !s.core) { s.core = true; s.title = title; }
      keys.forEach((k) => { if (!byKey.has(k)) byKey.set(k, s); });
      extra.forEach((k) => { if (!byKey.has(k)) byKey.set(k, s); });
      if (trackId != null) byTrack.set(trackId, s);
    }
    (local || []).forEach((x) => add(x.title, songAnswers(x), [], true));
    (tracks || []).forEach((t) => {
      if (/\s\/\s/.test(t.trackName)) return; // 메들리 ("투지 / 전사의 후예 / …")
      const v = titleVariants(t.trackName);
      if (v.keys.length) add(String(t.trackName).replace(/\s*[(\[][^)\]]*[)\]]/g, '').trim() || t.trackName, v.keys, v.extra, false, t.trackId);
    });
    return { songs, byKey };
  }

  // 릴레이 채점 → { song } 맞음 / { song: null, close } 틀림
  function relayCheck(text, disco) {
    const n = norm(text);
    if (!n) return { song: null, close: false };
    const v = titleVariants(text); // "캔디 (Candy)" 처럼 괄호 붙여 써도 인정
    const s = [n, ...v.keys, ...v.extra].map((k) => disco.byKey.get(k)).find(Boolean);
    if (s) return { song: s, close: false };
    let close = false;
    if (n.length >= 3) for (const a of disco.byKey.keys()) if (a.length >= 3 && lev(n, a) <= (a.length >= 7 ? 2 : 1)) { close = true; break; }
    return { song: null, close };
  }

  // getDiscography(artist) → { artist, songs, byKey, api(iTunes 성공 여부) }. 실패해도 내장 목록으로 돌려줌
  function makeDiscographyFetcher(fetchJSON, db) {
    const cache = new Map();
    async function findArtistId(artist) {
      const names = [...artistAnswers(artist, db.aliases), norm((db.en || {})[artist])].filter(Boolean);
      for (const term of [...new Set([(db.en || {})[artist], artist].filter(Boolean))]) {
        const r = await fetchJSON(`${ITUNES}search?entity=musicArtist&limit=10&term=${encodeURIComponent(term)}`);
        const hit = ((r && r.results) || []).find((x) => names.includes(norm(x.artistName)));
        if (hit) return hit.artistId;
      }
      return null;
    }
    return async function getDiscography(artist) {
      if (cache.has(artist)) return cache.get(artist);
      const local = db.byArtist.get(artist) || [];
      let tracks = [], ok = false;
      try {
        const id = await findArtistId(artist);
        if (id) {
          const urls = [
            `${ITUNES}lookup?entity=song&limit=200&country=kr&id=${id}`, // 한글 제목
            `${ITUNES}lookup?entity=song&limit=200&country=us&id=${id}`, // 영어 제목
            `${ITUNES}search?entity=song&attribute=artistTerm&limit=200&term=${encodeURIComponent((db.en || {})[artist] || artist)}`,
          ];
          const res = await Promise.all(urls.map((u) => fetchJSON(u).catch(() => null)));
          res.forEach((r) => ((r && r.results) || []).forEach((t) => {
            if (t.wrapperType === 'track' && t.artistId === id && t.trackName) tracks.push(t);
          }));
          ok = tracks.length > 0;
        }
      } catch (e) { ok = false; }
      const d = Object.assign(buildDiscography(local, tracks), { artist, api: ok });
      if (ok) { cache.set(artist, d); if (cache.size > 200) cache.delete(cache.keys().next().value); }
      return d;
    };
  }

  // ───── 안내 문구 ─────
  function helpHTML(multi) {
    const rows = [
      ['/시작 [n]', '게임 시작 (숫자 없으면 무제한, /종료 로 끝)'],
      ['/힌트', '힌트 (최대 3개, 쓸수록 점수↓)'],
      ['/패스', '이번 문제 넘기기'],
      [multi ? '/순위' : '/점수', multi ? '현재 순위 보기' : '현재 점수 보기'],
      ['/종료', '게임 끝내기'],
      ['/모드 이름', multi ? '초성 · 가수 · 가사 · 랜덤 · 부르기 · 얼굴 · 자켓 · 릴레이' : '초성 · 가수 · 가사 · 랜덤 · 부르기 · 얼굴 · 자켓'],
      ['/연대 값', '90 · 00 · 10 · 20 · 전체'],
      ['/가수 이름', '특정 가수만 (비우면 해제)'],
      ['/시간 초', '제한시간 (0 = 무제한)'],
      ['/끝말잇기 [초]', '끝말잇기 (사전에 있는 명사만, 기본 20초)'],
      ['/추가 …', '제목 | 가수 | 연도 | 가사'],
      ['/내문제', '추가한 가사 문제 목록'],
    ];
    if (multi) rows.push(['/누구', '접속한 사람 보기'], ['/닉네임 이름', '닉네임 바꾸기'], ['/통계', '수록곡 통계']);
    else rows.push(['/기록 · /통계', '최고 기록 · 수록곡 통계']);
    rows.push(['/위장 · /테마', '로그처럼 보이기 · 말풍선 테마'], ['/청소', '대화 지우기 (내 화면만)']);
    const tail = multi
      ? '<br>정답은 그냥 채팅으로! 제일 먼저 맞힌 사람이 점수를 가져가요.<br>🎤 <b>릴레이</b>: 가수가 나오면 돌아가면서 그 가수 노래를 하나씩 적어요. 3번 틀리거나 시간이 지나면 탈락!<br>시작·힌트·패스·순위·종료는 <code>/</code> 없이 쳐도 돼요.<br>🙈 <kbd>Esc</kbd> 채팅 숨기기 (멀티에서는 타이머가 계속 가요)'
      : '<br>정답은 그냥 채팅으로 치면 돼요 (띄어쓰기·대소문자 무시, 영어/한글 둘 다 OK).<br>시작·힌트·패스·점수·종료는 <code>/</code> 없이 쳐도 돼요.<br>🙈 <kbd>Esc</kbd> 채팅 숨기기 (숨기면 타이머 일시정지)';
    return `📖 <b>명령어</b><div class="help">${rows.map(([a, b]) => `<code>${esc(a)}</code><span>${esc(b)}</span>`).join('')}</div>${tail}`;
  }
  function statsHTML(db, customCount, idolCount, coverCount) {
    const cnt = { '90': 0, '00': 0, '10': 0, '20': 0 };
    db.songs.forEach((s) => cnt[eraKey(s.year)]++);
    const top = [...db.byArtist.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5).map(([a, l]) => `${esc(a)} ${l.length}`).join(' · ');
    return `📚 수록곡 <b>${db.songs.length}곡</b> · 가수 ${db.byArtist.size}팀 (${db.minYear}~${db.maxYear})<br>90년대 ${cnt['90']} · 2000년대 ${cnt['00']} · 2010년대 ${cnt['10']} · 2020년대 ${cnt['20']}<br>많이 나오는 가수: ${top}<br>가사 문제: ${customCount}개${idolCount != null ? ` · 얼굴 퀴즈 ${idolCount}명 · 자켓 ${coverCount}장` : ''}`;
  }

  return {
    CHO, isHangul, choOf, esc, norm, pick, shuffle, lev, choMask, artistMask,
    eraKey, ERA_LABEL, eraLabel, MODES, MODE_LABEL, IMAGE_MODES, parseMode, parseEra,
    buildDB, filterPool, buildIdols, buildCovers, poolFor, seenKey, makeSeen, orderDeck, countFresh, imageFile, BLUR, imageStage, artistAnswers, findArtist, songAnswers, normalizeCustom, parseCustomArg,
    titleKind, checkAnswer, questionHTML, hintText, card, revealCard, missText, points, grade, helpHTML, statsHTML,
    lyricLines, maskTitle, pickSnippet, chooseLyrics, makeLyricsFetcher, prepareQuestion,
    SING_HELP, buildSing, singCheck, singMask, fuzzyFind,
    titleVariants, buildDiscography, relayCheck, makeDiscographyFetcher,
  };
});

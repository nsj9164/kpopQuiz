// 끝말잇기 공통 로직 (혼자 하기 브라우저 + 멀티 서버가 같이 씀)
// 사전: js/words.js (표준국어대사전 명사) — window.WORD_DICT
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.WordChain = core;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const KIND_LABEL = { STD: '', COMMON: '', NAME: '고유명사', NK: '북한어', DIAL: '방언', OLD: '옛말' };
  // 봇이 말하지 않을 단어 (플레이어가 쓰는 건 사전에 있으면 OK)
  const BOT_SKIP = new Set('섹스 콘돔 새끼 쥐새끼 개새끼 호모 마약 창녀 매춘 강간 자살 살인 시체 변태 성교 정액 음경 음부 성기 항문 똥구멍'.split(' '));

  // ───── 사전 ─────
  function build(W) {
    W = W || {};
    const kind = new Map();
    const all = new Map();    // 첫 글자 → 모든 단어 (한방단어 판단용)
    const std = new Map();    // 첫 글자 → 표준어 (봇이 쓰는 단어)
    const common = new Map(); // 첫 글자 → 자주 쓰는 표준어
    const add = (m, w) => { const h = w[0]; if (!m.has(h)) m.set(h, []); m.get(h).push(w); };
    for (const k of ['STD', 'NAME', 'NK', 'DIAL', 'OLD']) {
      for (const w of String(W[k] || '').split(' ')) {
        if (!w || kind.has(w)) continue;
        kind.set(w, k);
        add(all, w);
        if (k === 'STD' && !BOT_SKIP.has(w)) add(std, w);
      }
    }
    for (const w of String(W.COMMON || '').split(' ')) if (kind.get(w) === 'STD' && !BOT_SKIP.has(w)) add(common, w);
    return { kind, all, std, common, size: kind.size };
  }

  // ───── 글자 규칙 ─────
  // 두음법칙: 력→역, 름→늠, 녀→여 …  (없으면 null)
  function dueum(c) {
    const code = c.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) return null;
    const cho = Math.floor(code / 588), jung = Math.floor((code % 588) / 28), jong = code % 28;
    let to = -1;
    if (cho === 5) to = [2, 6, 7, 12, 17, 20].includes(jung) ? 11 : 2; // ㄹ → ㅇ(ㅑㅕㅖㅛㅠㅣ) / ㄴ
    else if (cho === 2 && [6, 12, 17, 20].includes(jung)) to = 11;     // ㄴ → ㅇ(ㅕㅛㅠㅣ)
    return to < 0 ? null : String.fromCharCode(0xac00 + to * 588 + jung * 28 + jong);
  }
  const heads = (need) => { const d = dueum(need); return d ? [need, d] : [need]; };
  const lastOf = (w) => w[w.length - 1];
  const needLabel = (need) => heads(need).map((h) => `‘${esc(h)}’`).join(' 또는 ');
  const cleanWord = (t) => String(t || '').normalize('NFC').replace(/\s+/g, '');

  // 이 단어 다음에 이을 수 있는 단어가 사전에 하나도 없으면 한방단어
  function isKiller(d, word, used) {
    return heads(lastOf(word)).every((h) => !(d.all.get(h) || []).some((w) => w !== word && !(used && used.has(w))));
  }

  // 입력 검사. attempt=false 면 끝말잇기 시도가 아닌 그냥 채팅으로 봐도 됨
  // reason: hangul | head | short | used | nodict
  function check(d, text, need, used) {
    const word = cleanWord(text);
    if (!/^[가-힣]+$/.test(word)) return { ok: false, attempt: false, reason: 'hangul', word };
    if (need && !heads(need).includes(word[0])) return { ok: false, attempt: false, reason: 'head', word };
    if (word.length < 2) return { ok: false, attempt: true, reason: 'short', word };
    if (used && used.has(word)) return { ok: false, attempt: true, reason: 'used', word };
    const kind = d.kind.get(word);
    if (!kind) return { ok: false, attempt: true, reason: 'nodict', word };
    return { ok: true, attempt: true, word, kind, killer: isKiller(d, word, used) };
  }
  function reasonText(r, need) {
    switch (r.reason) {
      case 'head': return `${needLabel(need)}(으)로 시작하는 단어를 입력해주세요`;
      case 'short': return '두 글자 이상이어야 해요';
      case 'used': return `‘${esc(r.word)}’은(는) 이미 나온 단어예요`;
      case 'nodict': return `‘${esc(r.word)}’은(는) 사전에 없는 단어예요 📕`;
      default: return '한글 명사만 입력할 수 있어요';
    }
  }

  // ───── 봇 ─────
  function findRandom(arr, pred) {
    const a = arr.slice();
    for (let i = a.length - 1; i >= 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
      if (!pred || pred(a[i])) return a[i];
    }
    return null;
  }
  // attack: 0~1, 한방단어를 쓸 확률 (혼자 하기에서 턴이 길어지면 올라감)
  function botPick(d, need, used, attack) {
    const hs = heads(need);
    const fresh = (m) => hs.flatMap((h) => m.get(h) || []).filter((w) => !used.has(w));
    const common = fresh(d.common), std = fresh(d.std);
    const safe = (w) => !isKiller(d, w, used);
    const short = (w) => w.length <= 3 && safe(w);
    if (!std.length) { // 표준어로 못 이으면 사전의 다른 명사(북한어·방언 등)라도
      const rest = fresh(d.all).filter((w) => d.kind.get(w) !== 'OLD' && !BOT_SKIP.has(w));
      return findRandom(rest, safe) || (rest.length ? pick(rest) : null);
    }
    if (attack && Math.random() < attack) {
      const k = findRandom(std, (w) => !safe(w));
      if (k) return k;
    }
    if (common.length && Math.random() < 0.85) { const w = findRandom(common, safe); if (w) return w; }
    return findRandom(std, short) || findRandom(std, safe) || findRandom(common, safe) || pick(std);
  }
  // 시작 단어: 자주 쓰는 2~3글자 단어 중 끝 글자로 이을 단어가 많은 것
  function startWord(d, used) {
    const list = [...d.common.values()].flat().filter((w) => w.length <= 3 && !(used && used.has(w)));
    const many = (w) => heads(lastOf(w)).reduce((n, h) => n + (d.std.get(h) || []).length, 0) >= 80;
    return findRandom(list, many) || findRandom([...d.std.values()].flat(), many);
  }
  // 힌트: 이을 수 있는 단어 하나를 골라 첫 글자 + 나머지 초성으로
  function hintWord(d, need, used) { return botPick(d, need, used, 0); }
  function mask(w) {
    return [...w].map((c, i) => (i === 0 ? c : CHO[Math.floor((c.charCodeAt(0) - 0xac00) / 588)])).join('');
  }

  // ───── 화면 문구 ─────
  function wordHTML(word, kind, who) {
    const tag = KIND_LABEL[kind] ? ` <span class="wc-tag">${KIND_LABEL[kind]}</span>` : '';
    return `<div class="wc-word">${who ? `<span class="wc-who">${esc(who)}</span>` : ''}${esc(word)}${tag}</div><div class="q-meta">다음 글자: <b>${needLabel(lastOf(word))}</b></div>`;
  }
  function rulesHTML(multi, time) {
    return `🔤 <b>끝말잇기</b> 시작!<br>`
      + `· <b>표준국어대사전</b>에 있는 <b>명사</b>만 (2글자 이상)<br>`
      + `· 두음법칙 OK (력→역, 름→늠) · 한 번 나온 단어는 다시 못 써요<br>`
      + `· 한 턴 제한시간 <b>${time ? time + '초' : '없음'}</b>`
      + (multi
        ? '<br>· 제일 먼저 이은 사람이 글자 수만큼 점수! 같은 사람이 연속으로는 못 이어요<br>· 아무도 못 잇게 만들거나 한방단어를 쓰면 <b>+5</b>'
        : '<br>· 봇이 못 이으면 내가 이겨요 (한방단어 노려보기 💥)')
      + `<br>· <code>/힌트</code> 초성 힌트 · <code>/${multi ? '패스' : '포기'}</code> · <code>/종료</code>`;
  }

  return { BOT_SKIP, KIND_LABEL, build, dueum, heads, lastOf, needLabel, cleanWord, isKiller, check, reasonText, botPick, startWord, hintWord, mask, wordHTML, rulesHTML };
});

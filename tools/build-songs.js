#!/usr/bin/env node
// 노래 추가 목록(js/songs-extra.js) 만들기 — iTunes 검색 API 인기순으로 가수마다 몇 곡씩
//
// 실행: node tools/build-songs.js
//   · 가수 목록: js/songs.js 의 ARTIST_EN (곡이 없는 가수도 여기 있으면 수집)
//   · 영어 제목의 한글 발음: tools/readings.json  { "LOVE DIVE": "러브 다이브" }
//     발음이 없는 영어 제목은 빼고, tools/readings-todo.txt 에 적어둬요
//   · iTunes 응답은 data/itunes-cache/ 에 저장 (다시 돌리면 빠름). iTunes는 1분에 20번 정도까지만 돼서 천천히 불러요
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Q = require('../js/quiz-core.js');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'data', 'itunes-cache');
const OUT = path.join(ROOT, 'js', 'songs-extra.js');
const READINGS = path.join(__dirname, 'readings.json');
const TODO = path.join(__dirname, 'readings-todo.txt');
const ADD_BIG = 7;   // 이미 10곡 이상 있는 가수는 7곡 추가
const ADD_SMALL = 9; // 나머지 가수
const ADD_NEW = 7;   // songs.js 에 곡이 없는 가수
const MIN_NEW = 3;   // 곡이 없는 가수는 iTunes에서 이만큼도 못 찾으면 뺌 (피처링·OST만 있는 경우)

const sb = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'songs.js'), 'utf8'), sb);
const W = sb.window;
const db = Q.buildDB(W.SONGS, W.ARTIST_ALIASES, W.ARTIST_EN);
const readings = fs.existsSync(READINGS) ? JSON.parse(fs.readFileSync(READINGS, 'utf8')) : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function itunes(url) {
  const file = path.join(CACHE, require('crypto').createHash('md5').update(url).digest('hex') + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let tries = 0; ; tries++) {
    const wait = lastCall + 3200 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const r = await fetch(url, { headers: { 'User-Agent': 'kpop-quiz-build/1.0' } }).catch(() => null);
    if (r && r.ok) {
      const j = await r.json();
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(j));
      return j;
    }
    if (tries >= 4) throw new Error(`iTunes 실패 (${r ? r.status : 'network'}): ${url}`);
    console.log(`  … iTunes ${r ? r.status : '연결 오류'}, 1분 쉬었다가 다시`);
    await sleep(60000);
  }
}

const SKIP_PAREN = /remix|mix\b|live|inst|ver\b|ver\.|version|edit\b|acoustic|demo|sped|slowed|remaster|karaoke|radio|english|japanese|chinese|extended|alternate|\bmr\b|a cappella|orchestra|piano|guitar|bonus/i;
const SKIP_TITLE = /^(intro|outro|interlude|skit|prologue|epilogue|inst|instrumental)\b|\b(inst\.?|instrumental|mr)$|버전|라이브|리믹스/i;
const JAPANESE = /[぀-ヿ]/;
const KANJI = /[一-鿿]/;
const KPOP = /k-?pop|korean/i;
const JPOP = /j-?pop|anime|japan/i;
// (feat. …) 같은 괄호 빼기. 빼고 나서 글자가 안 남으면 ("%%(응응)") 그대로
const stripParens = (t) => {
  const s = String(t).replace(/\s*[(\[][^)\]]*[)\]]/g, '').trim();
  return /[0-9A-Za-z가-힣]/.test(s) ? s : String(t).trim();
};
const hasLatin = (s) => /[A-Za-z]/.test(s);
// 끝에 짝 없이 붙은 괄호·따옴표 떼기 ('Make It Count, Pt. 1]"' → 'Make It Count, Pt. 1')
function tidyTitle(t) {
  let s = String(t).trim();
  const count = (ch) => [...s].filter((c) => ch.includes(c)).length;
  for (;;) {
    const last = s.slice(-1);
    if ('"“”'.includes(last) && count('"“”') % 2) s = s.slice(0, -1).trim();
    else if (last === ']' && count('[') < count(']')) s = s.slice(0, -1).trim();
    else if (last === ')' && count('(') < count(')')) s = s.slice(0, -1).trim();
    else return s;
  }
}

function badTrack(name) {
  if (JAPANESE.test(name) || KANJI.test(stripParens(name))) return true;
  if (SKIP_TITLE.test(stripParens(name))) return true;
  for (const m of String(name).matchAll(/[(\[]([^)\]]+)[)\]]/g)) if (SKIP_PAREN.test(m[1])) return true;
  return /\s[-–]\s.*(remix|ver|inst|live)/i.test(name);
}

async function collect(artist) {
  const en = W.ARTIST_EN[artist] || artist;
  const names = new Set([...Q.artistAnswers(artist, W.ARTIST_ALIASES), Q.norm(en)].filter(Boolean));
  // 이름이 같은 다른 가수(일본 LiSA, 록밴드 Rainbow 등)와 헷갈리지 않게 K-Pop 장르 곡이 있는 가수만
  const kpop = (t) => KPOP.test(t.primaryGenreName || '');
  function pickArtist(list) {
    const cnt = new Map();
    list.forEach((t) => { if (kpop(t)) cnt.set(t.artistId, (cnt.get(t.artistId) || 0) + 1); });
    const best = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? list.filter((t) => t.artistId === best[0]) : [];
  }
  const res = await itunes(`https://itunes.apple.com/search?entity=song&attribute=artistTerm&limit=100&term=${encodeURIComponent(en)}`);
  let mine = pickArtist((res.results || []).filter((t) => t.wrapperType === 'track' && names.has(Q.norm(t.artistName))));
  if (!mine.length) {
    // "god", "BoA" 처럼 흔한 이름은 다른 가수 곡에 묻힘 → 가수부터 찾고 그 가수 곡 목록
    for (const term of [...new Set([en, artist])]) {
      const a = await itunes(`https://itunes.apple.com/search?entity=musicArtist&limit=25&term=${encodeURIComponent(term)}`);
      for (const hit of (a.results || []).filter((x) => names.has(Q.norm(x.artistName)))) {
        const l = await itunes(`https://itunes.apple.com/lookup?entity=song&limit=200&id=${hit.artistId}`);
        mine = pickArtist((l.results || []).filter((t) => t.wrapperType === 'track' && t.artistId === hit.artistId));
        if (mine.length) break;
      }
      if (mine.length) break;
    }
  }
  if (!mine.length) return { error: 'iTunes에서 K-Pop 가수를 못 찾음' };
  const tracks = mine.filter((t) => !badTrack(t.trackName) && !JPOP.test(t.primaryGenreName || '') && t.releaseDate);
  if (!tracks.length) return { songs: [] };
  // 한국 스토어 제목 (한글 제목이 있으면 그걸 씀)
  const kr = await itunes(`https://itunes.apple.com/lookup?country=kr&id=${tracks.map((t) => t.trackId).join(',')}`);
  const krName = new Map((kr.results || []).filter((t) => t.wrapperType === 'track').map((t) => [t.trackId, t]));

  // 이미 있는 곡 (songs.js)
  const taken = new Set();
  (db.byArtist.get(artist) || []).forEach((s) => Q.songAnswers(s).forEach((a) => taken.add(a)));
  const have = (db.byArtist.get(artist) || []).map((s) => Q.norm(s.title.replace(/\(.*?\)/g, ''))).filter((x) => x.length >= 2);
  const out = new Map(); // key → song
  for (const t of tracks) {
    const k = krName.get(t.trackId);
    const krTitle = k && !badTrack(k.trackName) ? k.trackName : t.trackName;
    const title = tidyTitle(stripParens(krTitle) || krTitle);
    const usTitle = tidyTitle(stripParens(t.trackName) || t.trackName);
    const keys = [...Q.titleVariants(krTitle).keys, ...Q.titleVariants(t.trackName).keys];
    if (keys.some((x) => taken.has(x)) || taken.has(Q.norm(title))) continue;
    if (have.some((h) => Q.norm(title).startsWith(h))) continue; // "루비 : 슬픈 눈물" ↔ 이미 있는 "루비"
    const year = Math.min(...[t.releaseDate, k && k.releaseDate].filter(Boolean).map((d) => +String(d).slice(0, 4)));
    const key = Q.norm(title);
    if (out.has(key)) { const o = out.get(key); o.year = Math.min(o.year, year); continue; }
    keys.forEach((x) => taken.add(x));
    const alias = [];
    if (Q.norm(usTitle) !== key) alias.push(usTitle); // "좋은 날" ↔ "Good Day"
    out.set(key, { title, year, alias });
  }
  return { songs: [...out.values()] };
}

(async () => {
  const existing = [...db.byArtist.keys()];
  const fresh = Object.keys(W.ARTIST_EN).filter((a) => !db.byArtist.has(a));
  const rows = [], todo = new Set(), problems = [];
  const all = [...existing, ...fresh];
  for (let i = 0; i < all.length; i++) {
    const artist = all[i];
    const have = (db.byArtist.get(artist) || []).length;
    const want = !have ? ADD_NEW : have >= 10 ? ADD_BIG : ADD_SMALL;
    let r;
    try { r = await collect(artist); } catch (e) { r = { error: e.message }; }
    if (!r.error && !have && r.songs.length < MIN_NEW) r = { error: `곡이 ${r.songs.length}개뿐이라 뺌` };
    if (r.error) { problems.push(`${artist}: ${r.error}`); console.log(`[${i + 1}/${all.length}] ${artist} ✗ ${r.error}`); continue; }
    let added = 0;
    for (const s of r.songs) {
      if (added >= want) break;
      let reading = '';
      if (hasLatin(s.title)) {
        reading = readings[s.title];
        if (!reading) { todo.add(s.title); added++; continue; } // 발음 채우면 다음 실행 때 들어감
      }
      rows.push([s.title, reading, artist, s.year, s.alias]);
      added++;
    }
    console.log(`[${i + 1}/${all.length}] ${artist} +${added}`);
  }
  rows.sort((a, b) => a[3] - b[3]);
  const body = rows.map((r) => '  ' + JSON.stringify(r[4].length ? r : r.slice(0, 4)).replace(/,(?=["\d[])/g, ', ')).join(',\n');
  fs.writeFileSync(OUT, `// 추가 노래 — tools/build-songs.js 로 만든 파일이에요 (직접 고치지 말고 songs.js 에 넣으세요)
// iTunes 검색 인기순으로 가수마다 몇 곡씩 모았어요. 형식은 songs.js 와 같아요
window.SONGS_EXTRA = [
${body},
];
`);
  fs.writeFileSync(TODO, [...todo].join('\n') + '\n');
  console.log(`\n✅ ${rows.length}곡 → js/songs-extra.js`);
  if (todo.size) console.log(`⚠ 한글 발음이 없어서 뺀 영어 제목 ${todo.size}개 → tools/readings-todo.txt`);
  if (problems.length) console.log(`⚠ 못 가져온 가수 ${problems.length}팀:\n  ${problems.join('\n  ')}`);
})();

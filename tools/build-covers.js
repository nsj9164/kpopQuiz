#!/usr/bin/env node
// 자켓 퀴즈용 앨범 자켓 목록(js/covers.js) 만들기 — iTunes 앨범 이미지
//
// 실행: node tools/build-covers.js   (먼저 node tools/build-songs.js 를 돌려두면 캐시가 있어서 빨라요)
//   · 대표곡(songs.js)은 다 넣고, 추가곡(songs-extra.js)은 타이틀곡 같은 것만 (싱글이거나 앨범 이름이 곡 제목)
//   · 한 앨범에 우리 곡이 여러 개면 문제 하나로 합치고 그중 아무거나 맞혀도 정답
//   · iTunes 응답은 build-songs.js 와 같은 data/itunes-cache/ 에 저장
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const Q = require('../js/quiz-core.js');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'data', 'itunes-cache');
const OUT = path.join(ROOT, 'js', 'covers.js');

const sb = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'songs.js'), 'utf8'), sb);
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'songs-extra.js'), 'utf8'), sb);
const W = sb.window;
const db = Q.buildDB([...W.SONGS, ...W.SONGS_EXTRA], W.ARTIST_ALIASES, W.ARTIST_EN);
const CORE = W.SONGS.length; // db.songs 앞쪽이 대표곡

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
async function itunes(url) {
  const file = path.join(CACHE, crypto.createHash('md5').update(url).digest('hex') + '.json');
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

// 캐시에 있는 곡 전부 (앨범 이미지가 있는 것)
const byKey = new Map();
function addTrack(t) {
  if (t.wrapperType !== 'track' || !t.artworkUrl100 || !t.collectionId) return;
  for (const k of Q.titleVariants(t.trackName).keys) {
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
}
if (fs.existsSync(CACHE)) for (const f of fs.readdirSync(CACHE)) {
  try { (JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')).results || []).forEach(addTrack); } catch (e) { /* 깨진 캐시 무시 */ }
}

const artistNames = (a) => [...new Set([...Q.artistAnswers(a, W.ARTIST_ALIASES), Q.norm(W.ARTIST_EN[a])].filter((x) => x && x.length >= 2))];
// "ROSÉ & Bruno Mars", "IU (Feat. …)" 같은 표기도 같은 가수
const sameArtist = (t, names) => { const n = Q.norm(t.artistName); return names.some((x) => n === x || n.startsWith(x)); };
const BAD_ALBUM = /remix|live|japan|japanese|best|hits|greatest|collection|anniversary|repackage|instrumental|karaoke|\bost\b|music from|soundtrack|chinese|english|ver\.|version|special|concert|tour|edition|complete|selected|summer|winter|vol\.\s*\d+\s*-\s*/i;

function candidates(s) {
  const names = artistNames(s.artist);
  const keys = Q.songAnswers(s);
  const seen = new Set();
  return keys.flatMap((k) => byKey.get(k) || []).filter((t) => {
    if (seen.has(t.trackId + t.collectionId)) return false;
    seen.add(t.trackId + t.collectionId);
    return sameArtist(t, names);
  });
}
// 원래 앨범 고르기: 이상한 앨범(리믹스·베스트·일본판 등) 빼고, 발매 연도가 맞고, 제일 먼저 나온 것
function bestAlbum(s, list) {
  const score = (t) => {
    const y = +String(t.releaseDate || '').slice(0, 4) || 9999;
    return (BAD_ALBUM.test(t.collectionName) ? 100 : 0) + (y === s.year ? 0 : Math.min(Math.abs(y - s.year), 20) + 1) + (y / 10000);
  };
  return list.slice().sort((a, b) => score(a) - score(b))[0];
}
const stripAlbum = (n) => String(n).replace(/\s*-\s*(Single|EP)$/i, '').replace(/\s*[(\[][^)\]]*[)\]]/g, '').trim();

(async () => {
  const picked = new Map(); // song id → track
  let fetched = 0;
  for (const s of db.songs) {
    let c = candidates(s);
    if (!c.length && s.id < CORE) {
      // 캐시에 없는 대표곡 → 제목 + 가수로 검색
      const term = `${s.title.replace(/\(.*?\)/g, '').trim()} ${W.ARTIST_EN[s.artist] || s.artist}`;
      for (const country of ['kr', 'us']) { // 한국 스토어에 없는 곡도 있음
        try {
          const j = await itunes(`https://itunes.apple.com/search?entity=song&limit=25&country=${country}&term=${encodeURIComponent(term)}`);
          (j.results || []).forEach(addTrack);
          fetched++;
        } catch (e) { console.log(`  ✗ ${s.title}: ${e.message}`); }
        c = candidates(s);
        if (c.length) break;
      }
    }
    if (c.length) picked.set(s.id, bestAlbum(s, c));
  }

  // 앨범별로 묶기
  const albums = new Map(); // art → { songs: [], t }
  for (const s of db.songs) {
    const t = picked.get(s.id);
    if (!t) continue;
    const art = t.artworkUrl100.replace(/^https?:\/\//, '').replace(/\/[^/]*$/, '');
    if (!albums.has(art)) albums.set(art, { songs: [], t });
    albums.get(art).songs.push(s);
  }
  const rows = [];
  let skipped = 0;
  for (const [art, a] of albums) {
    const core = a.songs.filter((s) => s.id < CORE);
    // 추가곡만 있는 앨범은 타이틀곡처럼 보일 때만 (싱글이거나 앨범 이름 = 곡 제목)
    const titleLike = (s) => a.t.trackCount <= 3 || Q.songAnswers(s).some((k) => k.length >= 2 && Q.norm(stripAlbum(a.t.collectionName)).startsWith(k));
    const main = core.length ? core : a.songs.filter(titleLike);
    if (!main.length) { skipped++; continue; }
    const s = main[0];
    rows.push([s.title, s.artist, art, main.slice(1).map((x) => x.title)]);
  }
  rows.sort((x, y) => x[1].localeCompare(y[1]) || x[0].localeCompare(y[0]));
  fs.writeFileSync(OUT, `// 자켓 퀴즈 앨범 자켓 목록 — tools/build-covers.js 로 만든 파일이에요 (직접 고치지 마세요)
// [곡 제목, 가수, 앨범 이미지 주소 (https:// 와 /크기.jpg 뺀 것), 같은 앨범의 다른 정답 곡]
// 이미지: iTunes / Apple Music 앨범 아트
window.COVERS = [
${rows.map((r) => '  ' + JSON.stringify(r[3].length ? r : r.slice(0, 3))).join(',\n')},
];
`);
  const coreMissing = W.SONGS.filter((r, i) => !picked.has(i)).map((r) => `${r[0]}/${r[2]}`);
  console.log(`✅ 자켓 ${rows.length}장 → js/covers.js (새로 검색 ${fetched}번, 수록곡만 있는 앨범 ${skipped}개 뺌)`);
  if (coreMissing.length) console.log(`⚠ 자켓을 못 찾은 대표곡 ${coreMissing.length}곡: ${coreMissing.join(', ')}`);
})();

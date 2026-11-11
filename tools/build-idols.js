#!/usr/bin/env node
// 얼굴 퀴즈용 아이돌 사진 목록(js/idols.js) 만들기 — 위키데이터(멤버·이름) + 위키미디어 공용(사진)
//
// 실행: node tools/build-idols.js
//   · 가수 목록: js/songs.js + js/songs-extra.js 에 나오는 가수 (그룹이면 멤버, 솔로면 본인)
//   · 이름 고치기: tools/idol-names.json  { "김남준": "RM" }  (위키데이터 이름 → 게임에 보일 이름)
//   · 응답은 data/wikidata-cache/ 에 저장 (다시 돌리면 빠름)
//   · 사진은 공용(Commons)의 자유 라이선스 사진이라 출처(찍은 사람·라이선스)를 같이 저장해서 정답 공개 때 보여줘요
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const Q = require('../js/quiz-core.js');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'data', 'wikidata-cache');
const OUT = path.join(ROOT, 'js', 'idols.js');
const NAMES = path.join(__dirname, 'idol-names.json');
const UA = 'kpop-quiz-build/1.0 (https://github.com/nsj9164/kpopQuiz)';
const THUMB = 500; // 사진 폭 (공용 표준 썸네일 크기)

const sb = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'songs.js'), 'utf8'), sb);
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'songs-extra.js'), 'utf8'), sb);
const W = sb.window;
const db = Q.buildDB([...W.SONGS, ...W.SONGS_EXTRA], W.ARTIST_ALIASES, W.ARTIST_EN);
const rename = fs.existsSync(NAMES) ? JSON.parse(fs.readFileSync(NAMES, 'utf8')) : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, body) {
  const file = path.join(CACHE, crypto.createHash('md5').update(url + (body || '')).digest('hex') + '.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  for (let tries = 0; ; tries++) {
    const r = await fetch(url, body
      ? { method: 'POST', body, headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' } }
      : { headers: { 'User-Agent': UA, Accept: 'application/json' } }).catch(() => null);
    if (r && r.ok) {
      const j = await r.json();
      fs.mkdirSync(CACHE, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(j));
      await sleep(500);
      return j;
    }
    if (tries >= 3) throw new Error(`요청 실패 (${r ? r.status : 'network'}): ${url}`);
    await sleep(5000 * (tries + 1));
  }
}
const sparql = async (q) => (await getJSON('https://query.wikidata.org/sparql', 'query=' + encodeURIComponent(q))).results.bindings;
const val = (b, k) => (b[k] ? b[k].value : '');
const qid = (uri) => String(uri).split('/').pop();
const split = (s) => (s ? s.split('|').filter(Boolean) : []);
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const lit = (s) => JSON.stringify(String(s));

// 가수 이름으로 찾을 때 쓸 표기들
function namesOf(artist) {
  return new Set([...Q.artistAnswers(artist, W.ARTIST_ALIASES), Q.norm(W.ARTIST_EN[artist])].filter((x) => x && x.length >= 2));
}

(async () => {
  const artists = [...db.byArtist.keys()];

  // 1) 한국 그룹 (사람 멤버가 있는 것) 이름 전부
  const groupRows = await sparql(`SELECT ?g ?l WHERE {
    { ?g wdt:P495 wd:Q884 } UNION { ?g wdt:P17 wd:Q884 } UNION { ?g wdt:P136 wd:Q213665 }
    { ?g wdt:P527 ?m } UNION { ?m wdt:P463 ?g }
    ?m wdt:P31 wd:Q5 .
    ?g rdfs:label|skos:altLabel ?l FILTER(lang(?l) = "en" || lang(?l) = "ko")
  }`);
  const groupNames = new Map(); // qid → Set(norm 이름)
  groupRows.forEach((b) => {
    const id = qid(val(b, 'g'));
    if (!groupNames.has(id)) groupNames.set(id, new Set());
    groupNames.get(id).add(Q.norm(val(b, 'l')));
  });

  // 2) 우리 가수 ↔ 그룹 연결
  const groupOf = new Map(); // artist → qid
  for (const a of artists) {
    const names = namesOf(a);
    const hits = [...groupNames].filter(([, s]) => [...s].some((x) => names.has(x))).map(([id]) => id);
    if (hits.length) groupOf.set(a, hits);
  }

  // 3) 그룹 멤버 + 이름·별명·사진
  const people = new Map(); // 사람 qid → { ko, en, alts:Set, img, groups:Set(artist) }
  const addPerson = (b, artist) => {
    const id = qid(val(b, 'm'));
    const p = people.get(id) || { id, ko: val(b, 'ko'), en: val(b, 'en'), alts: new Set(), img: val(b, 'img'), groups: [] };
    split(val(b, 'alts')).forEach((x) => p.alts.add(x));
    if (!p.img) p.img = val(b, 'img');
    if (!p.groups.includes(artist)) p.groups.push(artist);
    people.set(id, p);
  };
  const MEMBER_FIELDS = `
    OPTIONAL { ?m rdfs:label ?ko FILTER(lang(?ko) = "ko") }
    OPTIONAL { ?m rdfs:label ?en FILTER(lang(?en) = "en") }
    OPTIONAL { ?m skos:altLabel|wdt:P742|wdt:P1449 ?alt FILTER(lang(?alt) = "ko" || lang(?alt) = "en" || lang(?alt) = "") }
    OPTIONAL { ?m wdt:P18 ?img }`;
  const allGroups = [...new Set([...groupOf.values()].flat())];
  const memberOf = new Map(); // 그룹 qid → [rows]
  for (const part of chunks(allGroups, 40)) {
    const rows = await sparql(`SELECT ?g ?m ?ko ?en (GROUP_CONCAT(DISTINCT ?alt; separator="|") AS ?alts) (SAMPLE(?img) AS ?img) WHERE {
      VALUES ?g { ${part.map((g) => 'wd:' + g).join(' ')} }
      { ?g wdt:P527 ?m } UNION { ?m wdt:P463 ?g }
      ?m wdt:P31 wd:Q5 . ${MEMBER_FIELDS}
    } GROUP BY ?g ?m ?ko ?en`);
    rows.forEach((b) => { const g = qid(val(b, 'g')); if (!memberOf.has(g)) memberOf.set(g, []); memberOf.get(g).push(b); });
  }
  for (const [artist, gs] of groupOf) {
    // 이름이 같은 그룹이 여럿이면 멤버 많은 쪽
    const g = gs.sort((x, y) => (memberOf.get(y) || []).length - (memberOf.get(x) || []).length)[0];
    (memberOf.get(g) || []).forEach((b) => addPerson(b, artist));
  }

  // 4) 그룹으로 못 찾은 가수 = 솔로 → 사람 찾기 (한국 국적 or K-pop 장르)
  const solo = artists.filter((a) => !groupOf.has(a));
  const labels = new Map(); // 표기 → artist
  solo.forEach((a) => [a, W.ARTIST_EN[a], ...((W.ARTIST_ALIASES || {})[a] || [])].filter(Boolean).forEach((x) => labels.set(String(x), a)));
  const soloFound = new Map(); // artist → [{b, kpop}]
  for (const part of chunks([...labels.keys()], 60)) {
    const values = part.flatMap((x) => [`${lit(x)}@ko`, `${lit(x)}@en`]).join(' ');
    const rows = await sparql(`SELECT ?l ?m ?ko ?en (GROUP_CONCAT(DISTINCT ?alt; separator="|") AS ?alts) (SAMPLE(?img) AS ?img) (SAMPLE(?k) AS ?kpop) WHERE {
      VALUES ?l { ${values} }
      ?m rdfs:label|skos:altLabel|wdt:P742 ?l ; wdt:P31 wd:Q5 .
      { ?m wdt:P27 wd:Q884 } UNION { ?m wdt:P136 wd:Q213665 }
      ?m wdt:P106 ?job . VALUES ?job { wd:Q177220 wd:Q2252262 wd:Q639669 wd:Q753110 wd:Q488205 wd:Q855091 wd:Q5716684 }
      OPTIONAL { ?m wdt:P136 ?k FILTER(?k = wd:Q213665) }
      ${MEMBER_FIELDS}
    } GROUP BY ?l ?m ?ko ?en`);
    rows.forEach((b) => {
      const a = labels.get(val(b, 'l'));
      if (!a) return;
      if (!soloFound.has(a)) soloFound.set(a, []);
      soloFound.get(a).push(b);
    });
  }
  const missing = [];
  for (const a of solo) {
    const c = (soloFound.get(a) || []).filter((b) => val(b, 'img'));
    // K-pop 장르 > 이름 표기가 정확히 같은 사람
    const best = c.sort((x, y) => (val(y, 'kpop') ? 1 : 0) - (val(x, 'kpop') ? 1 : 0))[0];
    if (best) addPerson(best, a); else missing.push(a);
  }

  // 5) 사진 → 썸네일 주소 + 출처
  const files = [...new Set([...people.values()].map((p) => p.img).filter(Boolean).map((u) => decodeURIComponent(u.split('/').pop())))];
  const info = new Map();
  for (const part of chunks(files, 40)) {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata|size&iiextmetadatafilter=Artist|LicenseShortName&iiurlwidth=${THUMB}&titles=` +
      encodeURIComponent(part.map((f) => 'File:' + f).join('|'));
    const j = await getJSON(url);
    const norm = new Map(((j.query && j.query.normalized) || []).map((n) => [n.to, n.from]));
    Object.values((j.query && j.query.pages) || {}).forEach((pg) => {
      const ii = pg.imageinfo && pg.imageinfo[0];
      if (!ii) return;
      const md = ii.extmetadata || {};
      const artist = String((md.Artist || {}).value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const lic = String((md.LicenseShortName || {}).value || '').trim();
      const name = (norm.get(pg.title) || pg.title).replace(/^File:/, '');
      info.set(name, { thumb: String(ii.thumburl || '').replace(/\?.*$/, ''), w: ii.thumbwidth, h: ii.thumbheight, credit: [artist, lic].filter(Boolean).join(' · ') });
    });
  }

  // 6) 보일 이름 / 정답 표기
  const H = /^[가-힣]+$/;
  const SURNAME = '김이박최정강조윤장임한오서신권황안송류유전홍고문양손배백허남심노하곽성차주우구민진엄채원천방공현함변염여도석설';
  const rows = [], review = [];
  for (const p of people.values()) {
    const file = p.img && decodeURIComponent(p.img.split('/').pop());
    const im = file && info.get(file);
    if (!im || !im.thumb) continue;
    const alts = [...p.alts].filter((x) => x && !/[一-鿿぀-ヿ]/.test(x));
    let name = p.ko || p.en;
    if (!name) continue;
    // "제니 김" → "제니", "나오이 레이" → "레이" (별명에 같은 게 있으면)
    if (/\s/.test(name)) { const tok = name.split(/\s+/).find((t) => alts.includes(t)); if (tok) name = tok; }
    if (rename[name]) name = rename[name];
    else if (H.test(p.ko) && p.ko.length === 3 && p.en && !/[\s-]/.test(p.en)) review.push(`${p.ko} (${p.en}) - ${p.groups.join(',')}`);
    const answers = new Set([name, p.ko, p.en, ...alts].filter(Boolean));
    // "장원영" → "원영" 도 정답 (성으로 시작하는 세 글자 이름만. "아이유" → "이유" 는 안 됨)
    [name, p.ko].forEach((n) => { if (n && H.test(n) && n.length === 3 && SURNAME.includes(n[0])) answers.add(n.slice(1)); });
    const ans = [...new Set([...answers].map(Q.norm).filter((x) => x.length >= 1))].filter((x) => x !== Q.norm(name));
    rows.push([name, p.groups.join('|'), im.thumb, ans, im.credit]);
  }
  rows.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));

  const body = rows.map((r) => '  ' + JSON.stringify(r)).join(',\n');
  fs.writeFileSync(OUT, `// 얼굴 퀴즈 사진 목록 — tools/build-idols.js 로 만든 파일이에요 (직접 고치지 마세요)
// [보일 이름, 가수(여럿이면 |), 사진 주소, 정답으로 인정할 표기(norm), 사진 출처]
// 이름·사진: 위키데이터(CC0) / 사진: 위키미디어 공용 (각 사진의 라이선스는 출처 칸)
window.IDOLS = [
${body},
];
`);
  const by = new Map();
  rows.forEach((r) => r[1].split('|').forEach((g) => by.set(g, (by.get(g) || 0) + 1)));
  console.log(`✅ ${rows.length}명 (${by.size}팀) → js/idols.js`);
  const none = artists.filter((a) => !by.has(a));
  if (none.length) console.log(`⚠ 사진을 못 찾은 가수 ${none.length}팀: ${none.join(', ')}`);
  if (review.length) console.log(`\n본명일 수도 있는 이름 (예명으로 바꾸려면 tools/idol-names.json):\n  ${review.join('\n  ')}`);
})();

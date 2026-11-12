#!/usr/bin/env node
// 아직 목록에 없는 K-pop 가수 후보 찾기 — 위키데이터 (장르 K-pop, 한국 그룹·가수, 위키 문서 많은 순)
//
// 실행: node tools/find-artists.js [최소 문서 수=15]
//   · 결과를 보고 넣을 가수를 js/songs.js 의 ARTIST_EN(영어 이름)과 ARTIST_ALIASES(다른 이름)에 직접 추가
//   · 그다음 node tools/build-songs.js 로 노래 수집 (iTunes에서 곡을 3개도 못 찾은 가수는 자동으로 빠짐)
//   · 솔로 후보에는 솔로 활동이 거의 없는 그룹 멤버나 배우도 섞여 있어서 사람이 골라야 해요
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Q = require('../js/quiz-core.js');

const ROOT = path.join(__dirname, '..');
const UA = 'kpop-quiz-build/1.0 (https://github.com/nsj9164/kpopQuiz)';
const MIN_LINKS = parseInt(process.argv[2], 10) || 15;

const sb = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js', 'songs.js'), 'utf8'), sb);
const W = sb.window;
// 이미 있는 가수의 모든 표기
const known = new Set(Object.keys(W.ARTIST_EN).flatMap((a) => [...Q.artistAnswers(a, W.ARTIST_ALIASES), Q.norm(W.ARTIST_EN[a])]));

const query = `SELECT ?a ?ko ?en ?links ?kind (MIN(?y) AS ?year) WHERE {
  ?a wdt:P136 wd:Q213665 .
  { ?a wdt:P31 wd:Q5 . ?a wdt:P27 wd:Q884 . BIND("솔로" AS ?kind) }
  UNION { ?a wdt:P31/wdt:P279* wd:Q215380 . { ?a wdt:P495 wd:Q884 } UNION { ?a wdt:P17 wd:Q884 } BIND("그룹" AS ?kind) }
  ?a wikibase:sitelinks ?links . FILTER(?links >= ${MIN_LINKS})
  ?a rdfs:label ?ko FILTER(lang(?ko) = "ko")
  OPTIONAL { ?a rdfs:label ?en FILTER(lang(?en) = "en") }
  OPTIONAL { ?a wdt:P2031 ?s . BIND(YEAR(?s) AS ?y) }
} GROUP BY ?a ?ko ?en ?links ?kind ORDER BY DESC(?links)`;

(async () => {
  const r = await fetch('https://query.wikidata.org/sparql', {
    method: 'POST',
    body: 'query=' + encodeURIComponent(query),
    headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!r.ok) throw new Error('위키데이터 요청 실패: ' + r.status);
  const rows = (await r.json()).results.bindings;
  const seen = new Set();
  const out = [];
  for (const b of rows) {
    const id = b.a.value.split('/').pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const ko = b.ko.value.replace(/\s*\(.*?\)\s*/g, '').trim(); // "우현 (가수)" → "우현"
    const en = b.en ? b.en.value : '';
    if (known.has(Q.norm(ko)) || (en && known.has(Q.norm(en)))) continue;
    out.push(`${String(b.links.value).padStart(3)}  ${b.kind.value}  ${b.year ? b.year.value : '    '}  ${ko}${en ? '  (' + en + ')' : ''}`);
  }
  console.log(`문서 ${MIN_LINKS}개 이상, 아직 없는 가수 ${out.length}명/팀 (문서 수 · 구분 · 데뷔 · 이름)\n`);
  console.log(out.join('\n'));
})().catch((e) => { console.error(e.message); process.exit(1); });

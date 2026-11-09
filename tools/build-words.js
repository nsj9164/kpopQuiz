#!/usr/bin/env node
// 끝말잇기 사전(js/words.js) 만들기
//
// 원본 데이터 (국립국어원 표준국어대사전 표제어, 2018년 수집본)
//   1) kr_korean.csv  — https://github.com/korean-word-game/db  (낱말,품사 / 동음이의어 전부 들어 있음)
//   2) korean_dictionary1.json, korean_dictionary2.json — https://github.com/acidsound/korean_wordlist
//      (뜻풀이 포함. 북한어·방언·옛말·고유명사 구분에 사용)
//   3) ko_50k.txt (선택) — https://github.com/hermitdave/FrequencyWords (봇이 쉬운 단어를 먼저 쓰게 하는 용도)
//
// 실행: node tools/build-words.js <원본 폴더>   → js/words.js 생성
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
if (!SRC) { console.error('사용법: node tools/build-words.js <원본 폴더>'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'js', 'words.js');
const file = (n) => [path.join(SRC, n), path.join(SRC, 'kr', n)].find((p) => fs.existsSync(p));

const ok = (w) => /^[가-힣]{2,}$/.test(w);
const clean = (w) => String(w).replace(/[-^ ]/g, '');

// 1) CSV: 명사 표제어 + 동음이의어 개수
const csvCnt = new Map();
for (const line of fs.readFileSync(file('kr_korean.csv'), 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
  const i = line.lastIndexOf(',');
  if (i < 0) continue;
  const w = clean(line.slice(0, i));
  if (line.slice(i + 1).trim() === '명사' && ok(w)) csvCnt.set(w, (csvCnt.get(w) || 0) + 1);
}

// 2) JSON: 품사 바로 옆에 붙은 [북한어]/[방언]/[옛말], 《인명》/《지명》/《책명》 표시로 구분
const jsonKind = new Map(); // word → STD | NAME | NK | DIAL | OLD | null(명사 아님)
for (const n of ['korean_dictionary1.json', 'korean_dictionary2.json']) {
  for (const line of fs.readFileSync(file(n), 'utf8').split('\n')) {
    const m = line.match(/^\{'word': (['"])(.*?)\1, 'raw': /);
    if (!m) continue;
    const w = clean(m[2]);
    if (!ok(w)) continue;
    const runs = line.match(/(?:<FONT[^>]*>[［《][^］》]*[］》]<\/FONT>\s*)+/g) || [];
    const run = runs.find((r) => r.includes('［명사］'));
    if (!run) { if (!jsonKind.has(w)) jsonKind.set(w, null); continue; }
    jsonKind.set(w,
      run.includes('［옛말］') ? 'OLD'
        : run.includes('［북한어］') ? 'NK'
          : run.includes('［방언］') ? 'DIAL'
            : /《(인명|지명|책명)》/.test(run) ? 'NAME' : 'STD');
  }
}

// 합치기: 동음이의어가 2개 이상이면 표준어 명사로 봄 (JSON 쪽은 동음이의어 중 하나만 남아 있음)
const kind = new Map();
for (const [w, c] of csvCnt) { const k = jsonKind.get(w); kind.set(w, k && c < 2 ? k : 'STD'); }
for (const [w, k] of jsonKind) if (k && !kind.has(w)) kind.set(w, k);

const groups = { STD: [], NAME: [], NK: [], DIAL: [], OLD: [] };
for (const [w, k] of kind) groups[k].push(w);
for (const k in groups) groups[k].sort();

// 3) 자주 쓰는 표준어 명사 (자막 빈도순). 활용형과 겹치는 것(내가, 거야, 보여 …)은 최대한 거름
const common = [];
const freq = file('ko_50k.txt');
if (freq) {
  const std = new Set(groups.STD);
  const END = new Set([...'가야요고서지면도은는이을를게다나니자죠네래데랑건린걸든며써거겠까냐넌날만와에의께해했줘봐라려군구아어여한운인']);
  const NOT = new Set(('우리 여기 저기 거기 이리 저리 이제 지금 정말 진짜 아주 아직 모두 어서 위해 대해 바로 근데 이거 그거 저거 계속 제발 어디 '
    + '잠깐 가장 이미 절대 당장 전부 자기 아무 아마 혹시 그냥 다음 먼저 나중 이번 항상 별로 완전 정도 더욱 조금 만큼 마치 사실 보통 진심 '
    + '너무 다시 만약 방금 대체 물론 직접 언제 제일 지난 서로 매우 일단 매일 대신 금방 결국 그때 스스로 얼른 대로 분명 역시 잠시 번째 '
    + '만난 가질 아파 미리 즉시 오직 우선 보기 위로 '
    + '멀리 점점 얼마 자주 약간 자꾸 와우 다신 설마 일로 내내 최대한 오랫동안 저희 당신 미안 안녕 한번 하기 상관 이상 보고 위한 관한 '
    // 자막에서 온 사람 이름 · 회사에서 봇이 말하기 곤란한 단어
    + '제임스 헨리 로스 데릭 찰리 마크 셰퍼드 루시퍼 라파엘 리브 노바 조조 루피 미스터 '
    + '섹스 콘돔 새끼 쥐새끼 개새끼 호모 마약 창녀 매춘 강간 자살 살인 시체 변태 성교 정액 음경').split(' '));
  for (const line of fs.readFileSync(freq, 'utf8').split(/\r?\n/)) {
    const w = line.split(' ')[0];
    if (std.has(w) && jsonKind.get(w) !== 'NAME' && !END.has(w.slice(-1)) && !NOT.has(w) && common.length < 6000) common.push(w);
  }
}

const js = `// 끝말잇기 단어 사전 — tools/build-words.js 로 만든 파일이에요 (직접 고치지 마세요)
// 출처: 국립국어원 표준국어대사전 표제어 중 명사 (2글자 이상, 한글만 / 2018년 수집본)
//   https://github.com/korean-word-game/db · https://github.com/acidsound/korean_wordlist
//   자주 쓰는 단어 순서: https://github.com/hermitdave/FrequencyWords (MIT)
// STD 표준어 · NAME 고유명사(인명·지명·책명) · NK 북한어 · DIAL 방언 · OLD 옛말 · COMMON 자주 쓰는 STD
window.WORD_DICT = {
${Object.entries({ ...groups, COMMON: common }).map(([k, v]) => `  ${k}: ${JSON.stringify(v.join(' '))},`).join('\n')}
};
`;
fs.writeFileSync(OUT, js);
console.log(Object.entries({ ...groups, COMMON: common }).map(([k, v]) => `${k} ${v.length}`).join(' · '));
console.log(`→ ${path.relative(process.cwd(), OUT)} (${(Buffer.byteLength(js) / 1048576).toFixed(1)}MB)`);

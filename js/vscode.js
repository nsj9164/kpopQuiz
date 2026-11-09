// VS Code 처럼 보이는 껍데기: 파일 트리, 탭, 코드 하이라이트, 터미널, 숨김 키
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('kq.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('kq.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  // ───── 가짜 파일 읽기 ─────
  const FILES = {};
  document.querySelectorAll('script[type="text/plain"][data-file]').forEach((s) => {
    FILES[s.dataset.file] = s.textContent.replace(/^\r?\n/, '').replace(/\s+$/, '');
  });
  const GIT = {
    'src/orders/orders.service.ts': 'M',
    'src/orders/orders.controller.ts': 'M',
    'src/orders/dto/cancel-order.dto.ts': 'U',
  };
  const EMPTY_DIRS = ['dist', 'node_modules', 'test'];
  const IGNORED = new Set(['dist', 'node_modules']);

  // 트리 구성
  function buildTree() {
    const root = { name: '', path: '', dirs: {}, files: [] };
    const ensureDir = (parts) => {
      let node = root;
      parts.forEach((p, i) => {
        if (!node.dirs[p]) node.dirs[p] = { name: p, path: parts.slice(0, i + 1).join('/'), dirs: {}, files: [] };
        node = node.dirs[p];
      });
      return node;
    };
    EMPTY_DIRS.forEach((d) => ensureDir([d]));
    Object.keys(FILES).forEach((path) => {
      const parts = path.split('/');
      const file = parts.pop();
      ensureDir(parts).files.push({ name: file, path });
    });
    return root;
  }
  const TREE = buildTree();

  const state = {
    open: ['src/orders/orders.service.ts', 'src/orders/orders.controller.ts', 'package.json'],
    active: 'src/orders/orders.service.ts',
    expanded: new Set(['src', 'src/orders', 'src/common', 'src/common/utils']),
    cursor: {},
  };

  function langOf(p) {
    if (/\.ts$/.test(p)) return 'ts';
    if (/\.json$/.test(p)) return 'json';
    if (/\.ya?ml$/.test(p)) return 'yaml';
    if (/\.md$/.test(p)) return 'md';
    if (/\.env/.test(p)) return 'env';
    return 'plain';
  }
  const LANG_NAME = { ts: '{ } TypeScript', json: '{ } JSON', yaml: 'YAML', md: 'Markdown', env: 'Properties', plain: 'Ignore' };
  function fileIcon(name) {
    if (/\.ts$/.test(name)) return '<span class="fi" style="color:#3178c6">TS</span>';
    if (/\.json$/.test(name)) return '<span class="fi" style="color:#cbcb41">{}</span>';
    if (/\.ya?ml$/.test(name)) return '<span class="fi" style="color:#a074c4">!</span>';
    if (/\.md$/.test(name)) return '<span class="fi" style="color:#519aba">M↓</span>';
    if (/^\.env/.test(name)) return '<span class="fi" style="color:#e5c07b">⚙</span>';
    if (/^\.git/.test(name)) return '<span class="fi" style="color:#41535b">◆</span>';
    return '<span class="fi" style="color:#999">≡</span>';
  }

  // ───── 탐색기 ─────
  function renderTree() {
    const out = [];
    const walk = (node, depth) => {
      const dirs = Object.values(node.dirs).sort((a, b) => a.name.localeCompare(b.name));
      const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
      dirs.forEach((d) => {
        const open = state.expanded.has(d.path);
        const hasMod = Object.keys(GIT).some((p) => p.startsWith(d.path + '/'));
        const cls = (IGNORED.has(d.path) ? ' ign' : '') + (hasMod ? ' mod' : '');
        out.push(`<div class="ti${cls}" data-dir="${d.path}" style="padding-left:${depth * 12 + 4}px"><span class="chev">${open ? '⌄' : '›'}</span><span class="nm">${esc(d.name)}</span>${hasMod ? '<span class="git">●</span>' : ''}</div>`);
        if (open) walk(d, depth + 1);
      });
      files.forEach((f) => {
        const g = GIT[f.path];
        const cls = (g === 'M' ? ' mod' : g === 'U' ? ' untr' : '') + (f.path === state.active ? ' sel focus' : '');
        out.push(`<div class="ti${cls}" data-file="${f.path}" style="padding-left:${depth * 12 + 20}px">${fileIcon(f.name)}<span class="nm">${esc(f.name)}</span>${g ? `<span class="git">${g}</span>` : ''}</div>`);
      });
    };
    walk(TREE, 0);
    $('#tree').innerHTML = out.join('');
  }
  $('#tree').addEventListener('click', (e) => {
    const el = e.target.closest('.ti');
    if (!el) return;
    if (el.dataset.dir) {
      const p = el.dataset.dir;
      state.expanded.has(p) ? state.expanded.delete(p) : state.expanded.add(p);
      renderTree();
    } else if (el.dataset.file) openFile(el.dataset.file);
  });

  // ───── 탭 ─────
  function renderTabs() {
    $('#tabs').innerHTML = state.open.map((p) => {
      const name = p.split('/').pop();
      const cls = (p === state.active ? ' on' : '') + (GIT[p] === 'M' ? ' mod' : '');
      return `<div class="tab${cls}" data-file="${p}">${fileIcon(name)}<span class="nm">${esc(name)}</span><span class="x" data-close="${p}">×</span></div>`;
    }).join('');
  }
  $('#tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) { closeFile(close.dataset.close); return; }
    const t = e.target.closest('.tab');
    if (t) openFile(t.dataset.file);
  });
  $('#tabs').addEventListener('auxclick', (e) => {
    const t = e.target.closest('.tab');
    if (t && e.button === 1) closeFile(t.dataset.file);
  });

  function openFile(p) {
    if (!FILES[p]) return;
    if (!state.open.includes(p)) state.open.push(p);
    state.active = p;
    p.split('/').slice(0, -1).reduce((acc, part) => { const q = acc ? acc + '/' + part : part; state.expanded.add(q); return q; }, '');
    renderAll();
  }
  function closeFile(p) {
    const i = state.open.indexOf(p);
    if (i < 0) return;
    state.open.splice(i, 1);
    if (state.active === p) state.active = state.open[Math.max(0, i - 1)] || null;
    renderAll();
  }

  // ───── 하이라이터 ─────
  const CTRL = new Set('import export from return if else for while do switch case break continue throw try catch finally await default new of in as'.split(' '));
  const KW = new Set('const let var function class extends implements interface type enum public private protected readonly static this super null undefined true false void typeof instanceof keyof declare abstract async get set'.split(' '));
  const TYPES = new Set('number string boolean any unknown never object'.split(' '));
  const sp = (c, t) => `<span class="${c}">${esc(t)}</span>`;

  function hlTS(src) {
    let depth = 0, inBlock = false;
    return src.split('\n').map((line) => {
      if (inBlock || /^\s*\/\*/.test(line)) { inBlock = !/\*\//.test(line); return sp('cm', line); }
      const re = /(\/\/.*$)|(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(@[A-Za-z_]\w*)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([()[\]{}])/g;
      let out = '', last = 0, m;
      while ((m = re.exec(line))) {
        out += esc(line.slice(last, m.index));
        const tok = m[0];
        if (m[1]) out += sp('cm', tok);
        else if (m[2]) out += sp('s', tok);
        else if (m[3]) out += sp('f', tok);
        else if (m[4]) out += sp('n', tok);
        else if (m[5]) {
          const after = line.slice(m.index + tok.length);
          let cls;
          if (CTRL.has(tok)) cls = 'c';
          else if (KW.has(tok)) cls = 'k';
          else if (TYPES.has(tok)) cls = 't';
          else if (/^[A-Z][A-Z0-9_]+$/.test(tok)) cls = 'cst';
          else if (/^[A-Z]/.test(tok)) cls = 't';
          else if (/^\s*\(/.test(after) || /^\s*=\s*(async\s*)?\(/.test(after) && /const|let/.test(line.slice(0, m.index))) cls = 'f';
          else cls = 'v';
          out += sp(cls, tok);
        } else if (m[6]) {
          if ('([{'.includes(tok)) { out += sp('b' + (depth % 3 + 1), tok); depth++; }
          else { depth = Math.max(0, depth - 1); out += sp('b' + (depth % 3 + 1), tok); }
        }
        last = re.lastIndex;
      }
      return out + esc(line.slice(last));
    });
  }
  function hlJSON(src) {
    let depth = 0;
    return src.split('\n').map((line) => {
      const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?\b)|\b(true|false|null)\b|([{}[\]])/g;
      let out = '', last = 0, m;
      while ((m = re.exec(line))) {
        out += esc(line.slice(last, m.index));
        if (m[1]) out += sp(m[2] ? 'v' : 's', m[1]) + (m[2] ? esc(m[2]) : '');
        else if (m[3]) out += sp('n', m[3]);
        else if (m[4]) out += sp('k', m[4]);
        else if (m[5]) {
          if ('[{'.includes(m[5])) { out += sp('b' + (depth % 3 + 1), m[5]); depth++; }
          else { depth = Math.max(0, depth - 1); out += sp('b' + (depth % 3 + 1), m[5]); }
        }
        last = re.lastIndex;
      }
      return out + esc(line.slice(last));
    });
  }
  function hlYAML(src) {
    return src.split('\n').map((line) => {
      if (/^\s*#/.test(line)) return sp('cm', line);
      const m = line.match(/^(\s*-?\s*)([\w.-]+)(:)(.*)$/);
      if (m) return esc(m[1]) + sp('k', m[2]) + esc(m[3]) + yamlVal(m[4]);
      const li = line.match(/^(\s*-\s*)(.*)$/);
      if (li) return esc(li[1]) + yamlVal(li[2]);
      return esc(line);
    });
  }
  function yamlVal(v) {
    if (!v.trim()) return esc(v);
    if (/^\s*\d+(\.\d+)?\s*$/.test(v)) return sp('n', v);
    return sp('s', v);
  }
  function hlMD(src) {
    let fence = false;
    return src.split('\n').map((line) => {
      if (/^```/.test(line)) { fence = !fence; return sp('cm', line); }
      if (fence) return sp('s', line);
      if (/^#{1,6}\s/.test(line)) return sp('h', line);
      let html = esc(line).replace(/`([^`]+)`/g, '<span class="s">`$1`</span>');
      html = html.replace(/^(\s*)([-*])(\s)/, '$1<span class="k">$2</span>$3');
      return html;
    });
  }
  function hlENV(src) {
    return src.split('\n').map((line) => {
      if (/^\s*#/.test(line)) return sp('cm', line);
      const m = line.match(/^([\w.]+)(=)(.*)$/);
      return m ? sp('v', m[1]) + esc(m[2]) + sp('s', m[3]) : esc(line);
    });
  }
  function hlPlain(src) {
    return src.split('\n').map((line) => (/^\s*#/.test(line) ? sp('cm', line) : esc(line)));
  }
  const HL = { ts: hlTS, json: hlJSON, yaml: hlYAML, md: hlMD, env: hlENV, plain: hlPlain };

  // ───── 에디터 ─────
  const elCode = $('#code'), elLines = $('#lines'), elCaret = $('#caret');
  let charW = 7.7;
  (function measure() {
    const s = document.createElement('span');
    s.style.cssText = 'position:absolute;visibility:hidden;font:14px/19px ' + getComputedStyle(document.documentElement).getPropertyValue('--mono');
    s.textContent = 'x'.repeat(100);
    document.body.appendChild(s);
    charW = s.getBoundingClientRect().width / 100 || 7.7;
    s.remove();
  })();

  function renderEditor() {
    const p = state.active;
    if (!p) { elLines.innerHTML = ''; $('#mm').innerHTML = ''; elCaret.style.display = 'none'; return; }
    const lines = HL[langOf(p)](FILES[p]);
    const cur = state.cursor[p] || (state.cursor[p] = { ln: p.endsWith('orders.service.ts') ? 78 : 1, col: 5 });
    if (cur.ln > lines.length) cur.ln = lines.length;
    elLines.innerHTML = lines.map((h, i) => `<div class="line${i + 1 === cur.ln ? ' cur' : ''}"><span class="ln">${i + 1}</span><span class="lc">${h || ' '}</span></div>`).join('');
    $('#mm').innerHTML = lines.map((h) => `<div>${h || ' '}</div>`).join('');
    elCaret.style.display = '';
    placeCaret();
    elCode.scrollTop = Math.max(0, (cur.ln - 12) * 19);
    updateStatus();
    document.title = `${p.split('/').pop()} - order-api - Visual Studio Code`;
    updateSlider();
  }
  function placeCaret() {
    const cur = state.cursor[state.active];
    if (!cur) return;
    elCaret.style.top = (cur.ln - 1) * 19 + 'px';
    elCaret.style.left = 66 + 4 + (cur.col - 1) * charW + 'px';
  }
  elLines.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.line');
    if (!row || !state.active) return;
    const ln = [...elLines.children].indexOf(row) + 1;
    const lc = row.querySelector('.lc');
    const text = lc.textContent;
    const x = e.clientX - lc.getBoundingClientRect().left - 4;
    const col = Math.max(1, Math.min(text.length + 1, Math.round(x / charW) + 1));
    elLines.querySelector('.line.cur')?.classList.remove('cur');
    row.classList.add('cur');
    state.cursor[state.active] = { ln, col };
    placeCaret();
    updateStatus();
  });
  function updateSlider() {
    const s = $('#mm-slider');
    const scale = 0.16;
    s.style.top = elCode.scrollTop * scale + 'px';
    s.style.height = Math.max(20, elCode.clientHeight * scale) + 'px';
    $('#mm').style.marginTop = -Math.max(0, elCode.scrollTop * scale - elCode.clientHeight * 0.5) + 'px';
  }
  elCode.addEventListener('scroll', updateSlider);

  function renderCrumbs() {
    const p = state.active;
    if (!p) { $('#crumbs').innerHTML = ''; return; }
    const parts = p.split('/');
    const last = parts.pop();
    $('#crumbs').innerHTML = parts.map((x) => `<span>${esc(x)}</span><span class="sep">›</span>`).join('') + `${fileIcon(last)}<span>${esc(last)}</span>` +
      (/\.ts$/.test(last) && FILES[p].includes('class ') ? `<span class="sep">›</span><span style="color:#ee9d28">◈</span><span>${esc((FILES[p].match(/class (\w+)/) || [])[1] || '')}</span>` : '');
  }
  function updateStatus() {
    const cur = state.cursor[state.active] || { ln: 1, col: 1 };
    $('#st-pos').textContent = `Ln ${cur.ln}, Col ${cur.col}`;
    $('#st-lang').textContent = LANG_NAME[langOf(state.active || '')] || 'Plain Text';
  }

  function renderAll() { renderTree(); renderTabs(); renderCrumbs(); renderEditor(); }

  // ───── 터미널 ─────
  const elTerm = $('#term');
  const now = () => new Date();
  const hhmmss = (d) => d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const nestTs = (d) => `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${hhmmss(d)}`;
  const PID = 18000 + Math.floor(Math.random() * 999);
  function nestLine(ctx, msg, level = 'LOG', extra = '') {
    const color = level === 'WARN' ? 't-y' : level === 'ERROR' ? 't-r' : 't-g';
    return `<span class="${color}">[Nest] ${PID}  - </span>${nestTs(now())}     <span class="${color}">${level}</span> <span class="t-y">[${ctx}]</span> <span class="${color}">${msg}</span>${extra}`;
  }
  const termLines = [];
  function termPush(html) {
    termLines.push(html);
    if (termLines.length > 400) termLines.shift();
    const atBottom = elTerm.scrollHeight - elTerm.scrollTop - elTerm.clientHeight < 30;
    elTerm.innerHTML = termLines.join('\n') + '\n';
    if (atBottom) elTerm.scrollTop = elTerm.scrollHeight;
  }
  function bootTerminal() {
    const d = now();
    [
      'PS C:\\work\\order-api> npm run start:dev',
      '',
      '> order-api@1.4.2 start:dev',
      '> nest start --watch',
      '',
      `<span class="t-d">[${hhmmss(d)}]</span> Starting compilation in watch mode...`,
      '',
      `<span class="t-d">[${hhmmss(d)}]</span> Found 0 errors. Watching for file changes.`,
      '',
      nestLine('NestFactory', 'Starting Nest application...'),
      nestLine('InstanceLoader', 'TypeOrmModule dependencies initialized', 'LOG', ' <span class="t-y">+42ms</span>'),
      nestLine('InstanceLoader', 'ConfigModule dependencies initialized', 'LOG', ' <span class="t-y">+1ms</span>'),
      nestLine('InstanceLoader', 'PaymentsModule dependencies initialized', 'LOG', ' <span class="t-y">+0ms</span>'),
      nestLine('InstanceLoader', 'OrdersModule dependencies initialized', 'LOG', ' <span class="t-y">+1ms</span>'),
      nestLine('RoutesResolver', 'OrdersController {/api/v1/orders}:'),
      nestLine('RouterExplorer', 'Mapped {/api/v1/orders, GET} route'),
      nestLine('RouterExplorer', 'Mapped {/api/v1/orders/:id, GET} route'),
      nestLine('RouterExplorer', 'Mapped {/api/v1/orders, POST} route'),
      nestLine('RouterExplorer', 'Mapped {/api/v1/orders/:id/cancel, PATCH} route'),
      nestLine('NestApplication', 'Nest application successfully started'),
      nestLine('Bootstrap', 'Server running on http://localhost:3000/api/v1'),
    ].forEach(termPush);
  }
  const REQS = [
    ['GET', '/api/v1/orders?page=1&size=20', 200], ['GET', '/api/v1/orders?page=2&size=20', 200],
    ['GET', '/api/v1/orders/10428', 200], ['GET', '/api/v1/orders/10391', 200], ['POST', '/api/v1/orders', 201],
    ['PATCH', '/api/v1/orders/10377/cancel', 200], ['GET', '/api/v1/orders/99999', 404], ['GET', '/api/v1/health', 200],
  ];
  setInterval(() => {
    if (Math.random() < 0.45) return;
    const [m, url, code] = REQS[Math.floor(Math.random() * REQS.length)];
    const ms = 4 + Math.floor(Math.random() * 60);
    if (code === 404) termPush(nestLine('ExceptionsHandler', `Order #99999 not found`, 'WARN'));
    termPush(nestLine('HTTP', `${m} ${url} ${code}`, 'LOG', ` <span class="t-y">+${ms}ms</span>`));
  }, 3500);

  // ───── 패널 / 사이드바 / 채팅 토글 ─────
  const elChat = $('#chat'), actChat = $('#act-chat'), badge = $('#chat-badge');
  let unread = 0;
  function isChatVisible() { return !elChat.classList.contains('hidden'); }
  function setChat(show) {
    elChat.classList.toggle('hidden', !show);
    actChat.classList.toggle('on', show);
    store.set('chatVisible', show);
    if (show) {
      unread = 0; badge.textContent = '';
      setTimeout(() => $('#chat-input').focus(), 0);
    } else if (elChat.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    window.dispatchEvent(new CustomEvent('chatvisibility', { detail: show }));
  }
  function togglePanel() { $('#panel').classList.toggle('hidden'); }
  function toggleSidebar() {
    const sb = $('#sidebar');
    sb.classList.toggle('hidden');
    $('#act-explorer').classList.toggle('on', !sb.classList.contains('hidden'));
  }
  actChat.addEventListener('click', () => setChat(!isChatVisible()));
  $('#btn-close').addEventListener('click', () => setChat(false));
  $('#lay-chat').addEventListener('click', () => setChat(!isChatVisible()));
  $('#lay-panel').addEventListener('click', togglePanel);
  $('#panel-close').addEventListener('click', togglePanel);
  $('#lay-side').addEventListener('click', toggleSidebar);
  $('#act-explorer').addEventListener('click', toggleSidebar);
  document.querySelectorAll('.ptab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.ptab').forEach((x) => x.classList.toggle('on', x === t));
  }));

  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); setChat(!isChatVisible()); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === '`') { e.preventDefault(); togglePanel(); }
    else if (mod && !e.shiftKey && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleSidebar(); }
    else if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); }
    else if (mod && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); }
  });

  // 채팅창 폭 조절
  const resizer = $('#chat-resizer');
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizer.classList.add('drag');
    const move = (ev) => {
      const w = Math.max(280, Math.min(window.innerWidth - 420, window.innerWidth - ev.clientX));
      elChat.style.width = w + 'px';
    };
    const up = () => {
      resizer.classList.remove('drag');
      store.set('chatWidth', parseInt(elChat.style.width, 10));
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  const savedW = store.get('chatWidth', 0);
  if (savedW) elChat.style.width = Math.min(savedW, window.innerWidth - 420) + 'px';

  // 게임 쪽에서 쓰는 API
  window.VS = {
    isChatVisible,
    setChat,
    notifyChat() {
      if (isChatVisible()) return;
      unread++;
      badge.textContent = unread > 99 ? '99+' : String(unread);
    },
  };

  renderAll();
  bootTerminal();
  if (!store.get('chatVisible', true)) setChat(false); else actChat.classList.add('on');
})();

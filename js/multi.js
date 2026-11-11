// 멀티플레이 클라이언트: server.js 로 열었을 때만 동작 (file:// 로 열면 혼자 하기)
(function () {
  'use strict';
  if (!/^https?:$/.test(location.protocol)) return;
  const C = window.Chat, Q = window.QuizCore;
  const store = {
    get(k, d) { try { const v = localStorage.getItem('kq.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('kq.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const room = (new URLSearchParams(location.search).get('room') || 'lobby').replace(/[^\w가-힣-]/g, '').slice(0, 20) || 'lobby';
  let id = store.get('pid', null);
  if (!id || !/^[\w-]{6,40}$/.test(id)) { id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); store.set('pid', id); }
  let name = store.get('name', '');
  let me = null;            // 서버가 알려준 내 공개 id
  let es = null, connected = false;
  const LOCAL = new Set(['위장', '테마', '청소', '지우기', 'clear']);

  fetch('api/ping', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => { if (info && info.ok) init(); })
    .catch(() => { /* 서버 없음 → 혼자 하기 유지 */ });

  function init() {
    C.stopSolo();
    C.clear();
    C.setSub(`멜로디봇 · 멀티플레이 (방: ${room})`, '연결 중…');
    C.sys('👥 멀티플레이 모드');
    if (name) { C.setHandler(sendRemote); connect(); return; }
    C.addMsg('bot', '친구들이랑 같이 하는 방이에요!<br>먼저 <b>닉네임</b>을 입력해주세요. (최대 12자)');
    C.setHandler((t) => {
      const n = t.trim().slice(0, 12);
      if (!n) return;
      name = n;
      store.set('name', n);
      C.setHandler(sendRemote);
      connect();
    });
  }

  function connect() {
    if (es) es.close();
    es = new EventSource(`api/events?room=${encodeURIComponent(room)}&id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`);
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch (err) { return; }
      onEvent(ev);
    };
    es.onerror = () => {
      if (!connected) return;
      connected = false;
      C.sys('⚠ 서버 연결이 끊겼어요. 다시 연결하는 중…');
      C.setTimer('');
      C.setSub(null, '연결 끊김');
    };
  }

  function render(ev) {
    if (ev.t === 'msg') return C.addMsg(ev.who, ev.html, { ts: ev.ts });
    if (ev.t === 'chat') {
      const mine = ev.pid === me;
      const el = mine
        ? C.addMsg('me', Q.esc(ev.text), { ts: ev.ts })
        : C.addMsg('other', Q.esc(ev.text), { ts: ev.ts, name: ev.name, sender: 'u:' + ev.pid });
      if (ev.mark) el.classList.add(ev.mark);
    }
  }

  function onEvent(ev) {
    switch (ev.t) {
      case 'hello':
        connected = true;
        me = ev.you;
        name = ev.name;
        store.set('name', name);
        C.clear();
        if (window.VS && window.VS.image) window.VS.image({ close: true }); // 진행 중인 사진은 바로 뒤에 다시 옴
        ev.history.forEach(render);
        C.sys(`<b>${Q.esc(name)}</b>(으)로 접속했어요 · 방: ${Q.esc(ev.room)}`);
        break;
      case 'msg': case 'chat': render(ev); break;
      case 'timer': C.setTimer(ev.remain == null ? '' : `⏱ ${ev.remain}s`, ev.remain != null && ev.remain <= 10); break;
      case 'players': C.setSub(null, `👥 ${ev.list.length}명`, ev.list.map((p) => p.name).join(', ')); break;
      case 'name': name = ev.name; store.set('name', name); break;
      case 'img': if (window.VS && window.VS.image) window.VS.image(ev); break; // 얼굴·자켓 퀴즈 사진
    }
  }

  function sendRemote(text) {
    const t = text.trim();
    if (!t) return;
    const m = t.match(/^[\/!]\s*(\S+)/);
    if (m && LOCAL.has(m[1])) { C.addMsg('me', Q.esc(t)); C.runLocal(m[1]); return; }
    if (!connected) { C.sys('서버에 연결되어 있지 않아요. 잠시 후 다시 시도해주세요.'); return; }
    fetch('api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, id, text: t.slice(0, 300) }),
    }).catch(() => C.sys('⚠ 메시지 전송 실패'));
  }
})();

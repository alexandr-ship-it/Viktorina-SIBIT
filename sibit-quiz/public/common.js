// Общие помощники для страниц ведущего
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function store(k, v) {
  try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { return null; }
}

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

async function api(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-admin-key': store('sq_admin') || '' };
  const res = await fetch(url, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (res.status === 401) {
    const ok = await askPassword();
    if (ok) return api(url, opts);
    throw new Error('Нужен пароль ведущего');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка ' + res.status);
  return data;
}

function askPassword() {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<form class="modal" style="max-width:380px">
      <h2>Вход ведущего</h2>
      <p class="muted" style="margin:0 0 14px">Введи пароль, который задан на сервере.</p>
      <input class="input" type="password" autocomplete="current-password" placeholder="Пароль" required>
      <div class="modal-actions"><button type="submit" class="btn btn-primary">Войти</button></div></form>`;
    document.body.appendChild(back);
    const form = back.querySelector('form'), input = back.querySelector('input');
    input.focus();
    form.onsubmit = async e => {
      e.preventDefault();
      store('sq_admin', input.value);
      const r = await fetch('/api/auth', { headers: { 'x-admin-key': input.value } });
      if (r.ok) { back.remove(); resolve(true); } else { input.value = ''; input.placeholder = 'Неверный пароль'; }
    };
  });
}

function confirmBox(title, text, okLabel = 'Да') {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" style="max-width:420px"><h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
      <div class="modal-actions"><button class="btn btn-ghost" data-v="0">Отмена</button><button class="btn btn-primary" data-v="1">${esc(okLabel)}</button></div></div>`;
    document.body.appendChild(back);
    back.onclick = e => { const v = e.target.dataset?.v; if (v !== undefined || e.target === back) { back.remove(); resolve(v === '1'); } };
  });
}

function downloadFile(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
};

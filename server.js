// СИБИТ Квиз — живые викторины: вопросы на телефонах, таблица лидеров на большом экране.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';   // если задан — нужен для создания и запуска викторин
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); // адрес для QR, если сайт за прокси
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const QUIZ_FILE = path.join(DATA_DIR, 'quizzes.json');

const MAX_PLAYERS = 300;
const GAME_TTL_MS = 8 * 60 * 60 * 1000;

// ---------- хранилище викторин ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let quizzes = [];
try { quizzes = JSON.parse(fs.readFileSync(QUIZ_FILE, 'utf8')); } catch { quizzes = []; }
if (!quizzes.length) {
  try { quizzes = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-quizzes.json'), 'utf8')); saveQuizzes(); } catch {}
}
function saveQuizzes() {
  const tmp = QUIZ_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(quizzes, null, 2));
  fs.renameSync(tmp, QUIZ_FILE);
}
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');

function cleanQuiz(input) {
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const q = {
    title: str(input.title, 120) || 'Без названия',
    description: str(input.description, 400),
    questions: [],
  };
  for (const raw of Array.isArray(input.questions) ? input.questions.slice(0, 100) : []) {
    const options = (Array.isArray(raw.options) ? raw.options : []).map(o => str(o, 160)).slice(0, 6);
    if (options.length < 2 || options.some(o => !o)) continue;
    const type = raw.type === 'multi' ? 'multi' : 'single';
    let correct = [...new Set((Array.isArray(raw.correct) ? raw.correct : [])
      .map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < options.length))].sort();
    if (!correct.length) continue;
    if (type === 'single') correct = [correct[0]];
    const time = Math.min(300, Math.max(5, Number(raw.time) || 20));
    const points = Math.min(2000, Math.max(0, Number(raw.points ?? 1000)));
    q.questions.push({
      id: str(raw.id, 32) || uid(4),
      text: str(raw.text, 500) || 'Вопрос',
      image: /^https?:\/\//i.test(str(raw.image, 600)) ? str(raw.image, 600) : '',
      type, options, correct, time, points,
    });
  }
  return q;
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const key = req.get('x-admin-key') || '';
  const a = Buffer.from(key), b = Buffer.from(ADMIN_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Нужен пароль ведущего' });
}

app.get('/api/config', (req, res) => res.json({ needsPassword: !!ADMIN_PASSWORD }));
app.get('/api/auth', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/quizzes', requireAdmin, (req, res) => {
  res.json(quizzes.map(q => ({ id: q.id, title: q.title, description: q.description,
    count: q.questions.length, updatedAt: q.updatedAt })));
});
app.get('/api/quizzes/:id', requireAdmin, (req, res) => {
  const q = quizzes.find(x => x.id === req.params.id);
  q ? res.json(q) : res.status(404).json({ error: 'Викторина не найдена' });
});
app.post('/api/quizzes', requireAdmin, (req, res) => {
  const q = { id: uid(5), ...cleanQuiz(req.body || {}), updatedAt: Date.now() };
  quizzes.unshift(q); saveQuizzes(); res.json(q);
});
app.put('/api/quizzes/:id', requireAdmin, (req, res) => {
  const i = quizzes.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Викторина не найдена' });
  quizzes[i] = { id: quizzes[i].id, ...cleanQuiz(req.body || {}), updatedAt: Date.now() };
  saveQuizzes(); res.json(quizzes[i]);
});
app.delete('/api/quizzes/:id', requireAdmin, (req, res) => {
  quizzes = quizzes.filter(x => x.id !== req.params.id); saveQuizzes(); res.json({ ok: true });
});

app.post('/api/games', requireAdmin, (req, res) => {
  const quiz = quizzes.find(x => x.id === req.body?.quizId);
  if (!quiz) return res.status(404).json({ error: 'Викторина не найдена' });
  if (!quiz.questions.length) return res.status(400).json({ error: 'В викторине нет вопросов' });
  const game = createGame(quiz, req.body.settings || {});
  res.json({ pin: game.pin, hostToken: game.hostToken });
});

app.get('/api/games/:pin', (req, res) => {
  const g = games.get(req.params.pin);
  if (!g || g.status === 'ended') return res.status(404).json({ error: 'Игра с таким кодом не найдена' });
  res.json({ title: g.quiz.title, status: g.status });
});

app.get('/api/qr.svg', async (req, res) => {
  const data = String(req.query.data || '').slice(0, 300);
  if (!data) return res.status(400).end();
  const svg = await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#14294f', light: '#ffffff' } });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
});

app.get('/api/net', (req, res) => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  res.json({ publicUrl: PUBLIC_URL, ips, port: PORT });
});

app.get(['/play', '/join', '/join/:pin'], (req, res) => {
  if (req.params.pin) return res.redirect('/play?pin=' + encodeURIComponent(req.params.pin));
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/edit', (req, res) => res.sendFile(path.join(__dirname, 'public', 'edit.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- игры ----------
const games = new Map();

function newPin() {
  let pin;
  do { pin = String(crypto.randomInt(100000, 1000000)); } while (games.has(pin));
  return pin;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function createGame(quiz, settings) {
  const game = {
    pin: newPin(),
    hostToken: uid(16),
    quiz: JSON.parse(JSON.stringify(quiz)),
    settings: {
      shuffleQuestions: settings.shuffleQuestions !== false,
      showCorrect: settings.showCorrect !== false,
      speedBonus: settings.speedBonus !== false,
      allowLateJoin: settings.allowLateJoin !== false,
    },
    status: 'lobby',              // lobby → live → ended
    players: new Map(),
    createdAt: Date.now(), startedAt: 0, endedAt: 0,
    hostSockets: new Set(),
    pushTimer: null,
  };
  games.set(game.pin, game);
  return game;
}

const room = pin => 'game:' + pin;
const hostRoom = pin => 'host:' + pin;

function publicQuestion(game, p) {
  const qi = p.order[p.qIndex];
  const q = game.quiz.questions[qi];
  return { index: p.qIndex, total: p.order.length, text: q.text, image: q.image, type: q.type,
    options: q.options, time: q.time, multiCount: q.type === 'multi' ? q.correct.length : 1 };
}

function ranking(game) {
  return [...game.players.values()].filter(p => !p.kicked)
    .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount || a.totalTime - b.totalTime || a.joinedAt - b.joinedAt);
}
function rankOf(game, p) { return ranking(game).indexOf(p) + 1; }

function hostState(game) {
  const total = game.quiz.questions.length;
  const list = ranking(game).map((p, i) => ({
    id: p.id, name: p.name, avatar: p.avatar, rank: i + 1, score: p.score, streak: p.streak,
    correct: p.correctCount, answered: p.answers.length, total,
    // точки прогресса в порядке вопросов викторины: 1 верно, 0 неверно, -1 нет ответа
    dots: game.quiz.questions.map((_, qi) => { const a = p.answers.find(x => x.qi === qi); return a ? (a.correct ? 1 : 0) : -1; }),
    finished: p.finished, connected: p.connected,
  }));
  const qStats = game.quiz.questions.map((q, qi) => {
    let answered = 0, correct = 0, time = 0;
    for (const p of game.players.values()) {
      const a = p.answers.find(x => x.qi === qi);
      if (a) { answered++; if (a.correct) correct++; time += a.time; }
    }
    return { text: q.text, answered, correct, avgTime: answered ? Math.round(time / answered / 100) / 10 : 0 };
  });
  return { pin: game.pin, title: game.quiz.title, status: game.status, settings: game.settings,
    total, startedAt: game.startedAt, endedAt: game.endedAt, now: Date.now(), players: list, qStats };
}

// Таблица лидеров уходит ведущему не чаще 4 раз в секунду.
function pushHost(game, immediate = false) {
  if (immediate) { clearTimeout(game.pushTimer); game.pushTimer = null; io.to(hostRoom(game.pin)).emit('host:state', hostState(game)); return; }
  if (game.pushTimer) return;
  game.pushTimer = setTimeout(() => { game.pushTimer = null; io.to(hostRoom(game.pin)).emit('host:state', hostState(game)); }, 250);
}

function playerSummary(game, p) {
  return { name: p.name, avatar: p.avatar, score: p.score, rank: rankOf(game, p), players: ranking(game).length,
    correct: p.correctCount, total: p.order.length, streak: p.streak };
}

function sendQuestion(game, p) {
  clearTimeout(p.timer);
  if (p.qIndex >= p.order.length) {
    p.finished = true; p.state = 'finished';
    emitToPlayer(p, 'player:finished', playerSummary(game, p));
    pushHost(game);
    return;
  }
  p.state = 'question';
  p.qStartedAt = Date.now();
  const q = publicQuestion(game, p);
  emitToPlayer(p, 'player:question', { ...q, elapsed: 0 });
  // сервер сам закрывает вопрос, если ответ так и не пришёл
  p.timer = setTimeout(() => submitAnswer(game, p, p.qIndex, [], true), (q.time + 1.5) * 1000);
}

function emitToPlayer(p, ev, data) { if (p.socketId) io.to(p.socketId).emit(ev, data); }

function submitAnswer(game, p, qIndex, choice, timedOut = false) {
  if (game.status !== 'live' || p.state !== 'question' || qIndex !== p.qIndex) return;
  clearTimeout(p.timer);
  const qi = p.order[p.qIndex];
  const q = game.quiz.questions[qi];
  const elapsed = Date.now() - p.qStartedAt;
  const limit = q.time * 1000;
  const picked = [...new Set((Array.isArray(choice) ? choice : []).map(Number)
    .filter(i => Number.isInteger(i) && i >= 0 && i < q.options.length))].sort();
  const late = elapsed > limit + 1500;
  const correct = !timedOut && !late && picked.length === q.correct.length && picked.every((v, i) => v === q.correct[i]);
  let gained = 0;
  if (correct) {
    p.streak += 1;
    const speed = game.settings.speedBonus ? Math.max(0, 1 - Math.min(elapsed, limit) / limit) : 1;
    gained = Math.round(q.points * (game.settings.speedBonus ? 0.5 + 0.5 * speed : 1));
    if (p.streak >= 2 && q.points > 0) gained += Math.min(p.streak - 1, 5) * 50; // бонус за серию
    p.correctCount += 1;
  } else {
    p.streak = 0;
  }
  p.score += gained;
  p.totalTime += Math.min(elapsed, limit);
  p.answers.push({ qi, picked, correct, gained, time: Math.min(elapsed, limit) });
  p.state = 'result';
  p.qIndex += 1;
  emitToPlayer(p, 'player:result', {
    correct, timedOut: timedOut || late, gained, score: p.score, streak: p.streak,
    correctIdx: game.settings.showCorrect ? q.correct : null, picked,
    rank: rankOf(game, p), players: ranking(game).length, last: p.qIndex >= p.order.length,
  });
  pushHost(game);
}

function endGame(game) {
  if (game.status === 'ended') return;
  game.status = 'ended'; game.endedAt = Date.now();
  for (const p of game.players.values()) {
    clearTimeout(p.timer);
    if (!p.kicked) emitToPlayer(p, 'player:ended', playerSummary(game, p));
  }
  pushHost(game, true);
}

const AVATARS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '🦉', '🐧', '🐨', '🦄', '🐝', '🐳', '🦖', '🐢', '🦋', '🐺', '🦝', '🐹', '🐰', '🦜'];

// ---------- сокеты ----------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, pingInterval: 10000, pingTimeout: 8000 });

io.on('connection', socket => {
  // ведущий
  socket.on('host:join', ({ pin, token } = {}, ack) => {
    const game = games.get(String(pin));
    if (!game || game.hostToken !== token) return ack?.({ error: 'Игра не найдена или нет доступа' });
    socket.data.hostPin = game.pin;
    socket.join(hostRoom(game.pin));
    ack?.({ ok: true, state: hostState(game) });
  });
  const hostGame = () => { const g = games.get(socket.data.hostPin); return g || null; };

  socket.on('host:start', (_, ack) => {
    const game = hostGame(); if (!game || game.status !== 'lobby') return ack?.({ error: 'Нельзя начать' });
    if (!game.players.size) return ack?.({ error: 'Пока никто не подключился' });
    game.status = 'live'; game.startedAt = Date.now();
    for (const p of game.players.values()) if (!p.kicked) sendQuestion(game, p);
    pushHost(game, true); ack?.({ ok: true });
  });
  socket.on('host:end', (_, ack) => { const game = hostGame(); if (!game) return; endGame(game); ack?.({ ok: true }); });
  socket.on('host:kick', ({ id } = {}) => {
    const game = hostGame(); const p = game?.players.get(id); if (!p) return;
    clearTimeout(p.timer); p.kicked = true; emitToPlayer(p, 'player:kicked', {});
    game.players.delete(id); pushHost(game, true);
  });
  socket.on('host:settings', (s = {}) => {
    const game = hostGame(); if (!game || game.status !== 'lobby') return;
    for (const k of ['shuffleQuestions', 'showCorrect', 'speedBonus', 'allowLateJoin'])
      if (typeof s[k] === 'boolean') game.settings[k] = s[k];
    pushHost(game, true);
  });

  // игрок
  socket.on('player:join', ({ pin, name } = {}, ack) => {
    const game = games.get(String(pin || '').trim());
    if (!game || game.status === 'ended') return ack?.({ error: 'Игра с таким кодом не найдена' });
    if (game.status === 'live' && !game.settings.allowLateJoin) return ack?.({ error: 'Игра уже идёт, вход закрыт' });
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (name.length < 2) return ack?.({ error: 'Имя — минимум 2 символа' });
    const taken = [...game.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return ack?.({ error: 'Это имя уже занято, добавь фамилию или цифру' });
    if (game.players.size >= MAX_PLAYERS) return ack?.({ error: 'Комната заполнена' });
    const order = game.quiz.questions.map((_, i) => i);
    const p = {
      id: uid(6), key: uid(12), name, avatar: AVATARS[crypto.randomInt(0, AVATARS.length)],
      score: 0, streak: 0, correctCount: 0, totalTime: 0, answers: [],
      order: game.settings.shuffleQuestions ? shuffle(order) : order,
      qIndex: 0, state: 'lobby', finished: false, joinedAt: Date.now(),
      socketId: socket.id, connected: true, timer: null,
    };
    game.players.set(p.id, p);
    socket.data.player = { pin: game.pin, id: p.id };
    socket.join(room(game.pin));
    ack?.({ ok: true, id: p.id, key: p.key, name: p.name, avatar: p.avatar, title: game.quiz.title, status: game.status });
    if (game.status === 'live') sendQuestion(game, p);
    pushHost(game);
  });

  socket.on('player:rejoin', ({ pin, id, key } = {}, ack) => {
    const game = games.get(String(pin));
    const p = game?.players.get(id);
    if (!game || !p || p.key !== key) return ack?.({ error: 'gone' });
    p.socketId = socket.id; p.connected = true;
    socket.data.player = { pin: game.pin, id: p.id };
    socket.join(room(game.pin));
    ack?.({ ok: true, name: p.name, avatar: p.avatar, title: game.quiz.title, status: game.status });
    if (game.status === 'ended') emitToPlayer(p, 'player:ended', playerSummary(game, p));
    else if (game.status === 'live') {
      if (p.finished) emitToPlayer(p, 'player:finished', playerSummary(game, p));
      else if (p.state === 'question') {
        const q = publicQuestion(game, p);
        emitToPlayer(p, 'player:question', { ...q, elapsed: Date.now() - p.qStartedAt });
      } else sendQuestion(game, p);
    }
    pushHost(game);
  });

  const me = () => {
    const ref = socket.data.player; if (!ref) return {};
    const game = games.get(ref.pin); const p = game?.players.get(ref.id);
    return p ? { game, p } : {};
  };
  socket.on('player:answer', ({ index, choice } = {}) => {
    const { game, p } = me(); if (p) submitAnswer(game, p, Number(index), choice);
  });
  socket.on('player:next', () => {
    const { game, p } = me();
    if (p && game.status === 'live' && p.state === 'result') sendQuestion(game, p);
  });
  socket.on('player:leave', () => {
    const { game, p } = me(); if (!p) return;
    clearTimeout(p.timer); game.players.delete(p.id); socket.data.player = null; pushHost(game, true);
  });

  socket.on('disconnect', () => {
    const { game, p } = me();
    if (p && p.socketId === socket.id) { p.connected = false; pushHost(game); }
  });
});

// старые игры убираем из памяти
setInterval(() => {
  const now = Date.now();
  for (const [pin, g] of games) {
    if (now - g.createdAt > GAME_TTL_MS || (g.status === 'ended' && now - g.endedAt > 60 * 60 * 1000)) {
      for (const p of g.players.values()) clearTimeout(p.timer);
      games.delete(pin);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`СИБИТ Квиз запущен: http://localhost:${PORT}`);
  if (ADMIN_PASSWORD) console.log('Вход ведущего защищён паролем (ADMIN_PASSWORD).');
});

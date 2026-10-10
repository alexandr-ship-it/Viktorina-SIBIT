// Прогон игры целиком: ведущий + 3 бота. Запуск: node test/game.test.js (сервер должен работать на :3000)
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } else console.log('ok  -', m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise(r => s.emit(ev, data, r));

(async () => {
  const quizzes = await (await fetch(URL + '/api/quizzes')).json();
  assert(quizzes.length > 0, 'есть викторина-пример');
  const quiz = await (await fetch(URL + '/api/quizzes/' + quizzes[0].id)).json();
  const g = await (await fetch(URL + '/api/games', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quizId: quiz.id, settings: { shuffleQuestions: true } }) })).json();
  assert(/^\d{6}$/.test(g.pin), 'создана игра с PIN ' + g.pin);

  const host = io(URL); let hostState = null;
  host.on('host:state', s => hostState = s);
  const hj = await emit(host, 'host:join', { pin: g.pin, token: g.hostToken });
  assert(hj.ok, 'ведущий подключился');
  const bad = await emit(io(URL), 'host:join', { pin: g.pin, token: 'wrong' });
  assert(bad.error, 'чужой токен ведущего отклонён');

  // боты: «отличник» отвечает верно, «троечник» через раз, «соня» молчит до таймаута на 1-м вопросе
  const bots = [];
  for (const [name, skill] of [['Отличник', 1], ['Троечник', 0.5], ['Соня', 0]]) {
    const s = io(URL); const bot = { s, name, n: 0, results: [], ended: null };
    s.on('player:question', q => {
      bot.lastQ = q;
      // сервер не должен присылать правильные ответы
      if ('correct' in q) { console.error('FAIL: утечка ответа'); process.exit(1); }
      const real = quiz.questions.find(x => x.text === q.text);
      if (skill === 0) return; // молчит
      const right = Math.random() < skill || skill === 1;
      const choice = right ? real.correct : [real.correct[0] === 0 ? 1 : 0];
      setTimeout(() => s.emit('player:answer', { index: q.index, choice }), 200 + Math.random() * 300);
    });
    s.on('player:result', r => { bot.results.push(r); setTimeout(() => s.emit('player:next'), 50); });
    s.on('player:ended', e => bot.ended = e);
    s.on('player:finished', f => bot.finished = f);
    const r = await emit(s, 'player:join', { pin: g.pin, name });
    assert(r.ok, `игрок ${name} вошёл`);
    bots.push(bot);
  }
  const dup = await emit(io(URL), 'player:join', { pin: g.pin, name: 'отличник' });
  assert(dup.error, 'повторное имя отклонено');

  await wait(400);
  assert(hostState.players.length === 3, 'ведущий видит 3 игроков в лобби');
  const st = await emit(host, 'host:start');
  assert(st.ok, 'игра запущена');

  // опоздавший
  const late = io(URL); let lateQ = null; late.on('player:question', q => lateQ = q);
  const lj = await emit(late, 'player:join', { pin: g.pin, name: 'Опоздун' });
  await wait(300);
  assert(lj.ok && lateQ && lateQ.index === 0, 'опоздавший вошёл и получил первый вопрос');

  // ждём, пока отличник и троечник пройдут всё
  for (let i = 0; i < 100 && !(bots[0].finished && bots[1].finished); i++) await wait(100);
  assert(bots[0].finished && bots[1].finished, 'двое прошли все вопросы');
  assert(bots[0].results.every(r => r.correct), 'отличник: все ответы засчитаны верными');
  assert(bots[0].results[0].gained >= 500 && bots[0].results[0].gained <= 1000, 'очки за быстрый ответ в диапазоне 500–1000: ' + bots[0].results[0].gained);
  assert(bots[0].results.some(r => r.gained > 1000), 'бонус за серию начисляется');
  await wait(400);
  assert(hostState.players[0].name === 'Отличник', 'отличник первый в таблице лидеров');
  assert(hostState.players[0].dots.every(d => d === 1), 'у лидера все точки зелёные');

  // таймаут: «соня» молчит — сервер сам закрывает вопрос (лимит первого вопроса до 25с, ждём)
  const t1 = bots[2].lastQ.time;
  console.log(`…жду таймаут сони (${t1 + 2} с)`);
  await wait((t1 + 2) * 1000);
  assert(bots[2].results[0] && bots[2].results[0].timedOut && !bots[2].results[0].correct, 'сервер закрыл вопрос по таймеру');

  // переподключение
  bots[1].s.disconnect();
  await wait(300);
  const s2 = io(URL);
  const rj = await emit(s2, 'player:rejoin', { pin: g.pin, id: (await (async () => null)()) || 'x', key: 'y' });
  assert(rj.error, 'чужая сессия не восстанавливается');

  await emit(host, 'host:end');
  await wait(400);
  assert(bots[0].ended && bots[0].ended.rank === 1, 'финал: отличник получил 1 место');
  assert(hostState.status === 'ended' && hostState.qStats.length === quiz.questions.length, 'ведущий получил статистику по вопросам');
  const after = await fetch(URL + '/api/games/' + g.pin);
  assert(after.status === 404, 'после финала по PIN войти нельзя');
  console.log('\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

// index.js
require("dotenv").config();
const { Bot, GrammyError, HttpError, InlineKeyboard } = require("grammy");
const { hydrate } = require("@grammyjs/hydrate");
const axios = require("axios");

// ----------------------- НАСТРОЙКИ -----------------------
const bot = new Bot(process.env.BOT_API_KEY);
bot.use(hydrate());

const AIRTABLE_API = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE_ID;
const AIRTABLE_PLACES = process.env.AIRTABLE_PLACES_TABLE_ID;
const AIRTABLE_SMS = process.env.AIRTABLE_SMS_ID;
const AIRTABLE_PNL = process.env.AIRTABLE_PNL_ID;
// acts (НОВОЕ)
const AIRTABLE_ACTS = process.env.AIRTABLE_ACTS_TABLE_ID;

// Лучше хранить в .env
const SECONDARY_CHAT = Number(process.env.SECONDARY_CHAT_ID || -1002203093713);
const SUPABASE_WORKOUT_MESSAGE_URL =
  process.env.SUPABASE_WORKOUT_MESSAGE_URL ||
  "https://ahmwnchujgenbkpjyxdz.supabase.co/functions/v1/process-tg-workout-message";
const TG_WORKOUT_BOT_SECRET = process.env.TG_WORKOUT_BOT_SECRET;

// Airtable URLs
const airtableUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
const airtablePlacesUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_PLACES}`;
const airtableMessagesUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_SMS}`;
const airtablePnlUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_PNL}`;
const airtableActsUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_ACTS}`;

// Авторизация пользователей (оставляем как было)
const allowedIds = []; // сюда можно добавить id пользователей
const allowedUsers = [
  "Lokatororator",
  "Shaaaaaaat",
  "kapitanstar_coach",
  "fitfrol",
  "Gshakhnazarov",
  "dima_dubinin",
  "e_katrin_al",
];

const BUTTONS_PER_PAGE = 7;

// ----------------------- ХЕЛПЕРЫ -----------------------
const esc = (s = "") =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Структурный лог в одну строку JSON
const jlog = (ctx, event, extra = {}) => {
  const u = ctx.from || {};
  const base = {
    ts: new Date().toISOString(),
    event,
    uid: u.id,
    uname: u.username || null,
  };
  console.log(JSON.stringify({ ...base, ...extra }));
};

// Быстрый ответ на callback (исправляет "query is too old")
const safeAnswerCb = async (ctx) => {
  try {
    await ctx.answerCallbackQuery();
  } catch (e) {
    if (!(e instanceof GrammyError && e.error_code === 400)) {
      console.error("answerCallbackQuery error:", e);
    }
  }
};

// Парсер дат dd.mm или dd.mm.yyyy c «разумным» годом
const parseDMY = (s = "") => {
  const parts = s.split(".");
  if (parts.length === 3) return new Date(+parts[2], +parts[1] - 1, +parts[0]);
  const [d, m] = parts.map(Number);
  const now = new Date();
  let y = now.getFullYear();
  const candidate = new Date(y, m - 1, d);
  if (candidate > now) y -= 1;
  return new Date(y, m - 1, d);
};
const compareDates = (date1, date2) => parseDMY(date1) >= parseDMY(date2);

// Простой кэш (для локаций/PNL)
const putCache = (bag, key, val, ttlMs = 5 * 60 * 1000) => {
  bag._cache ??= {};
  bag._cache[key] = { val, exp: Date.now() + ttlMs };
  return val;
};
const getCache = (bag, key) => {
  const rec = bag._cache?.[key];
  return rec && rec.exp > Date.now() ? rec.val : null;
};

const sendMessageToSupabase = async (ctx, rawText) => {
  try {
    await axios.post(
      SUPABASE_WORKOUT_MESSAGE_URL,
      {
        raw_text: rawText,
        telegram_message_id: ctx.callbackQuery?.message?.message_id
          ? String(ctx.callbackQuery.message.message_id)
          : undefined,
        telegram_chat_id: ctx.chat?.id ? String(ctx.chat.id) : undefined,
        telegram_user_id: ctx.from?.id ? String(ctx.from.id) : undefined,
        telegram_username: ctx.from?.username || undefined,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-bot-secret": TG_WORKOUT_BOT_SECRET,
        },
        timeout: 60000,
      }
    );
  } catch (error) {
    console.error(
      "Error sending message to Supabase:",
      error?.response?.data || error?.message || error
    );
  }
};

// ----------------------- СОСТОЯНИЕ -----------------------
const userStates = {}; // userId -> state

const freshState = () => ({
  buttonTexts: [], // имена (для отображения)
  buttonIds: [], // [{id:'p_0', name:'Иван'}]
  buttonStates: {}, // {'p_0': true/false} — group/personal
  buttonCounters: {}, // {'p_0': 0..n}       — ds
  currentPage: 0,
  selectedDate: "---",
  selectedFormat: "---", // 'ds' | 'group' | 'personal' | 'split'
  selectedLocation: "---", // meaning
  locations: [], // [{id:'loc_0', label:'...', meaning:'...'}]
  pnlDataCache: [],
  _cache: null,
});
const ensureState = (uid) => (userStates[uid] ??= freshState());
const resetUserState = (uid) => {
  userStates[uid] = freshState();
};

// Подсчёт общего количества выбранных людей
const calcSelectedCount = (st) => {
  if (st.selectedFormat === "ds") {
    return Object.values(st.buttonCounters || {}).reduce(
      (a, b) => a + (b || 0),
      0
    );
  }
  return Object.values(st.buttonStates || {}).filter(Boolean).length;
};

// Шапка с Кол-во всегда
const buildSummary = (st) => {
  let txt =
    `<b>Введенные данные:</b>\n` +
    `📅 Дата: ${esc(st.selectedDate || "---")}\n` +
    `🤸 Тип тренировки: ${esc(st.selectedFormat || "---")}`;

  if (st.selectedFormat !== "ds") {
    txt += `\n📍 Место: ${esc(st.selectedLocation || "---")}`;
  }

  const totalCount = calcSelectedCount(st);
  const countDisplay = totalCount > 0 ? totalCount : "---";
  txt += `\n🔢 Кол-во: ${countDisplay}`;

  if (st.selectedFormat === "ds") {
    const pickedList = Object.entries(st.buttonCounters || {})
      .filter(([, v]) => v > 0)
      .map(
        ([id, v]) =>
          `${v}x ${st.buttonIds.find((x) => x.id === id)?.name || "?"}`
      );
    txt += `\n👥 Люди: ${esc(pickedList.join(", ") || "---")}`;
  } else {
    const pickedNames = Object.entries(st.buttonStates || {})
      .filter(([, v]) => !!v)
      .map(([id]) => st.buttonIds.find((x) => x.id === id)?.name || "?");
    txt += `\n👥 Люди: ${esc(pickedNames.join(", ") || "---")}`;
  }
  return txt;
};

// ----------------------- AIRTABLE -----------------------
const fetchDataFromAirtable = async (username, url) => {
  let records = [];
  let offset = null;
  do {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_API}` },
      params: { offset, pageSize: 100 },
    });
    records = records.concat(response.data.records);
    offset = response.data.offset;
  } while (offset);

  return records
    .filter((r) => r.fields.Coach && r.fields.Coach.includes(username))
    .map((r) => ({
      name: r.fields.FIO3,
      place: r.fields.Places,
      meaning: r.fields.Meanings,
    }));
};

const sendMessageToAirtable = async (message) => {
  try {
    await axios.post(
      airtableMessagesUrl,
      { records: [{ fields: { Message: message } }] },
      {
        headers: {
          Authorization: `Bearer ${AIRTABLE_API}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error(
      "Error sending message to Airtable:",
      error?.response?.data || error
    );
  }
};

const sendMessagesWithPause = async (messages) => {
  for (const message of messages) {
    await sendMessageToAirtable(message);
    await new Promise((r) => setTimeout(r, 10000));
  }
};

// ---- PNL по датам (используется в старом PNL-потоке; можно оставить) ----
const fetchPnlDataFromAirtable = async (username, startDateDM) => {
  let records = [];
  let offset = null;
  const filterFormula = `OR({Coach}='${username}', {Second_coach}='${username}')`;
  do {
    const response = await axios.get(airtablePnlUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_API}` },
      params: { offset, pageSize: 100, filterByFormula: filterFormula },
    });
    records = records.concat(response.data.records);
    offset = response.data.offset;
  } while (offset);

  return records
    .map((r) => ({
      date: r.fields.Data,
      coach: r.fields.Coach,
      secondCoach: r.fields.Second_coach,
      format: r.fields.Format,
      place: r.fields.Place,
      expense: r.fields.Expenses_coach || 0,
      secondExpense: r.fields.Expenses_second_coach || 0,
    }))
    .filter((rec) => compareDates(rec.date, startDateDM))
    .sort((a, b) => parseDMY(a.date) - parseDMY(b.date));
};

// ---- ACTS (НОВОЕ) ----
// получить все work-акты тренера
const fetchActsForCoach = async (username) => {
  const filterFormula = `AND({coach}='${username}', {status}='work')`;
  let records = [];
  let offset = null;
  do {
    const res = await axios.get(airtableActsUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_API}` },
      params: { offset, pageSize: 100, filterByFormula: filterFormula },
    });
    records = records.concat(res.data.records);
    offset = res.data.offset;
  } while (offset);

  return records.map((r) => ({
    id: r.id,
    coach: r.fields.coach,
    status: r.fields.status,
    period_start: r.fields.period_start, // "DD.MM.YYYY" (текст)
    period_end: r.fields.period_end, // "DD.MM.YYYY" (текст)
    act_number: r.fields.act_number, // "MSC-GE-8"
  }));
};

const parseActSuffix = (actNumber = "") => {
  const m = (actNumber || "").match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
};

const pickCurrentAct = (acts = []) => {
  if (!acts.length) return null;
  const sorted = [...acts].sort(
    (a, b) => parseDMY(b.period_end) - parseDMY(a.period_end)
  );
  return sorted[0];
};

const findPreviousAct = (allActs, currentAct) => {
  const suf = parseActSuffix(currentAct?.act_number);
  if (!suf || suf <= 1) return null;
  const prefix = currentAct.act_number.replace(/(\d+)\s*$/, "");
  const prevNum = suf - 1;
  const prevCode = `${prefix}${prevNum}`;
  return allActs.find((a) => a.act_number === prevCode) || null;
};

// PNL за диапазон [startDMY; endDMY] включительно (НОВОЕ)
const fetchPnlDataForRange = async (username, startDMY, endDMY) => {
  let records = [];
  let offset = null;
  const filterFormula = `OR({Coach}='${username}', {Second_coach}='${username}')`;
  do {
    const response = await axios.get(airtablePnlUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_API}` },
      params: { offset, pageSize: 100, filterByFormula: filterFormula },
    });
    records = records.concat(response.data.records);
    offset = response.data.offset;
  } while (offset);

  const start = parseDMY(startDMY);
  const end = parseDMY(endDMY);

  const arr = records
    .map((r) => ({
      date: r.fields.Data,
      coach: r.fields.Coach,
      secondCoach: r.fields.Second_coach,
      format: r.fields.Format,
      place: r.fields.Place,
      expense: r.fields.Expenses_coach || 0,
      secondExpense: r.fields.Expenses_second_coach || 0,
    }))
    .filter((rec) => {
      const d = parseDMY(rec.date);
      return d >= start && d <= end;
    })
    .sort((a, b) => parseDMY(a.date) - parseDMY(b.date));

  return arr;
};

// ----------------------- КЛАВИАТУРЫ -----------------------
const createDateKeyboard = () => {
  const kb = new InlineKeyboard();
  const now = new Date();
  const dates = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    dates.push(`${day}.${month}`);
  }
  kb.text(dates[0], dates[0]).row();
  for (let i = 4; i > 0; i--) kb.text(dates[i], dates[i]);
  kb.row();
  kb.text("🔄 Обновить даты", "refresh_dates").row();
  kb.text("💰 Посмотреть начисления", "view_pnl").row();
  return kb;
};

const createFormatKeyboard = () =>
  new InlineKeyboard()
    .text("ds", "ds")
    .row()
    .text("group", "group")
    .row()
    .text("personal", "personal")
    .row()
    .text("split", "split")
    .row()
    .text("⬅️ Вернуться", "back_to_dates")
    .row();

const createLocationKeyboard = (locations = []) => {
  const kb = new InlineKeyboard();
  for (const loc of locations) {
    const label = loc.label.charAt(0).toUpperCase() + loc.label.slice(1);
    kb.text(label, `location_${loc.id}`).row();
  }
  kb.text("⬅️ Вернуться", "back_to_format").row();
  return kb;
};

const createPeopleKeyboard = (userId, format) => {
  const st = ensureState(userId);
  const kb = new InlineKeyboard();
  const total = st.buttonIds.length;
  if (!total) return { keyboard: kb, currentSelection: "Нет данных" };

  const page = st.currentPage || 0;
  const start = page * BUTTONS_PER_PAGE;
  const end = Math.min(start + BUTTONS_PER_PAGE, total);
  const slice = st.buttonIds.slice(start, end);

  if (page > 0 && end < total)
    kb.text("⬅️ Назад", `prev_${page}`)
      .text("Еще люди ➡️", `next_${page}`)
      .row();
  else if (page > 0) kb.text("⬅️ Назад", `prev_${page}`).row();
  else if (end < total) kb.text("Еще люди ➡️", `next_${page}`).row();

  for (const { id, name } of slice) {
    if (format === "ds") {
      const count = st.buttonCounters[id] || 0;
      kb.text("➖", `minus_${id}`)
        .text(`(${count}) ${name}`, `pick_${id}`)
        .row();
    } else {
      const checked = !!st.buttonStates[id];
      kb.text(checked ? `${name} ✅` : name, `pick_${id}`).row();
    }
  }

  kb.text("⬅️ Вернуться", "back_to_location").text("ГОТОВО ✅", "done");

  const currentSelection = buildSummary(st);
  return { keyboard: kb, currentSelection };
};

// ----------------------- ОЧЕРЕДЬ ОТПРАВКИ -----------------------
const messageQueue = [];
let isProcessingQueue = false;

const processMessage = async (message) => {
  const { ctx, responseText, date, format } = message;
  const userId = ctx.from.id;
  const st = ensureState(userId);

  if (format === "ds") {
    const countsArr = Object.values(st.buttonCounters || {});
    const maxCount = countsArr.length ? Math.max(...countsArr) : 0;
    if (maxCount === 0) return;

    const messages = [];
    for (let i = 1; i <= maxCount; i++) {
      const people = Object.keys(st.buttonCounters)
        .filter((id) => st.buttonCounters[id] >= i)
        .map((id) => st.buttonIds.find((x) => x.id === id)?.name || "?");
      if (people.length > 0) {
        messages.push(
          `${ctx.from.username} / ${date} / ${format} // ${people.join(", ")}`
        );
      }
    }
    messages.reverse();
    await sendMessagesWithPause(messages);
  } else {
    await sendMessageToAirtable(responseText);
  }
};

const processQueue = async () => {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  try {
    while (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      try {
        await processMessage(msg);
      } catch (e) {
        console.error("processMessage error:", e);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    isProcessingQueue = false;
  }
};

// ----------------------- БОТ -----------------------
const initBot = async () => {
  bot.command("start", async (ctx) => {
    jlog(ctx, "cmd_start");

    const { id, username } = ctx.from;
    if (!(allowedIds.includes(id) || allowedUsers.includes(username))) {
      await ctx.reply("Отказ в доступе к боту");
      return;
    }

    ensureState(id);
    const st = userStates[id];

    const currentSelection = buildSummary(st);
    await ctx.reply(currentSelection + "\n\nВыберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  });

  const sendDateSelection = async (ctx) => {
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const currentSelection = buildSummary(st);
    await ctx.reply(currentSelection + "\n\nВыберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  };

  // --- Главные действия ---
  bot.callbackQuery(/^\d{2}\.\d{2}$/, async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "pick_date", { date: ctx.match[0] });

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.selectedDate = ctx.match[0];

    const currentSelection = buildSummary(st);
    await ctx.editMessageText(currentSelection + "\n\nВыберите формат:", {
      reply_markup: createFormatKeyboard(),
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/^(ds|group|personal|split)$/, async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "pick_format", { format: ctx.match[0] });

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.selectedFormat = ctx.match[0];

    if (st.selectedFormat === "ds") {
      let names = (
        await fetchDataFromAirtable(ctx.from.username, airtableUrl)
      ).map((r) => r.name);
      names.sort((a, b) => a.localeCompare(b));

      st.buttonTexts = names;
      st.buttonIds = names.map((name, i) => ({ id: `p_${i}`, name }));
      st.buttonStates = {};
      st.buttonCounters = Object.fromEntries(
        st.buttonIds.map(({ id }) => [id, 0])
      );
      st.currentPage = 0;

      const { keyboard, currentSelection } = createPeopleKeyboard(
        id,
        st.selectedFormat
      );
      await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
        reply_markup: keyboard,
        parse_mode: "HTML",
      });
    } else {
      let locs = getCache(st, "locations");
      if (!locs) {
        const raw = await fetchDataFromAirtable(
          ctx.from.username,
          airtablePlacesUrl
        );
        locs = raw.map((r, i) => ({
          id: `loc_${i}`,
          label: r.place,
          meaning: r.meaning,
        }));
        putCache(st, "locations", locs);
      }
      st.locations = locs;

      const currentSelection = buildSummary(st);
      await ctx.editMessageText(currentSelection + "\n\nВыберите локацию:", {
        reply_markup: createLocationKeyboard(locs),
        parse_mode: "HTML",
      });
    }
  });

  bot.callbackQuery(/^location_(loc_\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx);
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const locId = ctx.match[1];
    const loc = (st.locations || []).find((l) => l.id === locId);
    st.selectedLocation = loc?.meaning || "---";
    jlog(ctx, "pick_location", {
      loc_id: locId,
      loc_meaning: st.selectedLocation,
      loc_label: loc?.label || null,
    });

  // Всегда список имён (для group/personal/split)
  // Всегда свежий список имён
  let names = (
    await fetchDataFromAirtable(ctx.from.username, airtableUrl)
  ).map((r) => r.name);
  names.sort((a, b) => a.localeCompare(b));

  st.buttonTexts = names;
  st.buttonIds = names.map((name, i) => ({ id: `p_${i}`, name }));
  st.buttonStates = Object.fromEntries(
    st.buttonIds.map(({ id }) => [id, false])
  );
  st.buttonCounters = {};
  st.currentPage = 0;

  const { keyboard, currentSelection } = createPeopleKeyboard(
    id,
    st.selectedFormat
  );
  await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
    reply_markup: keyboard,
    parse_mode: "HTML",
  });
  });

  // Выбор людей
  bot.callbackQuery(/^pick_(p_\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx);
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const pid = ctx.match[1];

    if (st.selectedFormat === "ds") {
      st.buttonCounters[pid] = (st.buttonCounters[pid] || 0) + 1;
      jlog(ctx, "person_inc", {
        pid,
        name: st.buttonIds.find((x) => x.id === pid)?.name || "?",
      });
    } else {
      st.buttonStates[pid] = !st.buttonStates[pid];
      jlog(ctx, st.buttonStates[pid] ? "person_check_on" : "person_check_off", {
        pid,
        name: st.buttonIds.find((x) => x.id === pid)?.name || "?",
      });
    }

    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/^minus_(p_\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx);
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const pid = ctx.match[1];

    if ((st.buttonCounters?.[pid] || 0) > 0) st.buttonCounters[pid] -= 1;
    jlog(ctx, "person_dec", {
      pid,
      name: st.buttonIds.find((x) => x.id === pid)?.name || "?",
    });

    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  // Пагинация
  bot.callbackQuery(/prev_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "page_prev", { from_page: Number(ctx.match[1]) });

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.currentPage = Math.max(0, parseInt(ctx.match[1], 10) - 1);
    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(/next_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "page_next", { from_page: Number(ctx.match[1]) });

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st.currentPage = parseInt(ctx.match[1], 10) + 1;
    const { keyboard, currentSelection } = createPeopleKeyboard(
      id,
      st.selectedFormat
    );
    await ctx.editMessageText(currentSelection + "\n\nВыберите людей:", {
      reply_markup: keyboard,
      parse_mode: "HTML",
    });
  });

  // Готово
  bot.callbackQuery("done", async (ctx) => {
    await safeAnswerCb(ctx);
    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const username = ctx.from.username || `${ctx.from.id}`;
    const date = st.selectedDate;
    const format = st.selectedFormat;
    const location = st.selectedLocation;

    let responseText = "";
    if (format === "ds") {
      const selectedCounts = Object.entries(st.buttonCounters)
        .filter(([, v]) => v > 0)
        .map(
          ([pid, v]) =>
            `${v}x ${st.buttonIds.find((x) => x.id === pid)?.name || "?"}`
        );
      responseText = `${username} / ${date} / ${format} // ${selectedCounts.join(
        ", "
      )}`;
    } else {
      const selectedNames = Object.entries(st.buttonStates)
        .filter(([, v]) => v)
        .map(([pid]) => st.buttonIds.find((x) => x.id === pid)?.name || "?");
      responseText = `${username} / ${date} / ${format} / ${location} / ${selectedNames.join(
        ", "
      )}`;
    }

    // лог отправляемого сообщения
    jlog(ctx, "done_submit", {
      message: responseText,
      date,
      format,
      location: format === "ds" ? null : location,
    });

    void sendMessageToSupabase(ctx, responseText);

    try {
      await ctx.editMessageText(esc(responseText), { parse_mode: "HTML" });
    } catch (err) {
      console.error("Error editing message:", err);
    }

    try {
      await bot.api.sendMessage(SECONDARY_CHAT, responseText.trim());
    } catch (err) {
      console.error("Error sending to secondary chat:", err);
    }

    messageQueue.push({ ctx, responseText, date, format, location });
    processQueue();

    resetUserState(id);
    await sendDateSelection(ctx);
  });

  // Навигация/сброс
  bot.callbackQuery("back_to_start", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "nav_back_to_start");

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const currentSelection = buildSummary(st);
    await ctx.editMessageText(currentSelection + "\n\nВыберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("back_to_dates", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "nav_back_to_dates");

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const currentSelection = buildSummary(st);
    await ctx.editMessageText(currentSelection + "\n\nВыберите дату:", {
      reply_markup: createDateKeyboard(),
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("back_to_format", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "nav_back_to_format");

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];
    const currentSelection = buildSummary(st);
    await ctx.editMessageText(currentSelection + "\n\nВыберите формат:", {
      reply_markup: createFormatKeyboard(),
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery("back_to_location", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "nav_back_to_location");

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    if (st.selectedFormat === "ds") {
      const currentSelection = buildSummary(st);
      await ctx.editMessageText(currentSelection + "\n\nВыберите формат:", {
        reply_markup: createFormatKeyboard(),
        parse_mode: "HTML",
      });
    } else {
      let locs = st.locations;
      if (!locs?.length) {
        const raw = await fetchDataFromAirtable(
          ctx.from.username,
          airtablePlacesUrl
        );
        locs = raw.map((r, i) => ({
          id: `loc_${i}`,
          label: r.place,
          meaning: r.meaning,
        }));
        st.locations = locs;
      }
      const currentSelection = buildSummary(st);
      await ctx.editMessageText(currentSelection + "\n\nВыберите локацию:", {
        reply_markup: createLocationKeyboard(locs),
        parse_mode: "HTML",
      });
    }
  });

  bot.callbackQuery("refresh_dates", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "refresh_dates");

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    st._cache = null;
    st.selectedDate = "---";
    st.selectedFormat = "---";
    st.selectedLocation = "---";
    st.buttonStates = {};
    st.buttonCounters = {};

    const currentSelection = buildSummary(st);

    try {
      await ctx.editMessageText(currentSelection + "\n\nВыберите дату:", {
        reply_markup: createDateKeyboard(),
        parse_mode: "HTML",
      });
    } catch (e) {
      // глушим только "message is not modified"
      if (
        e instanceof GrammyError &&
        e.error_code === 400 &&
        /message is not modified/i.test(e.description || "")
      ) {
        // ничего не делаем
      } else {
        throw e;
      }
    }
  });

  // ----- НОВЫЙ поток PNL: два периода -----
  bot.callbackQuery("view_pnl", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "view_pnl");

    const kb = new InlineKeyboard()
      .text("Текущий период", "pnl_period_current")
      .row()
      .text("Предыдущий период", "pnl_period_prev")
      .row()
      .text("↩️ Вернуться", "back_to_dates")
      .row();

    await ctx.editMessageText("Выберите период для начислений:", {
      reply_markup: kb,
      parse_mode: "HTML",
    });
  });

  const showPnlForRange = async (ctx, startDMY, endDMY, label) => {
    const username = ctx.from.username;
    const pnl = await fetchPnlDataForRange(username, startDMY, endDMY);

    // кладём кэш для "детальной разбивки"
    const id = ctx.from.id;
    const st = ensureState(id);
    st.pnlDataCache = pnl;

    const totalRevenue = pnl.reduce((acc, r) => {
      if (r.coach === username) return acc + (r.expense || 0);
      if (r.secondCoach === username) return acc + (r.secondExpense || 0);
      return acc;
    }, 0);

    const kb = new InlineKeyboard()
      .text(`Детальная разбивка (${totalRevenue} ₽)`, "detailed_breakdown")
      .row()
      .text("↩️ Вернуться", "view_pnl")
      .row();

    await ctx.editMessageText(
      `${label}\nПериод: ${startDMY} — ${endDMY}\nИтого: ${totalRevenue} ₽`,
      { reply_markup: kb, parse_mode: "HTML" }
    );
  };

  bot.callbackQuery("pnl_period_current", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "pnl_pick_current");

    const username = ctx.from.username;
    const acts = await fetchActsForCoach(username);
    const current = pickCurrentAct(acts);

    if (!current) {
      await ctx.editMessageText("Не найден текущий акт со статусом work.", {
        reply_markup: new InlineKeyboard().text("↩️ Вернуться", "view_pnl"),
        parse_mode: "HTML",
      });
      return;
    }
    await showPnlForRange(
      ctx,
      current.period_start,
      current.period_end,
      `Начисления: Текущий период (акт ${current.act_number})`
    );
  });

  bot.callbackQuery("pnl_period_prev", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "pnl_pick_prev");

    const username = ctx.from.username;
    const acts = await fetchActsForCoach(username);
    const current = pickCurrentAct(acts);

    if (!current) {
      await ctx.editMessageText("Не найден текущий акт со статусом work.", {
        reply_markup: new InlineKeyboard().text("↩️ Вернуться", "view_pnl"),
        parse_mode: "HTML",
      });
      return;
    }

    const prev = findPreviousAct(acts, current);
    if (!prev) {
      await ctx.editMessageText(
        `Предыдущего периода нет (акт ${current.act_number}).`,
        {
          reply_markup: new InlineKeyboard().text("↩️ Вернуться", "view_pnl"),
          parse_mode: "HTML",
        }
      );
      return;
    }

    await showPnlForRange(
      ctx,
      prev.period_start,
      prev.period_end,
      `Начисления: Предыдущий период (акт ${prev.act_number})`
    );
  });

  // Детальная разбивка (использует st.pnlDataCache)
  bot.callbackQuery("detailed_breakdown", async (ctx) => {
    await safeAnswerCb(ctx);
    jlog(ctx, "pnl_detailed_breakdown");

    const id = ctx.from.id;
    ensureState(id);
    const st = userStates[id];

    const username = ctx.from.username;
    const pnl = st.pnlDataCache || [];

    const asCoach = pnl
      .filter((r) => r.coach === username)
      .map((r) => {
        const loc = r.format !== "ds" ? `, Локация: ${r.place}` : "";
        return `Дата: ${r.date}, Формат: ${r.format}${loc}, Сумма: ${r.expense} ₽`;
      })
      .join("\n");

    const asMentor = pnl
      .filter((r) => r.secondExpense > 0 && r.secondCoach === username)
      .map((r) => {
        const loc = r.format !== "ds" ? `, Локация: ${r.place}` : "";
        return `Дата: ${r.date}, Тренер: ${r.coach}, Формат: ${r.format}${loc}, Сумма: ${r.secondExpense} ₽`;
      })
      .join("\n");

    let text = `Ваши начисления как тренера:\n${asCoach || "Нет данных"}`;
    if (asMentor) text += `\n\nВаши начисления как ментора:\n${asMentor}`;

    const kb = new InlineKeyboard()
      .text("↩️ Вернуться в выбор периода", "view_pnl")
      .row();

    await ctx.editMessageText(esc(text), {
      reply_markup: kb,
      parse_mode: "HTML",
    });
  });

  // Глобальный catch
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`, err);
    if (err instanceof GrammyError) {
      console.error("Error in request:", err.description);
    } else if (err instanceof HttpError) {
      console.error("Could not contact Telegram:", err);
    } else {
      console.error("Unknown error:", err);
    }
  });
};

// ----------------------- ЗАПУСК (универсальный) -----------------------
(async () => {
  await initBot();

  const mode = (process.env.BOT_MODE || "polling").toLowerCase();

  if (mode === "polling") {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.start();
    console.log("Bot started in POLLING mode");
  } else if (mode === "webhook") {
    const express = require("express");
    const { webhookCallback } = require("grammy");

    const app = express();
    app.use(express.json());

    const url = process.env.WEBHOOK_URL;
    if (!url) throw new Error("WEBHOOK_URL is required in WEBHOOK mode");

    await bot.api.setWebhook({ url });
    app.use("/webhook", webhookCallback(bot, "express"));

    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log("Bot started in WEBHOOK mode on", port));
  } else {
    throw new Error(`Unknown BOT_MODE: ${mode}`);
  }
})();

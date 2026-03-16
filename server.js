// 📁 server.js — актуализирана версия
require('dotenv').config(); // Трябва да е най-отгоре
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const searchAbuseTracker = {};
const path = require('path');
const translateUsagePath = path.join(__dirname, 'translate_usage.json');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const ordersPath = path.join(__dirname, 'orders.json');
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
const settingsPath = path.join(__dirname, 'settings.json');
const nodemailer = require('nodemailer');
const cookieParser = require('cookie-parser');
const translationsPath = path.join(__dirname, 'translations.json');
const counterPath = path.join(__dirname, 'orderCounter.json');
const rateLimit = require('express-rate-limit');
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 5,              // до 5 заявки на минута на IP
  message: '🚫 Прекалено много опити за плащане. Моля, опитайте отново след малко.'
});

function generateSearchSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.ip
  );
}

function getNextOrderNumber() {
  try {
    const data = fs.readFileSync(counterPath, 'utf-8');
    const json = JSON.parse(data);
    json.lastOrderNumber += 1;
    fs.writeFileSync(counterPath, JSON.stringify(json, null, 2));
    return json.lastOrderNumber;
  } catch (err) {
    console.error('⚠️ Грешка при четене на orderCounter.json:', err);
    return Date.now(); // fallback уникално число
  }
}

let translateUsage = loadTranslateUsage();

let activeTranslations = 0;
const MAX_CONCURRENT_TRANSLATIONS = 5;

function cleanupAbuseTracker() {
  const now = Date.now();

  for (const ip of Object.keys(searchAbuseTracker)) {
    const entry = searchAbuseTracker[ip];

    if (
      now > entry.minuteWindowStart + 60 * 1000 &&
      now > entry.translationBlockedUntil &&
      now > entry.hardBlockedUntil
    ) {
      delete searchAbuseTracker[ip];
    }
  }
}

function checkIpAbuse(ip) {
  const now = Date.now();

  if (!searchAbuseTracker[ip]) {
    searchAbuseTracker[ip] = {
      minuteWindowStart: now,
      minuteCount: 0,
      translationBlockedUntil: 0,
      hardBlockedUntil: 0,
      alertSent: false
    };
  }

  const entry = searchAbuseTracker[ip];

  if (entry.hardBlockedUntil > now) {
    return { hardBlocked: true, translationAllowed: false };
  }

  if (entry.translationBlockedUntil > now) {
    return { hardBlocked: false, translationAllowed: false };
  }

  if (now - entry.minuteWindowStart > 60 * 1000) {
    entry.minuteWindowStart = now;
    entry.minuteCount = 0;
  }

  entry.minuteCount++;

  if (entry.minuteCount > 20) {
    entry.translationBlockedUntil = now + 24 * 60 * 60 * 1000;

    if (!entry.alertSent) {
      entry.alertSent = true;

      sendTelegramMessage(
        `⚠️ Suspicious search activity detected from IP ${ip}. Translation blocked for 24h.`
      );
    }

    return { hardBlocked: false, translationAllowed: false };
  }

  return { hardBlocked: false, translationAllowed: true };
}

// Зареждане на кеша с преводи
let translations = {};
try {
  translations = JSON.parse(fs.readFileSync(translationsPath, 'utf-8'));
} catch (err) {
  console.warn('⚠️ Неуспешно зареждане на translations.json, започваме с празен обект');
  translations = {};
}
// Конфигурация за Zoho Mail
const transporter = nodemailer.createTransport({
  host: process.env.ZOHO_SMTP_HOST,
  port: Number(process.env.ZOHO_SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.ZOHO_SMTP_USER,
    pass: process.env.ZOHO_SMTP_PASS
  }
});

// Telegram конфигурация
const TELEGRAM_BOT_TOKEN = '8074091356:AAHlninDNL8XFeKxJXs4q6EF5FG0qcrnF7U';
const TELEGRAM_CHAT_ID = '7367702928';
const TELEGRAM_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

const app = express();

app.set('trust proxy', 1);


app.get('/sitemap.xml', (req, res) => {
  res.header('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://youpart.net/</loc></url>
  <url><loc>https://youpart.net/product.html</loc></url>
  <url><loc>https://youpart.net/cart.html</loc></url>
  <url><loc>https://youpart.net/how-it-works.html</loc></url>
  <url><loc>https://youpart.net/delivery-returns.html</loc></url>
  <url><loc>https://youpart.net/legal.html</loc></url>
</urlset>`);
});

app.get('/search-session', (req, res) => {
  const token = generateSearchSessionToken();

  res.cookie('search_session', token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: false, // локално; на Render после ще стане true
    maxAge: 24 * 60 * 60 * 1000
  });

  res.json({ ok: true });
});

const { registerUser, loginUser } = require('./auth');
app.use(express.json());
app.post('/api/register', registerUser);
app.post('/api/login', loginUser);

function loadSettings() {
  try {
    const data = fs.readFileSync(settingsPath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('⚠️ Грешка при зареждане на settings.json:', err.message);
    return { markup: 1.2 };
  }
}

function getCurrentMonthKey() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function loadTranslateUsage() {
  try {
    if (fs.existsSync(translateUsagePath)) {
      const raw = fs.readFileSync(translateUsagePath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('❌ Грешка при четене на translate_usage.json:', e.message);
  }

  return {
    month: getCurrentMonthKey(),
    characters: 0,
    alertSent: false
  };
}

function saveTranslateUsage() {
  try {
    fs.writeFileSync(
      translateUsagePath,
      JSON.stringify(translateUsage, null, 2),
      'utf-8'
    );
  } catch (e) {
    console.error('❌ Грешка при запис на translate_usage.json:', e.message);
  }
}

function ensureTranslateUsageMonth() {
  const currentMonth = getCurrentMonthKey();

  if (translateUsage.month !== currentMonth) {
    translateUsage = {
      month: currentMonth,
      characters: 0,
      alertSent: false
    };

    saveTranslateUsage();
  }
}

function canUseGoogleTranslate() {
  ensureTranslateUsageMonth();
  return translateUsage.characters < 1000000;
}

function addTranslatedCharacters(count) {
  ensureTranslateUsageMonth();

  translateUsage.characters += count;
  saveTranslateUsage();
}

app.post('/api/settings', (req, res) => {
  try {
    const { markup, markupGlobal } = req.body;
    const data = {
      markup: Number(markup) || 1,
      markupGlobal: Number(markupGlobal) || 1
    };
    fs.writeFileSync('settings.json', JSON.stringify(data, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Грешка при запис в settings.json:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

const MESSAGES_FILE = path.join(__dirname, 'messages.json');
let messages = [];

if (fs.existsSync(MESSAGES_FILE)) {
  try {
    messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
  } catch (e) {
    console.error('❌ Грешка при четене на messages.json:', e.message);
  }
}

app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});



app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(cookieParser());
app.use(express.static(__dirname));

// Актуализиран endpoint за съобщения
app.post('/api/message', async (req, res) => {
  const { name, contact, message } = req.body;

  if (!name || !contact || !message) {
    return res.status(400).json({ error: 'Всички полета са задължителни.' });
  }

  try {
    // Записване на съобщението
    let messages = [];
    if (fs.existsSync(MESSAGES_FILE)) {
      messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
    }
    
    const newMessage = {
      id: Date.now(),
      name,
      contact,
      message,
      date: new Date().toISOString()
    };
    
    messages.push(newMessage);
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));

    // Изпращане на имейл до администратора
    const mailOptions = {
      from: '"YouPart" <contact@youpart.net>',
      to: 'contact@youpart.net',
      subject: 'Ново съобщение от контактната форма',
      text: `Име: ${name}\nКонтакт: ${contact}\nСъобщение: ${message}`
    };

    await transporter.sendMail(mailOptions);
    console.log('📧 Имейл изпратен до администратора');

    // Изпращане към Telegram
    const telegramMessage = `📥 НОВО СЪОБЩЕНИЕ:\n👤 ${name}\n📧 ${contact}\n💬 ${message}`;
    await axios.post(TELEGRAM_URL, {
      chat_id: TELEGRAM_CHAT_ID,
      text: telegramMessage
    });

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Грешка при обработка на съобщението:', err);
    res.status(500).json({ error: 'Грешка при изпращане' });
  }
});

app.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Всички полета са задължителни' });
  }

  const result = await registerUser({ email, password, name });
  if (!result.success) {
    return res.status(400).json({ error: result.message });
  }

  res.json({ success: true, message: 'Успешна регистрация' });
});

app.post('/api/settings', (req, res) => {
  const { markup } = req.body;

  if (markup === undefined || isNaN(markup)) {
    return res.status(400).json({ success: false, error: 'Невалидна стойност' });
  }

  try {
    fs.writeFileSync(settingsPath, JSON.stringify({ markup }, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Неуспешен запис на настройки:', err.message);
    res.status(500).json({ success: false });
  }
});

function isAllowedTranslationSource(req) {
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';

  return (
    origin.includes('youpart.net') ||
    referer.includes('youpart.net') ||
    origin.includes('localhost') ||
    referer.includes('localhost')
  );
}

function isAllowedSearchSource(req) {
  const origin = req.get('origin') || '';
  const referer = req.get('referer') || '';

  const allowedSources = [
    'https://youpart.net',
    'https://www.youpart.net',
    'http://localhost:3000'
  ];

  return allowedSources.some(src =>
    origin.startsWith(src) || referer.startsWith(src)
  );
}

// Ключови промени за обработка на бележките
function readOrders() {
  try {
    const raw = fs.readFileSync(ordersPath, 'utf-8');
    return raw.trim() ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('❌ Грешка при четене на orders.json:', err);
    return [];
  }
}


saveTranslateUsage();

app.post('/admin/update-note', (req, res) => {
  const { orderNumber, note } = req.body;
  
  try {
    const orders = readOrders();
    let orderFound = false;
    
    const updatedOrders = orders.map(order => {
      // Сравняваме като числа
      if (Number(order.orderNumber) === Number(orderNumber)) {
        orderFound = true;
        return { ...order, note };
      }
      return order;
    });

    if (!orderFound) {
      return res.status(404).json({ 
        success: false, 
        error: `Поръчка #${orderNumber} не е намерена` 
      });
    }

    fs.writeFileSync(ordersPath, JSON.stringify(updatedOrders, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Грешка при запис на бележка:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/archive', (req, res) => {
  const { orderNumber } = req.body;

  try {
    const orders = readOrders();
    const archive = fs.existsSync(path.join(__dirname, 'archive.json')) 
      ? JSON.parse(fs.readFileSync(path.join(__dirname, 'archive.json'), 'utf-8'))
      : [];
    
    // Сравняваме като числа
    const orderToArchive = orders.find(order => 
      Number(order.orderNumber) === Number(orderNumber)
    );
    
    if (!orderToArchive) {
      return res.status(404).json({ success: false, error: 'Поръчката не е намерена' });
    }

    archive.push(orderToArchive);
    fs.writeFileSync(path.join(__dirname, 'archive.json'), JSON.stringify(archive, null, 2));

    const updatedOrders = orders.filter(order => 
      Number(order.orderNumber) !== Number(orderNumber)
    );
    fs.writeFileSync(ordersPath, JSON.stringify(updatedOrders, null, 2));

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Грешка при архивиране:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Имейл и парола са задължителни' });
  }

  const result = await loginUser(email, password);
  if (!result.success) {
    return res.status(401).json({ error: result.message });
  }

  res.json({ success: true, message: 'Успешен вход', user: result.user });
});

const exchangeRates = {};
async function updateExchangeRates() {
  try {
    const response = await axios.get('https://open.er-api.com/v6/latest/USD');
    exchangeRates.BGN = response.data.rates.BGN;
    exchangeRates.EUR = response.data.rates.EUR;
    exchangeRates.GBP = response.data.rates.GBP;
    console.log('🔄 Обновени курсове:', exchangeRates);
  } catch (error) {
    console.error('❌ Грешка при обновяване на курсовете:', error.message);
  }
}

async function sendTelegramMessage(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      chat_id: telegramChatId,
      text: text
    });
  } catch (error) {
    console.error("❌ Telegram error:", error.message);
  }
}

async function notifyTranslateLimitReached() {
  if (translateUsage.alertSent) return;

  translateUsage.alertSent = true;
  saveTranslateUsage();

  try {
    await sendTelegramMessage(
      `⚠️ Google Translate limit reached: ${translateUsage.characters} characters for ${translateUsage.month}. Translation is now disabled.`
    );
  } catch (e) {
    console.error('❌ Грешка при изпращане на Telegram alert:', e.message);
  }
}

updateExchangeRates();
setInterval(updateExchangeRates, 3600000);

// Актуализирана функция за потвърдителни имейли
async function sendConfirmationEmail(order) {
  try {
    const emailTemplatePath = path.join(__dirname, 'email_template.json');
    const templateRaw = fs.readFileSync(emailTemplatePath, 'utf-8');
    const template = JSON.parse(templateRaw);

    const extra = parseFloat(order.extraCharge) || 0;
    const productList = order.items.map(item => 
      `🔹 ${item.title}\n💰 ${item.priceBGN} лв. / ${item.priceEUR} €\n`
    ).join('\n');

    const totalAmount = order.items.reduce((sum, item) => 
      sum + parseFloat(item.priceBGN), 0) + extra;

    const emailBody = template.body
      .replace('{{name}}', order.name)
      .replace('{{orderNumber}}', order.orderNumber)
      .replace('{{productList}}', productList)
      .replace('{{extraCharge}}', extra.toFixed(2))
      .replace('{{totalAmount}}', totalAmount.toFixed(2));

    // Използване на Zoho транспортера
    await transporter.sendMail({
      from: '"YouPart" <contact@youpart.net>',
      to: order.email,
      subject: template.subject,
      text: emailBody
    });

    console.log('📧 Имейл за потвърждение изпратен до клиента:', order.email);
  } catch (err) {
    console.error('❌ Грешка при изпращане на потвърдителен имейл:', err);
  }
}

app.post('/order', async (req, res) => {
  console.log('📥 Получена заявка за поръчка');
  console.log('➡️ Данни от клиента:', req.body);

  const order = {
    ...req.body,
    orderNumber: getNextOrderNumber(),
    createdAt: new Date().toISOString(),
    paid: false,
    archived: false
  };

  const messageItems = (order.items || []).map((item, index) => {
  const youpartLink = item.itemId && item.priceBGN
    ? `https://youpart.net/product.html?id=${item.itemId}&priceBGN=${item.priceBGN}`
    : 'няма';

  return `
🔹 Продукт ${index + 1}:
📦 ${item.title || 'неизвестен'}
💰 ${item.priceBGN || '??'} лв. (${item.priceEUR || '??'} €)
🔗 eBay: ${item.ebayLink || 'няма'}
🔗 YouPart: ${youpartLink}`;
}).join('\n');


  // Телеграм съобщение
  const message = `
🛒 НОВА ПОРЪЧКА #${order.orderNumber}:
👤 Име: ${order.name}
📧 Имейл: ${order.email}
📞 Телефон: ${order.phone}
🏠 Адрес: ${order.address}
${messageItems}
`;

  const telegramUrl = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  try {
    await axios.post(telegramUrl, {
      chat_id: telegramChatId,
      text: message
    });
  } catch (err) {
    console.error('❌ Неуспешно изпращане към Telegram:', err.message);
  }

  try {
    let orders = readOrders();

    const newOrder = {
      ...order,
      date: new Date().toISOString()
    };

    orders.push(newOrder);
    fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
    console.log('📦 Записана поръчка:', order);
    await sendConfirmationEmail(order);

    res.json({ success: true, orderNumber: order.orderNumber });

  } catch (err) {
    console.error('❌ Грешка при запис в orders.json:', err);
    res.status(500).json({ success: false });
  }
});


async function detectLanguage(text) {
  try {
    if (!canUseGoogleTranslate()) {
      return 'en';
    }

    const response = await axios.post(
      'https://translation.googleapis.com/language/translate/v2/detect',
      { q: text },
      {
        params: { key: process.env.GOOGLE_TRANSLATE_KEY }
      }
    );

    return response.data.data.detections[0][0].language;
  } catch (error) {
    console.error('❌ Грешка при разпознаване на езика:', error.message);
    return 'en';
  }
}


const translationCachePath = path.join(__dirname, 'translation_cache.json');
let translationCache = {};
try {
  if (fs.existsSync(translationCachePath)) {
    translationCache = JSON.parse(fs.readFileSync(translationCachePath, 'utf-8'));
  }
} catch (e) {
  console.error("⚠️ Грешка при зареждане на translation_cache.json:", e);
}

// 🧠 Кеширащ превод
async function cachedTranslate(text, sourceLang, targetLang) {
  const cacheKey = `${text}-${sourceLang}-${targetLang}`;

  if (translationCache[cacheKey]) {
    return translationCache[cacheKey];
  }

  const translated = await translateText(text, sourceLang, targetLang); // 👈 Тук трябва да се вика translateText, не cachedTranslate
  translationCache[cacheKey] = translated;
  return translated;
}


async function translateText(text, from, to) {
  try {

    if (activeTranslations >= MAX_CONCURRENT_TRANSLATIONS) {
      return text;
    }

    if (!canUseGoogleTranslate()) {
      await notifyTranslateLimitReached();
      return text;
    }

    activeTranslations++;

    const response = await axios.post(
      'https://translation.googleapis.com/language/translate/v2',
      null,
      {
        params: {
          q: text,
          source: from,
          target: to,
          key: process.env.GOOGLE_TRANSLATE_KEY
        }
      }
    );

    const translated = response.data.data.translations[0].translatedText;

    addTranslatedCharacters(String(text || '').length);

    if (!canUseGoogleTranslate()) {
      await notifyTranslateLimitReached();
    }

    return translated;

  } catch (error) {

    console.error('❌ Грешка при превод:', error.message);
    return text;

  } finally {

    activeTranslations--;

  }
}

const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 20, // до 20 search заявки на IP за минута
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Твърде много търсения. Опитайте отново след малко.' }
});

app.get('/search', searchLimiter, async (req, res) => {
  const clientIp = getClientIp(req);

  console.log("Search request IP:", clientIp);

  cleanupAbuseTracker();

  const ipCheck = checkIpAbuse(clientIp);

  if (ipCheck.hardBlocked) {
    return res.status(429).json({ error: "Too many requests" });
  }

  const translationAllowedForIp =
    ipCheck.translationAllowed && isAllowedTranslationSource(req);

  let query = req.query.part;
  const offset = parseInt(req.query.offset || '0');
  const region = req.query.region || 'europe';
  const condition = req.query.condition || 'used';

  if (!isAllowedSearchSource(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (query === 'random') {
    const sampleWords = ['brake', 'bumper', 'headlight', 'rims', 'liftgate'];
    query = sampleWords[Math.floor(Math.random() * sampleWords.length)];
  }

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing query' });
  }

  query = query.trim();

  if (query.length < 2 || query.length > 100) {
    return res.status(400).json({ error: 'Invalid search query' });
  }

  if (!query) return res.status(400).send('Грешка: Missing query');

  try {
    const lang = await detectLanguage(query);
    const translatedQuery = lang === 'bg' ? await cachedTranslate(query, 'bg', 'en') : query;

    const tokenRes = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${process.env.EBAY_BASE64}`
        },
      }
    );

    const filters = {};
    if (condition === 'used') {
      filters['filter'] = 'conditionIds:{3000}';
    } else if (condition === 'new') {
      filters['filter'] = 'conditionIds:{1000}';
    }
    
    const accessToken = tokenRes.data.access_token;
    const marketplaceId = region === 'global' ? 'EBAY_US' : 'EBAY_GB';

    const baseFilters = region === 'europe'
      ? {
          filter: 'sellerLocationCountry:GB',
          delivery_postal_code: 'WC2N5DU',
          fieldgroups: 'EXTENDED'
        }
      : {};

    const finalFilters = {
      ...baseFilters,
      ...(condition === 'used' ? { filter: (baseFilters.filter ? baseFilters.filter + ',' : '') + 'conditionIds:{3000}' } : {}),
      ...(condition === 'new' ? { filter: (baseFilters.filter ? baseFilters.filter + ',' : '') + 'conditionIds:{1000}' } : {})
    };

    const ebayRes = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': marketplaceId
      },
      params: {
        q: translatedQuery,
        limit: 10,
        offset,
        buying_options: 'FIXED_PRICE',
        sort: 'bestMatch',
        ...finalFilters
      }
    });

    const items = ebayRes.data.itemSummaries || [];
    const settings = loadSettings();
    const markup = settings.markup || 1.2;

    const results = await Promise.all(
      items.map(async (item) => {
        const priceValue = parseFloat(item?.price?.value) || 0;
        const shippingCost = parseFloat(item?.shippingOptions?.[0]?.shippingCost?.value) || 0;
        const totalPrice = priceValue + shippingCost;
        const currency = item.price.currency;

        let priceBGN = '—';
        let priceEUR = '—';

        if (currency === 'USD') {
          priceBGN = (totalPrice * exchangeRates.BGN * markup).toFixed(2);
          priceEUR = (totalPrice * exchangeRates.EUR * markup).toFixed(2);
        } else if (currency === 'EUR') {
          priceEUR = (totalPrice * markup).toFixed(2);
          priceBGN = (totalPrice * (exchangeRates.BGN / exchangeRates.EUR) * markup).toFixed(2);
        } else if (currency === 'GBP') {
          const gbpToBGN = exchangeRates.BGN / exchangeRates.GBP;
          const gbpToEUR = exchangeRates.EUR / exchangeRates.GBP;
          priceBGN = (totalPrice * gbpToBGN * markup).toFixed(2);
          priceEUR = (totalPrice * gbpToEUR * markup).toFixed(2);
        }

let translatedTitle;

if (translations[item.title]) {
  translatedTitle = translations[item.title];
} else if (translationAllowedForIp && canUseGoogleTranslate()) {
  translatedTitle = await cachedTranslate(item.title, 'en', 'bg');
  translations[item.title] = translatedTitle;

  fs.writeFileSync(translationsPath, JSON.stringify(translations, null, 2));
} else {
  translatedTitle = item.title;
}


        return {
          itemId: item.itemId,
          title: translatedTitle,
          image: item.image?.imageUrl || '',
          priceBGN,
          priceEUR,
          currency,
          priceOriginal: priceValue.toFixed(2),
          ebayLink: item.itemWebUrl || ''
        };
      })
    );

    res.json({ results, hasMore: items.length === 10 });
  } catch (err) {
    console.error('⚠️ Грешка при заявка към eBay /search:', err.message);
    res.status(500).json({ error: 'Product fetch failed' });
  }
});

async function getEbayAccessToken() {
  const res = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope'
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${process.env.EBAY_BASE64}`
      }
    }
  );

  return res.data.access_token;
}

app.get('/api/resolve-id', async (req, res) => {
  const rawUrl = req.query.url;
  const match = rawUrl.match(/\/itm\/(\d+)/);
  if (!match) return res.json({ error: 'Невалиден eBay линк (липсва itemId)' });

  const itemId = match[1];

  try {
    const accessToken = await getEbayAccessToken();
    const ebayRes = await axios.get(`https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
      }
    });

    const item = ebayRes.data;

    const result = {
      itemId: item.itemId,
      title: item.title || 'Неизвестен продукт',
      priceBGN: item.price?.value ? Math.round(parseFloat(item.price.value) * 1.95) : 0,
      region: 'global',
      query: 'custom'
    };

    console.log('🔗 Резолвнат eBay линк:', rawUrl);
    console.log('👉 Генериран itemId:', result.itemId);

    res.json(result);
  } catch (err) {
    console.error('❌ eBay ID resolution error:', err);
    res.json({ error: 'Неуспешна заявка към eBay' });
  }
});

app.get('/product', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing item ID' });

  try {
    const tokenRes = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.ebay.com/oauth/api_scope'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${process.env.EBAY_BASE64}`,
        },
      }
    );

    const accessToken = tokenRes.data.access_token;
    const ebayRes = await axios.get(`https://api.ebay.com/buy/browse/v1/item/${id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const item = ebayRes.data;
    const description = item.shortDescription || item.description || 'Няма описание';
    const title = item.title || 'Няма заглавие';
    const priceBGN = req.query.priceBGN || '—';
    const currency = req.query.currency || 'лв.';
    let priceEUR = '—';

    if (priceBGN !== '—' && exchangeRates.BGN && exchangeRates.EUR) {
      const bgn = parseFloat(priceBGN.replace(',', '.'));
      priceEUR = (bgn / exchangeRates.BGN * exchangeRates.EUR).toFixed(2);
    }

    const images = [];
    if (item.image?.imageUrl) images.push(item.image.imageUrl);
    if (item.additionalImages) {
      item.additionalImages.forEach(img => {
        if (img.imageUrl) images.push(img.imageUrl);
      });
    }

    res.json({
      title,
      price: priceBGN,
      priceEUR,
      currency,
      images,
      ebayLink: item.itemWebUrl || '#',
      description
    });

  } catch (err) {
    console.error('⚠️ Грешка при заявка към eBay /product:', err.message);
    res.status(500).json({ 
      error: 'Product fetch failed',
      title: req.query.title || 'Няма заглавие',
      price: req.query.priceBGN || '—',
      priceEUR: '—',
      currency: 'лв.',
      images: ['https://via.placeholder.com/300?text=No+Image'],
      ebayLink: '#',
      description: 'Няма налични данни за продукта'
    });
  }
});

app.get('/api/messages', (req, res) => {
  if (fs.existsSync(MESSAGES_FILE)) {
    try {
      const messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
      res.json(messages);
    } catch (e) {
      console.error('⚠️ Грешка при четене на съобщенията:', e.message);
      res.status(500).json({ error: 'Неуспешно четене' });
    }
  } else {
    res.json([]);
  }
});

app.get('/admin/archived-orders', (req, res) => {
  const archivedPath = path.join(__dirname, 'archived_orders.json');
  if (fs.existsSync(archivedPath)) {
    const data = fs.readFileSync(archivedPath, 'utf-8');
    res.json(JSON.parse(data));
  } else {
    res.json([]);
  }
});

app.get('/admin/orders', (req, res) => {
  try {
    const orders = readOrders();
    res.json({ orders });
  } catch (err) {
    console.error('❌ Грешка при четене на поръчките:', err);
    res.status(500).json({ error: 'Неуспешно зареждане на поръчки.' });
  }
});

app.get('/admin/archive', (req, res) => {
  try {
    const archivePath = path.join(__dirname, 'archive.json');
    if (!fs.existsSync(archivePath)) {
      return res.json({ orders: [] });
    }
    
    const rawData = fs.readFileSync(archivePath, 'utf-8');
    const archiveData = rawData.trim() ? JSON.parse(rawData) : [];
    res.json({ orders: archiveData });
    
  } catch (err) {
    console.error('❌ Грешка при четене на архива:', err);
    res.status(500).json({ error: 'Неуспешно зареждане на архива' });
  }
});

app.post('/api/reply', (req, res) => {
  const { id, reply } = req.body;

  if (!id || !reply) {
    return res.status(400).json({ error: 'ID и отговорът са задължителни' });
  }

  try {
    let messages = [];
    if (fs.existsSync(MESSAGES_FILE)) {
      messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
    }

    const index = messages.findIndex(m => m.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Съобщението не е намерено' });
    }

    messages[index].reply = reply;

    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf-8');
    console.log(`✉️ Добавен отговор към съобщение с ID ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Грешка при запис на отговор:', err.message);
    res.status(500).json({ error: 'Неуспешен запис' });
  }
});



app.post('/create-checkout-session', checkoutLimiter, async (req, res) => {
  try {
    const { items, orderNumber, extraCharge = 0 } = req.body;

    // Сума на артикулите
    let total = 0;
    for (const item of items) {
      const price = parseFloat(item.priceBGN);
      if (!isNaN(price)) total += price;
    }

    // Добави допълнителната такса
    total += parseFloat(extraCharge || 0);

    const totalAmount = Math.round(total * 100); // Stripe очаква в стотинки
    const DOMAIN = process.env.DOMAIN || 'http://localhost:3000';
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'bgn',
            product_data: {
              name: `Поръчка #${orderNumber}`
            },
            unit_amount: totalAmount
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      client_reference_id: orderNumber,
      success_url: `${DOMAIN}/success.html`,
      cancel_url: `${DOMAIN}/cancel.html`,
      // Добавете метаданни за orderNumber
      metadata: {
        orderNumber: orderNumber
      }
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Stripe session error:', err);
    res.status(500).json({ error: 'Stripe session creation failed' });
  }
});

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Stripe Webhook грешка при валидация:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

if (event.type === 'checkout.session.completed') {
  const session = event.data.object;
  const orderNumber = session.client_reference_id; // ✅ вече правилно

  console.log('✅ Успешно плащане за поръчка:', orderNumber);

  if (orderNumber) {
    const orders = readOrders();
    const updatedOrders = orders.map(order => {
      if (Number(order.orderNumber) === Number(orderNumber)) {
        return { ...order, paymentStatus: 'платена' };
      }
      return order;
    });

    fs.writeFileSync(ordersPath, JSON.stringify(updatedOrders, null, 2));
    console.log(`💾 Поръчка ${orderNumber} е отбелязана като платена.`);
  }
}


  res.status(200).send();
});

app.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
});




















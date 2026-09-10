// 📁 server.js — актуализирана версия с persistent storage (DATA_DIR)
require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const cookieParser = require('cookie-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ================== ENV ПРОВЕРКА ==================
console.log('🔧 ENV проверка:');
console.log('  STRIPE_SECRET_KEY:    ', process.env.STRIPE_SECRET_KEY ? '✅' : '❌ MISSING');
console.log('  STRIPE_WEBHOOK_SECRET:', process.env.STRIPE_WEBHOOK_SECRET ? '✅' : '❌ MISSING');
console.log('  TELEGRAM_BOT_TOKEN:   ', process.env.TELEGRAM_BOT_TOKEN ? '✅' : '❌ MISSING');
console.log('  TELEGRAM_CHAT_ID:     ', process.env.TELEGRAM_CHAT_ID ? '✅' : '❌ MISSING');
console.log('  ZOHO_SMTP_USER:       ', process.env.ZOHO_SMTP_USER ? '✅' : '❌ MISSING');
console.log('  GOOGLE_TRANSLATE_KEY: ', process.env.GOOGLE_TRANSLATE_KEY ? '✅' : '❌ MISSING');
console.log('  EBAY_BASE64:          ', process.env.EBAY_BASE64 ? '✅' : '❌ MISSING');
console.log('  DATA_DIR:             ', process.env.DATA_DIR || '(using __dirname)');

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// ================== PERSISTENT DATA DIR ==================
const DATA_DIR = process.env.DATA_DIR || __dirname;

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('📂 Създадена DATA_DIR:', DATA_DIR);
  } catch (e) {
    console.error('❌ Неуспешно създаване на DATA_DIR:', e.message);
  }
}

console.log('📂 Използвана DATA_DIR:', DATA_DIR);

const ordersPath          = path.join(DATA_DIR, 'orders.json');
const settingsPath        = path.join(DATA_DIR, 'settings.json');
const translationsPath    = path.join(DATA_DIR, 'translations.json');
const counterPath         = path.join(DATA_DIR, 'orderCounter.json');
const translateUsagePath  = path.join(DATA_DIR, 'translate_usage.json');
const translationCachePath= path.join(DATA_DIR, 'translation_cache.json');
const MESSAGES_FILE       = path.join(DATA_DIR, 'messages.json');
const archivePath         = path.join(DATA_DIR, 'archive.json');
const archivedOrdersPath  = path.join(DATA_DIR, 'archived_orders.json');
const emailTemplatePath   = path.join(DATA_DIR, 'email_template.json');

function ensureJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf-8');
      console.log('📄 Създаден файл:', filePath);
    } catch (e) {
      console.error(`❌ Неуспешно създаване на ${filePath}:`, e.message);
    }
  }
}

ensureJsonFile(ordersPath, []);
ensureJsonFile(settingsPath, { markup: 1.2, markupGlobal: 1.2 });
ensureJsonFile(translationsPath, {});
ensureJsonFile(counterPath, { lastOrderNumber: 1000 });
ensureJsonFile(MESSAGES_FILE, []);
ensureJsonFile(archivePath, []);
ensureJsonFile(archivedOrdersPath, []);
ensureJsonFile(translationCachePath, {});
ensureJsonFile(emailTemplatePath, {
  subject: 'Потвърждение на поръчка #{{orderNumber}}',
  body: 'Здравейте, {{name}}!\n\nВашата поръчка #{{orderNumber}} е платена.\n\n{{productList}}\n\nДопълнителна такса: {{extraCharge}} €\nОбщо: {{totalAmount}} €\n\nБлагодарим ви!\n\nYouPart'
});

// translate_usage има динамичен default (месец)
if (!fs.existsSync(translateUsagePath)) {
  const month = new Date().toISOString().slice(0, 7);
  fs.writeFileSync(translateUsagePath, JSON.stringify({
    month,
    characters: 0,
    alertSent: false
  }, null, 2), 'utf-8');
  console.log('📄 Създаден файл:', translateUsagePath);
}

// ================== IN-MEMORY STATE ==================
const searchAbuseTracker = {};
let activeTranslations = 0;
const MAX_CONCURRENT_TRANSLATIONS = 5;

// ================== HELPERS ==================
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
    json.lastOrderNumber = (json.lastOrderNumber || 1000) + 1;
    fs.writeFileSync(counterPath, JSON.stringify(json, null, 2));
    return json.lastOrderNumber;
  } catch (err) {
    console.error('⚠️ Грешка при четене на orderCounter.json:', err);
    return Date.now();
  }
}

function getCurrentMonthKey() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function readOrders() {
  try {
    const raw = fs.readFileSync(ordersPath, 'utf-8');
    return raw.trim() ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('❌ Грешка при четене на orders.json:', err.message);
    return [];
  }
}

function loadSettings() {
  try {
    const data = fs.readFileSync(settingsPath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('⚠️ Грешка при зареждане на settings.json:', err.message);
    return { markup: 1.2, markupGlobal: 1.2 };
  }
}

// ================== TRANSLATE USAGE ==================
let translateUsage = loadTranslateUsage();

function loadTranslateUsage() {
  try {
    if (fs.existsSync(translateUsagePath)) {
      const raw = fs.readFileSync(translateUsagePath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('❌ Грешка при четене на translate_usage.json:', e.message);
  }
  return { month: getCurrentMonthKey(), characters: 0, alertSent: false };
}

function saveTranslateUsage() {
  try {
    fs.writeFileSync(translateUsagePath, JSON.stringify(translateUsage, null, 2), 'utf-8');
  } catch (e) {
    console.error('❌ Грешка при запис на translate_usage.json:', e.message);
  }
}

function ensureTranslateUsageMonth() {
  const currentMonth = getCurrentMonthKey();
  if (translateUsage.month !== currentMonth) {
    translateUsage = { month: currentMonth, characters: 0, alertSent: false };
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

// ================== ABUSE TRACKER ==================
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

// ================== TRANSLATIONS CACHE ==================
let translations = {};
try {
  translations = JSON.parse(fs.readFileSync(translationsPath, 'utf-8'));
} catch (err) {
  console.warn('⚠️ Неуспешно зареждане на translations.json, започваме с празен обект');
  translations = {};
}

let translationCache = {};
try {
  translationCache = JSON.parse(fs.readFileSync(translationCachePath, 'utf-8'));
} catch (e) {
  console.error('⚠️ Грешка при зареждане на translation_cache.json:', e.message);
}

// ================== EMAIL / TELEGRAM ==================
const transporter = nodemailer.createTransport({
  host: process.env.ZOHO_SMTP_HOST,
  port: Number(process.env.ZOHO_SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.ZOHO_SMTP_USER,
    pass: process.env.ZOHO_SMTP_PASS
  }
});

// Проверка на SMTP при стартиране (не блокира)
transporter.verify((err) => {
  if (err) console.error('❌ Zoho SMTP не работи:', err.message);
  else console.log('✅ Zoho SMTP е готов за изпращане');
});

const TELEGRAM_URL = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;

async function sendTelegramMessage(text) {
  try {
    await axios.post(TELEGRAM_URL, { chat_id: telegramChatId, text });
  } catch (error) {
    console.error('❌ Telegram error:', error.message);
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

// ================== APP ==================
const app = express();

// ---------- STRIPE WEBHOOK (трябва да е ПРЕДИ express.json) ----------
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  // 🔍 DEBUG — изпълнява се САМО ако DEBUG_WEBHOOK=true в env
  if (process.env.DEBUG_WEBHOOK === 'true') {
    console.log('🔍 ===== WEBHOOK DEBUG =====');
    console.log('  sig header:', sig ? sig.substring(0, 40) + '...' : 'MISSING');
    console.log('  secret:', endpointSecret
      ? endpointSecret.substring(0, 12) + '...' + endpointSecret.slice(-4)
      : 'MISSING');
    console.log('  body is Buffer:', Buffer.isBuffer(req.body));
    console.log('  body length:', req.body?.length);
    console.log('  body first 100:', req.body?.toString().substring(0, 100));
    console.log('  content-type:', req.headers['content-type']);
    console.log('  ============================');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('✅ Подписът е валиден! Event type:', event.type);
  } catch (err) {
    console.error('❌ Stripe Webhook грешка при валидация:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Отговаряме ВЕДНАГА (важно за Stripe timeout)
  res.status(200).json({ received: true });

  // Обработката върви във фон
  if (event.type === 'checkout.session.completed') {
    setImmediate(() => {
      handleCheckoutCompleted(event).catch(err =>
        console.error('❌ Background обработка се провали:', err)
      );
    });
  }
});

async function handleCheckoutCompleted(event) {
  const session = event.data.object;
  const orderNumber = session.client_reference_id;

  console.log('💳 Checkout completed. orderNumber:', orderNumber,
              '| payment_status:', session.payment_status);

  if (!orderNumber) {
    console.error('❌ Липсва client_reference_id в Stripe session!');
    return;
  }

  if (session.payment_status !== 'paid') {
    console.log(`ℹ️ Плащането не е 'paid' (status: ${session.payment_status})`);
    return;
  }

  const orders = readOrders();
  const orderIndex = orders.findIndex(
    o => Number(o.orderNumber) === Number(orderNumber)
  );

  if (orderIndex === -1) {
    console.error(`❌ Поръчка #${orderNumber} НЕ е намерена в orders.json`);
    console.log('📋 Налични orderNumbers:', orders.map(o => o.orderNumber).slice(-10));
    return;
  }

  const order = orders[orderIndex];

  if (order.paymentStatus === 'платена') {
    console.log(`ℹ️ Поръчка #${orderNumber} вече е обработена (duplicate webhook)`);
    return;
  }

  order.paymentStatus = 'платена';
  order.paid = true;
  orders[orderIndex] = order;
  fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
  console.log(`💾 Поръчка #${orderNumber} записана като платена`);

  // 1) Имейл до клиента
  try {
    await sendConfirmationEmail(order);
    console.log(`📧 Имейл изпратен до ${order.email}`);
  } catch (err) {
    console.error('❌ Имейл грешка:', err.message);
  }

  // 2) Telegram до теб
  try {
    const messageItems = (order.items || []).map((item, i) => {
      const youpartLink = item.itemId
        ? `https://www.youpart.net/product.html?id=${encodeURIComponent(item.itemId)}`
        : 'няма';
      return `🔹 Продукт ${i + 1}:\n📦 ${item.title || 'неизвестен'}\n💰 ${item.priceEUR || '??'} €\n🔗 eBay: ${item.ebayLink || 'няма'}\n🔗 YouPart: ${youpartLink}`;
    }).join('\n');

    const message = `✅ ПЛАТЕНА ПОРЪЧКА #${order.orderNumber}
👤 Име: ${order.name}
📧 Имейл: ${order.email}
📞 Телефон: ${order.phone}
🏠 Адрес: ${order.address}

${messageItems}`;

    await axios.post(TELEGRAM_URL, {
      chat_id: telegramChatId,
      text: message
    });
    console.log(`📲 Telegram изпратен за #${orderNumber}`);
  } catch (err) {
    console.error('❌ Telegram грешка:', err.message);
  }
}

// ---------- JSON за всички останали routes ----------
app.use(express.json());

// Redirect youpart.net → www.youpart.net
app.use((req, res, next) => {
  const host = req.get('host');
  if (host === 'youpart.net') {
    return res.redirect(301, `https://www.youpart.net${req.originalUrl}`);
  }
  next();
});

app.set('trust proxy', 1);

// ================== RATE LIMITERS ==================
const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: '🚫 Прекалено много опити за плащане. Моля, опитайте отново след малко.'
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Твърде много търсения. Опитайте отново след малко.' }
});

const contactLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: '🚫 Прекалено много съобщения. Моля опитайте след малко.'
});

app.use(cookieParser());
app.use(express.static(__dirname));

// ================== AUTH ==================
const { registerUser, loginUser } = require('./auth');

app.post('/api/register', registerUser);
app.post('/api/login', loginUser);

app.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Всички полета са задължителни' });
  }
  const result = await registerUser({ email, password, name });
  if (!result.success) return res.status(400).json({ error: result.message });
  res.json({ success: true, message: 'Успешна регистрация' });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Имейл и парола са задължителни' });
  }
  const result = await loginUser(email, password);
  if (!result.success) return res.status(401).json({ error: result.message });
  res.json({ success: true, message: 'Успешен вход', user: result.user });
});

// ================== SETTINGS ==================
app.post('/api/settings', (req, res) => {
  try {
    const { markup, markupGlobal } = req.body;
    const data = {
      markup: Number(markup) || 1,
      markupGlobal: Number(markupGlobal) || 1
    };
    fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Грешка при запис в settings.json:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ================== SEO / STATIC ==================
app.get('/sitemap.xml', (req, res) => {
  res.header('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.youpart.net/</loc></url>
  <url><loc>https://www.youpart.net/product.html</loc></url>
  <url><loc>https://www.youpart.net/cart.html</loc></url>
  <url><loc>https://www.youpart.net/how-it-works.html</loc></url>
  <url><loc>https://www.youpart.net/delivery-returns.html</loc></url>
  <url><loc>https://www.youpart.net/legal.html</loc></url>
  <url><loc>https://www.youpart.net/brands/avtochasti-bmw.html</loc></url>
  <url><loc>https://www.youpart.net/brands/avtochasti-audi.html</loc></url>
  <url><loc>https://www.youpart.net/brands/avtochasti-toyota.html</loc></url>
</urlset>`);
});

app.get('/brands/:brand', (req, res) => {
  res.sendFile(path.join(__dirname, 'brands', 'index.html'));
});

app.get('/search-session', (req, res) => {
  const token = generateSearchSessionToken();
  res.cookie('search_session', token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  });
  res.json({ ok: true });
});

// ================== MESSAGES ==================
app.post('/api/message', contactLimiter, async (req, res) => {
  if (req.body.website) {
    return res.status(200).json({ success: true });
  }

  const { name, contact, message } = req.body;

  if (!name || !contact || !message) {
    return res.status(400).json({ error: 'Всички полета са задължителни.' });
  }

  try {
    let messages = [];
    if (fs.existsSync(MESSAGES_FILE)) {
      messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));
    }

    const newMessage = {
      id: Date.now(),
      name, contact, message,
      date: new Date().toISOString()
    };

    messages.push(newMessage);
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));

    const mailOptions = {
      from: '"YouPart" <contact@youpart.net>',
      to: 'contact@youpart.net',
      subject: 'Ново съобщение от контактната форма',
      text: `Име: ${name}\nКонтакт: ${contact}\nСъобщение: ${message}`
    };

    await transporter.sendMail(mailOptions);
    console.log('📧 Имейл изпратен до администратора');

    const telegramMessage = `📥 НОВО СЪОБЩЕНИЕ:\n👤 ${name}\n📧 ${contact}\n💬 ${message}`;
    await axios.post(TELEGRAM_URL, { chat_id: telegramChatId, text: telegramMessage });

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Грешка при обработка на съобщението:', err);
    res.status(500).json({ error: 'Грешка при изпращане' });
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
    if (index === -1) return res.status(404).json({ error: 'Съобщението не е намерено' });
    messages[index].reply = reply;
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), 'utf-8');
    console.log(`✉️ Добавен отговор към съобщение с ID ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Грешка при запис на отговор:', err.message);
    res.status(500).json({ error: 'Неуспешен запис' });
  }
});

// ================== ORDERS ==================
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

  try {
    const orders = readOrders();
    const newOrder = { ...order, date: new Date().toISOString() };
    orders.push(newOrder);
    fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
    console.log('📦 Записана неплатена поръчка:', order.orderNumber);
    res.json({ success: true, orderNumber: order.orderNumber });
  } catch (err) {
    console.error('❌ Грешка при запис в orders.json:', err);
    res.status(500).json({ success: false });
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

app.get('/admin/archived-orders', (req, res) => {
  try {
    if (fs.existsSync(archivedOrdersPath)) {
      const data = fs.readFileSync(archivedOrdersPath, 'utf-8');
      res.json(JSON.parse(data));
    } else {
      res.json([]);
    }
  } catch (err) {
    console.error('❌ Грешка при четене на archived_orders:', err.message);
    res.json([]);
  }
});

app.get('/admin/archive', (req, res) => {
  try {
    if (!fs.existsSync(archivePath)) return res.json({ orders: [] });
    const rawData = fs.readFileSync(archivePath, 'utf-8');
    const archiveData = rawData.trim() ? JSON.parse(rawData) : [];
    res.json({ orders: archiveData });
  } catch (err) {
    console.error('❌ Грешка при четене на архива:', err);
    res.status(500).json({ error: 'Неуспешно зареждане на архива' });
  }
});

app.post('/admin/update-note', (req, res) => {
  const { orderNumber, note } = req.body;
  try {
    const orders = readOrders();
    let orderFound = false;
    const updatedOrders = orders.map(order => {
      if (Number(order.orderNumber) === Number(orderNumber)) {
        orderFound = true;
        return { ...order, note };
      }
      return order;
    });
    if (!orderFound) {
      return res.status(404).json({ success: false, error: `Поръчка #${orderNumber} не е намерена` });
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
    const archive = fs.existsSync(archivePath)
      ? JSON.parse(fs.readFileSync(archivePath, 'utf-8'))
      : [];
    const orderToArchive = orders.find(order => Number(order.orderNumber) === Number(orderNumber));
    if (!orderToArchive) {
      return res.status(404).json({ success: false, error: 'Поръчката не е намерена' });
    }
    archive.push(orderToArchive);
    fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2));
    const updatedOrders = orders.filter(order => Number(order.orderNumber) !== Number(orderNumber));
    fs.writeFileSync(ordersPath, JSON.stringify(updatedOrders, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Грешка при архивиране:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================== EMAIL CONFIRMATION ==================
async function sendConfirmationEmail(order) {
  const templateRaw = fs.readFileSync(emailTemplatePath, 'utf-8');
  const template = JSON.parse(templateRaw);

  const extra = parseFloat(order.extraCharge) || 0;
  const productList = order.items.map(item =>
    `🔹 ${item.title}\n💰 ${parseFloat(item.priceEUR || 0).toFixed(2)} €\n`
  ).join('\n');

  const totalAmount = order.items.reduce(
    (sum, item) => sum + parseFloat(item.priceEUR || 0), 0
  ) + extra;

  const emailBody = template.body
    .replace('{{name}}', order.name)
    .replace('{{orderNumber}}', order.orderNumber)
    .replace('{{productList}}', productList)
    .replace('{{extraCharge}}', extra.toFixed(2))
    .replace('{{totalAmount}}', totalAmount.toFixed(2));

  await transporter.sendMail({
    from: '"YouPart" <contact@youpart.net>',
    to: order.email,
    subject: template.subject.replace('{{orderNumber}}', order.orderNumber),
    text: emailBody
  });
}

// ================== CURRENCY ==================
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

updateExchangeRates();
setInterval(updateExchangeRates, 3600000);

// ================== TRANSLATION ==================
async function detectLanguage(text) {
  try {
    if (!canUseGoogleTranslate()) return 'en';
    const response = await axios.post(
      'https://translation.googleapis.com/language/translate/v2/detect',
      { q: text },
      { params: { key: process.env.GOOGLE_TRANSLATE_KEY } }
    );
    return response.data.data.detections[0][0].language;
  } catch (error) {
    console.error('❌ Грешка при разпознаване на езика:', error.message);
    return 'en';
  }
}

async function translateText(text, from, to) {
  try {
    if (activeTranslations >= MAX_CONCURRENT_TRANSLATIONS) return text;
    if (!canUseGoogleTranslate()) {
      await notifyTranslateLimitReached();
      return text;
    }
    activeTranslations++;
    const response = await axios.post(
      'https://translation.googleapis.com/language/translate/v2',
      null,
      { params: { q: text, source: from, target: to, key: process.env.GOOGLE_TRANSLATE_KEY } }
    );
    const translated = response.data.data.translations[0].translatedText;
    addTranslatedCharacters(String(text || '').length);
    if (!canUseGoogleTranslate()) await notifyTranslateLimitReached();
    return translated;
  } catch (error) {
    console.error('❌ Грешка при превод:', error.message);
    return text;
  } finally {
    activeTranslations--;
  }
}

async function cachedTranslate(text, sourceLang, targetLang) {
  const cacheKey = `${text}-${sourceLang}-${targetLang}`;
  if (translationCache[cacheKey]) return translationCache[cacheKey];
  const translated = await translateText(text, sourceLang, targetLang);
  translationCache[cacheKey] = translated;
  return translated;
}

// ================== SOURCE VALIDATION ==================
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
  const allowedSources = ['https://www.youpart.net', 'http://localhost:3000'];
  return allowedSources.some(src => origin.startsWith(src) || referer.startsWith(src));
}

// ================== SEARCH ==================
app.get('/search', searchLimiter, async (req, res) => {
  const clientIp = getClientIp(req);
  console.log('Search request IP:', clientIp);

  cleanupAbuseTracker();
  const ipCheck = checkIpAbuse(clientIp);

  if (ipCheck.hardBlocked) {
    return res.status(429).json({ error: 'Too many requests' });
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

  try {
    const lang = await detectLanguage(query);
    const translatedQuery = lang === 'bg' ? await cachedTranslate(query, 'bg', 'en') : query;

    const tokenRes = await axios.post(
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

    const accessToken = tokenRes.data.access_token;
    const marketplaceId = region === 'global' ? 'EBAY_US' : 'EBAY_GB';

    const baseFilters = region === 'europe'
      ? { filter: 'sellerLocationCountry:GB', delivery_postal_code: 'WC2N5DU', fieldgroups: 'EXTENDED' }
      : {};

    const finalFilters = {
      ...baseFilters,
      ...(condition === 'used' ? { filter: (baseFilters.filter ? baseFilters.filter + ',' : '') + 'conditionIds:{3000}' } : {}),
      ...(condition === 'new'  ? { filter: (baseFilters.filter ? baseFilters.filter + ',' : '') + 'conditionIds:{1000}' } : {})
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

        let priceEUR = '—';
        if (currency === 'USD') {
          priceEUR = (totalPrice * exchangeRates.EUR * markup).toFixed(2);
        } else if (currency === 'EUR') {
          priceEUR = (totalPrice * markup).toFixed(2);
        } else if (currency === 'GBP') {
          const gbpToEUR = exchangeRates.EUR / exchangeRates.GBP;
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

// ================== EBAY HELPERS ==================
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
    console.error('❌ eBay ID resolution error:', err.message);
    res.json({ error: 'Неуспешна заявка към eBay' });
  }
});

app.get('/api/ebay-image-search', async (req, res) => {
  const oe = (req.query.oe || '').trim();
  if (!oe) return res.status(400).json({ error: 'Missing oe' });

  try {
    const accessToken = await getEbayAccessToken();
    const ebayRes = await axios.get('https://api.ebay.com/buy/browse/v1/item_summary/search', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB'
      },
      params: {
        q: oe,
        limit: 12,
        buying_options: 'FIXED_PRICE',
        sort: 'bestMatch',
        fieldgroups: 'EXTENDED',
        filter: 'conditionIds:{1000},sellerLocationCountry:GB',
        delivery_postal_code: 'WC2N5DU'
      }
    });

    const items = ebayRes.data.itemSummaries || [];
    const results = items.map(item => ({
      itemId: item.itemId || '',
      title: item.title || '',
      image: item.image?.imageUrl || '',
      ebayLink: item.itemWebUrl || ''
    })).filter(item => item.image);

    res.json({ oe, count: results.length, results });
  } catch (err) {
    console.error('⚠️ Грешка при /api/ebay-image-search:', err.message);
    res.status(500).json({ error: 'eBay image search failed' });
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
          Authorization: `Basic ${process.env.EBAY_BASE64}`
        }
      }
    );

    const accessToken = tokenRes.data.access_token;
    const ebayRes = await axios.get(`https://api.ebay.com/buy/browse/v1/item/${id}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const item = ebayRes.data;
    const description = item.shortDescription || item.description || 'Няма описание';
    const title = item.title || 'Няма заглавие';
    const settings = loadSettings();
    const markup = settings.markup || 1.2;

    const ebayPrice = parseFloat(item?.price?.value) || 0;
    const ebayCurrency = item?.price?.currency || '';
    const customPriceEUR = parseFloat(req.query.customPriceEUR);

    let priceEUR = '—';
    if (!isNaN(customPriceEUR) && customPriceEUR > 0) {
      priceEUR = customPriceEUR.toFixed(2);
    } else if (ebayPrice > 0) {
      if (ebayCurrency === 'EUR') {
        priceEUR = (ebayPrice * markup).toFixed(2);
      } else if (ebayCurrency === 'USD' && exchangeRates.EUR) {
        priceEUR = (ebayPrice * exchangeRates.EUR * markup).toFixed(2);
      } else if (ebayCurrency === 'GBP' && exchangeRates.EUR && exchangeRates.GBP) {
        const gbpToEUR = exchangeRates.EUR / exchangeRates.GBP;
        priceEUR = (ebayPrice * gbpToEUR * markup).toFixed(2);
      }
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
      priceEUR,
      currency: 'EUR',
      images,
      ebayLink: item.itemWebUrl || '#',
      description,
      localizedAspects: item.localizedAspects || []
    });
  } catch (err) {
    console.error('⚠️ Грешка при заявка към eBay /product:', err.message);
    res.status(500).json({
      error: 'Product fetch failed',
      title: req.query.title || 'Няма заглавие',
      priceEUR: '—',
      currency: 'EUR',
      images: ['https://via.placeholder.com/300?text=No+Image'],
      ebayLink: '#',
      description: 'Няма налични данни за продукта'
    });
  }
});

// ================== STRIPE CHECKOUT ==================
app.post('/create-checkout-session', checkoutLimiter, async (req, res) => {
  try {
    const { items, orderNumber, extraCharge = 0 } = req.body;

    let total = 0;
    for (const item of items) {
      const price = parseFloat(item.priceEUR);
      if (!isNaN(price)) total += price;
    }
    total += parseFloat(extraCharge || 0);

    const totalAmount = Math.round(total * 100);
    const DOMAIN = process.env.DOMAIN || 'http://localhost:3000';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `Поръчка #${orderNumber}` },
          unit_amount: totalAmount
        },
        quantity: 1
      }],
      mode: 'payment',
      client_reference_id: orderNumber,
      success_url: `${DOMAIN}/success.html`,
      cancel_url: `${DOMAIN}/cancel.html`,
      metadata: { orderNumber }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Stripe session error:', err);
    res.status(500).json({ error: 'Stripe session creation failed' });
  }
});

// ================== GLOBAL ERROR HANDLERS ==================
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 unhandledRejection:', reason);
});

// ================== START ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
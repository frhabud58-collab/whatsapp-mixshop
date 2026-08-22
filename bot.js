const { Client, LocalAuth, Poll, List, MessageMedia, Buttons } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs-extra');
const { CohereClient } = require('cohere-ai');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.static('public'));

const sessions = {};
const userStates = {};
const processedMsgs = new Set();

let DB = { orders: [], customers: [], stores: [], subscribers: [], supportTickets: [], stats: { messagesReceived: 0, totalOrders: 0, totalCustomers: 0, totalStores: 0 } };
const dbPath = './db.json';
if (fs.existsSync(dbPath)) DB = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

const DATA = fs.existsSync('./data.json') ? JSON.parse(fs.readFileSync('./data.json', 'utf8')) : { products: [], categories: [], offers: [], company: {} };

const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(DB, null, 2));
const logActivity = (t) => { console.log(t); fs.appendFileSync('./activity.log', `[${new Date().toLocaleString()}] ${t}\n`); };

const getUserState = (p) => {
    if (!userStates[p]) userStates[p] = { step: 'start', data: {}, history: [], greeted: false };
    return userStates[p];
};

// Cohere AI
const COHERE_API_KEY = 'cohere_6hLJz2Ffdg5zY1tL2Hzj74WoukB4UGzxWfdxWMvo1Gr0Nk';
const cohere = new CohereClient({ token: COHERE_API_KEY });

function getProductsContext() {
    if (!DATA.products || DATA.products.length === 0) return 'لا توجد منتجات حالياً.';
    return DATA.products.map(p => {
        let info = `- رقم: ${p.id}, الاسم: ${p.name}, السعر: ${p.price} ${p.currency || 'جنيه'}`;
        if (p.oldPrice) info += ` (كان ${p.oldPrice}), خصم: ${Math.round((1 - p.price / p.oldPrice) * 100)}%`;
        info += `, المخزون: ${p.stock}, التصنيف: ${p.category}, العلامة: ${p.brand}`;
        if (p.description) info += `, الوصف: ${p.description}`;
        return info;
    }).join('\n');
}

function getOffersContext() {
    if (!DATA.offers || DATA.offers.length === 0) return 'لا توجد عروض حالياً.';
    return DATA.offers.map(o => `- ${o.title}: ${o.description} (${o.duration})`).join('\n');
}

function buildSystemPrompt() {
    return `أنت MixBot، مساعد ذكي لشركة MIX SHOP (متجر إلكتروني). بتتكلم بالعامية المصرية بتاعة القاهرة، ودود وبتحب تساعد وبتهرج شوية. بتستخدم إيموجي بشكل طبيعي.

معلومات الشركة:
- اسم: ${DATA.company?.name || 'MIX SHOP'}
- الموقع: ${DATA.company?.website || 'https://mix-shop.xo.je/'}
- رقم الدعم: ${DATA.company?.supportPhone || '01274446542'}

المنتجات:
${getProductsContext()}

العروض:
${getOffersContext()}

قواعد مهمة:
- ردد على أرقام الأكشن بالظبط كما هي:
  [action:show_products] - عرض المنتجات
  [action:search:كلمة] - بحث عن منتج
  [action:buy] - شراء منتج
  [action:create_account] - عمل حساب
  [action:create_store] - فتح متجر
  [action:track_order] - تتبع طلب
  [action:support] - دعم فني
  [action:subscribe_offers] - اشتراك عروض
  [action:unsubscribe_offers] - إلغاء اشتراك
- ردود قصيرة ومباشرة
- لا تذكر نفسك كـ AI أو روبوت
- اقترح المنتجات والعروض على العميل`;
}

async function askAI(userMessage, phone) {
    try {
        const state = getUserState(phone);
        const chatHistory = (state.history || []).map(m => ({ role: m.role === 'user' ? 'USER' : 'CHATBOT', message: m.parts[0].text })).slice(-20);

        const response = await cohere.chat({
            model: 'command-a-03-2025',
            message: userMessage,
            chatHistory: chatHistory,
            preamble: buildSystemPrompt(),
            temperature: 0.7,
        });

        const text = response.text;
        if (!state.history) state.history = [];
        state.history.push({ role: 'user', parts: [{ text: userMessage }] });
        state.history.push({ role: 'model', parts: [{ text: text }] });
        if (state.history.length > 20) state.history = state.history.slice(-20);
        return text;
    } catch (err) {
        logActivity(`[AI ERROR] ${err.message}`);
        return null;
    }
}

// Product helpers
function searchProducts(query) {
    const q = query.toLowerCase().trim();
    return DATA.products.filter(p => p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q) || p.category.toLowerCase().includes(q) || p.brand.toLowerCase().includes(q));
}
function getProductById(id) { return DATA.products.find(p => p.id === parseInt(id)); }
function formatProduct(p) {
    let msg = `*${p.name}*\n${p.description || ''}\n💰 *${p.price} ${p.currency || 'جنيه'}*`;
    if (p.oldPrice) { const d = Math.round((1 - p.price / p.oldPrice) * 100); msg += ` (كان ${p.oldPrice}) 🔥 خصم ${d}%`; }
    msg += `\n📦 ${p.stock > 0 ? (p.stock > 10 ? 'متوفر' : `متبقي ${p.stock}`) : '❌ نفد'}`;
    msg += `\n📂 ${p.category} | 🏷️ ${p.brand}`;
    return msg;
}

// Data functions
function findCustomerByPhone(phone) { return DB.customers.find(c => c.phone === phone); }
function createCustomer(name, phone, email) { const c = { id: 'C' + Date.now(), name, phone, email: email || '', createdAt: new Date().toLocaleString('ar-EG'), status: 'active' }; DB.customers.push(c); DB.stats.totalCustomers++; saveDB(); return c; }
function createStore(ownerName, storeName, category, city, phone, description) { const s = { id: 'ST' + Date.now(), ownerName, storeName, category, city, phone, description, createdAt: new Date().toLocaleString('ar-EG'), status: 'pending' }; DB.stores.push(s); DB.stats.totalStores++; saveDB(); return s; }
function createOrder(items, customerName, phone, address, notes) {
    const orderId = '#' + Math.floor(Math.random() * 900000 + 100000);
    let total = 0;
    const orderItems = items.map(item => { const p = getProductById(item.productId); const sub = p ? p.price * item.qty : 0; total += sub; return { productId: item.productId, name: p?.name || 'غير معروف', price: p?.price || 0, qty: item.qty, subtotal: sub }; });
    const order = { id: orderId, customerName, phone, address, notes: notes || '', items: orderItems, total, currency: 'جنيه', status: 'pending', createdAt: new Date().toLocaleString('ar-EG') };
    DB.orders.push(order); DB.stats.totalOrders++; saveDB(); return order;
}
function getOrderByPhone(phone) { return DB.orders.filter(o => o.phone === phone); }
function createSupportTicket(name, phone, reason) { const t = { id: 'TK' + Date.now(), customerName: name, phone, reason, createdAt: new Date().toLocaleString('ar-EG'), status: 'open' }; if (!DB.supportTickets) DB.supportTickets = []; DB.supportTickets.push(t); saveDB(); return t; }
function subscribeToOffers(phone, name) { if (!DB.subscribers) DB.subscribers = []; if (DB.subscribers.find(s => s.phone === phone)) return false; DB.subscribers.push({ phone, name, subscribedAt: new Date().toLocaleString('ar-EG'), active: true }); saveDB(); return true; }
function unsubscribeFromOffers(phone) { if (!DB.subscribers) return false; const i = DB.subscribers.findIndex(s => s.phone === phone); if (i === -1) return false; DB.subscribers[i].active = false; saveDB(); return true; }

// Execute actions triggered by AI
async function executeAction(action, params, client, phone, name) {
    switch (action) {
        case 'show_products': {
            if (!DATA.products.length) return await client.sendMessage(phone, 'مفيش منتجات حالياً يا غالي');
            let msg = 'يلا نشوف اللي عندنا! 🛒\n\n';
            DATA.products.forEach(p => { msg += formatProduct(p) + '\n\n'; });
            msg += 'قوللي رقم لو عايز تشتري 😊';
            return await client.sendMessage(phone, msg);
        }
        case 'search': {
            const results = searchProducts(params.query || '');
            if (!results.length) return await client.sendMessage(phone, `مش لاقي حاجة باسم "${params.query}" 🤔\nجرّب كلمة تانية.`);
            let msg = `🔍 نتائج البحث عن "${params.query}":\n\n`;
            results.forEach((p, i) => { msg += `${i + 1}. ${formatProduct(p)}\n\n`; });
            msg += 'قوللي رقم لو عايز تشتري 😊';
            return await client.sendMessage(phone, msg);
        }
        case 'create_account': {
            const state = getUserState(phone);
            if (findCustomerByPhone(phone)) return await client.sendMessage(phone, `عندك حساب بالفعل يا ${name}! 😄`);
            state.step = 'collecting_account_name';
            return await client.sendMessage(phone, `يلا نعملك حساب يا ${name}! 🤝\nقوللي اسمك الكامل:`);
        }
        case 'create_store': {
            const state = getUserState(phone);
            state.step = 'collecting_store_owner';
            return await client.sendMessage(phone, 'يلا نعملك متجر! 🏪\nقوللي اسمك الكامل:');
        }
        case 'buy': {
            const state = getUserState(phone);
            state.step = 'buying_select_product';
            let msg = 'يلا نتسوق! 🛒 اختار رقم المنتج:\n\n';
            DATA.products.filter(p => p.stock > 0).forEach(p => { msg += `${p.id}️⃣ ${p.name} - ${p.price} ج.م\n`; });
            return await client.sendMessage(phone, msg);
        }
        case 'track_order': {
            const state = getUserState(phone);
            state.step = 'tracking_phone';
            return await client.sendMessage(phone, 'قوللي رقم تليفونك وأنا أقولك على حالة طلبك 📦');
        }
        case 'support': {
            const ticket = createSupportTicket(name, phone, params.reason || 'طلب دعم');
            return await client.sendMessage(phone, `📞 فريق الدعم هيتواصل معاك:\n\nرقم الدعم: *${DATA.company?.supportPhone || '01274446542'}*\nرقم التذكرة: ${ticket.id}\n\n💯 في أقرب وقت يا ${name}!`);
        }
        case 'subscribe_offers': {
            if (subscribeToOffers(phone, name)) return await client.sendMessage(phone, '🎉 تم تسجيلك! هنبعتلك أي عرض جديد.');
            return await client.sendMessage(phone, 'أنت مشترك بالفعل 😄');
        }
        case 'unsubscribe_offers': {
            if (unsubscribeFromOffers(phone)) return await client.sendMessage(phone, '✅ تم إلغاء الاشتراك.');
            return await client.sendMessage(phone, 'أنت مش مشترك أصلاً 😄');
        }
        default: return null;
    }
}

// Form steps handler
async function handleFormSteps(state, body, client, phone, name) {
    const step = state.step;

    if (step === 'collecting_account_name') { state.data.name = body; state.step = 'collecting_account_phone'; return await client.sendMessage(phone, `تمام يا ${body}! 🤝\nubicado رقم تليفونك:`); }
    if (step === 'collecting_account_phone') { state.data.phone = body; state.step = 'collecting_account_email'; return await client.sendMessage(phone, 'آخر حاجة - EMAIL (لو مش عايز اكتب "مش عايز"):'); }
    if (step === 'collecting_account_email') {
        state.data.email = body === 'مش عايز' ? '' : body;
        const c = createCustomer(state.data.name, state.data.phone, state.data.email);
        state.step = 'start'; state.data = {};
        return await client.sendMessage(phone, `يييس! تم الحساب يا ${c.name}! 🎉\n📱 تليفونك: ${c.phone}\n\nدلوقتي تقدر تتسوق 😎`);
    }

    if (step === 'collecting_store_owner') { state.data.ownerName = body; state.step = 'collecting_store_name'; return await client.sendMessage(phone, `حلو يا ${body}! 😄\nاسم المتجر:`); }
    if (step === 'collecting_store_name') { state.data.storeName = body; state.step = 'collecting_store_category'; return await client.sendMessage(phone, 'المتجر في أنهي مجال؟ (إلكترونيات، ملابس..)'); }
    if (step === 'collecting_store_category') { state.data.category = body; state.step = 'collecting_store_city'; return await client.sendMessage(phone, 'أي مدينة؟ 🏙️'); }
    if (step === 'collecting_store_city') { state.data.city = body; state.step = 'collecting_store_phone'; return await client.sendMessage(phone, 'رقم التليفون:'); }
    if (step === 'collecting_store_phone') { state.data.phone = body; state.step = 'collecting_store_desc'; return await client.sendMessage(phone, 'قولنا كلمة عن المتجر (بتبيع ايه):'); }
    if (step === 'collecting_store_desc') {
        state.data.description = body; state.step = 'collecting_store_confirm';
        return await client.sendMessage(phone, `يلا نشوف! 🏪\n\n👤 المالك: ${state.data.ownerName}\n🏪 المتجر: ${state.data.storeName}\n📂 المجال: ${state.data.category}\n🏙️ المدينة: ${state.data.city}\n📱 التليفون: ${state.data.phone}\n📝 الوصف: ${state.data.description}\n\nموافق قول "تمام" أو "لغي"`);
    }
    if (step === 'collecting_store_confirm') {
        if (['تمام', 'نعم', 'ايوه', 'موافق', 'افق', 'تأكيد'].some(w => body.includes(w))) {
            const s = createStore(state.data.ownerName, state.data.storeName, state.data.category, state.data.city, state.data.phone, state.data.description);
            state.step = 'start'; state.data = {};
            return await client.sendMessage(phone, `يييس! تم المتجر يا ${s.ownerName}! 🎉🏪\n📦 الاسم: ${s.storeName}\n🔖 رقم: ${s.id}\n\nفريق MIX SHOP هيتواصل معاك 💪`);
        } else { state.step = 'start'; state.data = {}; return await client.sendMessage(phone, 'مفيش مشكلة! تم الإلغاء 😊'); }
    }

    if (step === 'buying_select_product') {
        const p = getProductById(body);
        if (!p) return await client.sendMessage(phone, 'مش لاقي المنتج 🤔\nقوللي رقم تاني.');
        state.data.currentProduct = p; state.step = 'buying_qty';
        return await client.sendMessage(phone, `${p.name} اختيار ممتاز! 👌\nالسعر: ${p.price} ج.م\nعايز كام واحد؟`);
    }
    if (step === 'buying_qty') {
        const qty = parseInt(body);
        if (isNaN(qty) || qty < 1) return await client.sendMessage(phone, 'ادلنا رقم يا غالي 😅');
        if (!state.data.cart) state.data.cart = [];
        state.data.cart.push({ productId: state.data.currentProduct.id, qty }); state.step = 'buying_action';
        return await client.sendMessage(phone, `تمام! ${state.data.currentProduct.name} x${qty} ✅\n\n1️⃣ تضيف حاجة تانية\n2️⃣ تخلص الطلب\n3️⃣ تشوف السلة\nقوللي رقم 😊`);
    }
    if (step === 'buying_action') {
        if (body === '1' || body.includes('اضافة')) {
            state.step = 'buying_select_product';
            let list = 'اختار رقم:\n\n';
            DATA.products.forEach(p => { list += `${p.id}️⃣ ${p.name} - ${p.price} ج.م\n`; });
            return await client.sendMessage(phone, list);
        }
        if (body === '2' || body.includes('تمام') || body.includes('خلص')) {
            if (!state.data.cart?.length) { state.step = 'start'; return await client.sendMessage(phone, 'السلة فاضية 😅'); }
            state.step = 'buying_name';
            return await client.sendMessage(phone, 'قوللي اسمك 👤');
        }
        if (body === '3' || body.includes('سلة')) {
            if (!state.data.cart?.length) return await client.sendMessage(phone, 'السلة فاضية 😅');
            let msg = '🛒 السلة:\n\n'; let total = 0;
            state.data.cart.forEach((item, i) => { const p = getProductById(item.productId); if (p) { const sub = p.price * item.qty; total += sub; msg += `${i + 1}. ${p.name} x${item.qty} = ${sub} ج.م\n`; } });
            msg += `\n💰 الإجمالي: ${total} ج.م\n\nعايز تضيف حاجة ولا تخلص؟ 😊`;
            return await client.sendMessage(phone, msg);
        }
        return await client.sendMessage(phone, 'قوللي 1، 2، أو 3 😊');
    }
    if (step === 'buying_name') { state.data.customerName = body; state.step = 'buying_phone'; return await client.sendMessage(phone, `تمام يا ${body}! 🤝\nubicado رقم التليفون:`); }
    if (step === 'buying_phone') { state.data.customerPhone = body; state.step = 'buying_address'; return await client.sendMessage(phone, 'العنوان بالتفصيل (مدينة، شارع، علامة):'); }
    if (step === 'buying_address') { state.data.address = body; state.step = 'buying_notes'; return await client.sendMessage(phone, 'ملاحظات للتوصيل؟ (لو مش عايز اكتب "مش عايز"):'); }
    if (step === 'buying_notes') {
        state.data.notes = body === 'مش عايز' ? '' : body;
        let summary = '📋 الطلب:\n\n'; let total = 0;
        state.data.cart.forEach((item, i) => { const p = getProductById(item.productId); if (p) { const sub = p.price * item.qty; total += sub; summary += `${i + 1}. ${p.name} x${item.qty} = ${sub} ج.م\n`; } });
        summary += `\n💰 الإجمالي: ${total} ج.م\n👤 ${state.data.customerName}\n📱 ${state.data.customerPhone}\n📍 ${state.data.address}`;
        if (state.data.notes) summary += `\n📝 ${state.data.notes}`;
        summary += '\n\nكل حاجة تمام؟ قول "تمام" أو "لغي" 😊';
        state.step = 'buying_confirm';
        return await client.sendMessage(phone, summary);
    }
    if (step === 'buying_confirm') {
        if (['تمام', 'نعم', 'ايوه', 'موافق', 'تأكيد'].some(w => body.includes(w))) {
            const order = createOrder(state.data.cart, state.data.customerName, state.data.customerPhone, state.data.address, state.data.notes);
            io.emit('newOrder', order); state.step = 'start'; state.data = {};
            return await client.sendMessage(phone, `يييس! تم الطلب يا ${order.customerName}! 🎉\n🔖 رقم: ${order.id}\n💰 الإجمالي: ${order.total} ج.م\n⏳ الحالة: قيد المراجعة\n\nشكراً ليك 😊`);
        } else { state.step = 'start'; state.data = {}; return await client.sendMessage(phone, 'مفيش مشكلة! الإلغاء تم 😊'); }
    }

    if (step === 'tracking_phone') {
        const orders = getOrderByPhone(body); state.step = 'start';
        if (!orders.length) return await client.sendMessage(phone, `مش لاقي طلبات بالرقم ${body} 🤔\nكلمنا على ${DATA.company?.supportPhone || '01274446542'}`);
        let msg = '📦 طلباتك:\n\n';
        orders.forEach(o => { msg += `🔖 ${o.id} - ${o.customerName} - ${o.total} ج.م - ${o.status}\n📅 ${o.createdAt}\n\n`; });
        return await client.sendMessage(phone, msg);
    }

    return false;
}

// Welcome message for new customers
function getWelcomeMsg(name) {
    let productsList = '';
    const topProducts = DATA.products.filter(p => p.stock > 0).slice(0, 5);
    topProducts.forEach((p, i) => {
        productsList += `\n${i + 1}. *${p.name}* - ${p.price} ${p.currency || 'جنيه'}`;
        if (p.oldPrice) productsList += ` 🔥 خصم!`;
    });

    return `أهلاً وسهلاً يا ${name}! 👋🔥
أنا *MixBot*، مساعدك الذكي في *MIX SHOP*!

🛠️ خدماتنا:
🛒 تصفح وشراء المنتجات
📦 تتبع طلباتك
🏪 فتح متجر جديد
🏷️ عروض وخصومات حصرية
📞 الدعم الفني

${productsList ? `\n🔥 أكتر المنتجات مبيعاً:\n${productsList}\n` : ''}
💬 قولي عايز إيه وأنا هساعدك!`;
}

// Anti-spam: track last reply time per user
const lastReplyTime = {};

// Main message handler
async function handleMsg(sid, msg) {
    if (msg.fromMe) return;
    if (!msg.from || !msg.from.endsWith('@c.us')) return;

    DB.stats.messagesReceived = (DB.stats.messagesReceived || 0) + 1;
    saveDB(); io.emit('statsUpdate', DB.stats);

    const phone = msg.from;
    const name = msg.pushname || 'عميل';
    let body = msg.body?.trim() || "";
    const state = getUserState(phone);

    const msgId = msg.id?._serialized || Math.random().toString();
    if (processedMsgs.has(msgId)) return;
    processedMsgs.add(msgId);
    setTimeout(() => processedMsgs.delete(msgId), 30000);

    const client = sessions[sid]?.client;
    if (!client) return;

    if (msg.hasMedia) {
        logActivity(`[MEDIA] From: ${phone} Type: ${msg.type}`);
        return await client.sendMessage(phone, `شكراً يا ${name}! 😊\nمقدرش أشوف الصور حالياً.\nاكتبلي اللي عايزه بالكلام وأنا هساعدك! 🙏`);
    }

    logActivity(`[MSG] From: ${phone} Name: ${name} Body: ${body}`);

    if (!body || body.length === 0) return;

    const handled = await handleFormSteps(state, body, client, phone, name);
    if (handled) return;

    if (state.step !== 'start') return;

    if (!state.greeted) {
        state.greeted = true;
        const welcome = getWelcomeMsg(name);
        await client.sendMessage(phone, welcome);
        return;
    }

    const aiResponse = await askAI(body, phone);

    if (aiResponse) {
        const lower = aiResponse.toLowerCase();

        if (lower.includes('[action:show_products]')) { await executeAction('show_products', {}, client, phone, name); return; }
        if (lower.includes('[action:search]')) { const qMatch = aiResponse.match(/\[action:search:(.+?)\]/); await executeAction('search', { query: qMatch ? qMatch[1] : body }, client, phone, name); return; }
        if (lower.includes('[action:create_account]')) { await executeAction('create_account', {}, client, phone, name); return; }
        if (lower.includes('[action:create_store]')) { await executeAction('create_store', {}, client, phone, name); return; }
        if (lower.includes('[action:buy]')) { await executeAction('buy', {}, client, phone, name); return; }
        if (lower.includes('[action:track_order]')) { await executeAction('track_order', {}, client, phone, name); return; }
        if (lower.includes('[action:support]')) { await executeAction('support', { reason: body }, client, phone, name); return; }
        if (lower.includes('[action:subscribe_offers]')) { await executeAction('subscribe_offers', {}, client, phone, name); return; }
        if (lower.includes('[action:unsubscribe_offers]')) { await executeAction('unsubscribe_offers', {}, client, phone, name); return; }

        return await client.sendMessage(phone, aiResponse);
    }

    if (!lastReplyTime[phone] || Date.now() - lastReplyTime[phone] > 60000) {
        lastReplyTime[phone] = Date.now();
        return await client.sendMessage(phone, `معلش يا ${name} 😅\nفي مشكلة مؤقتة. كلمنا على ${DATA.company?.supportPhone || '01274446542'}`);
    }
}

// API Routes
app.get('/api/sessions', (req, res) => { res.json({ success: true, sessions: Object.keys(sessions).map(id => ({ id, ready: sessions[id].ready })) }); });
app.post('/api/add-session', (req, res) => { const { id } = req.body; if (!id || sessions[id]) return res.json({ success: false }); sessions[id] = { ready: false }; createSession(id); res.json({ success: true }); });
app.post('/api/delete-session', (req, res) => { const { id } = req.body; if (!sessions[id]) return res.json({ success: false }); sessions[id].client.destroy(); delete sessions[id]; res.json({ success: true }); });
app.get('/api/orders', (req, res) => res.json({ success: true, orders: DB.orders }));
app.get('/api/customers', (req, res) => res.json({ success: true, customers: DB.customers || [] }));
app.get('/api/stores', (req, res) => res.json({ success: true, stores: DB.stores || [] }));
app.get('/api/subscribers', (req, res) => res.json({ success: true, subscribers: DB.subscribers || [] }));
app.get('/api/products', (req, res) => res.json({ success: true, products: DATA.products }));
app.post('/api/products', (req, res) => { const p = { id: DATA.products.length + 1, ...req.body }; DATA.products.push(p); fs.writeFileSync('./data.json', JSON.stringify(DATA, null, 2)); res.json({ success: true, product: p }); });
app.post('/api/products/delete', (req, res) => { const i = DATA.products.findIndex(p => p.id === req.body.id); if (i === -1) return res.json({ success: false }); DATA.products.splice(i, 1); fs.writeFileSync('./data.json', JSON.stringify(DATA, null, 2)); res.json({ success: true }); });
app.get('/api/stats', (req, res) => res.json({ success: true, stats: DB.stats }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', company: 'MIX SHOP AI', version: '3.0', sessions: Object.keys(sessions).map(id => ({ id, ready: sessions[id].ready })) }));
app.get('/qr', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MIX SHOP - QR</title><style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#fff;flex-direction:column}img{width:300px;height:300px;border:3px solid #fff;border-radius:16px}h1{color:#e94560}#status{margin:20px;font-size:1.2em}</style></head><body><h1>MIX SHOP</h1><p>امسح الكود بالواتساب</p><img id="qr" src="" alt="QR"><p id="status">جاري تحميل QR...</p><script>const s=io();s.on('qrUpdate',d=>{document.getElementById('qr').src=d.qr;document.getElementById('status').textContent='امسح الكود بالواتساب 📱'});s.on('sessionReady',()=>{document.getElementById('status').textContent='تم الاتصال! ✅'});setTimeout(()=>fetch('/api/sessions').then(r=>r.json()).then(d=>{const s=d.sessions.find(s=>s.ready);if(s)document.getElementById('status').textContent='متصل بالفعل ✅'}),3000);</script><script src="/socket.io/socket.io.js"></script></body></html>`);
});
app.post('/api/send-campaign', async (req, res) => {
    const { sessionId, numbers, message } = req.body;
    const session = sessions[sessionId || 'default'];
    if (!session?.ready) return res.json({ success: false });
    let sent = 0;
    for (const num of numbers) { try { await session.client.sendMessage(num.includes('@c.us') ? num : `${num.replace(/\D/g, '')}@c.us`, message); sent++; await new Promise(r => setTimeout(r, 2000)); } catch (e) {} }
    res.json({ success: true, sent });
});
app.post('/api/config', (req, res) => {
    const sid = req.query.sessionId || 'default';
    if (!DB.sessions_config) DB.sessions_config = {};
    if (!DB.sessions_config[sid]) DB.sessions_config[sid] = { config: {} };
    DB.sessions_config[sid].config = req.body;
    if (req.body.companyName) DATA.company = { ...DATA.company, name: req.body.companyName };
    if (req.body.supportPhone) DATA.company = { ...DATA.company, supportPhone: req.body.supportPhone };
    if (req.body.website) DATA.company = { ...DATA.company, website: req.body.website };
    if (req.body.privacyPolicy) DATA.company = { ...DATA.company, privacyPolicy: req.body.privacyPolicy };
    saveDB(); fs.writeFileSync('./data.json', JSON.stringify(DATA, null, 2));
    res.json({ success: true });
});
app.get('/api/config', (req, res) => { const sid = req.query.sessionId || 'default'; res.json({ success: true, config: DB.sessions_config?.[sid]?.config || DATA.company || {} }); });

// Sessions
function createSession(sid) {
    if (!sessions[sid]) sessions[sid] = { ready: false };
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sid }),
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu', '--disable-extensions']
        }
    });
    sessions[sid].client = client;
    client.on('qr', q => { qrcodeTerminal.generate(q, { small: true }); QRCode.toDataURL(q, (e, url) => io.emit('qrUpdate', { id: sid, qr: url })); logActivity(`[QR] Session ${sid} waiting for scan...`); });
    client.on('ready', () => { sessions[sid].ready = true; logActivity(`[SUCCESS] Session ${sid} ONLINE!`); io.emit('sessionReady', { id: sid }); io.emit('statsUpdate', DB.stats); });
    client.on('authenticated', () => logActivity(`[AUTH] Session ${sid} Authenticated.`));
    client.on('auth_failure', (msg) => logActivity(`[AUTH FAIL] Session ${sid}: ${msg}`));
    client.on('disconnected', (reason) => { logActivity(`[DISCONNECTED] Session ${sid}: ${reason}`); sessions[sid].ready = false; });
    client.on('message', m => handleMsg(sid, m));
    client.on('message_create', m => { if (m.fromMe && m.type === 'poll_vote') handleMsg(sid, m); });
    client.on('error', (err) => logActivity(`[CLIENT ERROR] Session ${sid}: ${err.message}`));
    client.initialize().catch(e => logActivity(`Init Error: ${e.message}`));
}

server.listen(7860, '0.0.0.0', () => { logActivity("MIX SHOP AI v3.0 STARTED ON 7860"); createSession('default'); });

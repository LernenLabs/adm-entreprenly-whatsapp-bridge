'use strict';

/**
 * Entreprenly WhatsApp bridge — Multi-tenant.
 *
 * Manages one WhatsApp session per seller (identified by ownerEmail).
 * Sessions are initialised lazily on the first QR poll and persist across
 * restarts thanks to LocalAuth (each seller gets its own auth folder).
 *
 * REST API
 * --------
 *   GET  /health                    → { ok, sessions: [{ email, connected, phone }] }
 *   GET  /qr?email=X                → { qr, connected }   — starts session if not running
 *   POST /send                      → send a message on behalf of a seller
 *        body: { email, phone, content }   header: X-Bridge-Token
 *   GET  /                          → HTML status page (admin view)
 */

require('dotenv').config();
const express = require('express');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

// Two backends share one WhatsApp session via a manual "turn": only the active
// backend receives and answers incoming messages at any given time. The turn is
// changed from the /switch page.
const BACKENDS = {
  daop: (process.env.BACKEND_URL_DAOP || 'https://daop-api.entreprenly.online/api/v1').replace(/\/$/, ''),
  ap:   (process.env.BACKEND_URL_AP   || 'https://ap-api.entreprenly.online/api/v1').replace(/\/$/, ''),
};
let activeBackend = (process.env.DEFAULT_BACKEND || 'daop').toLowerCase();
if (!BACKENDS[activeBackend]) activeBackend = 'daop';
const backendUrl = () => BACKENDS[activeBackend];

const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN  || 'entreprenly-bridge-secret';
// Guards the /switch page; defaults to the bridge token when not set separately.
const SWITCH_TOKEN = process.env.SWITCH_TOKEN  || BRIDGE_TOKEN;
const PORT         = Number(process.env.PORT   || 3001);
const BROWSER_PATH = process.env.WHATSAPP_BROWSER_PATH || undefined;

// ── Session registry ─────────────────────────────────────────────────────────
// email → { client, state: { qr, connected, phone }, sellerId, businessName }
const sessions    = new Map();
const initializing = new Set(); // guard against duplicate init

// ── Helpers ──────────────────────────────────────────────────────────────────

function toPhone(jid) {
  const digits = String(jid || '').split('@')[0].replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

async function callBackend(path, body) {
  try {
    const res = await fetch(`${backendUrl()}${path}`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': BRIDGE_TOKEN },
      body   : JSON.stringify(body),
    });
    if (!res.ok) console.warn(`[backend] ${path} → ${res.status}`);
    return res.status === 204 ? {} : await res.json().catch(() => ({}));
  } catch (err) {
    console.warn(`[backend] ${path} falló: ${err.message}`);
    return null;
  }
}

/**
 * Downloads an incoming image. WhatsApp Web often has not finished fetching the media when
 * the 'message' event fires, so downloadMedia() can return nothing on the first try.
 */
async function downloadReceipt(msg, email, fromPhone) {
  const waits = [0, 2000, 5000];
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await new Promise(resolve => setTimeout(resolve, waits[attempt]));
    try {
      const media = await msg.downloadMedia();
      if (media?.data) return media;
      console.warn(`[whatsapp:${email}] Imagen de ${fromPhone} vacía (intento ${attempt + 1})`);
    } catch (err) {
      console.warn(`[whatsapp:${email}] Error descargando imagen de ${fromPhone} (intento ${attempt + 1}):`, err.message);
    }
  }
  console.warn(`[whatsapp:${email}] No se pudo descargar la imagen de ${fromPhone}`);
  return null;
}

// ── Session factory ───────────────────────────────────────────────────────────

async function initSession(email, sellerId = 1, businessName = 'Mi Negocio') {
  if (sessions.has(email) || initializing.has(email)) return;
  initializing.add(email);
  console.log(`[bridge] Iniciando sesión para ${email} …`);

  const state    = { qr: null, connected: false, phone: null };
  // Each seller gets its own auth folder so sessions are fully independent.
  const clientId = `seller-${email.replace(/[^a-z0-9]/gi, '-')}`;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId }),
    puppeteer: {
      headless: true,
      executablePath: BROWSER_PATH,
      timeout: 60_000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ],
    },
  });

  // Store before initialize() so /qr can return immediately.
  sessions.set(email, { client, state, sellerId, businessName });
  initializing.delete(email);

  client.on('qr', async (qr) => {
    state.qr        = qr;
    state.connected = false;
    console.log(`[whatsapp:${email}] Nuevo QR generado`);
    qrcodeTerminal.generate(qr, { small: true });
    await callBackend('/chatbot/whatsapp/bridge/qr', { qr, ownerEmail: email });
  });

  client.on('authenticated', () =>
    console.log(`[whatsapp:${email}] Sesión autenticada`));

  client.on('auth_failure', (m) =>
    console.error(`[whatsapp:${email}] Fallo de autenticación:`, m));

  client.on('ready', async () => {
    state.qr        = null;
    state.connected = true;
    state.phone     = toPhone(client.info?.wid?._serialized);
    console.log(`[whatsapp:${email}] Conectado como ${state.phone}`);
    await callBackend('/chatbot/whatsapp/bridge/status', {
      connected   : true,
      phone       : state.phone,
      businessName,
      sellerId,
      ownerEmail  : email,
    });
  });

  client.on('disconnected', async (reason) => {
    console.warn(`[whatsapp:${email}] Desconectado: ${reason}`);
    state.connected = false;
    state.qr        = null;
    await callBackend('/chatbot/whatsapp/bridge/status', {
      connected   : false,
      phone       : state.phone,
      businessName,
      sellerId,
      ownerEmail  : email,
    });
  });

  client.on('message', async (msg) => {
    // Ignore own messages, status broadcasts and groups.
    if (msg.fromMe || msg.from === 'status@broadcast' || msg.from.endsWith('@g.us')) return;

    const fromPhone = toPhone(msg.from);
    console.log(`[whatsapp:${email}] Llegó ${msg.type} de ${fromPhone} (media: ${msg.hasMedia})`);

    // Payment receipt image.
    if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
      try {
        const media = await downloadReceipt(msg, email, fromPhone);
        if (!media) {
          // Never drop a receipt silently: the client would wait for an answer that never comes.
          await client.sendMessage(msg.from, 'No pude leer tu imagen. ¿Puedes enviarla de nuevo?');
          return;
        }
        const image = `data:${media.mimetype};base64,${media.data}`;
        console.log(`[whatsapp:${email}] Comprobante de ${fromPhone} (${Math.round(media.data.length / 1024)} KB)`);
        const reply = await callBackend('/chatbot/whatsapp/webhook/receipt',
          { fromPhone, ownerEmail: email, image });
        if (!reply) console.warn(`[whatsapp:${email}] El backend no recibió el comprobante de ${fromPhone}`);
        if (reply?.content) await client.sendMessage(msg.from, reply.content);
      } catch (err) {
        console.warn(`[whatsapp:${email}] Error procesando comprobante:`, err.message);
      }
      return;
    }

    if (!msg.body?.trim()) return;

    let clientName = fromPhone;
    try {
      const contact = await msg.getContact();
      clientName = contact.pushname || contact.name || contact.number || fromPhone;
    } catch { /* keep phone */ }

    console.log(`[whatsapp:${email}] Mensaje de ${clientName} (${fromPhone}): ${msg.body}`);

    const reply = await callBackend('/chatbot/whatsapp/webhook', {
      fromPhone,
      clientName,
      content   : msg.body,
      ownerEmail: email,
    });

    if (reply?.content) {
      try {
        await client.sendMessage(msg.from, reply.content);
        console.log(`[whatsapp:${email}] Bot respondió: ${reply.content}`);
      } catch (err) {
        console.warn(`[whatsapp:${email}] No se pudo enviar respuesta:`, err.message);
      }
    }
  });

  client.initialize();
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

/** Health check — lists all active sessions. */
app.get('/health', (_req, res) => {
  const list = [...sessions.entries()].map(([email, s]) => ({
    email,
    connected: s.state.connected,
    phone    : s.state.phone,
  }));
  res.json({ ok: true, sessions: list });
});

/**
 * Returns the QR state for one seller.
 * If no session exists yet, starts one (first call triggers Puppeteer launch).
 * The frontend polls this endpoint every 5 s via the backend proxy.
 *
 * Query params:
 *   email  (required) — ownerEmail of the seller
 */
app.get('/qr', async (req, res) => {
  const { email, sellerId, businessName } = req.query;
  if (!email) return res.status(400).json({ error: 'email es requerido' });

  if (!sessions.has(email)) {
    // Fire-and-forget; next poll will see the session.
    initSession(email, Number(sellerId) || 1, businessName || 'Mi Negocio')
      .catch(err => console.error(`[bridge] init falló para ${email}:`, err));
    return res.json({ qr: null, connected: false });
  }

  const { state } = sessions.get(email);
  res.json({ qr: state.qr, connected: state.connected });
});

/**
 * Send a message through a seller's WhatsApp.
 * Called by the backend when a payment is approved etc.
 * Protected by X-Bridge-Token header.
 */
app.post('/send', async (req, res) => {
  if ((req.get('X-Bridge-Token') || '') !== BRIDGE_TOKEN)
    return res.status(403).json({ error: 'forbidden' });

  const { email, phone, content } = req.body || {};
  if (!email || !phone || !content)
    return res.status(400).json({ error: 'email, phone y content son requeridos' });

  const session = sessions.get(email);
  if (!session?.state.connected)
    return res.status(409).json({ error: 'WhatsApp no conectado para ese email' });

  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return res.status(400).json({ error: 'teléfono inválido' });

  try {
    await session.client.sendMessage(`${digits}@c.us`, String(content));
    console.log(`[bridge:${email}] Mensaje enviado a +${digits}`);
    res.json({ ok: true });
  } catch (err) {
    console.warn(`[bridge:${email}] No se pudo enviar a +${digits}:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

/**
 * Turn-switch page: pick which backend receives WhatsApp messages.
 * Open it as /switch?key=<SWITCH_TOKEN>; the buttons reuse that key.
 */
app.get('/switch', (req, res) => {
  const key = String(req.query.key || '');
  const button = (id, label) => {
    const isActive = activeBackend === id;
    return `<button class="opt${isActive ? ' active' : ''}" ${isActive ? 'disabled' : `onclick="sw('${id}')"`}>
      ${isActive ? '✅ ' : ''}${label}${isActive ? ' — activo' : ''}</button>`;
  };
  res.send(`<!doctype html><html lang="es"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Turno de WhatsApp — Entreprenly</title>
    <style>
      body{font-family:system-ui;background:#0f172a;color:#e2e8f0;margin:0;min-height:100vh;
        display:flex;align-items:center;justify-content:center}
      .box{background:#1e293b;padding:2rem;border-radius:16px;width:340px;text-align:center;
        box-shadow:0 10px 30px rgba(0,0,0,.4)}
      h1{font-size:1.2rem;margin:0 0 .25rem}
      p{color:#94a3b8;font-size:.9rem;margin:.25rem 0 1.5rem}
      .opt{display:block;width:100%;padding:1rem;margin:.5rem 0;border:0;border-radius:10px;
        font-size:1rem;cursor:pointer;background:#334155;color:#e2e8f0}
      .opt.active{background:#16a34a;color:#fff;cursor:default}
      .opt:not(.active):hover{background:#475569}
      .msg{font-size:.8rem;color:#94a3b8;margin-top:1rem;min-height:1rem}
    </style></head><body>
    <div class="box">
      <h1>📲 Turno de WhatsApp</h1>
      <p>El backend activo recibe y responde los mensajes.</p>
      ${button('daop', 'DAOP (Java)')}
      ${button('ap', 'AP (.NET)')}
      <div class="msg" id="msg"></div>
    </div>
    <script>
      const key = ${JSON.stringify(key)};
      async function sw(to){
        const m = document.getElementById('msg'); m.textContent = 'Cambiando…';
        try{
          const r = await fetch('/switch', { method:'POST',
            headers:{ 'Content-Type':'application/json' },
            body: JSON.stringify({ to, key }) });
          const d = await r.json();
          if (r.ok) location.href = '/switch?key=' + encodeURIComponent(key);
          else m.textContent = d.error || 'Error';
        } catch { m.textContent = 'Error de red'; }
      }
    </script></body></html>`);
});

/** Apply a turn switch. Protected by SWITCH_TOKEN (body.key or X-Bridge-Token). */
app.post('/switch', (req, res) => {
  const key = (req.body && req.body.key) || req.get('X-Bridge-Token') || '';
  if (key !== SWITCH_TOKEN) return res.status(403).json({ error: 'clave inválida' });

  const target = String((req.body && req.body.to) || '').toLowerCase();
  if (!BACKENDS[target]) return res.status(400).json({ error: 'backend desconocido' });

  activeBackend = target;
  console.log(`[bridge] Turno cambiado → ${activeBackend} (${backendUrl()})`);

  // Re-sync every already-connected session to the backend that just took the turn,
  // so it knows which WhatsApp accounts are linked (the 'ready' event only fired for
  // whichever backend was active at connection time).
  for (const [email, s] of sessions.entries()) {
    if (s.state.connected) {
      callBackend('/chatbot/whatsapp/bridge/status', {
        connected   : true,
        phone       : s.state.phone,
        businessName: s.businessName,
        sellerId    : s.sellerId,
        ownerEmail  : email,
      });
      console.log(`[bridge] Estado re-enviado a ${activeBackend}: ${email} (${s.state.phone})`);
    }
  }

  res.json({ ok: true, active: activeBackend, url: backendUrl() });
});

/** Admin HTML status page. */
app.get('/', async (_req, res) => {
  const rows = [...sessions.entries()].map(([email, { state }]) => {
    if (state.connected) {
      return `<tr><td>${email}</td><td>✅ ${state.phone}</td><td>Conectado</td></tr>`;
    }
    if (state.qr) {
      return `<tr><td>${email}</td><td>—</td><td>⏳ Esperando escaneo</td></tr>`;
    }
    return `<tr><td>${email}</td><td>—</td><td>🔄 Iniciando…</td></tr>`;
  });

  const table = rows.length
    ? `<table border="1" cellpadding="8"><tr><th>Email</th><th>Teléfono</th><th>Estado</th></tr>${rows.join('')}</table>`
    : '<p>No hay sesiones activas todavía.</p>';

  res.send(`<!doctype html><html lang="es"><head>
    <meta charset="utf-8"><meta http-equiv="refresh" content="10">
    <title>Entreprenly Bridge</title>
    <style>body{font-family:system-ui;padding:2rem;background:#f5f5f5}
    table{border-collapse:collapse;background:#fff}th{background:#f90;color:#fff}</style>
    </head><body><h1>Entreprenly WhatsApp Bridge</h1>${table}
    <p style="color:#888;font-size:12px">Recarga automática cada 10 s.</p>
    </body></html>`);
});

app.listen(PORT, () => {
  console.log(`[bridge] Multi-tenant bridge escuchando en puerto ${PORT}`);
  console.log(`[bridge] Backends → DAOP: ${BACKENDS.daop} | AP: ${BACKENDS.ap}`);
  console.log(`[bridge] Turno activo: ${activeBackend} (${backendUrl()})`);
  console.log(`[bridge] Estado: http://localhost:${PORT}  ·  Cambiar turno: http://localhost:${PORT}/switch`);
});

const express = require('express');
const cors = require('cors');
// const { Resend } = require('resend');  // aggiungi domani
// const admin = require('firebase-admin'); // aggiungi domani

const app = express();
app.use(express.json());
app.use(cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = null; // Resend: aggiungi pacchetto domani
const PORT = process.env.PORT || 3000;

// Firebase Admin: configurato domani
const firestoreAdmin = null;

app.post('/chat', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'API key non configurata.' });
  }
  const { messages, context, sessionId } = req.body;
  
  if (!sessionId || !messages || !context) {
    return res.status(400).json({ error: 'Parametri mancanti' });
  }

  if (!checkRateLimit(sessionId)) {
    return res.status(429).json({ error: 'Hai raggiunto il limite di messaggi per oggi. Torna domani.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        system: buildSystemPrompt(context),
        messages: messages.slice(-10) // ultimi 10 messaggi per memoria contestuale
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Errore API Anthropic');
    }

    const data = await response.json();
    const reply = data.content[0].text;

    res.json({ reply, usage: data.usage });
  } catch (error) {
    console.error('Errore:', error.message);
    res.status(500).json({ error: 'Errore del server. Riprova tra poco.' });
  }
});

// ─── Endpoint usato dalla versione attuale del frontend (index-2.html) ──
// L'app manda richieste già formattate in stile Anthropic — qui le passiamo
// dirette all'API, senza dover ricostruire context/sessionId come per /chat.
// ─── RATE LIMITING per /v1/messages — questa route NON aveva alcun limite, ───
// ed è chiamata direttamente da 16 punti diversi del frontend. Senza un
// limite, chiunque conosca l'URL del proxy (pubblico, è in un'app web) può
// fare richieste illimitate consumando il budget Anthropic API a piacimento,
// anche bypassando completamente l'app. Limite per IP: generoso per un uso
// normale, ma chiude la porta a un abuso automatizzato.
const ipRateLimits = new Map();
const MAX_REQUESTS_PER_IP_PER_HOUR = 60;

function checkIpRateLimit(ip) {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  if (!ipRateLimits.has(ip)) {
    ipRateLimits.set(ip, { count: 1, resetAt: now + hourMs });
    return true;
  }
  const limit = ipRateLimits.get(ip);
  if (now > limit.resetAt) {
    ipRateLimits.set(ip, { count: 1, resetAt: now + hourMs });
    return true;
  }
  if (limit.count >= MAX_REQUESTS_PER_IP_PER_HOUR) return false;
  limit.count++;
  return true;
}

// ─── COST TRACKER IN MEMORIA ─────────────────────────────────────────────────
// Conta ogni chiamata AI e stima il costo in USD dai token usati.
// Si resetta al riavvio del server (Render lo fa automaticamente ogni ~24h).
// Per dati storici, usa il dashboard di Anthropic Console.
const costTracker = {
  totalCalls: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  todayCalls: 0,
  todayCostUsd: 0,
  startedAt: new Date().toISOString()
};

// Reset contatori giornalieri a mezzanotte
setInterval(function() {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() < 1) {
    costTracker.todayCalls = 0;
    costTracker.todayCostUsd = 0;
  }
}, 60 * 1000); // controlla ogni minuto

// ─── ENDPOINT /stats — dashboard costi in tempo reale ────────────────────────
// Accessibile solo con la password admin. Mostra quante chiamate e quanto
// sta costando il proxy in questa sessione. Utile per il lancio.
app.get('/stats', (req, res) => {
  const password = req.query.key;
  if (password !== process.env.STATS_PASSWORD && password !== 'EDOARDO2026') {
    return res.status(401).json({ error: 'Non autorizzato.' });
  }
  res.json({
    uptime_since: costTracker.startedAt,
    total: {
      calls: costTracker.totalCalls,
      input_tokens: costTracker.totalInputTokens,
      output_tokens: costTracker.totalOutputTokens,
      cost_usd: parseFloat(costTracker.totalCostUsd.toFixed(4)),
      cost_eur: parseFloat((costTracker.totalCostUsd * 0.92).toFixed(4))
    },
    today: {
      calls: costTracker.todayCalls,
      cost_usd: parseFloat(costTracker.todayCostUsd.toFixed(4)),
      cost_eur: parseFloat((costTracker.todayCostUsd * 0.92).toFixed(4))
    },
    rate_limits: {
      active_ips: ipRateLimits.size,
      active_sessions: rateLimits.size,
      max_per_ip_per_hour: MAX_REQUESTS_PER_IP_PER_HOUR,
      max_chat_per_day: MAX_MESSAGES_PER_DAY
    }
  });
});

// Pulizia periodica delle mappe di rate limit per evitare crescita illimitata
// della memoria nel lungo periodo (gli IP/sessioni scaduti non vengono mai
// rimossi altrimenti, restano per sempre come voci morte nella Map).
setInterval(function() {
  const now = Date.now();
  [rateLimits, emailRateLimits, ipRateLimits].forEach(function(map) {
    map.forEach(function(value, key) {
      if (now > value.resetAt) map.delete(key);
    });
  });
}, 30 * 60 * 1000); // ogni 30 minuti

app.post('/v1/messages', async (req, res) => {
  // Check API key prima di tutto — errore chiaro se manca
  if (!ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY non configurata nelle variabili d\'ambiente Render');
    return res.status(503).json({ error: 'API key Anthropic non configurata. Vai su Render → Environment → aggiungi ANTHROPIC_API_KEY.' });
  }

  const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;
  if (!checkIpRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Troppe richieste. Riprova più tardi.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    // ─── TRACKING COSTI IN TEMPO REALE ──────────────────────────────────────
    // Stima il costo di ogni chiamata dai token usati e lo accumula in memoria.
    // Visibile dall'endpoint /stats — ti permette di sapere quanto stai spendendo
    // senza dover aspettare la bolletta di fine mese da Anthropic.
    if (data.usage) {
      const inputTokens  = data.usage.input_tokens  || 0;
      const outputTokens = data.usage.output_tokens || 0;
      // Prezzi Claude Sonnet 4.6: $3/1M input, $15/1M output
      const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
      costTracker.totalCalls++;
      costTracker.totalInputTokens  += inputTokens;
      costTracker.totalOutputTokens += outputTokens;
      costTracker.totalCostUsd      += costUsd;
      costTracker.todayCalls++;
      costTracker.todayCostUsd      += costUsd;
    }

    res.status(response.status).json(data);
  } catch (error) {
    console.error('Errore proxy /v1/messages:', error.message);
    res.status(500).json({ error: 'Errore del server. Riprova tra poco.' });
  }
});

// ─── STRIPE CHECKOUT ─────────────────────────────────────────────────────────
// Crea una Checkout Session Stripe e restituisce l'URL di redirect.
// Il frontend reindirizza l'utente su quella URL — Stripe gestisce tutto
// il pagamento in modo sicuro, noi non tocchiamo mai i dati della carta.
//
// Setup richiesto:
// 1. Crea account Stripe su stripe.com
// 2. Crea i prodotti "Foundri Pro Monthly" e "Foundri Pro Yearly" nel Dashboard
// 3. Copia i Price ID (price_xxx) e aggiornali nel frontend (STRIPE_PRICES)
// 4. Aggiungi STRIPE_SECRET_KEY alle variabili d'ambiente su Render
// 5. Configura webhook Stripe → https://foundri-proxy.onrender.com/stripe-webhook
// Stripe: configura domani
const stripe = null;

app.post('/create-checkout', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Pagamenti non ancora configurati. Contatta il supporto.' });
  }
  const { priceId, customerEmail, successUrl, cancelUrl, metadata } = req.body;
  if (!priceId || !successUrl) {
    return res.status(400).json({ error: 'Parametri mancanti.' });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: customerEmail || undefined,
      success_url: successUrl,
      cancel_url: cancelUrl || successUrl,
      metadata: metadata || {},
      subscription_data: {
        metadata: metadata || {}
      },
      locale: 'it',
      allow_promotion_codes: true
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Errore creazione pagamento: ' + err.message });
  }
});

// ─── STRIPE WEBHOOK ──────────────────────────────────────────────────────────
// Riceve eventi da Stripe dopo il pagamento (checkout.session.completed).
// Aggiorna il piano dell'utente su Firestore quando il pagamento è confermato.
// Variabile env richiesta: STRIPE_WEBHOOK_SECRET (da Dashboard Stripe → Webhooks)
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.sendStatus(400);
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature invalid:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.customer_details?.email;
    const customerId = session.customer;
    console.log('Pagamento completato:', email, customerId);
    // Se Firebase Admin è disponibile, aggiorna il piano su Firestore
    if (firestoreAdmin && email) {
      try {
        await firestoreAdmin.collection('subscriptions').doc(email.replace(/[@.]/g, '_')).set({
          plan: 'pro',
          stripeCustomerId: customerId,
          activatedAt: new Date().toISOString(),
          email: email
        });
        console.log('Piano Pro attivato per:', email);
      } catch(e) {
        console.error('Errore aggiornamento Firestore:', e.message);
      }
    }
  }
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Foundri AI Proxy' });
});

// ─── EMAIL TRANSAZIONALI (Resend) — richieste connessione + inviti team ──────
// Rate limit semplice per evitare abusi: max 20 email/ora per indirizzo mittente.
const emailRateLimits = new Map();
const MAX_EMAILS_PER_HOUR = 20;

function checkEmailRateLimit(key) {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  if (!emailRateLimits.has(key)) {
    emailRateLimits.set(key, { count: 1, resetAt: now + hourMs });
    return true;
  }
  const limit = emailRateLimits.get(key);
  if (now > limit.resetAt) {
    emailRateLimits.set(key, { count: 1, resetAt: now + hourMs });
    return true;
  }
  if (limit.count >= MAX_EMAILS_PER_HOUR) return false;
  limit.count++;
  return true;
}

function emailLayout(title, bodyHtml) {
  return `
    <div style="font-family:'DM Sans',Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#F4F2ED;">
      <div style="font-family:Georgia,serif;font-weight:800;font-size:18px;color:#0A0A0F;margin-bottom:20px;">
        Found<span style="color:#4B3FE4;">ri</span>
      </div>
      <div style="background:#FFFFFF;border:1px solid #E2DFD8;border-radius:14px;padding:24px;">
        <h2 style="font-size:16px;color:#0A0A0F;margin:0 0 12px;">${title}</h2>
        ${bodyHtml}
      </div>
      <div style="text-align:center;margin-top:20px;font-size:11px;color:#6B6860;">
        Hai ricevuto questa email perché usi Foundri — foundri.netlify.app
      </div>
    </div>`;
}

app.post('/send-email', async (req, res) => {
  if (!resend) {
    return res.status(503).json({ error: 'Servizio email non configurato sul server.' });
  }
  if (!firestoreAdmin) {
    return res.status(503).json({ error: 'Firebase Admin non configurato sul server.' });
  }

  const { type, toUid, fromName, teamName, appUrl } = req.body;
  if (!toUid || !type) {
    return res.status(400).json({ error: 'Parametri mancanti (toUid, type).' });
  }

  // Legge l'email SOLO lato server, con privilegi Admin — il client non ha
  // mai accesso a questo dato per via delle regole Firestore.
  let toEmail;
  try {
    const doc = await firestoreAdmin.collection('private_profiles').doc(toUid).get();
    if (!doc.exists || !doc.data().email) {
      return res.status(404).json({ error: 'Profilo o email del destinatario non trovati.' });
    }
    // Rispetta la preferenza dell'utente impostata nella pagina Impostazioni.
    // Default true se il campo non esiste (utenti registrati prima di questa
    // feature) — coerente con l'inizializzazione lato client.
    if (doc.data().emailNotificationsEnabled === false) {
      return res.json({ ok: true, skipped: 'Notifiche email disattivate dal destinatario.' });
    }
    toEmail = doc.data().email;
  } catch (e) {
    console.error('Errore lettura private_profiles:', e.message);
    return res.status(500).json({ error: 'Errore nel recupero del destinatario.' });
  }

  if (!checkEmailRateLimit(toEmail)) {
    return res.status(429).json({ error: 'Troppe email inviate a questo indirizzo, riprova più tardi.' });
  }

  const link = appUrl || 'https://foundri.netlify.app';
  let subject, bodyHtml;

  if (type === 'connection_request') {
    subject = `${fromName || 'Un founder'} vuole connettersi con te su Foundri`;
    bodyHtml = emailLayout(
      'Nuova richiesta di connessione',
      `<p style="font-size:14px;color:#0A0A0F;line-height:1.6;"><strong>${fromName || 'Un founder'}</strong> vuole connettersi con te su Foundri.</p>
       <a href="${link}" style="display:inline-block;margin-top:14px;background:#4B3FE4;color:white;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:700;font-size:13px;">Apri Foundri →</a>`
    );
  } else if (type === 'team_invite') {
    subject = `${fromName || 'Un founder'} ti ha invitato nel team "${teamName || ''}"`;
    bodyHtml = emailLayout(
      'Invito a un team',
      `<p style="font-size:14px;color:#0A0A0F;line-height:1.6;"><strong>${fromName || 'Un founder'}</strong> ti ha invitato a entrare nel team <strong>${teamName || ''}</strong> su Foundri.</p>
       <a href="${link}" style="display:inline-block;margin-top:14px;background:#4B3FE4;color:white;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:700;font-size:13px;">Apri Foundri →</a>`
    );
  } else {
    return res.status(400).json({ error: 'Tipo email non valido.' });
  }

  try {
    await resend.emails.send({
      from: 'Foundri <onboarding@resend.dev>',
      to: toEmail,
      subject: subject,
      html: bodyHtml
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Errore invio email:', error.message);
    res.status(500).json({ error: 'Invio email fallito.' });
  }
});

app.listen(PORT, () => {
  console.log(`Foundri AI Proxy in ascolto sulla porta ${PORT}`);
});

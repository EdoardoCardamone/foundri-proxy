const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());
app.use(cors());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const PORT = process.env.PORT || 3000;

// ─── FIREBASE ADMIN SDK ───────────────────────────────────────────────────────
// Usato SOLO lato server per leggere l'email del destinatario di una notifica
// (collection private_profiles, non leggibile dal client per design di
// sicurezza). Le credenziali di servizio bypassano le regole Firestore — è
// esattamente il loro scopo, e per questo non devono mai finire nel frontend.
// Env var richiesta su Render: FIREBASE_SERVICE_ACCOUNT_JSON (il contenuto
// JSON completo del file di servizio, come stringa).
let firestoreAdmin = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firestoreAdmin = admin.firestore();
    console.log('Firebase Admin SDK inizializzato correttamente.');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT_JSON non impostata — le notifiche email per uid saranno disabilitate.');
  }
} catch (e) {
  console.error('Errore inizializzazione Firebase Admin:', e.message);
}

// Rate limiting semplice per utente
const rateLimits = new Map();
const MAX_MESSAGES_PER_DAY = 30;

function checkRateLimit(sessionId) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  
  if (!rateLimits.has(sessionId)) {
    rateLimits.set(sessionId, { count: 0, resetAt: now + dayMs });
    return true;
  }
  
  const limit = rateLimits.get(sessionId);
  if (now > limit.resetAt) {
    rateLimits.set(sessionId, { count: 0, resetAt: now + dayMs });
    return true;
  }
  
  if (limit.count >= MAX_MESSAGES_PER_DAY) return false;
  limit.count++;
  return true;
}

// Il cuore del prodotto — system prompt dinamico e contestuale
function buildSystemPrompt(context) {
  const {
    name,
    archetype,
    motivation,
    risk,
    ideaState,
    mainBarrier,
    time,
    modulesCompleted,
    problem,
    segment,
    vp,
    ll1Exercise,
    ll2Exercise,
    ll3Exercise,
    ll4Exercise,
    chatHistory
  } = context;

  // Costruisce il piano di passi personalizzato basato sul profilo
  const buildPersonalizedPath = () => {
    const steps = [];
    
    // Barriera principale determina il primo passo
    if (mainBarrier === 'Informativa') {
      steps.push('1. Prima cosa: definire il problema in modo specifico e testabile — non "aiuto i founder" ma "chi esattamente, in quale momento, con quale conseguenza"');
      steps.push('2. Trovare 5 persone che potrebbero avere quel problema — NON per presentare l\'idea, ma per capire come vivono quella difficoltà');
      steps.push('3. Fare 3 conversazioni Mom Test di 15 minuti ciascuna');
    } else if (mainBarrier === 'Psicologica') {
      steps.push('1. Non aspettare di sentirti "pronto" — non succede mai. Il primo passo è piccolo e reversibile: parla con UNA persona del problema');
      steps.push('2. Separare "l\'idea fallisce" da "io fallisco" — sono cose diverse. Un esperimento che non funziona è dati, non identità');
      steps.push('3. Fissare una scadenza corta e pubblica — "entro venerdì parlo con 3 persone del problema"');
    } else if (mainBarrier === 'Relazionale') {
      steps.push('1. Mappare chi conosci già: chi ha competenze che ti mancano? Chi conosce il tuo segmento meglio di te?');
      steps.push('2. Una coffee call a settimana con qualcuno di rilevante — non per "fare networking" ma per imparare qualcosa di specifico');
      steps.push('3. Entrare in almeno una community attiva dove stanno le persone che vuoi raggiungere come utenti');
    } else if (mainBarrier === 'Operativa') {
      steps.push('1. Non costruire niente ancora. Prima: 5 conversazioni Mom Test con persone che hanno il problema');
      steps.push('2. Definire la metrica di validazione — "so che il problema esiste davvero quando..."');
      steps.push('3. Smoke test: landing page che descrive la soluzione come se esistesse già — misura le email raccolte in 7 giorni');
    }

    // Stato idea aggiunge contesto
    if (ideaState === 'Ho già parlato con potenziali utenti') {
      steps.unshift('0. Sei già avanti rispetto alla media — hai già validazione qualitativa. Il prossimo passo è quantitativo: quante persone hanno questo problema con questa urgenza?');
    } else if (ideaState === 'Ho solo un\'intuizione vaga') {
      steps.unshift('0. Prima di tutto il resto: scrivi in una frase il problema che vuoi risolvere. Non la soluzione — il problema. Chi soffre cosa, in quale momento.');
    }

    // Tempo disponibile calibra l'intensità
    if (time === 'Meno di 2 ore') {
      steps.push(`NOTA SUL TEMPO: con meno di 2 ore a settimana, un passo alla settimana è il ritmo giusto. Non di più — altrimenti molli tutto.`);
    } else if (time === 'Più di 10 ore') {
      steps.push(`NOTA SUL TEMPO: con più di 10 ore a settimana puoi muoverti veloce. Ma veloce non significa frettoloso — la validazione richiede il tempo che richiede.`);
    }

    return steps.join('\n');
  };

  // Analisi di cosa è stato completato
  const completedModulesInfo = modulesCompleted.length > 0 
    ? `Ha completato i moduli: ${modulesCompleted.map(m => {
        const labels = {1:'Barriera informativa', 2:'Barriera psicologica', 3:'Barriera relazionale', 4:'Barriera operativa'};
        return labels[m];
      }).join(', ')}.`
    : 'Non ha ancora completato moduli del Learning Lab.';

  // Esercizi scritti dall'utente — dati reali e preziosi
  const exercisesInfo = [
    ll1Exercise && `Esercizio modulo 1 (barriera informativa): "${ll1Exercise.substring(0, 150)}"`,
    ll2Exercise && `Esercizio modulo 2 (barriera psicologica): "${ll2Exercise.substring(0, 150)}"`,
    ll3Exercise && `Esercizio modulo 3 (barriera relazionale): "${ll3Exercise.substring(0, 150)}"`,
    ll4Exercise && `Esercizio modulo 4 (barriera operativa): "${ll4Exercise.substring(0, 150)}"`,
  ].filter(Boolean).join('\n');

  return `Sei Foundri AI — il mentor di ${name || 'questo founder'} su Foundri, una piattaforma italiana per pre-founder e first-time founder.

Il tuo lavoro non è motivare. È aiutare ${name || 'il founder'} a capire cosa fare ESATTAMENTE, nel suo caso specifico, con le sue risorse e i suoi vincoli reali. Ogni founder ha un percorso diverso — il tuo valore sta nel costruire IL SUO percorso, non un percorso generico.

═══════════════════════════════════
PROFILO COMPLETO
═══════════════════════════════════
Nome: ${name || 'Non fornito'}
Archetipo founder: ${archetype || 'Non definito'}
Motivazione principale: ${motivation || 'Non specificata'}
Rapporto col rischio: ${risk || 'Non specificato'}
Stato attuale dell'idea: ${ideaState || 'Fase iniziale'}
Barriera principale identificata: ${mainBarrier || 'Non identificata'}
Tempo disponibile a settimana: ${time || 'Non specificato'}
${completedModulesInfo}

PROGETTO IN CORSO:
- Problem statement: ${problem || 'Non ancora definito'}
- Segmento target: ${segment || 'Non ancora definito'}
- Value proposition: ${vp || 'Non ancora definita'}

${exercisesInfo ? `COSA HA SCRITTO NEGLI ESERCIZI:\n${exercisesInfo}` : ''}

═══════════════════════════════════
IL SUO PERCORSO PERSONALIZZATO
═══════════════════════════════════
Basandosi sul profilo sopra, questi sono i passi specifici per ${name || 'questo founder'} — nell'ordine giusto per lui/lei:

${buildPersonalizedPath()}

═══════════════════════════════════
DATI DI RICERCA — usali quando rilevanti, non sistematicamente
═══════════════════════════════════
- 49% dei giovani non avvia per paura del fallimento, in crescita dal 44% del 2019 (GEM 2024/2025)
- 39% preferirebbe il lavoro autonomo (Flash Eurobarometer, Commissione Europea)
- 3,6 milioni di "missing youth entrepreneurs" nei Paesi OCSE (OECD)
- 18% tasso di successo first-time founder (CB Insights)
- 42% delle startup fallisce per no product-market fit — ha costruito qualcosa che il mercato non voleva (CB Insights)
- Le 4 barriere: informativa, psicologica, relazionale, operativa (ricerca accademica: Cacciotti et al. 2016, Newman et al. 2019, Bogatyreva et al. 2019, Mason & Kwok 2010)

═══════════════════════════════════
REGOLE DI COMPORTAMENTO — NON NEGOZIABILI
═══════════════════════════════════

TONO:
- Parla come un co-founder brutalmente onesto e competente, non come un coach motivazionale
- Niente "ottimo!", "fantastico!", "sei sulla strada giusta!" — sono frasi vuote
- Se qualcosa non va, dillo chiaramente. Se l'idea ha un buco, indicalo
- Sii diretto come un amico che sa di cosa parla, non un bot di supporto

STRUTTURA DELLE RISPOSTE:
- Una domanda o una insight alla volta — mai tre domande consecutive
- Massimo 4-5 frasi per risposta, salvo quando spieghi un framework specifico richiesto
- Se fai una domanda, aspetta la risposta — non rispondere tu stesso alla domanda che hai fatto
- Usa il nome di ${name || 'questo founder'} di tanto in tanto, non sempre

COME GUIDARE:
- Il percorso personalizzato sopra è la tua bussola — guida ${name || 'il founder'} step by step
- Se è bloccato su uno step, smonta il blocco prima di passare al prossimo
- Non saltare passi — se non ha ancora parlato con utenti reali, non parlare di pricing o scaling
- Quando suggerisci un passo, sii specifico: non "parla con qualcuno" ma "manda questo messaggio a queste 3 persone questa settimana"

QUANDO SMONTARE ASSUNZIONI:
- Se il problem statement è vago, dillo: "Questo è ancora troppo generico — chi esattamente?"
- Se sta costruendo prima di validare, frenalo: "Prima di continuare — hai parlato con qualcuno che ha questo problema?"
- Se dice "tutti hanno questo problema", spingi: "Dimmi la persona specifica — nome, età, cosa fa — che ha questo problema più di chiunque altro"
- Se usa buzz words vuote (disruption, game changer, rivoluzionario), ignorale e torna al concreto

COSA NON FARE MAI:
- Non dare liste di 10 cose da fare
- Non spiegare framework se non sono richiesti
- Non fare il recap di quello che ha detto — vai avanti
- Non usare emoji
- Non iniziare mai una risposta con "Certo!", "Assolutamente!", "Ottima osservazione!"
- Non dire "come mentor ti consiglio" — sei lì per ragionare insieme, non per dispensare saggezza dall'alto`;
}

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
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

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

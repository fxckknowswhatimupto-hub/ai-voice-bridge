"use strict";

const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 10000);

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!GROQ_API_KEY) {
  console.error("CRITICAL ERROR: GROQ_API_KEY is missing.");
  process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
  console.error("CRITICAL ERROR: DEEPGRAM_API_KEY is missing.");
  process.exit(1);
}

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const DEEPGRAM_PRIMARY_STT =
  process.env.DEEPGRAM_STT_MODEL || "nova-2-phonecall";
const DEEPGRAM_FALLBACK_STT =
  process.env.DEEPGRAM_STT_FALLBACK || "nova-3";
const DEEPGRAM_TTS_MODEL =
  process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en";

const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const PCM_BYTES_PER_FRAME = (SAMPLE_RATE * FRAME_MS / 1000) * 2; // 320 bytes
const START_BUFFER_FRAMES = 6; // 120 ms jitter buffer
const MAX_QUEUE_BYTES = SAMPLE_RATE * 2 * 8; // maximum 8 seconds queued audio

const groq = new Groq({ apiKey: GROQ_API_KEY });
const activeCalls = new Map();

let callCounter = 0;

// ============================================================
// FAKE H&M DATA
// ============================================================

const PRODUCTS = [
  {
    id: "HM-JNS-001",
    name: "Bootcut High Waist Jeans",
    category: "Jeans",
    price: 2499,
    colors: ["dark blue", "light blue", "black", "faded teal"],
    sizes: ["28", "30", "32", "34", "36"],
    materials: ["cotton", "elastane", "stretch"],
    materialDescription: "98% Cotton, 2% Elastane",
    stock: 18,
    description: "Classic bootcut jeans with a high waist and comfortable stretch."
  },
  {
    id: "HM-TSH-102",
    name: "Oversized Cotton T-Shirt",
    category: "T-Shirts",
    price: 999,
    colors: ["white", "black", "sage green", "beige"],
    sizes: ["S", "M", "L", "XL"],
    materials: ["cotton", "organic cotton"],
    materialDescription: "100% Organic Cotton",
    stock: 42,
    description: "Relaxed oversized fit made from heavy-weight organic cotton."
  },
  {
    id: "HM-DRS-501",
    name: "Ribbed Midi Dress",
    category: "Dresses",
    price: 1999,
    colors: ["burgundy", "black", "cream"],
    sizes: ["XS", "S", "M", "L"],
    materials: ["viscose", "viscose blend"],
    materialDescription: "Viscose Blend",
    stock: 14,
    description: "Soft ribbed midi dress with a fitted silhouette."
  },
  {
    id: "HM-HOD-301",
    name: "Relaxed Fit Hoodie",
    category: "Hoodies",
    price: 1799,
    colors: ["black", "grey", "cream", "navy"],
    sizes: ["S", "M", "L", "XL", "XXL"],
    materials: ["cotton", "polyester", "cotton blend"],
    materialDescription: "80% Cotton, 20% Polyester",
    stock: 27,
    description: "Soft relaxed-fit hoodie for everyday wear."
  }
];

const CUSTOMERS = [
  {
    phone: "8667859535",
    name: "Syed",
    loyaltyPoints: 450,
    address: "Coimbatore, Tamil Nadu, India",
    cart: [
      {
        productId: "HM-TSH-102",
        product: "Oversized Cotton T-Shirt",
        color: "black",
        size: "L",
        quantity: 1
      }
    ],
    orders: [
      {
        id: "HM88291",
        product: "Bootcut High Waist Jeans",
        color: "dark blue",
        size: "32",
        quantity: 1,
        status: "Shipped",
        courier: "BlueDart",
        tracking: "IN-HM-928371",
        estimatedDelivery: "August 15"
      }
    ]
  },
  {
    phone: "9876543210",
    name: "Alex",
    loyaltyPoints: 180,
    address: "Bangalore, Karnataka, India",
    cart: [],
    orders: []
  }
];

// ============================================================
// GENERAL HELPERS
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");

  if (digits.startsWith("0") && digits.length === 11) {
    digits = digits.slice(1);
  }

  if (digits.startsWith("91") && digits.length >= 12) {
    digits = digits.slice(-10);
  }

  if (digits.length > 10) {
    digits = digits.slice(-10);
  }

  return digits;
}

function findCustomer(phone) {
  const normalized = normalizePhone(phone);

  return CUSTOMERS.find(
    customer => normalizePhone(customer.phone) === normalized
  ) || null;
}

function getProductFromText(text, preferredProductId = null) {
  const q = normalizeText(text);

  if (preferredProductId) {
    const preferred = PRODUCTS.find(product => product.id === preferredProductId);

    if (preferred) {
      return preferred;
    }
  }

  return PRODUCTS.find(product => {
    return (
      q.includes(normalizeText(product.name)) ||
      q.includes(normalizeText(product.category)) ||
      product.colors.some(color => q.includes(normalizeText(color))) ||
      product.materials.some(material => q.includes(normalizeText(material)))
    );
  }) || null;
}

function findColor(text) {
  const q = normalizeText(text);

  for (const product of PRODUCTS) {
    for (const color of product.colors) {
      if (q.includes(normalizeText(color))) {
        return color;
      }
    }
  }

  return null;
}

function findSize(text) {
  const q = normalizeText(text);

  const spokenSizes = {
    "extra extra large": "XXL",
    "extra large": "XL",
    "extra small": "XS",
    small: "S",
    medium: "M",
    large: "L"
  };

  for (const [spoken, size] of Object.entries(spokenSizes)) {
    if (q.includes(spoken)) {
      return size;
    }
  }

  const sizes = ["XXL", "XL", "XS", "36", "34", "32", "30", "28", "S", "M", "L"];

  for (const size of sizes) {
    const expression = new RegExp(`(^|\\s)${size.toLowerCase()}($|\\s)`);

    if (expression.test(q)) {
      return size;
    }
  }

  return null;
}

function findQuantity(text) {
  const q = normalizeText(text);
  const match = q.match(/\b([1-9]|10)\b/);

  if (match) {
    return Number(match[1]);
  }

  const words = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5
  };

  return Object.entries(words).find(([word]) => q.includes(word))?.[1] || 1;
}

function formatMoney(amount) {
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}

function closeSocket(socket, label, callId) {
  if (!socket) {
    return;
  }

  try {
    socket.removeAllListeners();
    socket.close();
  } catch (error) {
    console.error(`[${callId}] ${label} CLOSE ERROR:`, error.message);
  }
}

function sendExotel(call, payload) {
  if (
    call.destroyed ||
    !call.ws ||
    call.ws.readyState !== WebSocket.OPEN
  ) {
    return false;
  }

  try {
    call.ws.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    console.error(`[${call.id}] EXOTEL SEND ERROR:`, error.message);
    return false;
  }
}

// ============================================================
// 20 MS PCM PLAYBACK SCHEDULER
// ============================================================

function createAudioQueue(call) {
  let pending = Buffer.alloc(0);
  let started = false;
  let sourceFinished = false;
  let timer = null;
  let nextFrameAt = 0;

  function stopTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function sendFrame(frame) {
    if (!call.streamSid || call.destroyed) {
      return;
    }

    sendExotel(call, {
      event: "media",
      stream_sid: call.streamSid,
      media: {
        payload: frame.toString("base64")
      }
    });
  }

  function finishIfDone() {
    if (!sourceFinished || pending.length !== 0 || !started) {
      return;
    }

    started = false;
    sourceFinished = false;
    call.aiSpeaking = false;
    call.ttsFlushed = false;

    if (typeof call.onSpeechFinished === "function") {
      call.onSpeechFinished();
    }
  }

  function pump() {
    timer = null;

    if (call.destroyed || !call.aiSpeaking) {
      return;
    }

    if (!started) {
      if (pending.length < PCM_BYTES_PER_FRAME * START_BUFFER_FRAMES && !sourceFinished) {
        return;
      }

      if (pending.length === 0) {
        finishIfDone();
        return;
      }

      started = true;
      nextFrameAt = Date.now();
    }

    if (pending.length < PCM_BYTES_PER_FRAME) {
      if (!sourceFinished) {
        return;
      }

      if (pending.length > 0) {
        const finalFrame = Buffer.alloc(PCM_BYTES_PER_FRAME);
        pending.copy(finalFrame);
        pending = Buffer.alloc(0);
        sendFrame(finalFrame);
      }

      finishIfDone();
      return;
    }

    const frame = pending.subarray(0, PCM_BYTES_PER_FRAME);
    pending = pending.subarray(PCM_BYTES_PER_FRAME);

    sendFrame(frame);

    nextFrameAt += FRAME_MS;
    const delay = Math.max(0, nextFrameAt - Date.now());

    timer = setTimeout(pump, delay);
  }

  function schedule() {
    if (!timer && call.aiSpeaking) {
      pump();
    }
  }

  return {
    enqueue(buffer) {
      if (
        call.destroyed ||
        !call.aiSpeaking ||
        !Buffer.isBuffer(buffer) ||
        buffer.length === 0
      ) {
        return;
      }

      pending = pending.length === 0
        ? Buffer.from(buffer)
        : Buffer.concat([pending, buffer]);

      if (pending.length > MAX_QUEUE_BYTES) {
        console.warn(`[${call.id}] Audio queue exceeded limit; trimming old audio.`);
        pending = pending.subarray(pending.length - MAX_QUEUE_BYTES);
      }

      schedule();
    },

    markSourceFinished() {
      sourceFinished = true;
      schedule();
    },

    clear() {
      stopTimer();
      pending = Buffer.alloc(0);
      started = false;
      sourceFinished = false;
      nextFrameAt = 0;
    },

    hasAudio() {
      return pending.length > 0 || started;
    }
  };
}

// ============================================================
// DEEPGRAM WEBSOCKET HELPERS
// ============================================================

function openDeepgramSocket(url) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`
      }
    });

    socket.once("open", () => {
      if (!settled) {
        settled = true;
        resolve(socket);
      }
    });

    socket.once("unexpected-response", (request, response) => {
      let body = "";

      response.on("data", chunk => {
        body += chunk.toString();
      });

      response.on("end", () => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `Deepgram HTTP ${response.statusCode}: ${body || "No response body"}`
            )
          );
        }
      });
    });

    socket.once("error", error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    socket.once("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("Deepgram socket closed before opening."));
      }
    });
  });
}

function buildSTTUrl(model) {
  // Exotel raw/slin: 16-bit, 8 kHz, mono PCM.
  // Do not add keepalive=true here. KeepAlive is a WebSocket message.
  return (
    "wss://api.deepgram.com/v1/listen" +
    `?model=${encodeURIComponent(model)}` +
    "&language=en-US" +
    "&encoding=linear16" +
    "&sample_rate=8000" +
    "&channels=1" +
    "&interim_results=true" +
    "&smart_format=true" +
    "&punctuate=true" +
    "&endpointing=300" +
    "&utterance_end_ms=800"
  );
}

async function connectSTT(call) {
  const models = [...new Set([DEEPGRAM_PRIMARY_STT, DEEPGRAM_FALLBACK_STT])];
  let lastError = null;

  for (const model of models) {
    try {
      console.log(`[${call.id}] Connecting Deepgram STT (${model})...`);

      const socket = await openDeepgramSocket(buildSTTUrl(model));

      call.sttModel = model;
      call.sttReady = true;

      console.log(`[${call.id}] Deepgram STT connected (${model})`);

      socket.on("message", raw => {
        if (call.destroyed) {
          return;
        }

        let message;

        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (message.type === "SpeechStarted") {
          if (call.aiSpeaking) {
            interruptAI(call);
          }

          return;
        }

        const transcript =
          message?.channel?.alternatives?.[0]?.transcript || "";

        const clean = transcript.replace(/\s+/g, " ").trim();

        if (!clean) {
          return;
        }

        if (message.is_final !== true) {
          call.lastInterim = clean;

          if (call.aiSpeaking && clean.length >= 3) {
            interruptAI(call);
          }

          return;
        }

        call.finalParts.push(clean);

        if (message.speech_final !== true) {
          return;
        }

        const finalText = call.finalParts.join(" ")
          .replace(/\s+/g, " ")
          .trim();

        call.finalParts = [];
        call.lastInterim = "";

        if (finalText) {
          console.log(`[${call.id}] CUSTOMER: ${finalText}`);
          handleCustomerSpeech(call, finalText);
        }
      });

      socket.on("error", error => {
        console.error(`[${call.id}] STT SOCKET ERROR:`, error.message);
      });

      socket.on("close", (code, reason) => {
        call.sttReady = false;

        if (!call.destroyed) {
          console.log(
            `[${call.id}] STT CLOSED: ${code} ${reason?.toString() || ""}`
          );
        }
      });

      return socket;
    } catch (error) {
      lastError = error;
      console.error(
        `[${call.id}] STT ${model} FAILED: ${error.message}`
      );
    }
  }

  throw lastError || new Error("All Deepgram STT models failed.");
}

async function connectTTS(call) {
  const url =
    "wss://api.deepgram.com/v1/speak" +
    `?model=${encodeURIComponent(DEEPGRAM_TTS_MODEL)}` +
    "&encoding=linear16" +
    "&sample_rate=8000";

  console.log(`[${call.id}] Connecting Deepgram TTS...`);

  const socket = await openDeepgramSocket(url);

  call.ttsReady = true;
  console.log(`[${call.id}] Deepgram TTS connected`);

  socket.on("message", (data, isBinary) => {
    if (call.destroyed) {
      return;
    }

    if (isBinary || Buffer.isBuffer(data)) {
      if (call.aiSpeaking && !call.discardTtsAudio) {
        call.audioQueue.enqueue(Buffer.from(data));
      }

      return;
    }

    let message;

    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message.type === "Flushed") {
      call.ttsFlushed = true;
      call.audioQueue.markSourceFinished();
      return;
    }

    if (message.type === "Warning") {
      console.warn(
        `[${call.id}] TTS WARNING:`,
        message.description || message.code || "Unknown warning"
      );
    }
  });

  socket.on("error", error => {
    console.error(`[${call.id}] TTS SOCKET ERROR:`, error.message);
  });

  socket.on("close", (code, reason) => {
    call.ttsReady = false;

    if (!call.destroyed) {
      console.log(
        `[${call.id}] TTS CLOSED: ${code} ${reason?.toString() || ""}`
      );
    }
  });

  return socket;
}

function startKeepAlive(call) {
  call.keepAliveTimer = setInterval(() => {
    if (
      call.destroyed ||
      !call.sttSocket ||
      call.sttSocket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    try {
      call.sttSocket.send(JSON.stringify({ type: "KeepAlive" }));
    } catch {
      // Socket cleanup handles this.
    }
  }, 3000);
}

// ============================================================
// BUSINESS LOGIC
// ============================================================

function cartSummary(customer) {
  if (!customer || customer.cart.length === 0) {
    return "Your cart is empty.";
  }

  const items = customer.cart
    .map(item => `${item.quantity} ${item.color} ${item.size} ${item.product}`)
    .join(", ");

  const total = customer.cart.reduce((sum, item) => {
    const product = PRODUCTS.find(product => product.id === item.productId);
    return sum + (product?.price || 0) * item.quantity;
  }, 0);

  return `Your cart has ${items}. The total is ${formatMoney(total)}.`;
}

function addToCart(customer, product, color, size, quantity) {
  if (!customer || !product) {
    return false;
  }

  const existing = customer.cart.find(item =>
    item.productId === product.id &&
    item.color === color &&
    item.size === size
  );

  if (existing) {
    existing.quantity += quantity;
  } else {
    customer.cart.push({
      productId: product.id,
      product: product.name,
      color,
      size,
      quantity
    });
  }

  return true;
}

function removeFromCart(customer, product) {
  if (!customer || !product) {
    return false;
  }

  const index = customer.cart.findIndex(item => item.productId === product.id);

  if (index === -1) {
    return false;
  }

  customer.cart.splice(index, 1);
  return true;
}

function handleDeterministicIntent(call, text) {
  const q = normalizeText(text);
  const customer = call.customer;

  if (call.awaitingGoodbyeConfirmation) {
    if (/\b(yes|yeah|yep|please|correct|confirm|end)\b/.test(q)) {
      speakText(call, "Thanks for calling H and M. Take care.").then(() => {
        setTimeout(() => cleanupCall(call, "Customer ended call"), 1200);
      });
      return true;
    }

    call.awaitingGoodbyeConfirmation = false;
    speakText(call, "No problem. What else can I help you with?");
    return true;
  }

  if (/\b(bye|goodbye|end the call|hang up)\b/.test(q)) {
    call.awaitingGoodbyeConfirmation = true;
    speakText(call, "Just to confirm, would you like me to end the call?");
    return true;
  }

  if (q.includes("loyalty") || q.includes("points")) {
    if (!customer) {
      speakText(call, "I could not find an account for this number.");
    } else {
      speakText(
        call,
        `You have ${customer.loyaltyPoints} H and M loyalty points.`
      );
    }

    return true;
  }

  if (
    q.includes("track") ||
    q.includes("where is my order") ||
    q.includes("order status") ||
    q.includes("delivery")
  ) {
    if (!customer?.orders?.length) {
      speakText(call, "I could not find any recent orders for this number.");
      return true;
    }

    const order = customer.orders[0];

    speakText(
      call,
      `Your order ${order.id}, the ${order.color} ${order.product}, is ${order.status}. ` +
      `It is with ${order.courier} and is expected by ${order.estimatedDelivery}.`
    );

    return true;
  }

  if (q.includes("what is in my cart") || q === "cart" || q.includes("my basket")) {
    speakText(call, cartSummary(customer));
    return true;
  }

  const product = getProductFromText(text, call.lastProductId);
  const color = findColor(text);
  const size = findSize(text);
  const quantity = findQuantity(text);

  if (q.includes("remove") || q.includes("delete from") || q.includes("take out")) {
    if (!product) {
      speakText(call, "Which item would you like me to remove?");
      return true;
    }

    if (!customer) {
      speakText(call, "I could not access a cart for this phone number.");
      return true;
    }

    if (removeFromCart(customer, product)) {
      speakText(call, `Done. I removed the ${product.name} from your cart.`);
    } else {
      speakText(call, `I could not find ${product.name} in your cart.`);
    }

    return true;
  }

  if (q.includes("add to cart") || q.includes("add it") || q.includes("add this")) {
    if (!product) {
      speakText(call, "Which product would you like to add?");
      return true;
    }

    const selectedColor = color || product.colors[0];
    const selectedSize = size || product.sizes[0];

    if (!product.colors.includes(selectedColor)) {
      speakText(call, `${product.name} is not available in ${selectedColor}.`);
      return true;
    }

    if (!product.sizes.includes(selectedSize)) {
      speakText(call, `${product.name} is not available in size ${selectedSize}.`);
      return true;
    }

    if (!customer) {
      speakText(call, "I could not access a cart for this phone number.");
      return true;
    }

    addToCart(customer, product, selectedColor, selectedSize, quantity);

    speakText(
      call,
      `Done. I added ${quantity} ${selectedColor} ${product.name}, size ${selectedSize}, to your cart.`
    );

    return true;
  }

  if (product) {
    call.lastProductId = product.id;

    if (q.includes("price") || q.includes("cost") || q.includes("how much")) {
      speakText(call, `${product.name} costs ${formatMoney(product.price)}.`);
      return true;
    }

    if (q.includes("color") || q.includes("available in")) {
      speakText(
        call,
        `${product.name} is available in ${product.colors.join(", ")}.`
      );
      return true;
    }

    if (q.includes("size")) {
      speakText(
        call,
        `${product.name} is available in sizes ${product.sizes.join(", ")}.`
      );
      return true;
    }

    if (q.includes("material") || q.includes("made of") || q.includes("fabric")) {
      speakText(
        call,
        `${product.name} is made from ${product.materialDescription}.`
      );
      return true;
    }

    if (q.includes("stock") || q.includes("available") || q.includes("have")) {
      if (color && !product.colors.includes(color)) {
        speakText(call, `Sorry, ${product.name} is not available in ${color}.`);
      } else if (size && !product.sizes.includes(size)) {
        speakText(call, `Sorry, ${product.name} is not available in size ${size}.`);
      } else {
        speakText(
          call,
          `Yes, ${product.name} is in stock. It is ${formatMoney(product.price)}.`
        );
      }

      return true;
    }
  }

  return false;
}

// ============================================================
// GROQ + STREAMING TTS
// ============================================================

function buildSystemPrompt(call) {
  const customer = call.customer || { name: "Guest", cart: [], orders: [] };

  return `
You are an H&M customer-service assistant speaking over a phone call.

Speak naturally, warmly, and concisely. Never mention being an AI.
Use short sentences, with no markdown, lists, emojis, or long explanations.

Customer:
${JSON.stringify(customer)}

Products:
${JSON.stringify(PRODUCTS)}

Rules:
- Answer product questions from the provided product data only.
- The customer might say "a dress", which STT can transcribe as "address".
  In clothing context, interpret "address" as "a dress" when appropriate.
- Be helpful with products, colors, sizes, materials, prices, stock, carts,
  loyalty points, orders, deliveries, and tracking.
- Keep usual replies to one or two short sentences.
- Do not invent orders, stock, discounts, policies, or products.
`;
}

function splitSpeakableSentences(buffer, force = false) {
  const sentences = [];
  let working = buffer;

  const pattern = /(.+?[.!?])(?=\s|$)/g;
  let match;
  let consumed = 0;

  while ((match = pattern.exec(working)) !== null) {
    const sentence = match[1].trim();

    if (sentence) {
      sentences.push(sentence);
    }

    consumed = pattern.lastIndex;
  }

  working = working.slice(consumed).trimStart();

  if (force && working.trim()) {
    sentences.push(working.trim());
    working = "";
  }

  if (!force && working.length > 180) {
    const cut = working.lastIndexOf(" ");

    if (cut > 40) {
      sentences.push(working.slice(0, cut).trim());
      working = working.slice(cut + 1).trimStart();
    }
  }

  return { sentences, remainder: working };
}

async function speakText(call, text) {
  if (call.destroyed || !text) {
    return;
  }

  interruptAI(call, false);

  if (!call.ttsSocket || call.ttsSocket.readyState !== WebSocket.OPEN) {
    console.error(`[${call.id}] TTS is not connected.`);
    return;
  }

  call.aiSpeaking = true;
  call.discardTtsAudio = false;
  call.ttsFlushed = false;
  call.responseGeneration += 1;

  const generation = call.responseGeneration;

  try {
    call.ttsSocket.send(JSON.stringify({
      type: "Speak",
      text
    }));

    call.ttsSocket.send(JSON.stringify({ type: "Flush" }));
  } catch (error) {
    console.error(`[${call.id}] TTS SEND ERROR:`, error.message);

    if (generation === call.responseGeneration) {
      call.aiSpeaking = false;
    }
  }
}

async function answerWithGroq(call, customerText) {
  interruptAI(call, false);

  if (call.destroyed) {
    return;
  }

  const generation = ++call.responseGeneration;

  call.aiSpeaking = true;
  call.discardTtsAudio = false;
  call.ttsFlushed = false;

  const messages = [
    { role: "system", content: buildSystemPrompt(call) },
    ...call.history.slice(-10),
    { role: "user", content: customerText }
  ];

  call.history.push({ role: "user", content: customerText });

  let completeAnswer = "";
  let sentenceBuffer = "";

  try {
    const stream = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 180,
      stream: true
    });

    for await (const chunk of stream) {
      if (call.destroyed || generation !== call.responseGeneration) {
        return;
      }

      const text = chunk.choices?.[0]?.delta?.content || "";

      if (!text) {
        continue;
      }

      completeAnswer += text;
      sentenceBuffer += text;

      const split = splitSpeakableSentences(sentenceBuffer);
      sentenceBuffer = split.remainder;

      for (const sentence of split.sentences) {
        if (
          call.ttsSocket &&
          call.ttsSocket.readyState === WebSocket.OPEN &&
          generation === call.responseGeneration
        ) {
          call.ttsSocket.send(JSON.stringify({
            type: "Speak",
            text: sentence
          }));
        }
      }
    }

    if (call.destroyed || generation !== call.responseGeneration) {
      return;
    }

    const finalSplit = splitSpeakableSentences(sentenceBuffer, true);

    for (const sentence of finalSplit.sentences) {
      call.ttsSocket.send(JSON.stringify({
        type: "Speak",
        text: sentence
      }));
    }

    if (!completeAnswer.trim()) {
      call.aiSpeaking = false;
      return;
    }

    call.history.push({
      role: "assistant",
      content: completeAnswer.trim()
    });

    call.ttsSocket.send(JSON.stringify({ type: "Flush" }));
  } catch (error) {
    console.error(`[${call.id}] GROQ ERROR:`, error.message);

    if (generation === call.responseGeneration) {
      speakText(call, "Sorry, I had a connection issue. Could you say that again?");
    }
  }
}

// ============================================================
// BARGE-IN / CLEANUP
// ============================================================

function interruptAI(call, clearRemoteAudio = true) {
  call.responseGeneration += 1;
  call.aiSpeaking = false;
  call.discardTtsAudio = true;
  call.ttsFlushed = false;

  call.audioQueue.clear();

  if (clearRemoteAudio && call.streamSid) {
    sendExotel(call, {
      event: "clear",
      stream_sid: call.streamSid
    });
  }

  if (
    call.ttsSocket &&
    call.ttsSocket.readyState === WebSocket.OPEN
  ) {
    try {
      call.ttsSocket.send(JSON.stringify({ type: "Clear" }));
    } catch {
      // Cleanup will handle a failed socket.
    }
  }
}

function cleanupCall(call, reason) {
  if (!call || call.destroyed) {
    return;
  }

  call.destroyed = true;
  call.aiSpeaking = false;

  console.log(`[${call.id}] CLEANUP: ${reason}`);

  if (call.keepAliveTimer) {
    clearInterval(call.keepAliveTimer);
  }

  call.audioQueue?.clear();

  closeSocket(call.sttSocket, "STT", call.id);
  closeSocket(call.ttsSocket, "TTS", call.id);

  if (call.ws && call.ws.readyState === WebSocket.OPEN) {
    try {
      call.ws.close();
    } catch {
      // Nothing else to do.
    }
  }

  activeCalls.delete(call.id);

  console.log(`[${call.id}] CLEANED UP. ACTIVE CALLS: ${activeCalls.size}`);
}

// ============================================================
// CUSTOMER SPEECH
// ============================================================

function handleCustomerSpeech(call, text) {
  if (call.destroyed || !text) {
    return;
  }

  if (call.processingSpeech) {
    return;
  }

  call.processingSpeech = true;

  Promise.resolve()
    .then(async () => {
      if (call.aiSpeaking) {
        interruptAI(call);
      }

      if (!handleDeterministicIntent(call, text)) {
        await answerWithGroq(call, text);
      }
    })
    .catch(error => {
      console.error(`[${call.id}] SPEECH HANDLER ERROR:`, error.message);
    })
    .finally(() => {
      call.processingSpeech = false;
    });
}

// ============================================================
// EXOTEL WEBSOCKET
// ============================================================

async function setupDeepgram(call) {
  try {
    const [sttSocket, ttsSocket] = await Promise.all([
      connectSTT(call),
      connectTTS(call)
    ]);

    if (call.destroyed) {
      closeSocket(sttSocket, "STT", call.id);
      closeSocket(ttsSocket, "TTS", call.id);
      return;
    }

    call.sttSocket = sttSocket;
    call.ttsSocket = ttsSocket;

    startKeepAlive(call);

    console.log(`[${call.id}] DEEPGRAM READY`);

    const name = call.customer?.name || "there";
    await speakText(
      call,
      `Hi ${name}, welcome to H and M. What can I help you with today?`
    );
  } catch (error) {
    console.error(`[${call.id}] DEEPGRAM SETUP ERROR: ${error.message}`);

    if (!call.destroyed) {
      await speakText(
        call,
        "Sorry, I am having trouble connecting right now. Please try again shortly."
      );
    }
  }
}

function handleExotelMessage(call, raw) {
  let message;

  try {
    message = JSON.parse(raw.toString());
  } catch {
    console.warn(`[${call.id}] Ignoring invalid Exotel JSON.`);
    return;
  }

  const event = message.event;

  if (event === "connected") {
    console.log(`[${call.id}] EXOTEL CONNECTED`);
    return;
  }

  if (event === "start") {
    const start = message.start || {};

    call.streamSid =
      start.stream_sid ||
      start.streamSid ||
      message.stream_sid ||
      message.streamSid;

    call.callSid =
      start.call_sid ||
      start.callSid ||
      start.call_id ||
      message.call_sid ||
      message.callSid ||
      "";

    const phone =
      start.from ||
      start.caller ||
      start.custom_parameters?.from ||
      start.customParameters?.from ||
      "";

    call.phone = normalizePhone(phone);
    call.customer = findCustomer(call.phone);

    console.log(`[${call.id}] EXOTEL STREAM CONNECTED`);
    console.log(`[${call.id}] CALL SID: ${call.callSid || "Unknown"}`);
    console.log(`[${call.id}] STREAM SID: ${call.streamSid || "Unknown"}`);
    console.log(`[${call.id}] PHONE: ${call.phone || "Unknown"}`);
    console.log(`[${call.id}] CUSTOMER: ${call.customer?.name || "Guest"}`);

    if (!call.deepgramSetupStarted) {
      call.deepgramSetupStarted = true;
      setupDeepgram(call);
    }

    return;
  }

  if (event === "media") {
    const payload = message.media?.payload;

    if (!payload) {
      return;
    }

    const pcm = Buffer.from(payload, "base64");

    if (
      call.sttSocket &&
      call.sttSocket.readyState === WebSocket.OPEN
    ) {
      try {
        call.sttSocket.send(pcm);
      } catch (error) {
        console.error(`[${call.id}] STT AUDIO SEND ERROR:`, error.message);
      }
    } else if (call.preSttAudio.length < 100) {
      call.preSttAudio.push(pcm);
    }

    return;
  }

  if (event === "stop") {
    console.log(`[${call.id}] EXOTEL CALL STOP`);
    cleanupCall(call, "Exotel stop event");
  }
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      activeCalls: activeCalls.size
    }));
    return;
  }

  response.writeHead(200, { "Content-Type": "text/plain" });
  response.end("H&M Exotel voice assistant is running.");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", ws => {
  const call = {
    id: `CALL-${++callCounter}`,
    ws,
    streamSid: null,
    callSid: null,
    phone: "",
    customer: null,

    sttSocket: null,
    ttsSocket: null,
    sttReady: false,
    ttsReady: false,
    sttModel: null,
    deepgramSetupStarted: false,

    finalParts: [],
    lastInterim: "",
    history: [],
    lastProductId: null,

    aiSpeaking: false,
    discardTtsAudio: false,
    ttsFlushed: false,
    responseGeneration: 0,
    processingSpeech: false,
    awaitingGoodbyeConfirmation: false,

    preSttAudio: [],
    keepAliveTimer: null,
    destroyed: false,
    audioQueue: null,
    onSpeechFinished: null
  };

  call.audioQueue = createAudioQueue(call);

  call.onSpeechFinished = () => {
    console.log(`[${call.id}] AI PLAYBACK FINISHED`);
  };

  activeCalls.set(call.id, call);

  console.log("============================================");
  console.log(`[${call.id}] EXOTEL WEBSOCKET CONNECTED`);
  console.log(`[${call.id}] ACTIVE CALLS: ${activeCalls.size}`);
  console.log("============================================");

  ws.on("message", raw => {
    handleExotelMessage(call, raw);

    if (
      call.sttSocket &&
      call.sttSocket.readyState === WebSocket.OPEN &&
      call.preSttAudio.length > 0
    ) {
      const bufferedAudio = call.preSttAudio.splice(0);

      for (const chunk of bufferedAudio) {
        try {
          call.sttSocket.send(chunk);
        } catch {
          break;
        }
      }
    }
  });

  ws.on("error", error => {
    console.error(`[${call.id}] EXOTEL SOCKET ERROR:`, error.message);
  });

  ws.on("close", () => {
    cleanupCall(call, "Exotel WebSocket closed");
  });
});

server.listen(PORT, () => {
  console.log(`H&M voice assistant listening on port ${PORT}`);
});

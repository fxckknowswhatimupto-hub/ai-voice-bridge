"use strict";

/*
 * H&M / Exotel voice assistant
 * Required packages: npm i ws groq-sdk
 * Environment: GROQ_API_KEY, DEEPGRAM_API_KEY
 * Optional: PORT, MAX_CONCURRENT_CALLS, GROQ_MODEL, DEEPGRAM_STT_MODEL,
 * DEEPGRAM_TTS_MODEL, EXOTEL_PCM_ENCODING (linear16 by default)
 */

const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

const PORT = Number(process.env.PORT || 10000);
const MAX_CONCURRENT_CALLS = Math.max(1, Number(process.env.MAX_CONCURRENT_CALLS || 10));
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const DEEPGRAM_STT_MODEL = process.env.DEEPGRAM_STT_MODEL || "nova-3";
const DEEPGRAM_TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en";
const EXOTEL_PCM_ENCODING = process.env.EXOTEL_PCM_ENCODING || "linear16";

if (!GROQ_API_KEY || !DEEPGRAM_API_KEY) {
  console.error("CRITICAL ERROR: GROQ_API_KEY and DEEPGRAM_API_KEY are required.");
  process.exit(1);
}

const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const PCM_BYTES_PER_FRAME = (SAMPLE_RATE * FRAME_MS / 1000) * 2;
const START_BUFFER_FRAMES = 6;
const MAX_QUEUE_BYTES = SAMPLE_RATE * 2 * 5;
const MAX_PRE_STT_CHUNKS = 150;
const MAX_RECONNECTS = 4;
const RECONNECT_BASE_MS = 350;

const groq = new Groq({ apiKey: GROQ_API_KEY });
const activeCalls = new Map();

let callCounter = 0;

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

function normal(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9%\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function money(amount) {
  return `rupees ${amount.toLocaleString("en-IN")}`;
}

function phoneFromStart(start) {
  const raw =
    start?.custom_parameters?.phone ||
    start?.custom_parameters?.from ||
    start?.from ||
    start?.caller_number ||
    "";

  return String(raw).replace(/\D/g, "").slice(-10);
}

function findProduct(text) {
  const input = normal(text);

  return (
    PRODUCTS.find(product =>
      normal(product.name)
        .split(" ")
        .some(word => word.length > 3 && input.includes(word))
    ) ||
    PRODUCTS.find(product =>
      input.includes(normal(product.category).replace(/s$/, ""))
    ) ||
    null
  );
}

function sendExotel(call, payload) {
  if (call.destroyed || call.ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    call.ws.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    console.error(`[${call.id}] Exotel send error: ${error.message}`);
    return false;
  }
}

function createAudioQueue(call) {
  let pending = Buffer.alloc(0);
  let started = false;
  let finished = false;
  let timer = null;
  let nextFrameAt = 0;

  function stop() {
    if (timer) {
      clearTimeout(timer);
    }

    timer = null;
  }

  function complete() {
    if (!finished || pending.length || !started) {
      return;
    }

    started = false;
    finished = false;
    call.aiSpeaking = false;

    const done = call.onSpeechFinished;
    call.onSpeechFinished = null;

    if (done) {
      done();
    }
  }

  function sendFrame(frame) {
    if (!call.streamSid) {
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

  function pump() {
    timer = null;

    if (call.destroyed || !call.aiSpeaking) {
      return;
    }

    if (!started) {
      if (
        !finished &&
        pending.length < PCM_BYTES_PER_FRAME * START_BUFFER_FRAMES
      ) {
        return;
      }

      if (!pending.length) {
        complete();
        return;
      }

      started = true;
      nextFrameAt = Date.now();
    }

    if (pending.length < PCM_BYTES_PER_FRAME) {
      if (!finished) {
        return;
      }

      if (pending.length) {
        const lastFrame = Buffer.alloc(PCM_BYTES_PER_FRAME);
        pending.copy(lastFrame);
        pending = Buffer.alloc(0);
        sendFrame(lastFrame);
      }

      complete();
      return;
    }

    const frame = pending.subarray(0, PCM_BYTES_PER_FRAME);
    pending = pending.subarray(PCM_BYTES_PER_FRAME);

    sendFrame(frame);

    nextFrameAt += FRAME_MS;
    timer = setTimeout(
      pump,
      Math.max(0, nextFrameAt - Date.now())
    );
  }

  function schedule() {
    if (!timer && call.aiSpeaking) {
      pump();
    }
  }

  return {
    enqueue(chunk) {
      if (
        call.destroyed ||
        !call.aiSpeaking ||
        !chunk ||
        !chunk.length
      ) {
        return;
      }

      pending = pending.length
        ? Buffer.concat([pending, chunk])
        : Buffer.from(chunk);

      if (pending.length > MAX_QUEUE_BYTES) {
        pending = pending.subarray(
          pending.length - MAX_QUEUE_BYTES
        );
      }

      schedule();
    },

    finish() {
      finished = true;
      schedule();
    },

    clear() {
      stop();
      pending = Buffer.alloc(0);
      started = false;
      finished = false;
      nextFrameAt = 0;
    }
  };
}

function openDeepgramSocket(url) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`
      },
      handshakeTimeout: 10000
    });

    function fail(error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }

    socket.once("open", () => {
      if (!settled) {
        settled = true;
        resolve(socket);
      }
    });

    socket.once("error", fail);

    socket.once("close", () => {
      fail(new Error("Deepgram closed before opening."));
    });

    socket.once("unexpected-response", (_request, response) => {
      let body = "";

      response.on("data", chunk => {
        body += chunk.toString();
      });

      response.on("end", () => {
        fail(
          new Error(
            `Deepgram HTTP ${response.statusCode}: ${body || "no body"}`
          )
        );
      });
    });
  });
}

function sttUrl() {
  return (
    "wss://api.deepgram.com/v1/listen" +
    `?model=${encodeURIComponent(DEEPGRAM_STT_MODEL)}` +
    `&encoding=${encodeURIComponent(EXOTEL_PCM_ENCODING)}` +
    "&sample_rate=8000" +
    "&channels=1" +
    "&interim_results=true" +
    "&endpointing=300"
  );
}

function ttsUrl() {
  return (
    "wss://api.deepgram.com/v1/speak" +
    `?model=${encodeURIComponent(DEEPGRAM_TTS_MODEL)}` +
    "&encoding=linear16" +
    "&sample_rate=8000"
  );
}

function socketIsOpen(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function reconnectDelay(attempt) {
  return Math.min(
    5000,
    RECONNECT_BASE_MS * 2 ** attempt
  );
}

function scheduleReconnect(call, kind) {
  const timerKey = `${kind}ReconnectTimer`;
  const attemptsKey = `${kind}Reconnects`;

  if (
    call.destroyed ||
    call[timerKey] ||
    call[attemptsKey] >= MAX_RECONNECTS
  ) {
    return;
  }

  const attempt = call[attemptsKey]++;
  const delay = reconnectDelay(attempt);

  console.warn(
    `[${call.id}] ${kind.toUpperCase()} reconnect ${attempt + 1}/${MAX_RECONNECTS} in ${delay}ms`
  );

  call[timerKey] = setTimeout(async () => {
    call[timerKey] = null;

    try {
      if (kind === "stt") {
        await connectSTT(call);
      } else {
        await connectTTS(call);
      }
    } catch (error) {
      console.error(
        `[${call.id}] ${kind.toUpperCase()} reconnect failed: ${error.message}`
      );
      scheduleReconnect(call, kind);
    }
  }, delay);
}

async function connectSTT(call) {
  if (call.destroyed || socketIsOpen(call.sttSocket)) {
    return call.sttSocket;
  }

  if (call.sttConnectPromise) {
    return call.sttConnectPromise;
  }

  call.sttConnectPromise = openDeepgramSocket(sttUrl());

  let socket;

  try {
    socket = await call.sttConnectPromise;
  } finally {
    call.sttConnectPromise = null;
  }

  if (call.destroyed) {
    socket.close();
    return null;
  }

  call.sttSocket = socket;
  call.sttReady = true;
  call.sttReconnects = 0;

  socket.on("message", raw => {
    handleSttMessage(call, raw);
  });

  socket.on("error", error => {
    console.error(`[${call.id}] STT error: ${error.message}`);
  });

  socket.on("close", (code, reason) => {
    if (call.sttSocket === socket) {
      call.sttSocket = null;
      call.sttReady = false;

      if (!call.destroyed) {
        console.warn(
          `[${call.id}] STT closed ${code} ${reason.toString()}`
        );
        scheduleReconnect(call, "stt");
      }
    }
  });

  for (const audio of call.preSttAudio.splice(0)) {
    if (socketIsOpen(socket)) {
      socket.send(audio);
    }
  }

  return socket;
}

function handleSttMessage(call, raw) {
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

  const text = message?.channel?.alternatives?.[0]?.transcript
    ?.replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return;
  }

  if (!message.is_final) {
    if (call.aiSpeaking && text.length >= 3) {
      interruptAI(call);
    }

    return;
  }

  call.finalParts.push(text);

  if (message.speech_final) {
    const utterance = call.finalParts
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    call.finalParts = [];

    if (utterance) {
      handleCustomerSpeech(call, utterance);
    }
  }
}

async function connectTTS(call) {
  if (call.destroyed || socketIsOpen(call.ttsSocket)) {
    return call.ttsSocket;
  }

  if (call.ttsConnectPromise) {
    return call.ttsConnectPromise;
  }

  call.ttsConnectPromise = openDeepgramSocket(ttsUrl());

  let socket;

  try {
    socket = await call.ttsConnectPromise;
  } finally {
    call.ttsConnectPromise = null;
  }

  if (call.destroyed) {
    socket.close();
    return null;
  }

  call.ttsSocket = socket;
  call.ttsReady = true;
  call.ttsReconnects = 0;

  socket.on("message", (data, isBinary) => {
    if (call.destroyed) {
      return;
    }

    if (isBinary || Buffer.isBuffer(data)) {
      if (call.aiSpeaking && !call.discardTts) {
        call.audioQueue.enqueue(Buffer.from(data));
      }

      return;
    }

    try {
      const control = JSON.parse(data.toString());

      if (
        control.type === "Flushed" &&
        call.aiSpeaking &&
        !call.discardTts
      ) {
        call.audioQueue.finish();
      }
    } catch {
      // Ignore non-audio provider messages.
    }
  });

  socket.on("error", error => {
    console.error(`[${call.id}] TTS error: ${error.message}`);
  });

  socket.on("close", (code, reason) => {
    if (call.ttsSocket === socket) {
      call.ttsSocket = null;
      call.ttsReady = false;

      if (!call.destroyed) {
        console.warn(
          `[${call.id}] TTS closed ${code} ${reason.toString()}`
        );
        scheduleReconnect(call, "tts");
      }
    }
  });

  return socket;
}

function interruptAI(call) {
  if (!call.aiSpeaking) {
    return;
  }

  call.responseGeneration++;
  call.discardTts = true;
  call.aiSpeaking = false;
  call.audioQueue.clear();
  call.onSpeechFinished = null;

  if (call.streamSid) {
    sendExotel(call, {
      event: "clear",
      stream_sid: call.streamSid
    });
  }

  // Close and recreate TTS so old audio cannot leak into the next answer.
  const oldSocket = call.ttsSocket;

  call.ttsSocket = null;
  call.ttsReady = false;

  if (oldSocket) {
    try {
      oldSocket.close();
    } catch {
      // Ignore close errors.
    }
  }

  connectTTS(call).catch(error => {
    console.error(
      `[${call.id}] TTS reset error: ${error.message}`
    );
    scheduleReconnect(call, "tts");
  });
}

async function speak(call, text, onFinished) {
  const sentence = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!sentence || call.destroyed) {
    return;
  }

  const generation = ++call.responseGeneration;

  call.aiSpeaking = true;
  call.discardTts = false;
  call.onSpeechFinished = onFinished || null;

  try {
    const socket = await connectTTS(call);

    if (
      call.destroyed ||
      generation !== call.responseGeneration ||
      !socketIsOpen(socket)
    ) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: "Speak",
        text: sentence
      })
    );

    socket.send(JSON.stringify({ type: "Flush" }));

    // Safety fallback if Deepgram does not emit a Flushed control message.
    setTimeout(() => {
      if (
        !call.destroyed &&
        generation === call.responseGeneration
      ) {
        call.audioQueue.finish();
      }
    }, 3000 + sentence.length * 45);
  } catch (error) {
    console.error(`[${call.id}] TTS speak failed: ${error.message}`);

    if (generation === call.responseGeneration) {
      call.aiSpeaking = false;
      scheduleReconnect(call, "tts");
    }
  }
}

function productReply(product, text) {
  const input = normal(text);

  if (/(price|cost|how much)/.test(input)) {
    return `${product.name} is ${money(product.price)}.`;
  }

  if (/(colour|color)/.test(input)) {
    return `${product.name} is available in ${product.colors.join(", ")}.`;
  }

  if (/(size|sizing)/.test(input)) {
    return `${product.name} is available in sizes ${product.sizes.join(", ")}.`;
  }

  if (/(material|made of|fabric)/.test(input)) {
    return `${product.name} is made of ${product.materialDescription}.`;
  }

  if (/(stock|available|availability)/.test(input)) {
    return product.stock > 0
      ? `${product.name} is currently in stock.`
      : `${product.name} is currently out of stock.`;
  }

  return `${product.name}: ${product.description} It costs ${money(product.price)}.`;
}

function handleDeterministicIntent(call, spoken) {
  const input = normal(spoken);
  const customer = call.customer;

  if (/\b(bye|goodbye|end call|hang up|that is all|nothing else)\b/.test(input)) {
    if (!call.goodbyeConfirmed) {
      call.goodbyeConfirmed = true;
      return "Before I end the call, is there anything else I can help with?";
    }

    return {
      text: "Thank you for calling H and M. Goodbye.",
      endAfter: true
    };
  }

  if (call.goodbyeConfirmed) {
    call.goodbyeConfirmed = false;
  }

  if (/(return|refund|exchange)/.test(input)) {
    return "You can start a return within thirty days with your order number. Would you like order help?";
  }

  if (/(store hour|opening hour|store location|nearest store)/.test(input)) {
    return "For store hours and locations, please use the H and M store locator. Is there anything else I can help with?";
  }

  if (/(loyalty|point|membership)/.test(input)) {
    return customer
      ? `You have ${customer.loyaltyPoints} loyalty points.`
      : "Please sign in with your registered number to check loyalty points.";
  }

  if (/(my address|delivery address|address)/.test(input)) {
    return customer
      ? `Your saved delivery address is ${customer.address}.`
      : "I could not find a saved address for this number.";
  }

  if (/(order|tracking|delivery|courier|shipment)/.test(input)) {
    if (!customer?.orders?.length) {
      return "I could not find an order for this number.";
    }

    const order = customer.orders[0];

    return `Order ${order.id} for ${order.product} is ${order.status}. ${order.courier} tracking is ${order.tracking}, expected ${order.estimatedDelivery}.`;
  }

  if (/(cart|basket)/.test(input)) {
    if (!customer) {
      return "I could not find a customer account for this number.";
    }

    if (!customer.cart.length) {
      return "Your cart is empty.";
    }

    return `Your cart has ${customer.cart
      .map(item => `${item.quantity} ${item.product}, ${item.color}, size ${item.size}`)
      .join("; ")}.`;
  }

  const product = findProduct(input);

  if (product && /(add to cart|add this|buy this)/.test(input)) {
    if (!customer) {
      return "Please sign in before adding an item to your cart.";
    }

    customer.cart.push({
      productId: product.id,
      product: product.name,
      color: product.colors[0],
      size: product.sizes[0],
      quantity: 1
    });

    return `${product.name} has been added to your cart in ${product.colors[0]}, size ${product.sizes[0]}.`;
  }

  if (
    product &&
    (
      /(remove|delete).*(cart|basket)/.test(input) ||
      /(cart|basket).*(remove|delete)/.test(input)
    )
  ) {
    if (!customer) {
      return "I could not find your cart.";
    }

    const before = customer.cart.length;

    customer.cart = customer.cart.filter(
      item => item.productId !== product.id
    );

    return before === customer.cart.length
      ? `${product.name} is not in your cart.`
      : `${product.name} was removed from your cart.`;
  }

  if (product) {
    return productReply(product, input);
  }

  if (/(what.*(sell|have)|products|catalogue|catalog)/.test(input)) {
    return "We have jeans, T-shirts, dresses, and hoodies. Which would you like to hear about?";
  }

  return null;
}

async function getGroqReply(call, spoken) {
  const history = call.history.slice(-6);

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    temperature: 0.2,
    max_tokens: 80,
    messages: [
      {
        role: "system",
        content:
          "You are H&M customer care on a phone. Give a helpful answer in at most two short sentences. Never invent prices, stock, orders, returns policy, or account data. For data requests, ask the caller to rephrase or offer product, order, cart, returns, or loyalty help."
      },
      ...history,
      {
        role: "user",
        content: spoken
      }
    ]
  });

  return (
    completion.choices?.[0]?.message?.content?.trim() ||
    "I can help with products, orders, carts, returns, or loyalty points."
  );
}

async function handleCustomerSpeech(call, spoken) {
  if (call.destroyed || call.processing) {
    return;
  }

  call.processing = true;
  interruptAI(call);

  console.log(`[${call.id}] CUSTOMER: ${spoken}`);

  try {
    let result = handleDeterministicIntent(call, spoken);

    if (!result) {
      result = await getGroqReply(call, spoken);
    }

    const text = typeof result === "string"
      ? result
      : result.text;

    call.history.push(
      { role: "user", content: spoken },
      { role: "assistant", content: text }
    );

    await speak(
      call,
      text,
      result?.endAfter
        ? () => cleanupCall(call, "goodbye")
        : null
    );
  } catch (error) {
    console.error(`[${call.id}] response error: ${error.message}`);

    await speak(
      call,
      "I am sorry, I could not complete that. Please try again."
    );
  } finally {
    call.processing = false;
  }
}

function cleanupCall(call, reason) {
  if (call.destroyed) {
    return;
  }

  call.destroyed = true;

  console.log(`[${call.id}] cleanup: ${reason}`);

  for (const key of [
    "sttReconnectTimer",
    "ttsReconnectTimer",
    "sttKeepAlive"
  ]) {
    if (call[key]) {
      clearInterval(call[key]);
    }
  }

  call.audioQueue.clear();

  for (const socket of [call.sttSocket, call.ttsSocket]) {
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  activeCalls.delete(call.id);

  console.log(
    `[${call.id}] active calls: ${activeCalls.size}`
  );
}

function createCall(ws) {
  const id = `CALL-${++callCounter}`;

  const call = {
    id,
    ws,
    destroyed: false,
    streamSid: null,
    phone: "",
    customer: null,
    sttSocket: null,
    ttsSocket: null,
    sttConnectPromise: null,
    ttsConnectPromise: null,
    sttReady: false,
    ttsReady: false,
    sttReconnects: 0,
    ttsReconnects: 0,
    sttReconnectTimer: null,
    ttsReconnectTimer: null,
    sttKeepAlive: null,
    preSttAudio: [],
    finalParts: [],
    history: [],
    aiSpeaking: false,
    discardTts: false,
    responseGeneration: 0,
    processing: false,
    goodbyeConfirmed: false,
    onSpeechFinished: null
  };

  call.audioQueue = createAudioQueue(call);

  activeCalls.set(id, call);

  return call;
}

function startCall(call, start) {
  call.streamSid = start.stream_sid || start.streamSid || null;
  call.phone = phoneFromStart(start);

  call.customer =
    CUSTOMERS.find(customer => customer.phone === call.phone) ||
    null;

  console.log(
    `[${call.id}] start stream=${call.streamSid} phone=${call.phone || "unknown"}`
  );

  // STT and TTS connect in parallel. Greeting never waits for STT or Groq.
  connectSTT(call).catch(error => {
    console.error(`[${call.id}] initial STT: ${error.message}`);
    scheduleReconnect(call, "stt");
  });

  connectTTS(call)
    .then(() => {
      const greeting = call.customer?.name
        ? `Welcome back, ${call.customer.name}. `
        : "Welcome to H and M customer care. ";

      speak(
        call,
        `${greeting}I can help with products, orders, your cart, returns, or loyalty points. How may I help?`
      );
    })
    .catch(error => {
      console.error(`[${call.id}] initial TTS: ${error.message}`);
      scheduleReconnect(call, "tts");
    });

  call.sttKeepAlive = setInterval(() => {
    if (socketIsOpen(call.sttSocket)) {
      try {
        call.sttSocket.send(
          JSON.stringify({ type: "KeepAlive" })
        );
      } catch {
        // The close handler schedules reconnect.
      }
    }
  }, 5000);
}

function rejectOverload(ws) {
  console.warn("Rejected call: capacity reached.");

  setTimeout(() => {
    try {
      ws.close(1013, "Server busy");
    } catch {
      // Ignore close errors.
    }
  }, 250);
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });

    res.end(
      JSON.stringify({
        ok: true,
        activeCalls: activeCalls.size,
        maxConcurrentCalls: MAX_CONCURRENT_CALLS
      })
    );

    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", ws => {
  if (activeCalls.size >= MAX_CONCURRENT_CALLS) {
    rejectOverload(ws);
    return;
  }

  const call = createCall(ws);

  console.log(`[${call.id}] Exotel connected`);

  ws.on("message", raw => {
    if (call.destroyed) {
      return;
    }

    let event;

    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (event.event === "start") {
      startCall(call, event.start || event);
      return;
    }

    if (event.event === "media") {
      const payload = event.media?.payload;

      if (!payload) {
        return;
      }

      const audio = Buffer.from(payload, "base64");

      if (socketIsOpen(call.sttSocket)) {
        try {
          call.sttSocket.send(audio);
        } catch {
          call.preSttAudio.push(audio);
        }
      } else {
        call.preSttAudio.push(audio);

        if (call.preSttAudio.length > MAX_PRE_STT_CHUNKS) {
          call.preSttAudio.shift();
        }
      }

      return;
    }

    if (event.event === "stop") {
      cleanupCall(call, "Exotel stop");
    }
  });

  ws.on("close", () => {
    cleanupCall(call, "Exotel socket closed");
  });

  ws.on("error", error => {
    console.error(
      `[${call.id}] Exotel error: ${error.message}`
    );

    cleanupCall(call, "Exotel error");
  });
});

function shutdown(signal) {
  console.log(
    `${signal}: closing ${activeCalls.size} calls`
  );

  for (const call of [...activeCalls.values()]) {
    cleanupCall(call, signal);
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `H&M voice server listening on ${PORT}; max calls=${MAX_CONCURRENT_CALLS}`
  );
});

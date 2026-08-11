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
  console.error("❌ GROQ_API_KEY is missing");
  process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
  console.error("❌ DEEPGRAM_API_KEY is missing");
  process.exit(1);
}

const GROQ_MODEL = "llama-3.1-8b-instant";

// Deepgram
const STT_MODEL = "nova-2-phonecall";

// IMPORTANT:
// Use an Aura-2 voice instead of the old aura-asteria-en.
const TTS_MODEL = "aura-2-asteria-en";

const SAMPLE_RATE = 8000;

// 8kHz * 16-bit mono * 20ms = 320 bytes
const AUDIO_CHUNK_BYTES = 320;
const AUDIO_CHUNK_MS = 20;

// Faster endpointing = faster replies.
// Deepgram endpointing is based on detected pauses.
const ENDPOINTING_MS = 220;

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

const activeCalls = new Map();

let callCounter = 1;


// ============================================================
// FAKE H&M DATABASE
// ============================================================

const PRODUCTS = [
  {
    id: "HM-JNS-001",
    name: "Bootcut High Waist Jeans",
    category: "Jeans",
    price: 2499,
    colors: [
      "dark blue",
      "light blue",
      "black",
      "faded teal",
      "bluish green",
      "faded bluish green"
    ],
    sizes: ["28", "30", "32", "34", "36"],
    materials: [
      "cotton",
      "stretch cotton",
      "elastane"
    ],
    material: "98% Cotton, 2% Elastane",
    description:
      "Classic high-waist bootcut jeans with a slight stretch."
  },

  {
    id: "HM-DRS-501",
    name: "Ribbed Midi Dress",
    category: "Dresses",
    price: 1999,
    colors: [
      "burgundy",
      "black",
      "cream",
      "dark red",
      "wine"
    ],
    sizes: ["XS", "S", "M", "L"],
    materials: [
      "viscose",
      "viscose blend",
      "ribbed jersey"
    ],
    material: "Viscose Blend",
    description:
      "Soft ribbed midi dress with a fitted silhouette."
  },

  {
    id: "HM-TSH-102",
    name: "Oversized Cotton T-Shirt",
    category: "T-Shirts",
    price: 999,
    colors: [
      "white",
      "black",
      "sage green",
      "beige"
    ],
    sizes: ["S", "M", "L", "XL"],
    materials: [
      "cotton",
      "organic cotton"
    ],
    material: "100% Organic Cotton",
    description:
      "Relaxed oversized T-shirt made from organic cotton."
  },

  {
    id: "HM-HOD-220",
    name: "Relaxed Fit Hoodie",
    category: "Hoodies",
    price: 2299,
    colors: [
      "black",
      "grey",
      "navy",
      "cream"
    ],
    sizes: ["S", "M", "L", "XL", "XXL"],
    materials: [
      "cotton",
      "fleece"
    ],
    material: "Cotton Fleece",
    description:
      "Warm relaxed-fit hoodie with a soft fleece interior."
  },

  {
    id: "HM-JKT-310",
    name: "Oversized Denim Jacket",
    category: "Jackets",
    price: 3499,
    colors: [
      "blue",
      "light blue",
      "washed blue",
      "black"
    ],
    sizes: ["S", "M", "L", "XL"],
    materials: [
      "denim",
      "cotton"
    ],
    material: "100% Cotton Denim",
    description:
      "Oversized washed denim jacket."
  }
];


// ============================================================
// FAKE CUSTOMER DATABASE
// ============================================================

const CUSTOMERS = {

  "919876543210": {
    name: "Syed",
    phone: "919876543210",
    loyaltyPoints: 450,

    cart: [
      {
        productId: "HM-JNS-001",
        name: "Bootcut High Waist Jeans",
        size: "32",
        color: "faded teal",
        quantity: 1,
        price: 2499
      }
    ],

    lastOrder: {
      id: "HM88291",
      status: "Shipped",
      trackingNumber: "HMTX8829101",
      delivery: "August 15",
      items: [
        "Bootcut High Waist Jeans"
      ]
    }
  },

  "08667859535": {
    name: "Syed",
    phone: "08667859535",
    loyaltyPoints: 450,

    cart: [],

    lastOrder: {
      id: "HM88291",
      status: "Shipped",
      trackingNumber: "HMTX8829101",
      delivery: "August 15",
      items: [
        "Bootcut High Waist Jeans"
      ]
    }
  }
};


// ============================================================
// TEXT HELPERS
// ============================================================

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}


// ============================================================
// COMMON ASR CORRECTIONS
// ============================================================
//
// Phone STT can produce:
// "a dress" -> "address"
// "jeans" -> "genes"
// "t-shirt" -> "teacher"
// etc.
//
// We don't blindly replace every occurrence.
// We use the surrounding shopping context.
//

function correctShoppingTranscript(text) {

  let t = normalizeText(text);

  const corrections = [

    // dress/address
    {
      regex: /\b(address|adress)\b/g,
      replacement: "dress"
    },

    // jeans/genes
    {
      regex: /\bgenes\b/g,
      replacement: "jeans"
    },

    // shirt
    {
      regex: /\b(t shirt|tee shirt|tshirt)\b/g,
      replacement: "t-shirt"
    },

    // hoodie
    {
      regex: /\b(hodie|hoody)\b/g,
      replacement: "hoodie"
    },

    // colour
    {
      regex: /\b(color|colour)\b/g,
      replacement: "color"
    },

    // bluish green variants
    {
      regex: /\b(blueish green|bluishgreen|blue green)\b/g,
      replacement: "bluish green"
    },

    // faded blue-green
    {
      regex: /\b(faded blue green|faded bluishgreen)\b/g,
      replacement: "faded bluish green"
    }
  ];

  for (const rule of corrections) {
    t = t.replace(rule.regex, rule.replacement);
  }

  return t;
}


// ============================================================
// PRODUCT SEARCH
// ============================================================

function searchProducts(query) {

  const q = normalizeText(query);

  const words = q.split(/\s+/);

  return PRODUCTS.filter(product => {

    const searchable = [
      product.name,
      product.category,
      product.description,
      product.material,
      ...(product.colors || []),
      ...(product.materials || []),
      ...(product.sizes || [])
    ]
      .join(" ")
      .toLowerCase();

    if (searchable.includes(q)) {
      return true;
    }

    let matches = 0;

    for (const word of words) {

      if (word.length < 3) {
        continue;
      }

      if (searchable.includes(word)) {
        matches++;
      }
    }

    return matches >= Math.min(2, words.length);
  });
}


// ============================================================
// END CALL DETECTION
// ============================================================

const END_PHRASES = [
  "that's it",
  "thats it",
  "nothing else",
  "no that's all",
  "no thats all",
  "that's all",
  "thats all",
  "i'm done",
  "im done",
  "bye",
  "goodbye",
  "that's everything",
  "thats everything"
];

function isEndIntent(text) {

  const t = normalizeText(text);

  return END_PHRASES.some(phrase => {

    if (t === phrase) {
      return true;
    }

    if (
      t.length <= phrase.length + 10 &&
      t.includes(phrase)
    ) {
      return true;
    }

    return false;
  });
}


// ============================================================
// AUDIO QUEUE
// ============================================================

function createAudioQueue(call) {

  let queue = [];
  let timer = null;

  function pump() {

    if (
      call.destroyed ||
      !queue.length
    ) {
      timer = null;
      return;
    }

    const chunk = queue.shift();

    if (
      call.exotelWs &&
      call.exotelWs.readyState === WebSocket.OPEN &&
      call.streamSid
    ) {

      try {

        call.exotelWs.send(
          JSON.stringify({
            event: "media",
            stream_sid: call.streamSid,
            media: {
              payload: chunk.toString("base64")
            }
          })
        );

      } catch (error) {

        console.error(
          `[${call.id}] Audio send error:`,
          error.message
        );

      }
    }

    timer = setTimeout(
      pump,
      AUDIO_CHUNK_MS
    );
  }

  return {

    enqueue(buffer) {

      if (!Buffer.isBuffer(buffer)) {
        return;
      }

      for (
        let i = 0;
        i < buffer.length;
        i += AUDIO_CHUNK_BYTES
      ) {

        queue.push(
          buffer.subarray(
            i,
            Math.min(
              i + AUDIO_CHUNK_BYTES,
              buffer.length
            )
          )
        );
      }

      if (!timer) {
        pump();
      }
    },

    clear() {

      queue = [];

      if (timer) {
        clearTimeout(timer);
      }

      timer = null;
    },

    size() {
      return queue.length;
    }
  };
}


// ============================================================
// DEEPGRAM STT
// ============================================================

function connectDeepgramSTT(call) {

  return new Promise((resolve, reject) => {

    const params = new URLSearchParams({
      model: STT_MODEL,
      encoding: "linear16",
      sample_rate: "8000",
      channels: "1",
      interim_results: "true",
      endpointing: String(ENDPOINTING_MS),
      utterance_end_ms: "700",
      smart_format: "false",
      punctuate: "true"
    });

    const url =
      `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    console.log(
      `[${call.id}] Connecting Deepgram STT...`
    );

    const socket = new WebSocket(
      url,
      {
        headers: {
          Authorization:
            `Token ${DEEPGRAM_API_KEY}`
        }
      }
    );

    let opened = false;

    socket.on("open", () => {

      opened = true;

      console.log(
        `[${call.id}] Deepgram STT connected`
      );

      resolve(socket);
    });

    socket.on("message", data => {

      if (call.destroyed) {
        return;
      }

      try {

        const msg =
          JSON.parse(data.toString());

        const alternative =
          msg.channel?.alternatives?.[0];

        if (!alternative) {
          return;
        }

        let transcript =
          alternative.transcript || "";

        if (!transcript.trim()) {
          return;
        }

        transcript =
          normalizeText(transcript);

        // ----------------------------------------------------
        // BARGE-IN
        // ----------------------------------------------------

        if (
          call.aiSpeaking &&
          !call.interrupting &&
          transcript.split(" ").length >= 2
        ) {

          console.log(
            `[${call.id}] Barge-in detected: ${transcript}`
          );

          interruptAI(call);
        }

        // ----------------------------------------------------
        // FINAL TURN
        // ----------------------------------------------------

        if (
          msg.is_final &&
          transcript.trim()
        ) {

          const corrected =
            correctShoppingTranscript(
              transcript
            );

          console.log(
            `[${call.id}] CUSTOMER: ${transcript}`
          );

          if (corrected !== transcript) {

            console.log(
              `[${call.id}] ASR CORRECTED: ${corrected}`
            );
          }

          call.pendingTranscript = corrected;

          if (msg.speech_final) {

            const finalText =
              call.pendingTranscript;

            call.pendingTranscript = "";

            handleUserSpeech(
              call,
              finalText
            );
          }
        }

      } catch (error) {

        console.error(
          `[${call.id}] STT message error:`,
          error.message
        );
      }
    });

    socket.on("error", error => {

      console.error(
        `[${call.id}] Deepgram STT error:`,
        error.message
      );

      if (!opened) {
        reject(error);
      }
    });

    socket.on("close", () => {

      console.log(
        `[${call.id}] Deepgram STT closed`
      );

    });
  });
}


// ============================================================
// DEEPGRAM TTS
// ============================================================

function connectDeepgramTTS(call) {

  return new Promise((resolve, reject) => {

    // IMPORTANT:
    // Do NOT use container=none.
    //
    // Streaming TTS supports raw linear16.
    //
    const params = new URLSearchParams({
      model: TTS_MODEL,
      encoding: "linear16",
      sample_rate: "8000"
    });

    const url =
      `wss://api.deepgram.com/v1/speak?${params.toString()}`;

    console.log(
      `[${call.id}] Connecting Deepgram TTS...`
    );

    const socket = new WebSocket(
      url,
      {
        headers: {
          Authorization:
            `Token ${DEEPGRAM_API_KEY}`
        }
      }
    );

    let opened = false;

    socket.on("open", () => {

      opened = true;

      console.log(
        `[${call.id}] Deepgram TTS connected`
      );

      resolve(socket);
    });

    socket.on("message", data => {

      if (call.destroyed) {
        return;
      }

      // Audio is binary.
      if (Buffer.isBuffer(data)) {

        if (!call.interrupting) {

          call.audioQueue.enqueue(data);
        }

        return;
      }

      // Deepgram can also send JSON control events.
      try {

        const message =
          JSON.parse(data.toString());

        if (message.type === "Warning") {

          console.warn(
            `[${call.id}] TTS warning:`,
            message.description
          );
        }

      } catch {
        // Binary/non-JSON message.
      }
    });

    socket.on("error", error => {

      console.error(
        `[${call.id}] Deepgram TTS error:`,
        error.message
      );

      if (!opened) {
        reject(error);
      }
    });

    socket.on("close", () => {

      console.log(
        `[${call.id}] Deepgram TTS closed`
      );

    });
  });
}


// ============================================================
// INTERRUPT AI
// ============================================================

function interruptAI(call) {

  call.interrupting = true;
  call.aiSpeaking = false;

  call.responseGeneration++;

  call.audioQueue.clear();

  if (
    call.exotelWs &&
    call.exotelWs.readyState === WebSocket.OPEN
  ) {

    try {

      call.exotelWs.send(
        JSON.stringify({
          event: "clear",
          stream_sid: call.streamSid
        })
      );

    } catch {
      // Ignore clear failure.
    }
  }

  if (
    call.ttsSocket &&
    call.ttsSocket.readyState === WebSocket.OPEN
  ) {

    try {

      call.ttsSocket.send(
        JSON.stringify({
          type: "Clear"
        })
      );

    } catch {
      // Ignore.
    }
  }

  setTimeout(() => {

    if (!call.destroyed) {
      call.interrupting = false;
    }

  }, 100);
}


// ============================================================
// SEND TEXT TO TTS
// ============================================================

function speak(call, text) {

  if (
    call.destroyed ||
    call.interrupting
  ) {
    return;
  }

  const clean = String(text || "").trim();

  if (!clean) {
    return;
  }

  if (
    !call.ttsSocket ||
    call.ttsSocket.readyState !== WebSocket.OPEN
  ) {

    console.error(
      `[${call.id}] TTS socket unavailable`
    );

    return;
  }

  try {

    call.ttsSocket.send(
      JSON.stringify({
        type: "Speak",
        text: clean
      })
    );

  } catch (error) {

    console.error(
      `[${call.id}] TTS send error:`,
      error.message
    );
  }
}


// ============================================================
// FLUSH TTS
// ============================================================

function flushTTS(call) {

  if (
    call.ttsSocket &&
    call.ttsSocket.readyState === WebSocket.OPEN
  ) {

    try {

      call.ttsSocket.send(
        JSON.stringify({
          type: "Flush"
        })
      );

    } catch {
      // Ignore.
    }
  }
}


// ============================================================
// CUSTOMER LOOKUP
// ============================================================

function findCustomer(phone) {

  if (!phone) {
    return null;
  }

  const cleaned =
    String(phone)
      .replace(/\D/g, "");

  if (CUSTOMERS[cleaned]) {
    return CUSTOMERS[cleaned];
  }

  return null;
}


// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(call) {

  const customer =
    call.customer || {
      name: "Guest",
      loyaltyPoints: 0,
      cart: [],
      lastOrder: null
    };

  return `
You are a highly natural H&M phone customer-service and shopping assistant.

You are speaking to a real customer on a telephone call.

PERSONALITY:
- Sound like a real helpful human employee.
- Be warm, confident, natural and conversational.
- Never sound robotic.
- Do not repeatedly say "I'm an AI".
- Do not over-explain.
- Use short spoken sentences.
- Do not use bullet points while speaking.
- Don't repeat the customer's entire sentence unnecessarily.
- Ask one useful question at a time.
- If the customer gives enough information, move the conversation forward.
- If something is unclear, ask naturally.
- Never invent an unavailable product.
- Understand natural descriptions such as:
  "faded bluish green",
  "dark washed blue",
  "something loose",
  "a little oversized",
  "not too tight",
  "something casual".
- Understand sizes, colours, materials, categories and fit.

IMPORTANT SPEECH RECOGNITION RULE:
Telephone speech recognition can make mistakes.

Examples:
"a dress" may become "address"
"jeans" may become "genes"
"t-shirt" may become "teacher"

Use conversational context to determine what the customer probably meant.

If the customer says something that clearly sounds like a shopping item, prefer the shopping interpretation rather than assuming they are talking about an unrelated topic.

For example:
Customer: "I want a dress"
Even if STT incorrectly produced "address", interpret it as "dress".

PRODUCT DATABASE:
${JSON.stringify(PRODUCTS)}

CUSTOMER:
${JSON.stringify(customer)}

CURRENT CART:
${JSON.stringify(call.cart)}

CURRENT ORDER:
${JSON.stringify(customer.lastOrder || null)}

AVAILABLE ACTIONS:
- search products
- recommend products
- explain products
- add products to cart
- remove products from cart
- change cart quantity
- change size
- change color
- show cart
- provide order details
- provide tracking details
- explain loyalty points
- help with general H&M shopping questions

SHOPPING LOGIC:
If customer says:
"I want a dress"
Ask useful follow-up such as style, size or color.

If customer says:
"I want the bootcut jeans"
Recognize the product.

If customer says:
"faded bluish green"
Treat that as a valid colour description and match it to the closest available product colour.

If an exact color is not available:
Do not reject the customer.
Offer the closest available option.

If size is unavailable:
Tell them naturally and offer available sizes.

CART:
When adding something, confirm the product, size, color and quantity when those details are known.

ORDER:
If customer asks about their order, use the customer database.
Never invent tracking information.

UNKNOWN QUESTIONS:
If the customer asks something unrelated to H&M, answer briefly if it is harmless and useful, then bring the conversation back to H&M.

NEVER SAY:
"Sorry, I had trouble there"
unless there is genuinely no recoverable response.

If the customer's request is ambiguous, ask a natural clarification instead.

CALL END:
If the customer says they are finished, do not immediately end.
The application handles confirmation separately.
`;
}


// ============================================================
// GROQ RESPONSE
// ============================================================

async function generateResponse(call, userText) {

  const generation =
    ++call.responseGeneration;

  call.aiSpeaking = true;

  call.history.push({
    role: "user",
    content: userText
  });

  try {

    const messages = [
      {
        role: "system",
        content: buildSystemPrompt(call)
      },
      ...call.history.slice(-12)
    ];

    const stream =
      await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages,
        temperature: 0.35,
        max_tokens: 100,
        stream: true
      });

    let fullResponse = "";

    let sentenceBuffer = "";

    let firstTextSent = false;

    for await (const chunk of stream) {

      if (
        call.destroyed ||
        generation !== call.responseGeneration ||
        call.interrupting
      ) {
        break;
      }

      const token =
        chunk.choices?.[0]?.delta?.content || "";

      if (!token) {
        continue;
      }

      fullResponse += token;
      sentenceBuffer += token;

      // ------------------------------------------------------
      // LOW LATENCY TTS
      // ------------------------------------------------------
      //
      // Start speaking after a small natural phrase,
      // rather than waiting for the entire answer.
      //

      const trimmed =
        sentenceBuffer.trim();

      const hasSentenceEnd =
        /[.!?]\s*$/.test(trimmed);

      const longEnough =
        trimmed.length >= 45;

      if (
        hasSentenceEnd ||
        longEnough
      ) {

        const textToSpeak =
          sentenceBuffer.trim();

        if (textToSpeak) {

          speak(
            call,
            textToSpeak
          );

          firstTextSent = true;

          sentenceBuffer = "";
        }
      }
    }

    // Speak remaining text.
    if (
      generation === call.responseGeneration &&
      !call.interrupting &&
      !call.destroyed
    ) {

      const remaining =
        sentenceBuffer.trim();

      if (remaining) {

        speak(
          call,
          remaining
        );
      }

      flushTTS(call);

      if (fullResponse.trim()) {

        call.history.push({
          role: "assistant",
          content: fullResponse.trim()
        });
      }

      // Keep this true until audio queue has had time
      // to play instead of immediately assuming speech ended.
      setTimeout(() => {

        if (
          !call.destroyed &&
          generation === call.responseGeneration
        ) {
          call.aiSpeaking = false;
        }

      }, 500);

    }

    return fullResponse;

  } catch (error) {

    console.error(
      `[${call.id}] Groq error:`,
      error.message
    );

    if (
      generation === call.responseGeneration &&
      !call.destroyed
    ) {

      // Don't expose technical errors to customer.
      //
      // Give a useful recovery response.
      //
      speak(
        call,
        "Sorry, could you say that once more?"
      );

      flushTTS(call);
    }

    return null;
  }
}


// ============================================================
// END CALL CONFIRMATION
// ============================================================

async function handleEndIntent(call) {

  if (call.endConfirmed) {
    return;
  }

  if (call.endConfirmationPending) {
    return;
  }

  call.endConfirmationPending = true;

  const confirmation =
    "Just to confirm, would you like me to end the call?";

  call.history.push({
    role: "assistant",
    content: confirmation
  });

  speak(call, confirmation);
  flushTTS(call);

  setTimeout(() => {

    if (!call.destroyed) {
      call.endConfirmationPending = false;
    }

  }, 1500);
}


// ============================================================
// CHECK CONFIRMATION
// ============================================================

function isYes(text) {

  const t = normalizeText(text);

  return [
    "yes",
    "yeah",
    "yep",
    "yes please",
    "please do",
    "do it",
    "sure",
    "okay",
    "ok",
    "that's okay",
    "thats okay"
  ].includes(t);
}


function isNo(text) {

  const t = normalizeText(text);

  return [
    "no",
    "nope",
    "not yet",
    "no thanks",
    "keep it open",
    "don't",
    "dont"
  ].includes(t);
}


// ============================================================
// MAIN USER SPEECH HANDLER
// ============================================================

async function handleUserSpeech(call, rawText) {

  if (
    call.destroyed ||
    call.interrupting
  ) {
    return;
  }

  let text =
    correctShoppingTranscript(rawText);

  text =
    normalizeText(text);

  if (!text) {
    return;
  }

  // ----------------------------------------------------------
  // END CONFIRMATION
  // ----------------------------------------------------------

  if (call.endConfirmationPending) {

    call.endConfirmationPending = false;

    if (isYes(text)) {

      call.endConfirmed = true;

      speak(
        call,
        "Absolutely. Thanks for calling H&M. Have a great day!"
      );

      flushTTS(call);

      // We do not forcibly close Exotel here because
      // different Exotel stream configurations handle
      // call termination differently.
      //
      // Your Exotel hangup API/webhook can terminate the
      // actual call after endConfirmed becomes true.

      return;
    }

    if (isNo(text)) {

      speak(
        call,
        "Of course. How else can I help you?"
      );

      flushTTS(call);

      call.history.push({
        role: "assistant",
        content: "Of course. How else can I help you?"
      });

      return;
    }

    // If they said something else, continue normally.
  }

  // ----------------------------------------------------------
  // END INTENT
  // ----------------------------------------------------------

  if (isEndIntent(text)) {

    await handleEndIntent(call);
    return;
  }

  // ----------------------------------------------------------
  // NORMAL CONVERSATION
  // ----------------------------------------------------------

  await generateResponse(
    call,
    text
  );
}


// ============================================================
// GREETING
// ============================================================

function sendGreeting(call) {

  const name =
    call.customer?.name || "there";

  const greeting =
    `Hi ${name}! Thanks for calling H&M. I can help you find products, check sizes and colours, manage your cart, or check an existing order. What would you like to shop for today?`;

  call.history.push({
    role: "assistant",
    content: greeting
  });

  call.aiSpeaking = true;

  speak(
    call,
    greeting
  );

  flushTTS(call);
}


// ============================================================
// CALL SESSION
// ============================================================

async function startCallSession(exotelWs) {

  const call = {

    id: `CALL-${callCounter++}`,

    exotelWs,

    streamSid: null,
    callSid: null,

    destroyed: false,

    customer: null,

    history: [],

    cart: [],

    aiSpeaking: false,

    interrupting: false,

    responseGeneration: 0,

    pendingTranscript: "",

    endConfirmationPending: false,

    endConfirmed: false,

    sttSocket: null,

    ttsSocket: null,

    audioQueue: null
  };

  call.audioQueue =
    createAudioQueue(call);

  activeCalls.set(
    call.id,
    call
  );

  console.log("");
  console.log("============================================");
  console.log(
    `[${call.id}] EXOTEL STREAM CONNECTED`
  );
  console.log("============================================");

  // ----------------------------------------------------------
  // EXOTEL MESSAGE
  // ----------------------------------------------------------

  exotelWs.on("message", async data => {

    if (call.destroyed) {
      return;
    }

    try {

      const msg =
        JSON.parse(data.toString());

      // ------------------------------------------------------
      // START
      // ------------------------------------------------------

      if (msg.event === "start") {

        const start =
          msg.start || {};

        call.streamSid =
          msg.stream_sid ||
          start.stream_sid ||
          start.streamSid ||
          null;

        call.callSid =
          start.call_sid ||
          start.callSid ||
          msg.call_sid ||
          null;

        const phone =
          start.custom_parameters?.phone ||
          start.customParameters?.phone ||
          start.from ||
          start.phone ||
          null;

        call.customer =
          findCustomer(phone);

        if (call.customer) {

          // Clone cart so one call doesn't modify DB object.
          call.cart =
            JSON.parse(
              JSON.stringify(
                call.customer.cart || []
              )
            );

        } else {

          call.cart = [];
        }

        console.log(
          `[${call.id}] CALL SID: ${call.callSid || "unknown"}`
        );

        console.log(
          `[${call.id}] STREAM SID: ${call.streamSid || "unknown"}`
        );

        console.log(
          `[${call.id}] PHONE: ${phone || "unknown"}`
        );

        console.log(
          `[${call.id}] CUSTOMER: ${
            call.customer?.name || "Guest"
          }`
        );

        try {

          // Connect both in parallel.
          const [
            stt,
            tts
          ] =
            await Promise.all([
              connectDeepgramSTT(call),
              connectDeepgramTTS(call)
            ]);

          call.sttSocket = stt;
          call.ttsSocket = tts;

          console.log(
            `[${call.id}] Deepgram STT/TTS READY`
          );

          sendGreeting(call);

        } catch (error) {

          console.error(
            `[${call.id}] DEEPGRAM SETUP ERROR:`,
            error.message
          );

          destroyCall(call);
        }

        return;
      }

      // ------------------------------------------------------
      // MEDIA
      // ------------------------------------------------------

      if (msg.event === "media") {

        const payload =
          msg.media?.payload;

        if (!payload) {
          return;
        }

        if (
          call.sttSocket &&
          call.sttSocket.readyState === WebSocket.OPEN
        ) {

          const audio =
            Buffer.from(
              payload,
              "base64"
            );

          try {

            call.sttSocket.send(audio);

          } catch (error) {

            console.error(
              `[${call.id}] STT audio send error:`,
              error.message
            );
          }
        }

        return;
      }

      // ------------------------------------------------------
      // STOP
      // ------------------------------------------------------

      if (msg.event === "stop") {

        console.log(
          `[${call.id}] EXOTEL CALL STOP`
        );

        destroyCall(call);

        return;
      }

    } catch (error) {

      console.error(
        `[${call.id}] Exotel message error:`,
        error.message
      );
    }
  });


  // ----------------------------------------------------------
  // CLOSE
  // ----------------------------------------------------------

  exotelWs.on("close", () => {

    console.log(
      `[${call.id}] EXOTEL WS CLOSED`
    );

    destroyCall(call);
  });


  // ----------------------------------------------------------
  // ERROR
  // ----------------------------------------------------------

  exotelWs.on("error", error => {

    console.error(
      `[${call.id}] EXOTEL WS ERROR:`,
      error.message
    );

    destroyCall(call);
  });
}


// ============================================================
// CLEANUP
// ============================================================

function destroyCall(call) {

  if (call.destroyed) {
    return;
  }

  call.destroyed = true;

  call.audioQueue?.clear();

  try {

    if (
      call.sttSocket &&
      call.sttSocket.readyState === WebSocket.OPEN
    ) {
      call.sttSocket.close();
    }

  } catch {}

  try {

    if (
      call.ttsSocket &&
      call.ttsSocket.readyState === WebSocket.OPEN
    ) {
      call.ttsSocket.close();
    }

  } catch {}

  activeCalls.delete(call.id);

  console.log(
    `[${call.id}] CLEANED UP`
  );
}


// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer((req, res) => {

    if (req.url === "/") {

      res.writeHead(
        200,
        {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      );

      return res.end(
        "H&M Voice Assistant is running."
      );
    }

    if (req.url === "/health") {

      res.writeHead(
        200,
        {
          "Content-Type":
            "application/json"
        }
      );

      return res.end(
        JSON.stringify({
          status: "ok",
          activeCalls:
            activeCalls.size,
          uptime:
            process.uptime()
        })
      );
    }

    res.writeHead(404);

    res.end("Not found");
  });


// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss =
  new WebSocket.Server({
    server
  });

wss.on(
  "connection",
  ws => {

    startCallSession(ws)
      .catch(error => {

        console.error(
          "Session startup error:",
          error
        );

        try {
          ws.close();
        } catch {}
      });
  }
);


// ============================================================
// GLOBAL ERROR HANDLING
// ============================================================

process.on(
  "uncaughtException",
  error => {

    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {

    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);


// ============================================================
// START
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log("============================================");
    console.log(" H&M AI VOICE ASSISTANT");
    console.log("============================================");
    console.log(
      `Server running on port ${PORT}`
    );
    console.log(
      `Groq model: ${GROQ_MODEL}`
    );
    console.log(
      `Deepgram STT: ${STT_MODEL}`
    );
    console.log(
      `Deepgram TTS: ${TTS_MODEL}`
    );
    console.log(
      `Sample rate: ${SAMPLE_RATE} Hz`
    );
    console.log("============================================");
    console.log("");
  }
);

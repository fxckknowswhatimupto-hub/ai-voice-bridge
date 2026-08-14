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
  console.error("ERROR: GROQ_API_KEY is missing.");
  process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
  console.error("ERROR: DEEPGRAM_API_KEY is missing.");
  process.exit(1);
}

const GROQ_MODEL =
  process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const DEEPGRAM_STT_MODEL =
  process.env.DEEPGRAM_STT_MODEL || "nova-2-phonecall";

const DEEPGRAM_TTS_MODEL =
  process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en";

const STT_SAMPLE_RATE = 8000;
const TTS_SAMPLE_RATE = 8000;

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
      "faded teal"
    ],
    sizes: [
      "28",
      "30",
      "32",
      "34",
      "36"
    ],
    materials: [
      "cotton",
      "elastane",
      "stretch"
    ],
    materialDescription:
      "98% Cotton, 2% Elastane",
    stock: 18
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
    sizes: [
      "S",
      "M",
      "L",
      "XL"
    ],
    materials: [
      "organic cotton",
      "cotton"
    ],
    materialDescription:
      "100% Organic Cotton",
    stock: 42
  },

  {
    id: "HM-DRS-501",
    name: "Ribbed Midi Dress",
    category: "Dresses",
    price: 1999,
    colors: [
      "burgundy",
      "black",
      "cream"
    ],
    sizes: [
      "XS",
      "S",
      "M",
      "L"
    ],
    materials: [
      "viscose",
      "viscose blend"
    ],
    materialDescription:
      "Viscose Blend",
    stock: 14
  },

  {
    id: "HM-HOD-301",
    name: "Relaxed Fit Hoodie",
    category: "Hoodies",
    price: 1799,
    colors: [
      "black",
      "grey",
      "cream",
      "navy"
    ],
    sizes: [
      "S",
      "M",
      "L",
      "XL",
      "XXL"
    ],
    materials: [
      "cotton",
      "polyester",
      "cotton blend"
    ],
    materialDescription:
      "80% Cotton, 20% Polyester",
    stock: 27
  }
];

// ============================================================
// CUSTOMERS
// ============================================================

const CUSTOMERS = [
  {
    phone: "8667859535",
    name: "Syed",
    loyaltyPoints: 450,

    address:
      "Coimbatore, Tamil Nadu, India",

    orders: [
      {
        id: "HM88291",
        status: "Shipped",
        product:
          "Bootcut High Waist Jeans",
        color: "dark blue",
        size: "32",
        quantity: 1,
        tracking:
          "IN-HM-928371",
        courier: "BlueDart",
        estimatedDelivery:
          "August 15"
      }
    ],

    cart: [
      {
        productId: "HM-TSH-102",
        product:
          "Oversized Cotton T-Shirt",
        color: "black",
        size: "L",
        quantity: 1
      }
    ]
  },

  {
    phone: "9876543210",
    name: "Alex",
    loyaltyPoints: 180,

    address:
      "Bangalore, Karnataka, India",

    orders: [],

    cart: []
  }
];

// ============================================================
// NORMALIZATION
// ============================================================

function normalizePhone(phone) {
  if (!phone) return "";

  let digits =
    String(phone).replace(/\D/g, "");

  if (digits.startsWith("91") &&
      digits.length >= 12) {
    digits =
      digits.substring(
        digits.length - 10
      );
  }

  if (digits.length > 10) {
    digits =
      digits.substring(
        digits.length - 10
      );
  }

  return digits;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// CUSTOMER LOOKUP
// ============================================================

function findCustomer(phone) {
  const normalized =
    normalizePhone(phone);

  return (
    CUSTOMERS.find(
      c =>
        normalizePhone(c.phone) ===
        normalized
    ) || null
  );
}

// ============================================================
// PRODUCT SEARCH
// ============================================================

function searchProducts(text) {
  const q =
    normalizeText(text);

  return PRODUCTS.filter(product => {
    if (
      q.includes(
        normalizeText(product.name)
      )
    ) {
      return true;
    }

    if (
      q.includes(
        normalizeText(product.category)
      )
    ) {
      return true;
    }

    if (
      product.colors.some(
        color =>
          q.includes(
            normalizeText(color)
          )
      )
    ) {
      return true;
    }

    if (
      product.materials.some(
        material =>
          q.includes(
            normalizeText(material)
          )
      )
    ) {
      return true;
    }

    return false;
  });
}

// ============================================================
// PRODUCT ATTRIBUTE EXTRACTION
// ============================================================

function findColor(text) {
  const q =
    normalizeText(text);

  for (const product of PRODUCTS) {
    for (const color of product.colors) {
      if (
        q.includes(
          normalizeText(color)
        )
      ) {
        return color;
      }
    }
  }

  return null;
}

function findSize(text) {
  const q =
    normalizeText(text);

  const sizes = [
    "xxl",
    "xl",
    "xs",
    "s",
    "m",
    "l",
    "28",
    "30",
    "32",
    "34",
    "36"
  ];

  for (const size of sizes) {
    const pattern =
      new RegExp(
        `(^|\\s)${size}($|\\s)`
      );

    if (pattern.test(q)) {
      return size.toUpperCase();
    }
  }

  return null;
}

function findMaterial(text) {
  const q =
    normalizeText(text);

  const materials = [
    "organic cotton",
    "cotton",
    "elastane",
    "stretch",
    "viscose",
    "polyester"
  ];

  return (
    materials.find(
      material =>
        q.includes(material)
    ) || null
  );
}

// ============================================================
// AUDIO QUEUE
// ============================================================

function createAudioQueue(call) {
  const queue = [];

  let timer = null;

  // 100 ms of 8kHz mono 16-bit PCM
  // = 1600 bytes.
  const CHUNK_SIZE = 1600;

  function pump() {
    if (
      call.destroyed ||
      queue.length === 0
    ) {
      timer = null;
      return;
    }

    const audio =
      queue.shift();

    if (
      call.ws &&
      call.ws.readyState ===
        WebSocket.OPEN &&
      call.streamSid
    ) {
      try {
        call.ws.send(
          JSON.stringify({
            event: "media",
            stream_sid:
              call.streamSid,

            media: {
              payload:
                audio.toString(
                  "base64"
                )
            }
          })
        );
      } catch (error) {
        console.error(
          `[${call.id}] AUDIO SEND ERROR:`,
          error.message
        );
      }
    }

    timer =
      setTimeout(
        pump,
        100
      );
  }

  return {
    enqueue(buffer) {
      if (
        !Buffer.isBuffer(buffer) ||
        buffer.length === 0
      ) {
        return;
      }

      for (
        let i = 0;
        i < buffer.length;
        i += CHUNK_SIZE
      ) {
        queue.push(
          buffer.subarray(
            i,
            i + CHUNK_SIZE
          )
        );
      }

      if (!timer) {
        pump();
      }
    },

    clear() {
      queue.length = 0;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    pending() {
      return queue.length;
    }
  };
}

// ============================================================
// DEEPGRAM HTTP ERROR EXTRACTION
// ============================================================

function createDeepgramSocket(
  url
) {
  return new Promise(
    (resolve, reject) => {
      const socket =
        new WebSocket(
          url,
          {
            headers: {
              Authorization:
                `Token ${DEEPGRAM_API_KEY}`
            }
          }
        );

      let settled = false;

      socket.once(
        "open",
        () => {
          settled = true;
          resolve(socket);
        }
      );

      socket.once(
        "unexpected-response",
        (
          request,
          response
        ) => {
          let body = "";

          response.on(
            "data",
            chunk => {
              body +=
                chunk.toString();
            }
          );

          response.on(
            "end",
            () => {
              const error =
                new Error(
                  `Deepgram HTTP ${response.statusCode}: ${body}`
                );

              if (!settled) {
                settled = true;
                reject(error);
              }
            }
          );
        }
      );

      socket.once(
        "error",
        error => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        }
      );

      socket.once(
        "close",
        () => {
          if (!settled) {
            settled = true;

            reject(
              new Error(
                "Deepgram socket closed before opening"
              )
            );
          }
        }
      );
    }
  );
}

// ============================================================
// DEEPGRAM STT
// ============================================================

async function connectSTT(call) {
  const url =
    "wss://api.deepgram.com/v1/listen" +
    `?model=${encodeURIComponent(
      DEEPGRAM_STT_MODEL
    )}` +
    "&encoding=linear16" +
    `&sample_rate=${STT_SAMPLE_RATE}` +
    "&channels=1" +
    "&interim_results=true" +
    "&smart_format=true" +
    "&punctuate=true" +
    "&endpointing=300" +
    "&utterance_end_ms=800";

  console.log(
    `[${call.id}] Connecting Deepgram STT...`
  );

  console.log(
    `[${call.id}] STT MODEL:`,
    DEEPGRAM_STT_MODEL
  );

  const socket =
    await createDeepgramSocket(
      url
    );

  console.log(
    `[${call.id}] Deepgram STT connected`
  );

  socket.on(
    "message",
    raw => {
      if (call.destroyed) {
        return;
      }

      let message;

      try {
        message =
          JSON.parse(
            raw.toString()
          );
      } catch {
        return;
      }

      if (
        message.type ===
        "KeepAlive"
      ) {
        return;
      }

      const transcript =
        message
          ?.channel
          ?.alternatives?.[0]
          ?.transcript || "";

      if (!transcript) {
        return;
      }

      const clean =
        transcript
          .replace(
            /\s+/g,
            " "
          )
          .trim();

      if (
        message.is_final !==
        true
      ) {
        call.lastInterim =
          clean;

        // Barge-in
        if (
          call.aiSpeaking &&
          clean.length > 2
        ) {
          interruptAI(call);
        }

        return;
      }

      if (
        message.speech_final !==
        true
      ) {
        call.finalParts.push(
          clean
        );

        return;
      }

      call.finalParts.push(
        clean
      );

      const finalText =
        call.finalParts
          .join(" ")
          .replace(
            /\s+/g,
            " "
          )
          .trim();

      call.finalParts = [];
      call.lastInterim = "";

      if (!finalText) {
        return;
      }

      console.log(
        `[${call.id}] CUSTOMER:`,
        finalText
      );

      handleCustomerSpeech(
        call,
        finalText
      );
    }
  );

  socket.on(
    "error",
    error => {
      console.error(
        `[${call.id}] DEEPGRAM STT ERROR:`,
        error.message
      );
    }
  );

  socket.on(
    "close",
    (code, reason) => {
      call.sttReady =
        false;

      if (!call.destroyed) {
        console.log(
          `[${call.id}] STT CLOSED`,
          code,
          reason?.toString() ||
            ""
        );
      }
    }
  );

  return socket;
}

// ============================================================
// DEEPGRAM TTS
// ============================================================

async function connectTTS(call) {
  const url =
    "wss://api.deepgram.com/v1/speak" +
    `?model=${encodeURIComponent(
      DEEPGRAM_TTS_MODEL
    )}` +
    "&encoding=linear16" +
    `&sample_rate=${TTS_SAMPLE_RATE}` +
    "&speed=1.08";

  console.log(
    `[${call.id}] Connecting Deepgram TTS...`
  );

  const socket =
    await createDeepgramSocket(
      url
    );

  console.log(
    `[${call.id}] Deepgram TTS connected`
  );

  socket.on(
    "message",
    (data, isBinary) => {
      if (call.destroyed) {
        return;
      }

      if (
        isBinary ||
        Buffer.isBuffer(data)
      ) {
        if (
          call.aiSpeaking
        ) {
          call.audioQueue.enqueue(
            Buffer.from(data)
          );
        }

        return;
      }

      let message;

      try {
        message =
          JSON.parse(
            data.toString()
          );
      } catch {
        return;
      }

      if (
        message.type ===
        "Warning"
      ) {
        console.log(
          `[${call.id}] TTS WARNING:`,
          message.description ||
            message.code ||
            "unknown"
        );
      }

      if (
        message.type ===
        "Flushed"
      ) {
        call.ttsFlushed =
          true;
      }
    }
  );

  socket.on(
    "error",
    error => {
      console.error(
        `[${call.id}] DEEPGRAM TTS ERROR:`,
        error.message
      );
    }
  );

  socket.on(
    "close",
    () => {
      call.ttsReady =
        false;

      if (!call.destroyed) {
        console.log(
          `[${call.id}] TTS CLOSED`
        );
      }
    }
  );

  return socket;
}

// ============================================================
// KEEPALIVE
// ============================================================

function startKeepAlive(call) {
  call.keepAliveTimer =
    setInterval(
      () => {
        if (
          call.destroyed
        ) {
          return;
        }

        if (
          call.sttSocket &&
          call.sttSocket.readyState ===
            WebSocket.OPEN
        ) {
          try {
            call.sttSocket.send(
              JSON.stringify({
                type:
                  "KeepAlive"
              })
            );
          } catch {}
        }
      },
      3000
    );
}

// ============================================================
// INTERRUPT
// ============================================================

function interruptAI(call) {
  if (!call.aiSpeaking) {
    return;
  }

  console.log(
    `[${call.id}] BARGE-IN`
  );

  call.responseGeneration++;

  call.aiSpeaking =
    false;

  call.audioQueue.clear();

  if (
    call.ws &&
    call.ws.readyState ===
      WebSocket.OPEN
  ) {
    try {
      call.ws.send(
        JSON.stringify({
          event: "clear",
          stream_sid:
            call.streamSid
        })
      );
    } catch {}
  }

  if (
    call.ttsSocket &&
    call.ttsSocket.readyState ===
      WebSocket.OPEN
  ) {
    try {
      call.ttsSocket.send(
        JSON.stringify({
          type: "Clear"
        })
      );
    } catch {}
  }
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(call) {
  const customer =
    call.customer;

  const cart =
    customer?.cart || [];

  const orders =
    customer?.orders || [];

  return `
You are a natural human-sounding H&M customer service phone assistant.

You are talking to a customer over a telephone call.

CUSTOMER:
${JSON.stringify(
  customer || {
    name: "Guest"
  }
)}

AVAILABLE PRODUCTS:
${JSON.stringify(
  PRODUCTS
)}

CUSTOMER CART:
${JSON.stringify(
  cart
)}

CUSTOMER ORDERS:
${JSON.stringify(
  orders
)}

YOUR PERSONALITY:

- relaxed
- warm
- confident
- concise
- conversational
- natural
- helpful
- never robotic
- never overly formal
- never mention that you are an AI
- don't repeat the customer's entire sentence
- don't use long paragraphs
- don't sound like a scripted IVR

PHONE SPEAKING RULES:

Instead of:
"How may I assist you today?"

Prefer:
"Sure, what can I help you with?"

Instead of:
"I apologize for the inconvenience."

Prefer:
"Yeah, sorry about that."

Use natural phrases like:
"Sure."
"Yeah."
"Absolutely."
"Got it."
"Let me check that."
"Yep, I've got it."
"No problem."

Do NOT overuse these phrases.

IMPORTANT SPEECH RECOGNITION:

The customer may say "a dress", which speech recognition might incorrectly transcribe as "address".

Use conversational context.

If the conversation is about clothes, shopping, products, colors, sizes or materials, interpret "address" cautiously as potentially meaning "a dress".

Never ask the customer to repeat themselves merely because of a tiny transcription mistake.

PRODUCT QUESTIONS:

You can answer questions about:

- product names
- colors
- sizes
- materials
- prices
- availability
- categories
- descriptions

If the customer asks:

"Do you have the dress in black?"

Look through the product database.

If they specify a color, size or material, use that exact requirement.

CART:

You may help the customer:

- add products
- remove products
- replace products
- change size
- change color
- change quantity

Before making a meaningful cart change, confirm the exact item when necessary.

ORDERS:

You can provide:

- order ID
- order status
- courier
- tracking number
- estimated delivery
- product
- size
- color

TRACKING:

If the customer asks where their order is, provide the available tracking information from the database.

LOYALTY:

You can tell customers their loyalty points.

GOODBYE:

If the customer says goodbye, do not immediately terminate.

Ask once:

"Just to confirm, would you like me to end the call?"

Only end after confirmation.

RESPONSE LENGTH:

Normally respond in 1-3 short sentences.

This is a PHONE CALL.

Do not produce essays.

Do not use markdown.

Do not use bullet points while speaking.

Do not say:
"Sorry, I had trouble there."

Instead, if genuinely uncertain, say naturally:
"Sorry, I didn't quite catch that. Could you say that again?"

But only use that when you genuinely cannot understand the request.

`;
}

// ============================================================
// PRODUCT CONTEXT LOGIC
// ============================================================

function addContextToUserText(
  call,
  text
) {
  const products =
    searchProducts(text);

  const color =
    findColor(text);

  const size =
    findSize(text);

  const material =
    findMaterial(text);

  const context = [];

  if (products.length) {
    context.push(
      "Possible products: " +
      products
        .map(p => p.name)
        .join(", ")
    );
  }

  if (color) {
    context.push(
      `Requested color: ${color}`
    );
  }

  if (size) {
    context.push(
      `Requested size: ${size}`
    );
  }

  if (material) {
    context.push(
      `Requested material: ${material}`
    );
  }

  if (
    context.length === 0
  ) {
    return text;
  }

  return (
    text +
    "\n\nInternal shopping context:\n" +
    context.join("\n")
  );
}

// ============================================================
// GROQ RESPONSE
// ============================================================

async function generateResponse(
  call,
  userText
) {
  const generation =
    ++call.responseGeneration;

  call.aiSpeaking =
    true;

  call.audioQueue.clear();

  const enriched =
    addContextToUserText(
      call,
      userText
    );

  call.history.push({
    role: "user",
    content: enriched
  });

  try {
    const stream =
      await groq.chat.completions.create(
        {
          model:
            GROQ_MODEL,

          messages: [
            {
              role: "system",
              content:
                buildSystemPrompt(
                  call
                )
            },
            ...call.history
          ],

          temperature: 0.55,

          max_tokens: 180,

          stream: true
        }
      );

    let fullText = "";

    let sentenceBuffer = "";

    for await (
      const chunk of stream
    ) {
      if (
        call.destroyed ||
        generation !==
          call.responseGeneration
      ) {
        break;
      }

      const token =
        chunk
          ?.choices?.[0]
          ?.delta
          ?.content || "";

      if (!token) {
        continue;
      }

      fullText += token;
      sentenceBuffer += token;

      /*
       * Start TTS as soon as a natural
       * speech unit is available.
       */

      if (
        /[.!?]\s$/.test(
          sentenceBuffer
        ) ||
        sentenceBuffer.length >=
          90
      ) {
        const text =
          sentenceBuffer
            .trim();

        if (
          text &&
          call.ttsSocket &&
          call.ttsSocket.readyState ===
            WebSocket.OPEN &&
          generation ===
            call.responseGeneration
        ) {
          call.ttsSocket.send(
            JSON.stringify({
              type: "Speak",
              text
            })
          );
        }

        sentenceBuffer = "";
      }
    }

    if (
      generation !==
      call.responseGeneration
    ) {
      return;
    }

    if (
      sentenceBuffer.trim() &&
      call.ttsSocket &&
      call.ttsSocket.readyState ===
        WebSocket.OPEN
    ) {
      call.ttsSocket.send(
        JSON.stringify({
          type: "Speak",
          text:
            sentenceBuffer.trim()
        })
      );
    }

    if (
      call.ttsSocket &&
      call.ttsSocket.readyState ===
        WebSocket.OPEN
    ) {
      call.ttsSocket.send(
        JSON.stringify({
          type: "Flush"
        })
      );
    }

    call.history.push({
      role: "assistant",
      content: fullText
    });

  } catch (error) {
    console.error(
      `[${call.id}] GROQ ERROR:`,
      error.message
    );

    if (
      generation ===
      call.responseGeneration &&
      call.ttsSocket &&
      call.ttsSocket.readyState ===
        WebSocket.OPEN
    ) {
      call.ttsSocket.send(
        JSON.stringify({
          type: "Speak",
          text:
            "Sorry, give me just a second."
        })
      );

      call.ttsSocket.send(
        JSON.stringify({
          type: "Flush"
        })
      );
    }
  }
}

// ============================================================
// CUSTOMER SPEECH
// ============================================================

async function handleCustomerSpeech(
  call,
  text
) {
  if (
    call.destroyed
  ) {
    return;
  }

  const cleaned =
    normalizeText(text);

  if (!cleaned) {
    return;
  }

  /*
   * Prevent duplicate final transcripts.
   */

  if (
    cleaned ===
    call.lastProcessedText
  ) {
    return;
  }

  call.lastProcessedText =
    cleaned;

  /*
   * If assistant was speaking,
   * interrupt it.
   */

  if (
    call.aiSpeaking
  ) {
    interruptAI(call);
  }

  await generateResponse(
    call,
    text
  );
}

// ============================================================
// GREETING
// ============================================================

function sendGreeting(
  call
) {
  if (
    call.greetingSent ||
    !call.ttsReady ||
    !call.streamSid ||
    call.destroyed
  ) {
    return;
  }

  call.greetingSent =
    true;

  const name =
    call.customer?.name ||
    "there";

  const greeting =
    `Hi ${name}, welcome to H and M. What can I help you with today?`;

  console.log(
    `[${call.id}] GREETING:`,
    greeting
  );

  call.aiSpeaking =
    true;

  call.history.push({
    role: "assistant",
    content: greeting
  });

  try {
    call.ttsSocket.send(
      JSON.stringify({
        type: "Speak",
        text: greeting
      })
    );

    call.ttsSocket.send(
      JSON.stringify({
        type: "Flush"
      })
    );
  } catch (error) {
    console.error(
      `[${call.id}] GREETING ERROR:`,
      error.message
    );
  }
}

// ============================================================
// CREATE CALL
// ============================================================

function createCall(ws) {
  const call = {
    id:
      `CALL-${callCounter++}`,

    ws,

    streamSid: null,
    callSid: null,

    phoneNumber: null,
    customer: null,

    sttSocket: null,
    ttsSocket: null,

    sttReady: false,
    ttsReady: false,

    greetingSent: false,

    aiSpeaking: false,

    destroyed: false,

    responseGeneration: 0,

    lastProcessedText: "",

    lastInterim: "",

    finalParts: [],

    keepAliveTimer: null,

    audioQueue: null,

    history: []
  };

  call.audioQueue =
    createAudioQueue(
      call
    );

  return call;
}

// ============================================================
// CLOSE CALL
// ============================================================

function destroyCall(call) {
  if (
    !call ||
    call.destroyed
  ) {
    return;
  }

  call.destroyed =
    true;

  call.aiSpeaking =
    false;

  call.responseGeneration++;

  if (
    call.keepAliveTimer
  ) {
    clearInterval(
      call.keepAliveTimer
    );

    call.keepAliveTimer =
      null;
  }

  if (
    call.audioQueue
  ) {
    call.audioQueue.clear();
  }

  for (
    const socket of [
      call.sttSocket,
      call.ttsSocket
    ]
  ) {
    try {
      if (
        socket &&
        socket.readyState !==
          WebSocket.CLOSED
      ) {
        socket.close();
      }
    } catch {}
  }

  call.sttSocket =
    null;

  call.ttsSocket =
    null;

  activeCalls.delete(
    call.id
  );

  console.log(
    `[${call.id}] CLEANED UP`
  );
}

// ============================================================
// EXOTEL WEBSOCKET
// ============================================================

const server =
  http.createServer(
    (req, res) => {
      if (
        req.url ===
        "/health"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json"
          }
        );

        res.end(
          JSON.stringify({
            status: "ok",
            activeCalls:
              activeCalls.size
          })
        );

        return;
      }

      res.writeHead(
        404
      );

      res.end(
        "Not found"
      );
    }
  );

const wss =
  new WebSocket.Server({
    server
  });

// ============================================================
// EXOTEL CONNECTION
// ============================================================

wss.on(
  "connection",
  ws => {
    const call =
      createCall(ws);

    activeCalls.set(
      call.id,
      call
    );

    console.log(
      "============================================"
    );

    console.log(
      `[${call.id}] EXOTEL CONNECTED`
    );

    console.log(
      `[${call.id}] ACTIVE CALLS:`,
      activeCalls.size
    );

    console.log(
      "============================================"
    );

    /*
     * IMPORTANT:
     *
     * Do not connect STT before we know
     * the Exotel stream parameters.
     *
     * We wait for the start event.
     */

    ws.on(
      "message",
      async raw => {
        if (
          call.destroyed
        ) {
          return;
        }

        let message;

        try {
          message =
            JSON.parse(
              raw.toString()
            );
        } catch {
          console.log(
            `[${call.id}] INVALID EXOTEL MESSAGE`
          );

          return;
        }

        const event =
          message.event;

        // ------------------------------------------------------
        // CONNECTED
        // ------------------------------------------------------

        if (
          event ===
          "connected"
        ) {
          console.log(
            `[${call.id}] EXOTEL STREAM CONNECTED`
          );

          return;
        }

        // ------------------------------------------------------
        // START
        // ------------------------------------------------------

        if (
          event ===
          "start"
        ) {
          call.streamSid =
            message.stream_sid ||
            message.start?.stream_sid ||
            message.start?.streamSid ||
            null;

          call.callSid =
            message.start?.call_sid ||
            message.start?.callSid ||
            null;

          call.phoneNumber =
            message.start?.from ||
            message.start?.caller_number ||
            message.start?.phone_number ||
            null;

          call.customer =
            findCustomer(
              call.phoneNumber
            );

          console.log(
            `[${call.id}] CALL SID:`,
            call.callSid
          );

          console.log(
            `[${call.id}] STREAM SID:`,
            call.streamSid
          );

          console.log(
            `[${call.id}] PHONE:`,
            call.phoneNumber
          );

          console.log(
            `[${call.id}] CUSTOMER:`,
            call.customer?.name ||
              "Guest"
          );

          /*
           * Deepgram is started only now.
           */

          try {
            call.sttSocket =
              await connectSTT(
                call
              );

            call.sttReady =
              true;

            call.ttsSocket =
              await connectTTS(
                call
              );

            call.ttsReady =
              true;

            console.log(
              `[${call.id}] DEEPGRAM READY`
            );

            startKeepAlive(
              call
            );

            sendGreeting(
              call
            );

          } catch (error) {
            console.error(
              `[${call.id}] DEEPGRAM SETUP ERROR:`,
              error.message
            );

            /*
             * Crucially, this prints the actual
             * HTTP response from Deepgram when
             * the server returns 400.
             */

            destroyCall(
              call
            );
          }

          return;
        }

        // ------------------------------------------------------
        // MEDIA
        // ------------------------------------------------------

        if (
          event ===
          "media"
        ) {
          const payload =
            message.media?.payload;

          if (!payload) {
            return;
          }

          if (
            !call.sttSocket ||
            call.sttSocket.readyState !==
              WebSocket.OPEN
          ) {
            return;
          }

          try {
            const audio =
              Buffer.from(
                payload,
                "base64"
              );

            call.sttSocket.send(
              audio
            );

          } catch (error) {
            console.error(
              `[${call.id}] STT AUDIO ERROR:`,
              error.message
            );
          }

          return;
        }

        // ------------------------------------------------------
        // STOP
        // ------------------------------------------------------

        if (
          event ===
          "stop"
        ) {
          console.log(
            `[${call.id}] EXOTEL CALL STOP`
          );

          destroyCall(
            call
          );

          return;
        }

        // ------------------------------------------------------
        // DTMF
        // ------------------------------------------------------

        if (
          event ===
          "dtmf"
        ) {
          console.log(
            `[${call.id}] DTMF:`,
            message.dtmf?.digit
          );

          return;
        }
      }
    );

    // ----------------------------------------------------------
    // EXOTEL CLOSE
    // ----------------------------------------------------------

    ws.on(
      "close",
      () => {
        console.log(
          `[${call.id}] EXOTEL DISCONNECTED`
        );

        destroyCall(
          call
        );
      }
    );

    // ----------------------------------------------------------
    // EXOTEL ERROR
    // ----------------------------------------------------------

    ws.on(
      "error",
      error => {
        console.error(
          `[${call.id}] EXOTEL WS ERROR:`,
          error.message
        );

        destroyCall(
          call
        );
      }
    );
  }
);

// ============================================================
// SERVER ERROR
// ============================================================

server.on(
  "error",
  error => {
    console.error(
      "SERVER ERROR:",
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
    console.log(
      "============================================"
    );

    console.log(
      "H&M AI VOICE ASSISTANT"
    );

    console.log(
      "============================================"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "GROQ:",
      GROQ_MODEL
    );

    console.log(
      "DEEPGRAM STT:",
      DEEPGRAM_STT_MODEL
    );

    console.log(
      "DEEPGRAM TTS:",
      DEEPGRAM_TTS_MODEL
    );

    console.log(
      "STT SAMPLE RATE:",
      STT_SAMPLE_RATE
    );

    console.log(
      "TTS SAMPLE RATE:",
      TTS_SAMPLE_RATE
    );

    console.log(
      "Fake database: ENABLED"
    );

    console.log(
      "Barge-in: ENABLED"
    );

    console.log(
      "Streaming TTS: ENABLED"
    );

    console.log(
      "============================================"
    );
  }
);

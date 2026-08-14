"use strict";

const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = Number(process.env.PORT || 10000);

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!GROQ_API_KEY) {
  console.error("CRITICAL: GROQ_API_KEY is missing");
  process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
  console.error("CRITICAL: DEEPGRAM_API_KEY is missing");
  process.exit(1);
}

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  "llama-3.1-8b-instant";

const DEEPGRAM_STT_MODEL =
  process.env.DEEPGRAM_STT_MODEL ||
  "nova-2-phonecall";

const DEEPGRAM_TTS_MODEL =
  process.env.DEEPGRAM_TTS_MODEL ||
  "aura-2-thalia-en";

const STT_SAMPLE_RATE = 8000;
const TTS_SAMPLE_RATE = 8000;

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

let callCounter = 1;

const activeCalls = new Map();

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

    stock: 18,

    description:
      "Classic bootcut jeans with a high waist and comfortable stretch."
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
      "cotton",
      "organic cotton"
    ],

    materialDescription:
      "100% Organic Cotton",

    stock: 42,

    description:
      "Relaxed oversized fit made from heavy-weight organic cotton."
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

    stock: 14,

    description:
      "Soft ribbed midi dress with a fitted silhouette."
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

    stock: 27,

    description:
      "Soft relaxed-fit hoodie for everyday wear."
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

    cart: [
      {
        productId: "HM-TSH-102",
        product:
          "Oversized Cotton T-Shirt",
        color: "black",
        size: "L",
        quantity: 1
      }
    ],

    orders: [
      {
        id: "HM88291",

        product:
          "Bootcut High Waist Jeans",

        color: "dark blue",

        size: "32",

        quantity: 1,

        status: "Shipped",

        courier: "BlueDart",

        tracking:
          "IN-HM-928371",

        estimatedDelivery:
          "August 15"
      }
    ]
  },

  {
    phone: "9876543210",
    name: "Alex",

    loyaltyPoints: 180,

    address:
      "Bangalore, Karnataka, India",

    cart: [],

    orders: []
  }
];

// ============================================================
// TEXT HELPERS
// ============================================================

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhone(phone) {
  if (!phone) {
    return "";
  }

  let digits =
    String(phone).replace(/\D/g, "");

  if (digits.startsWith("91")) {
    digits =
      digits.slice(-10);
  }

  if (digits.length > 10) {
    digits =
      digits.slice(-10);
  }

  return digits;
}

// ============================================================
// CUSTOMER LOOKUP
// ============================================================

function findCustomer(phone) {
  const normalized =
    normalizePhone(phone);

  return (
    CUSTOMERS.find(
      customer =>
        normalizePhone(customer.phone) ===
        normalized
    ) || null
  );
}

// ============================================================
// PRODUCT HELPERS
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
      product.colors.some(color =>
        q.includes(
          normalizeText(color)
        )
      )
    ) {
      return true;
    }

    if (
      product.materials.some(material =>
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

function detectColor(text) {
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

function detectMaterial(text) {
  const q =
    normalizeText(text);

  const materials = [
    "organic cotton",
    "cotton",
    "elastane",
    "stretch",
    "viscose blend",
    "viscose",
    "polyester"
  ];

  for (const material of materials) {
    if (q.includes(material)) {
      return material;
    }
  }

  return null;
}

function detectSize(text) {
  const q =
    normalizeText(text);

  const sizes = [
    "xxl",
    "xl",
    "xs",
    "36",
    "34",
    "32",
    "30",
    "28",
    "small",
    "medium",
    "large"
  ];

  for (const size of sizes) {
    if (
      new RegExp(
        `(^|\\s)${size}($|\\s)`
      ).test(q)
    ) {
      if (size === "small") return "S";
      if (size === "medium") return "M";
      if (size === "large") return "L";

      return size.toUpperCase();
    }
  }

  return null;
}

// ============================================================
// CART OPERATIONS
// ============================================================

function addToCart(
  customer,
  product,
  color,
  size,
  quantity = 1
) {
  if (!customer) {
    return false;
  }

  const existing =
    customer.cart.find(
      item =>
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

function removeFromCart(
  customer,
  productName
) {
  if (!customer) {
    return false;
  }

  const index =
    customer.cart.findIndex(
      item =>
        normalizeText(
          item.product
        ).includes(
          normalizeText(
            productName
          )
        )
    );

  if (index === -1) {
    return false;
  }

  customer.cart.splice(index, 1);

  return true;
}

// ============================================================
// AUDIO QUEUE
// ============================================================

function createAudioQueue(call) {
  const queue = [];

  let timer = null;

  // 100ms of 8kHz 16-bit mono PCM
  const CHUNK_BYTES = 1600;

  function pump() {
    if (
      call.destroyed ||
      queue.length === 0
    ) {
      timer = null;
      return;
    }

    const chunk =
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
                chunk.toString(
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
        i += CHUNK_BYTES
      ) {
        queue.push(
          buffer.subarray(
            i,
            i + CHUNK_BYTES
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
    }
  };
}

// ============================================================
// DEEPGRAM CONNECTION
// ============================================================

function connectDeepgram(url) {
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

      let opened = false;

      socket.once(
        "open",
        () => {
          opened = true;
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
              reject(
                new Error(
                  `Deepgram HTTP ${response.statusCode}: ${body}`
                )
              );
            }
          );
        }
      );

      socket.once(
        "error",
        error => {
          if (!opened) {
            reject(error);
          }
        }
      );

      socket.once(
        "close",
        () => {
          if (!opened) {
            reject(
              new Error(
                "Deepgram closed before opening"
              )
            );
          }
        }
      );
    }
  );
}

// ============================================================
// STT
// ============================================================

async function connectSTT(call) {
  const url =
    "wss://api.deepgram.com/v1/listen" +
    `?model=${encodeURIComponent(
      DEEPGRAM_STT_MODEL
    )}` +
    "&encoding=linear16" +
    "&sample_rate=8000" +
    "&channels=1" +
    "&interim_results=true" +
    "&smart_format=true" +
    "&punctuate=true" +
    "&endpointing=300" +
    "&utterance_end_ms=800";

  console.log(
    `[${call.id}] Connecting Deepgram STT`
  );

  console.log(
    `[${call.id}] STT URL MODEL: ${DEEPGRAM_STT_MODEL}`
  );

  const socket =
    await connectDeepgram(
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
        "SpeechStarted"
      ) {
        if (
          call.aiSpeaking
        ) {
          interruptAI(
            call
          );
        }

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

        if (
          call.aiSpeaking &&
          clean.length >= 3
        ) {
          interruptAI(
            call
          );
        }

        return;
      }

      call.finalParts.push(
        clean
      );

      if (
        message.speech_final !==
        true
      ) {
        return;
      }

      const question =
        call.finalParts
          .join(" ")
          .replace(
            /\s+/g,
            " "
          )
          .trim();

      call.finalParts = [];

      call.lastInterim = "";

      if (!question) {
        return;
      }

      console.log(
        `[${call.id}] CUSTOMER: ${question}`
      );

      handleCustomerSpeech(
        call,
        question
      );
    }
  );

  socket.on(
    "error",
    error => {
      console.error(
        `[${call.id}] STT ERROR:`,
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
          `[${call.id}] STT CLOSED:`,
          code,
          reason?.toString() || ""
        );
      }
    }
  );

  return socket;
}

// ============================================================
// TTS
// ============================================================

async function connectTTS(call) {
  const url =
    "wss://api.deepgram.com/v1/speak" +
    `?model=${encodeURIComponent(
      DEEPGRAM_TTS_MODEL
    )}` +
    "&encoding=linear16" +
    "&sample_rate=8000" +
    "&container=none" +
    "&speed=1.08";

  console.log(
    `[${call.id}] Connecting Deepgram TTS`
  );

  const socket =
    await connectDeepgram(
      url
    );

  console.log(
    `[${call.id}] Deepgram TTS connected`
  );

  socket.on(
    "message",
    (data, isBinary) => {
      if (
        call.destroyed
      ) {
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
    }
  );

  socket.on(
    "error",
    error => {
      console.error(
        `[${call.id}] TTS ERROR:`,
        error.message
      );
    }
  );

  socket.on(
    "close",
    (code, reason) => {
      call.ttsReady =
        false;

      if (!call.destroyed) {
        console.log(
          `[${call.id}] TTS CLOSED:`,
          code,
          reason?.toString() || ""
        );
      }
    }
  );

  return socket;
}

// ============================================================
// DEEPGRAM KEEPALIVE
// ============================================================

function startKeepAlive(call) {
  if (call.keepAliveTimer) {
    clearInterval(
      call.keepAliveTimer
    );
  }

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
      4000
    );
}

// ============================================================
// INTERRUPT / BARGE-IN
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

  return `
You are the H&M phone customer assistant.

You sound like a relaxed, friendly, genuinely helpful human customer-service employee.

Never sound robotic.

Never mention that you are an AI.

Keep phone responses short and natural.

Use casual natural phrases when appropriate:
"Sure."
"Yeah, absolutely."
"Got it."
"No problem."
"Yep, let me check that."
"Sure, I can help with that."

Do not overuse them.

CUSTOMER:
${JSON.stringify(
  customer || {
    name: "Guest"
  }
)}

PRODUCT DATABASE:
${JSON.stringify(PRODUCTS)}

CART:
${JSON.stringify(
  customer?.cart || []
)}

ORDERS:
${JSON.stringify(
  customer?.orders || []
)}

You can help with:

- finding products
- dresses
- jeans
- shirts
- hoodies
- colors
- sizes
- materials
- prices
- stock
- product descriptions
- adding products to cart
- removing products
- replacing cart products
- changing size
- changing color
- quantities
- order status
- tracking
- courier information
- estimated delivery
- loyalty points
- customer information
- general H&M shopping assistance

SPECIFIC PRODUCT REQUIREMENTS:

If the customer asks for a very specific color, size or material, respect that requirement.

Example:

"I want a black dress in medium."

Find a dress that supports black and M.

If it exists, say so.

If it doesn't, suggest the closest available option.

IMPORTANT SPEECH RECOGNITION:

Phone speech recognition may confuse:

"a dress"

with:

"address"

If the conversation is about clothing, interpret "address" as "a dress" when that makes contextual sense.

Do not unnecessarily ask the customer to repeat themselves.

GOODBYE:

If the customer says:

"that's it"
"nothing else"
"no that's all"
"I'm done"
"bye"
"goodbye"
"that's everything"

do NOT immediately terminate.

Ask:

"Just to confirm, would you like me to end the call?"

Only terminate after the customer confirms.

PHONE STYLE:

Never give long paragraphs.

Normally answer in one to three short sentences.

Do not use markdown.

Do not use bullet points while speaking.

Do not repeatedly say:
"Sorry, I had trouble there."

Only ask the customer to repeat themselves if the speech genuinely cannot be understood.
`;
}

// ============================================================
// CONTEXT ENRICHMENT
// ============================================================

function enrichCustomerText(
  call,
  text
) {
  const products =
    searchProducts(text);

  const color =
    detectColor(text);

  const size =
    detectSize(text);

  const material =
    detectMaterial(text);

  const hints = [];

  if (products.length) {
    hints.push(
      "Relevant products: " +
      products
        .map(p => p.name)
        .join(", ")
    );
  }

  if (color) {
    hints.push(
      `Requested color: ${color}`
    );
  }

  if (size) {
    hints.push(
      `Requested size: ${size}`
    );
  }

  if (material) {
    hints.push(
      `Requested material: ${material}`
    );
  }

  if (!hints.length) {
    return text;
  }

  return (
    `${text}\n\n` +
    `INTERNAL SHOPPING CONTEXT:\n` +
    hints.join("\n")
  );
}

// ============================================================
// NATURAL RESPONSE CLEANUP
// ============================================================

function cleanForSpeech(text) {
  return String(text || "")
    .replace(
      /\*\*/g,
      ""
    )
    .replace(
      /[*_#`]/g,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

// ============================================================
// GROQ + STREAMING TTS
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
    enrichCustomerText(
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

    let fullResponse = "";

    let buffer = "";

    for await (
      const chunk of stream
    ) {
      if (
        call.destroyed ||
        generation !==
          call.responseGeneration
      ) {
        return;
      }

      const token =
        chunk
          ?.choices?.[0]
          ?.delta
          ?.content || "";

      if (!token) {
        continue;
      }

      fullResponse += token;

      buffer += token;

      /*
       * Do not wait for the entire LLM response.
       * Start TTS as soon as a natural speech
       * segment exists.
       */

      const sentenceMatch =
        buffer.match(
          /^([\s\S]*?[.!?])\s+/
        );

      if (
        sentenceMatch ||
        buffer.length >= 100
      ) {
        let speakText;

        if (sentenceMatch) {
          speakText =
            sentenceMatch[1];

          buffer =
            buffer.slice(
              sentenceMatch[0]
                .length
            );
        } else {
          const split =
            buffer.lastIndexOf(
              " "
            );

          if (
            split > 30
          ) {
            speakText =
              buffer.slice(
                0,
                split
              );

            buffer =
              buffer.slice(
                split + 1
              );
          } else {
            continue;
          }
        }

        speakText =
          cleanForSpeech(
            speakText
          );

        if (
          speakText &&
          call.ttsSocket &&
          call.ttsSocket.readyState ===
            WebSocket.OPEN &&
          generation ===
            call.responseGeneration
        ) {
          call.ttsSocket.send(
            JSON.stringify({
              type: "Speak",
              text: speakText
            })
          );
        }
      }
    }

    if (
      generation !==
      call.responseGeneration
    ) {
      return;
    }

    buffer =
      cleanForSpeech(
        buffer
      );

    if (
      buffer &&
      call.ttsSocket &&
      call.ttsSocket.readyState ===
        WebSocket.OPEN
    ) {
      call.ttsSocket.send(
        JSON.stringify({
          type: "Speak",
          text: buffer
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

    if (fullResponse) {
      call.history.push({
        role: "assistant",
        content:
          fullResponse
      });
    }

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
      try {
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
      } catch {}
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

  const normalized =
    normalizeText(text);

  if (!normalized) {
    return;
  }

  if (
    normalized ===
    call.lastProcessedText
  ) {
    return;
  }

  call.lastProcessedText =
    normalized;

  if (
    call.aiSpeaking
  ) {
    interruptAI(
      call
    );
  }

  await generateResponse(
    call,
    text
  );
}

// ============================================================
// GREETING
// ============================================================

function sendGreeting(call) {
  if (
    call.destroyed ||
    call.greetingSent ||
    !call.ttsReady ||
    !call.streamSid
  ) {
    return;
  }

  call.greetingSent =
    true;

  const name =
    call.customer?.name ||
    "there";

  const greeting =
    `Hi ${name}, welcome to H and M. I can help you find products, check colors, sizes and materials, manage your cart, check orders and tracking, and help with anything else you're shopping for. What would you like to purchase today?`;

  console.log(
    `[${call.id}] GREETING: ${greeting}`
  );

  call.aiSpeaking =
    true;

  call.history.push({
    role: "assistant",
    content:
      greeting
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
// CALL SESSION
// ============================================================

function createCallSession(ws) {
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
// CLEANUP
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

  try {
    if (
      call.sttSocket &&
      call.sttSocket.readyState !==
        WebSocket.CLOSED
    ) {
      call.sttSocket.close();
    }
  } catch {}

  try {
    if (
      call.ttsSocket &&
      call.ttsSocket.readyState !==
        WebSocket.CLOSED
    ) {
      call.ttsSocket.close();
    }
  } catch {}

  call.sttSocket = null;
  call.ttsSocket = null;

  activeCalls.delete(
    call.id
  );

  console.log(
    `[${call.id}] CLEANED UP`
  );
}

// ============================================================
// HTTP SERVER
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
              activeCalls.size,
            stt:
              DEEPGRAM_STT_MODEL,
            tts:
              DEEPGRAM_TTS_MODEL
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

// ============================================================
// EXOTEL WEBSOCKET SERVER
// ============================================================

const wss =
  new WebSocket.Server({
    server
  });

wss.on(
  "connection",
  ws => {
    const call =
      createCallSession(
        ws
      );

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
          console.error(
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
            `[${call.id}] CALL SID: ${call.callSid}`
          );

          console.log(
            `[${call.id}] STREAM SID: ${call.streamSid}`
          );

          console.log(
            `[${call.id}] PHONE: ${call.phoneNumber}`
          );

          console.log(
            `[${call.id}] CUSTOMER: ${
              call.customer?.name ||
              "Guest"
            }`
          );

          try {
            /*
             * IMPORTANT:
             *
             * Deepgram is connected only AFTER
             * Exotel's start event.
             */

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
              `[${call.id}] DEEPGRAM SETUP ERROR:`
            );

            console.error(
              error.message
            );

            /*
             * This is deliberately not hidden.
             * If Deepgram rejects the WebSocket,
             * Render will show the actual HTTP
             * status and body.
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
              `[${call.id}] AUDIO TO STT ERROR:`,
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
// START SERVER
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
      `PORT: ${PORT}`
    );

    console.log(
      `GROQ MODEL: ${GROQ_MODEL}`
    );

    console.log(
      `STT MODEL: ${DEEPGRAM_STT_MODEL}`
    );

    console.log(
      `TTS MODEL: ${DEEPGRAM_TTS_MODEL}`
    );

    console.log(
      `STT SAMPLE RATE: ${STT_SAMPLE_RATE}`
    );

    console.log(
      `TTS SAMPLE RATE: ${TTS_SAMPLE_RATE}`
    );

    console.log(
      "CUSTOMER DATABASE: ENABLED"
    );

    console.log(
      "STREAMING GROQ: ENABLED"
    );

    console.log(
      "STREAMING TTS: ENABLED"
    );

    console.log(
      "BARGE-IN: ENABLED"
    );

    console.log(
      "============================================"
    );
  }
);

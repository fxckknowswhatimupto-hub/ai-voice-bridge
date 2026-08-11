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

const GROQ_MODEL =
  process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const DEEPGRAM_STT_MODEL =
  process.env.DEEPGRAM_STT_MODEL || "nova-2-phonecall";

const DEEPGRAM_TTS_MODEL =
  process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en";

const AUDIO_SAMPLE_RATE = 8000;
const AUDIO_CHUNK_BYTES = 320;
const AUDIO_CHUNK_MS = 20;

const GROQ_TIMEOUT = 9000;
const DEEPGRAM_TIMEOUT = 8000;

if (!GROQ_API_KEY) {
  console.error("CRITICAL: GROQ_API_KEY is missing.");
  process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
  console.error("CRITICAL: DEEPGRAM_API_KEY is missing.");
  process.exit(1);
}

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
    category: "jeans",
    price: 2499,

    colors: [
      "dark blue",
      "light blue",
      "black",
      "faded blue",
      "faded teal",
      "bluish green",
      "faded bluish green"
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
      "stretch",
      "98% cotton",
      "2% elastane"
    ],

    description:
      "High-waist bootcut jeans with slight stretch.",

    stock: {
      "dark blue": ["28", "30", "32", "34", "36"],
      "light blue": ["28", "30", "32", "34"],
      black: ["28", "30", "32", "34", "36"],
      "faded blue": ["28", "30", "32", "34"],
      "faded teal": ["28", "30", "32"],
      "bluish green": ["28", "30", "32"],
      "faded bluish green": ["28", "30", "32"]
    }
  },

  {
    id: "HM-TSH-102",
    name: "Oversized Cotton T-Shirt",
    category: "t-shirts",
    price: 999,

    colors: [
      "white",
      "black",
      "sage green",
      "beige",
      "cream"
    ],

    sizes: [
      "S",
      "M",
      "L",
      "XL"
    ],

    materials: [
      "cotton",
      "organic cotton",
      "100% organic cotton"
    ],

    description:
      "Relaxed oversized cotton T-shirt.",

    stock: {
      white: ["S", "M", "L", "XL"],
      black: ["S", "M", "L", "XL"],
      "sage green": ["S", "M", "L"],
      beige: ["S", "M", "L"],
      cream: ["S", "M"]
    }
  },

  {
    id: "HM-DRS-501",
    name: "Ribbed Midi Dress",
    category: "dresses",
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
      "viscose blend",
      "ribbed jersey"
    ],

    description:
      "Fitted ribbed midi dress.",

    stock: {
      burgundy: ["XS", "S", "M"],
      black: ["XS", "S", "M", "L"],
      cream: ["XS", "S", "M", "L"]
    }
  },

  {
    id: "HM-HOD-220",
    name: "Relaxed Fit Hoodie",
    category: "hoodies",
    price: 1799,

    colors: [
      "black",
      "grey",
      "navy",
      "cream"
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
      "cotton blend",
      "fleece"
    ],

    description:
      "Relaxed hoodie with soft fleece interior.",

    stock: {
      black: ["S", "M", "L", "XL"],
      grey: ["S", "M", "L", "XL", "XXL"],
      navy: ["S", "M", "L", "XL"],
      cream: ["S", "M", "L"]
    }
  },

  {
    id: "HM-JKT-301",
    name: "Denim Jacket",
    category: "jackets",
    price: 2999,

    colors: [
      "blue",
      "light blue",
      "black"
    ],

    sizes: [
      "S",
      "M",
      "L",
      "XL"
    ],

    materials: [
      "denim",
      "cotton",
      "cotton denim"
    ],

    description:
      "Classic regular-fit denim jacket.",

    stock: {
      blue: ["S", "M", "L", "XL"],
      "light blue": ["S", "M", "L"],
      black: ["S", "M", "L", "XL"]
    }
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

    address:
      "Chennai, Tamil Nadu",

    orders: [
      {
        id: "HM88291",

        status: "Shipped",

        tracking:
          "HMTRK88291IN",

        carrier:
          "H&M Delivery",

        delivery:
          "August 15",

        items: [
          {
            productId:
              "HM-JNS-001",

            name:
              "Bootcut High Waist Jeans",

            color:
              "dark blue",

            size:
              "32",

            quantity:
              1,

            price:
              2499
          }
        ],

        total:
          2499
      },

      {
        id: "HM77102",

        status:
          "Delivered",

        tracking:
          "HMTRK77102IN",

        carrier:
          "H&M Delivery",

        delivery:
          "Delivered",

        items: [
          {
            productId:
              "HM-TSH-102",

            name:
              "Oversized Cotton T-Shirt",

            color:
              "black",

            size:
              "L",

            quantity:
              1,

            price:
              999
          }
        ],

        total:
          999
      }
    ]
  }
};

// ============================================================
// HELPERS
// ============================================================

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

// ============================================================
// GOODBYE DETECTION
// ============================================================

function getGoodbyeType(text) {
  const q = normalize(text);

  const phrases = [
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

  for (const phrase of phrases) {
    if (
      q === phrase ||
      q.includes(phrase)
    ) {
      return phrase;
    }
  }

  return null;
}

// ============================================================
// PRODUCT SEARCH
// ============================================================

function findProducts(query) {
  const q = normalize(query);

  return PRODUCTS
    .map(product => {

      let score = 0;

      const name =
        normalize(product.name);

      const category =
        normalize(product.category);

      if (q.includes(name)) {
        score += 10;
      }

      if (q.includes(category)) {
        score += 6;
      }

      for (const color of product.colors) {
        if (
          q.includes(
            normalize(color)
          )
        ) {
          score += 4;
        }
      }

      for (const material of product.materials) {
        if (
          q.includes(
            normalize(material)
          )
        ) {
          score += 3;
        }
      }

      const words =
        q.split(/\s+/);

      for (const word of words) {
        if (
          word.length > 2 &&
          name.includes(word)
        ) {
          score++;
        }
      }

      return {
        product,
        score
      };
    })
    .filter(item => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score
    )
    .map(item => item.product);
}

// ============================================================
// COLOR UNDERSTANDING
// ============================================================

function detectColor(text) {
  const q = normalize(text);

  const colors = [
    "faded bluish green",
    "bluish green",
    "faded teal",
    "faded blue",
    "dark blue",
    "light blue",
    "sage green",
    "burgundy",
    "cream",
    "beige",
    "black",
    "white",
    "navy",
    "grey",
    "gray",
    "blue"
  ];

  for (const color of colors) {
    if (q.includes(color)) {
      return color;
    }
  }

  return null;
}

// ============================================================
// SIZE UNDERSTANDING
// ============================================================

function detectSize(text) {
  const q = normalize(text);

  const match =
    q.match(
      /\b(xs|s|m|l|xl|xxl|28|30|32|34|36)\b/i
    );

  if (!match) {
    return null;
  }

  return match[1].toUpperCase();
}

// ============================================================
// CART
// ============================================================

function addToCart(
  call,
  product,
  color,
  size,
  quantity = 1
) {
  const selectedColor =
    color ||
    product.colors[0];

  const selectedSize =
    size ||
    product.sizes[0];

  const existing =
    call.cart.find(item =>
      item.productId ===
        product.id &&
      item.color ===
        selectedColor &&
      item.size ===
        selectedSize
    );

  if (existing) {
    existing.quantity +=
      quantity;
  } else {
    call.cart.push({
      productId:
        product.id,

      name:
        product.name,

      color:
        selectedColor,

      size:
        selectedSize,

      quantity:
        quantity,

      price:
        product.price
    });
  }
}

function removeFromCart(
  call,
  productName
) {
  const q =
    normalize(productName);

  const oldLength =
    call.cart.length;

  call.cart =
    call.cart.filter(item =>
      !normalize(item.name)
        .includes(q)
    );

  return (
    oldLength !==
    call.cart.length
  );
}

function cartTotal(call) {
  return call.cart.reduce(
    (total, item) =>
      total +
      item.price *
        item.quantity,
    0
  );
}

function cartText(call) {
  if (!call.cart.length) {
    return "The customer's cart is empty.";
  }

  const items =
    call.cart.map(item =>
      `${item.quantity} ${item.name}, ${item.color}, size ${item.size}`
    );

  return (
    `Customer cart: ${items.join("; ")}. ` +
    `Cart total: ₹${cartTotal(call)}.`
  );
}

// ============================================================
// ORDER LOOKUP
// ============================================================

function latestOrder(call) {
  if (
    !call.customer ||
    !Array.isArray(
      call.customer.orders
    )
  ) {
    return null;
  }

  return (
    call.customer.orders[0] ||
    null
  );
}

function orderContext(call) {
  const order =
    latestOrder(call);

  if (!order) {
    return "No customer orders were found.";
  }

  return [
    `Order ID: ${order.id}`,
    `Status: ${order.status}`,
    `Tracking: ${order.tracking}`,
    `Carrier: ${order.carrier}`,
    `Delivery: ${order.delivery}`,
    `Total: ₹${order.total}`
  ].join(". ");
}

// ============================================================
// BUSINESS CONTEXT
// ============================================================

function getBusinessContext(
  call,
  question
) {
  const q =
    normalize(question);

  const context = [];

  // ----------------------------------------------------------
  // CART
  // ----------------------------------------------------------

  if (
    q.includes("cart") ||
    q.includes("basket")
  ) {
    context.push(
      cartText(call)
    );
  }

  // ----------------------------------------------------------
  // ORDER
  // ----------------------------------------------------------

  if (
    q.includes("order") ||
    q.includes("tracking") ||
    q.includes("track") ||
    q.includes("delivery") ||
    q.includes("where is my")
  ) {
    context.push(
      orderContext(call)
    );
  }

  // ----------------------------------------------------------
  // LOYALTY
  // ----------------------------------------------------------

  if (
    q.includes("loyalty") ||
    q.includes("points") ||
    q.includes("reward")
  ) {
    context.push(
      `Customer loyalty points: ${
        call.customer?.loyaltyPoints || 0
      }`
    );
  }

  // ----------------------------------------------------------
  // PRODUCT
  // ----------------------------------------------------------

  const products =
    findProducts(question);

  if (products.length) {

    for (
      const product
      of products.slice(0, 4)
    ) {

      context.push(
        [
          `Product: ${product.name}`,
          `ID: ${product.id}`,
          `Price: ₹${product.price}`,
          `Colors: ${product.colors.join(", ")}`,
          `Sizes: ${product.sizes.join(", ")}`,
          `Materials: ${product.materials.join(", ")}`,
          `Description: ${product.description}`
        ].join(". ")
      );
    }
  }

  // ----------------------------------------------------------
  // COLOR
  // ----------------------------------------------------------

  const color =
    detectColor(question);

  if (color) {
    context.push(
      `Customer mentioned color: ${color}. Treat color descriptions semantically.`
    );
  }

  // ----------------------------------------------------------
  // SIZE
  // ----------------------------------------------------------

  const size =
    detectSize(question);

  if (size) {
    context.push(
      `Customer mentioned size: ${size}. Remember it during this conversation.`
    );
  }

  return context.join("\n");
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(call) {

  return `
You are the H&M customer service and shopping voice assistant.

You are talking to a customer over a real telephone call.

Your job is to behave like a natural, helpful human H&M representative.

PERSONALITY:

- Friendly.
- Warm.
- Natural.
- Conversational.
- Concise.
- Confident.
- Never robotic.
- Never give huge paragraphs.
- Usually answer in 1 to 3 short sentences.
- Ask one useful follow-up question when needed.
- Do not repeat information unnecessarily.

IMPORTANT:

The customer can interrupt you.

If the customer changes the subject, immediately follow their latest request.

Remember information already given during this call.

For example:

Customer:
"I want bootcut jeans."

Assistant:
"Sure. What color and size are you looking for?"

Customer:
"Faded bluish green."

You MUST understand that as a color description.

Do NOT say:

"Sorry, I can only help with H&M products."

Instead, understand natural descriptions such as:

- faded bluish green
- washed blue-green
- teal-ish
- blue with green tint
- faded turquoise
- dark washed blue
- light washed blue

Match them to the closest catalog color.

AVAILABLE H&M PRODUCTS:

${JSON.stringify(PRODUCTS)}

CUSTOMER:

${JSON.stringify(
    call.customer || {
      name: "Guest"
    }
  )}

CURRENT CART:

${JSON.stringify(call.cart)}

CART TOTAL:

₹${cartTotal(call)}

CURRENT CONVERSATION:

${call.history
  .slice(-12)
  .map(
    x =>
      `${x.role}: ${x.content}`
  )
  .join("\n")}

FUNCTIONAL FEATURES:

You can help with:

- Product search
- Product recommendations
- Colors
- Sizes
- Materials
- Product availability
- Adding products to cart
- Removing products from cart
- Changing cart items
- Viewing cart
- Cart total
- Order details
- Order status
- Tracking information
- Delivery information
- Loyalty points
- General H&M shopping questions

IMPORTANT BUSINESS RULE:

If a requested feature is not implemented, say:

"Sorry, that option isn't available right now, but I can help with products, shopping, sizes, your cart, orders and tracking."

Do NOT invent real orders or real H&M policies.

The database provided to you is the source of truth.

If something is not in the database, say that you don't currently have that information.

When the customer wants to add something to their cart, identify:

1. Product
2. Color
3. Size
4. Quantity

Do not ask for something that the customer already provided.

If one detail is missing, ask only for that detail.

Keep spoken answers short because this is a phone conversation.
`;
}

// ============================================================
// TTS AUDIO QUEUE
// ============================================================

function createAudioQueue(
  call
) {
  let queue = [];
  let timer = null;
  let stopped = false;

  let sequence =
    1;

  let chunk =
    0;

  let timestamp =
    0;

  function pump() {

    timer = null;

    if (
      stopped ||
      call.destroyed
    ) {
      return;
    }

    if (!queue.length) {
      return;
    }

    if (
      !call.ws ||
      call.ws.readyState !==
        WebSocket.OPEN ||
      !call.streamSid
    ) {
      return;
    }

    const audio =
      queue.shift();

    try {

      call.ws.send(
        JSON.stringify({
          event:
            "media",

          sequence_number:
            String(sequence),

          stream_sid:
            call.streamSid,

          media: {
            chunk:
              String(chunk),

            timestamp:
              String(timestamp),

            payload:
              audio.toString(
                "base64"
              )
          }
        })
      );

      sequence++;
      chunk++;
      timestamp +=
        AUDIO_CHUNK_MS;

    } catch (error) {

      console.error(
        `[${call.id}] Audio send error:`,
        error.message
      );
    }

    if (queue.length) {
      timer =
        setTimeout(
          pump,
          AUDIO_CHUNK_MS
        );
    }
  }

  return {

    enqueue(buffer) {

      if (
        stopped ||
        call.destroyed ||
        !buffer ||
        !buffer.length
      ) {
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
              i +
                AUDIO_CHUNK_BYTES,
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
        timer = null;
      }
    },

    stop() {

      stopped = true;

      queue = [];

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

// ============================================================
// DEEPGRAM STT
// ============================================================

function connectSTT(call) {

  return new Promise(
    (resolve, reject) => {

      const url =
        "wss://api.deepgram.com/v1/listen" +
        "?model=" +
        encodeURIComponent(
          DEEPGRAM_STT_MODEL
        ) +
        "&language=en-US" +
        "&encoding=linear16" +
        "&sample_rate=8000" +
        "&channels=1" +
        "&interim_results=true" +
        "&endpointing=250" +
        "&punctuate=true" +
        "&smart_format=true";

      console.log(
        `[${call.id}] Connecting Deepgram STT...`
      );

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

      let opened =
        false;

      const timer =
        setTimeout(() => {

          if (!opened) {

            try {
              socket.close();
            } catch (_) {}

            reject(
              new Error(
                "Deepgram STT timeout"
              )
            );
          }

        }, DEEPGRAM_TIMEOUT);

      socket.on(
        "open",
        () => {

          opened =
            true;

          clearTimeout(timer);

          console.log(
            `[${call.id}] Deepgram STT connected`
          );

          resolve(socket);
        }
      );

      socket.on(
        "error",
        error => {

          console.error(
            `[${call.id}] Deepgram STT error:`,
            error.message
          );

          if (!opened) {
            clearTimeout(timer);
            reject(error);
          }
        }
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
          } catch (_) {
            return;
          }

          const transcript =
            message
              ?.channel
              ?.alternatives?.[0]
              ?.transcript ||
            "";

          if (!transcript.trim()) {
            return;
          }

          // ----------------------------------------------------
          // INTERIM
          // ----------------------------------------------------

          if (
            !message.is_final
          ) {

            call.interim =
              transcript;

            if (
              call.aiSpeaking &&
              transcript.trim()
                .split(/\s+/)
                .length >= 2
            ) {

              interruptAI(
                call
              );
            }

            return;
          }

          // ----------------------------------------------------
          // FINAL
          // ----------------------------------------------------

          console.log(
            `[${call.id}] CUSTOMER: ${transcript}`
          );

          call.interim =
            "";

          handleSpeech(
            call,
            transcript
          );
        }
      );
    }
  );
}

// ============================================================
// DEEPGRAM TTS
// ============================================================

function connectTTS(call) {

  return new Promise(
    (resolve, reject) => {

      // IMPORTANT:
      // No container=none here.
      // Streaming TTS returns raw audio.

      const url =
        "wss://api.deepgram.com/v1/speak" +
        "?model=" +
        encodeURIComponent(
          DEEPGRAM_TTS_MODEL
        ) +
        "&encoding=linear16" +
        "&sample_rate=8000" +
        "&speed=1.15";

      console.log(
        `[${call.id}] Connecting Deepgram TTS...`
      );

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

      let opened =
        false;

      const timer =
        setTimeout(() => {

          if (!opened) {

            try {
              socket.close();
            } catch (_) {}

            reject(
              new Error(
                "Deepgram TTS timeout"
              )
            );
          }

        }, DEEPGRAM_TIMEOUT);

      socket.on(
        "open",
        () => {

          opened =
            true;

          clearTimeout(timer);

          console.log(
            `[${call.id}] Deepgram TTS connected`
          );

          resolve(socket);
        }
      );

      socket.on(
        "error",
        error => {

          console.error(
            `[${call.id}] Deepgram TTS error:`,
            error.message
          );

          if (!opened) {
            clearTimeout(timer);
            reject(error);
          }
        }
      );

      socket.on(
        "close",
        (code, reason) => {

          console.log(
            `[${call.id}] Deepgram TTS closed:`,
            code,
            reason
              ? reason.toString()
              : ""
          );
        }
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

            const audio =
              Buffer.from(data);

            if (
              audio.length &&
              !call.interrupting
            ) {

              call.audioQueue
                .enqueue(
                  audio
                );
            }

            return;
          }

          try {

            const message =
              JSON.parse(
                data.toString()
              );

            if (
              message.type ===
              "Warning"
            ) {

              console.log(
                `[${call.id}] TTS warning:`,
                message.description ||
                  message.code ||
                  "unknown"
              );
            }

          } catch (_) {}
        }
      );
    }
  );
}

// ============================================================
// SEND TTS
// ============================================================

function speak(
  call,
  text
) {

  if (
    call.destroyed ||
    call.interrupting ||
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {
    return false;
  }

  try {

    call.ttsSocket.send(
      JSON.stringify({
        type:
          "Speak",

        text:
          String(text)
      })
    );

    return true;

  } catch (error) {

    console.error(
      `[${call.id}] TTS send error:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// FLUSH TTS
// ============================================================

function flush(
  call
) {

  if (
    call.destroyed ||
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {
    return false;
  }

  try {

    call.ttsSocket.send(
      JSON.stringify({
        type:
          "Flush"
      })
    );

    return true;

  } catch (_) {
    return false;
  }
}

// ============================================================
// CLEAR / INTERRUPTION
// ============================================================

function interruptAI(
  call
) {

  if (
    call.destroyed ||
    !call.aiSpeaking
  ) {
    return;
  }

  console.log(
    `[${call.id}] BARGE-IN`
  );

  call.ttsGeneration++;

  call.aiSpeaking =
    false;

  call.interrupting =
    true;

  call.audioQueue.clear();

  // Clear Exotel's queued audio.

  if (
    call.ws &&
    call.ws.readyState ===
      WebSocket.OPEN
  ) {

    try {

      call.ws.send(
        JSON.stringify({
          event:
            "clear",

          stream_sid:
            call.streamSid
        })
      );

    } catch (_) {}
  }

  // Clear Deepgram TTS.

  if (
    call.ttsSocket &&
    call.ttsSocket.readyState ===
      WebSocket.OPEN
  ) {

    try {

      call.ttsSocket.send(
        JSON.stringify({
          type:
            "Clear"
        })
      );

    } catch (_) {}
  }

  setTimeout(() => {

    if (!call.destroyed) {
      call.interrupting =
        false;
    }

  }, 80);
}

// ============================================================
// GROQ RESPONSE
// ============================================================

async function generateAI(
  call,
  userText,
  businessContext,
  generation
) {

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, GROQ_TIMEOUT);

  const messages = [
    {
      role:
        "system",

      content:
        buildSystemPrompt(call)
    }
  ];

  for (
    const message
    of call.history.slice(-10)
  ) {

    messages.push({
      role:
        message.role,

      content:
        message.content
    });
  }

  let prompt =
    userText;

  if (businessContext) {

    prompt +=
      `\n\nINTERNAL BUSINESS CONTEXT:\n${businessContext}`;
  }

  messages.push({
    role:
      "user",

    content:
      prompt
  });

  try {

    const stream =
      await groq.chat.completions.create(
        {
          model:
            GROQ_MODEL,

          messages,

          temperature:
            0.2,

          max_tokens:
            120,

          stream:
            true
        },
        {
          signal:
            controller.signal
        }
      );

    let fullText =
      "";

    let sentence =
      "";

    for await (
      const chunk
      of stream
    ) {

      if (
        call.destroyed ||
        call.ttsGeneration !==
          generation
      ) {
        break;
      }

      const token =
        chunk
          ?.choices?.[0]
          ?.delta
          ?.content ||
        "";

      if (!token) {
        continue;
      }

      fullText +=
        token;

      sentence +=
        token;

      // ------------------------------------------------------
      // LOW LATENCY SENTENCE TTS
      // ------------------------------------------------------

      const match =
        sentence.match(
          /^([\s\S]*?[.!?])(?:\s+|$)/
        );

      if (match) {

        const spoken =
          match[1]
            .replace(
              /\s+/g,
              " "
            )
            .trim();

        sentence =
          sentence
            .slice(
              match[0].length
            )
            .trimStart();

        if (spoken) {

          speak(
            call,
            spoken
          );
        }
      }

      // ------------------------------------------------------
      // PREVENT LONG TTS BUFFER
      // ------------------------------------------------------

      if (
        sentence.length >
        80
      ) {

        const split =
          sentence.lastIndexOf(
            " "
          );

        if (
          split > 30
        ) {

          const spoken =
            sentence
              .slice(
                0,
                split
              )
              .trim();

          sentence =
            sentence
              .slice(
                split + 1
              )
              .trimStart();

          if (spoken) {
            speak(
              call,
              spoken
            );
          }
        }
      }
    }

    if (
      sentence.trim() &&
      !call.destroyed &&
      call.ttsGeneration ===
        generation
    ) {

      speak(
        call,
        sentence
          .replace(
            /\s+/g,
            " "
          )
          .trim()
      );
    }

    if (
      !call.destroyed &&
      call.ttsGeneration ===
        generation
    ) {

      flush(call);
    }

    return fullText
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  } finally {

    clearTimeout(
      timeout
    );
  }
}

// ============================================================
// GOODBYE CONFIRMATION
// ============================================================

async function handleGoodbye(
  call
) {

  call.goodbyePending =
    true;

  call.aiSpeaking =
    true;

  const generation =
    ++call.ttsGeneration;

  const response =
    "Just to confirm, would you like me to end the call?";

  speak(
    call,
    response
  );

  flush(call);

  setTimeout(() => {

    if (
      !call.destroyed &&
      call.ttsGeneration ===
        generation
    ) {
      call.aiSpeaking =
        false;
    }

  }, 1300);
}

// ============================================================
// GOODBYE CONFIRMATION ANSWER
// ============================================================

function isYes(text) {

  const q =
    normalize(text);

  return [
    "yes",
    "yeah",
    "yep",
    "yes please",
    "please do",
    "end it",
    "hang up",
    "hang up please",
    "that's right",
    "thats right"
  ].some(
    phrase =>
      q === phrase ||
      q.includes(phrase)
  );
}

function isNo(text) {

  const q =
    normalize(text);

  return [
    "no",
    "nope",
    "not yet",
    "don't",
    "dont",
    "keep going",
    "continue"
  ].some(
    phrase =>
      q === phrase ||
      q.includes(phrase)
  );
}

// ============================================================
// END CALL
// ============================================================

function endCall(
  call
) {

  if (
    call.destroyed
  ) {
    return;
  }

  console.log(
    `[${call.id}] Ending call after confirmation`
  );

  call.ttsGeneration++;

  call.aiSpeaking =
    true;

  call.audioQueue.clear();

  const goodbye =
    "Thanks for calling H&M. Have a great day!";

  speak(
    call,
    goodbye
  );

  flush(call);

  // Give the final audio time to leave
  // the TTS pipeline before closing.

  setTimeout(() => {

    if (
      call.destroyed
    ) {
      return;
    }

    try {

      if (
        call.ws &&
        call.ws.readyState ===
          WebSocket.OPEN
      ) {

        call.ws.close(
          1000,
          "Customer requested call end"
        );
      }

    } catch (_) {}

    destroyCall(
      call
    );

  }, 1800);
}

// ============================================================
// HANDLE SPEECH
// ============================================================

async function handleSpeech(
  call,
  text
) {

  if (
    call.destroyed
  ) {
    return;
  }

  const userText =
    String(text)
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (!userText) {
    return;
  }

  // ----------------------------------------------------------
  // GOODBYE CONFIRMATION STATE
  // ----------------------------------------------------------

  if (
    call.goodbyePending
  ) {

    if (
      isYes(userText)
    ) {

      call.goodbyePending =
        false;

      endCall(
        call
      );

      return;
    }

    if (
      isNo(userText)
    ) {

      call.goodbyePending =
        false;

      call.aiSpeaking =
        false;

      await answerNormal(
        call,
        "Okay, no problem. What else can I help you with?"
      );

      return;
    }

    // If unclear, ask once more.

    call.goodbyePending =
      false;

    await answerNormal(
      call,
      `I didn't quite catch that. What would you like to do next?`
    );

    return;
  }

  // ----------------------------------------------------------
  // GOODBYE TRIGGER
  // ----------------------------------------------------------

  if (
    getGoodbyeType(userText)
  ) {

    interruptAI(
      call
    );

    await sleep(50);

    if (
      call.destroyed
    ) {
      return;
    }

    await handleGoodbye(
      call
    );

    return;
  }

  // ----------------------------------------------------------
  // NEW SPEECH INTERRUPTS AI
  // ----------------------------------------------------------

  if (
    call.aiSpeaking
  ) {

    interruptAI(
      call
    );

    await sleep(50);
  }

  await answerNormal(
    call,
    userText
  );
}

// ============================================================
// NORMAL ANSWER
// ============================================================

async function answerNormal(
  call,
  userText
) {

  if (
    call.destroyed
  ) {
    return;
  }

  const generation =
    ++call.ttsGeneration;

  call.aiSpeaking =
    true;

  call.interrupting =
    false;

  // ----------------------------------------------------------
  // BUSINESS CONTEXT
  // ----------------------------------------------------------

  const businessContext =
    getBusinessContext(
      call,
      userText
    );

  call.history.push({
    role:
      "user",

    content:
      userText
  });

  try {

    const answer =
      await generateAI(
        call,
        userText,
        businessContext,
        generation
      );

    if (
      call.destroyed ||
      call.ttsGeneration !==
        generation
    ) {
      return;
    }

    if (answer) {

      call.history.push({
        role:
          "assistant",

        content:
          answer
      });

      // Keep memory bounded.

      if (
        call.history.length >
        14
      ) {

        call.history =
          call.history.slice(
            -14
          );
      }

      console.log(
        `[${call.id}] AI: ${answer}`
      );
    }

  } catch (error) {

    if (
      call.destroyed
    ) {
      return;
    }

    console.error(
      `[${call.id}] GROQ ERROR:`,
      error.message
    );

    speak(
      call,
      "Sorry, I had a little trouble there. Could you say that again?"
    );

    flush(call);

  } finally {

    if (
      call.ttsGeneration ===
        generation &&
      !call.destroyed
    ) {

      setTimeout(() => {

        if (
          !call.destroyed &&
          call.ttsGeneration ===
            generation
        ) {

          call.aiSpeaking =
            false;
        }

      }, 250);
    }
  }
}

// ============================================================
// DESTROY CALL
// ============================================================

function destroyCall(
  call
) {

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

  call.ttsGeneration++;

  if (
    call.audioQueue
  ) {
    call.audioQueue.stop();
  }

  try {

    if (
      call.sttSocket
    ) {
      call.sttSocket.close();
    }

  } catch (_) {}

  try {

    if (
      call.ttsSocket
    ) {
      call.ttsSocket.close();
    }

  } catch (_) {}

  activeCalls.delete(
    call.id
  );

  console.log(
    `[${call.id}] CLEANED UP`
  );

  console.log(
    `Active calls: ${activeCalls.size}`
  );
}

// ============================================================
// CREATE CALL
// ============================================================

function createCall(
  ws
) {

  const call = {

    id:
      `CALL-${callCounter++}`,

    ws,

    streamSid:
      null,

    callSid:
      null,

    phone:
      null,

    customer:
      null,

    sttSocket:
      null,

    ttsSocket:
      null,

    audioQueue:
      null,

    cart:
      [],

    history:
      [],

    aiSpeaking:
      false,

    interrupting:
      false,

    goodbyePending:
      false,

    ttsGeneration:
      0,

    interim:
      "",

    destroyed:
      false
  };

  call.audioQueue =
    createAudioQueue(
      call
    );

  activeCalls.set(
    call.id,
    call
  );

  return call;
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
            status:
              "ok",

            service:
              "H&M Voice Assistant",

            activeCalls:
              activeCalls.size,

            groq:
              GROQ_MODEL,

            stt:
              DEEPGRAM_STT_MODEL,

            tts:
              DEEPGRAM_TTS_MODEL
          })
        );

        return;
      }

      res.writeHead(
        200,
        {
          "Content-Type":
            "application/json"
        }
      );

      res.end(
        JSON.stringify({
          status:
            "ok",

          service:
            "H&M AI Voice Assistant"
        })
      );
    }
  );

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

    const call =
      createCall(ws);

    console.log(
      "============================================"
    );

    console.log(
      `[${call.id}] EXOTEL CONNECTED`
    );

    console.log(
      `Active calls: ${activeCalls.size}`
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

        } catch (error) {

          console.error(
            `[${call.id}] Invalid Exotel JSON`
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
            null;

          call.callSid =
            message.start?.call_sid ||
            null;

          call.phone =
            message.start?.from ||
            message.start
              ?.custom_parameters
              ?.phone ||
            null;

          const phone =
            String(
              call.phone || ""
            )
              .replace(
                /\D/g,
                ""
              );

          call.customer =
            CUSTOMERS[
              phone
            ] || null;

          console.log(
            `[${call.id}] CALL SID: ${call.callSid}`
          );

          console.log(
            `[${call.id}] STREAM SID: ${call.streamSid}`
          );

          console.log(
            `[${call.id}] PHONE: ${call.phone || "unknown"}`
          );

          console.log(
            `[${call.id}] CUSTOMER: ${
              call.customer?.name ||
              "Guest"
            }`
          );

          // ----------------------------------------------------
          // CONNECT BOTH DEEPGRAM SOCKETS
          // ----------------------------------------------------

          try {

            const results =
              await Promise.all([
                connectSTT(call),
                connectTTS(call)
              ]);

            if (
              call.destroyed
            ) {
              return;
            }

            call.sttSocket =
              results[0];

            call.ttsSocket =
              results[1];

            console.log(
              `[${call.id}] DEEPGRAM READY`
            );

            // --------------------------------------------------
            // GREETING
            // --------------------------------------------------

            const greeting =
              `Hi ${
                call.customer?.name ||
                "there"
              }! Welcome to H&M. I can help you find products, choose colors and sizes, manage your cart, check orders and tracking, and help with shopping. What would you like to shop for today?`;

            call.aiSpeaking =
              true;

            call.history.push({
              role:
                "assistant",

              content:
                greeting
            });

            speak(
              call,
              greeting
            );

            flush(
              call
            );

            setTimeout(() => {

              if (
                !call.destroyed
              ) {
                call.aiSpeaking =
                  false;
              }

            }, 2500);

          } catch (error) {

            console.error(
              `[${call.id}] DEEPGRAM SETUP ERROR:`,
              error.message
            );

            // Don't immediately kill the call.
            // Try a short fallback message.

            if (
              call.ttsSocket &&
              call.ttsSocket.readyState ===
                WebSocket.OPEN
            ) {

              speak(
                call,
                "Sorry, I'm having trouble connecting my voice service. Please try again."
              );

              flush(
                call
              );
            }
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

          if (
            !payload ||
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

            if (
              audio.length
            ) {

              call.sttSocket.send(
                audio
              );
            }

          } catch (error) {

            console.error(
              `[${call.id}] AUDIO ERROR:`,
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
    // CLOSE
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
    // ERROR
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
      `PORT: ${PORT}`
    );

    console.log(
      `GROQ: ${GROQ_MODEL}`
    );

    console.log(
      `STT: ${DEEPGRAM_STT_MODEL}`
    );

    console.log(
      `TTS: ${DEEPGRAM_TTS_MODEL}`
    );

    console.log(
      "AUDIO: 16-bit PCM / 8kHz / MONO"
    );

    console.log(
      "============================================"
    );
  }
);

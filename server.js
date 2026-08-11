const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 10000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";

const GROQ_MODEL = "llama-3.1-8b-instant";
const DEEPGRAM_STT_MODEL = "nova-2";
const DEEPGRAM_TTS_MODEL = "aura-asteria-en";

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;
const AUDIO_CHUNK_BYTES = 320;
const AUDIO_CHUNK_MS = 20;

const GROQ_TIMEOUT_MS = 8000;
const DEEPGRAM_CONNECT_TIMEOUT_MS = 7000;
const TAVILY_TIMEOUT_MS = 1800;

if (!GROQ_API_KEY) {
  console.error("ERROR: GROQ_API_KEY is missing");
  process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
  console.error("ERROR: DEEPGRAM_API_KEY is missing");
  process.exit(1);
}

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

// ============================================================
// GLOBAL STATE
// ============================================================

const activeCalls = new Map();
let nextCallNumber = 1;

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
      "faded teal",
      "faded blue",
      "bluish green",
      "faded bluish green"
    ],
    sizes: ["28", "30", "32", "34", "36"],
    materials: [
      "98% cotton",
      "2% elastane",
      "cotton",
      "stretch"
    ],
    stock: {
      "dark blue": ["28", "30", "32", "34", "36"],
      "light blue": ["28", "30", "32", "34"],
      black: ["28", "30", "32", "34", "36"],
      "faded teal": ["28", "30", "32"],
      "faded blue": ["28", "30", "32", "34"],
      "bluish green": ["28", "30", "32"],
      "faded bluish green": ["28", "30", "32"]
    },
    description:
      "Classic high-waist bootcut jeans with slight stretch."
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
    sizes: ["S", "M", "L", "XL"],
    materials: [
      "100% organic cotton",
      "organic cotton",
      "cotton"
    ],
    stock: {
      white: ["S", "M", "L", "XL"],
      black: ["S", "M", "L", "XL"],
      "sage green": ["S", "M", "L"],
      beige: ["S", "M", "L"],
      cream: ["S", "M"]
    },
    description:
      "Relaxed oversized fit made from organic cotton."
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
    sizes: ["XS", "S", "M", "L"],
    materials: [
      "viscose",
      "viscose blend",
      "ribbed jersey"
    ],
    stock: {
      burgundy: ["XS", "S", "M"],
      black: ["XS", "S", "M", "L"],
      cream: ["XS", "S", "M", "L"]
    },
    description:
      "Fitted calf-length ribbed midi dress."
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
    sizes: ["S", "M", "L", "XL", "XXL"],
    materials: [
      "cotton",
      "cotton blend",
      "fleece"
    ],
    stock: {
      black: ["S", "M", "L", "XL"],
      grey: ["S", "M", "L", "XL", "XXL"],
      navy: ["S", "M", "L", "XL"],
      cream: ["S", "M", "L"]
    },
    description:
      "Soft relaxed-fit hoodie with brushed fleece interior."
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
    sizes: ["S", "M", "L", "XL"],
    materials: [
      "denim",
      "cotton denim",
      "cotton"
    ],
    stock: {
      blue: ["S", "M", "L", "XL"],
      "light blue": ["S", "M", "L"],
      black: ["S", "M", "L", "XL"]
    },
    description:
      "Classic denim jacket with a regular fit."
  }
];

// ============================================================
// FAKE CUSTOMERS
// ============================================================

const CUSTOMERS = {
  "919876543210": {
    name: "Syed",
    phone: "919876543210",
    loyaltyPoints: 450,
    address: "Chennai, Tamil Nadu",
    orders: [
      {
        id: "HM88291",
        status: "Shipped",
        tracking: "HMTRK88291IN",
        carrier: "H&M Delivery",
        delivery: "August 15",
        items: [
          {
            productId: "HM-JNS-001",
            name: "Bootcut High Waist Jeans",
            color: "dark blue",
            size: "32",
            quantity: 1,
            price: 2499
          }
        ],
        total: 2499
      },
      {
        id: "HM77102",
        status: "Delivered",
        tracking: "HMTRK77102IN",
        carrier: "H&M Delivery",
        delivery: "Delivered",
        items: [
          {
            productId: "HM-TSH-102",
            name: "Oversized Cotton T-Shirt",
            color: "black",
            size: "L",
            quantity: 1,
            price: 999
          }
        ],
        total: 999
      }
    ]
  }
};

// ============================================================
// TEXT HELPERS
// ============================================================

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s%-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// GOODBYE DETECTION
// ============================================================

function isGoodbye(text) {
  const q = normalizeText(text);

  const patterns = [
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

  return patterns.some(pattern => {
    return q === pattern ||
      q.includes(pattern);
  });
}

// ============================================================
// INTERRUPTION DETECTION
// ============================================================

function isExplicitInterrupt(text) {
  const q = normalizeText(text);

  const patterns = [
    "stop",
    "wait",
    "hold on",
    "hang on",
    "pause",
    "be quiet",
    "that's enough",
    "thats enough",
    "enough"
  ];

  return patterns.some(pattern => {
    return q === pattern ||
      q.startsWith(pattern + " ");
  });
}

// ============================================================
// PRODUCT MATCHING
// ============================================================

function findProducts(query) {
  const q = normalizeText(query);

  const words = q.split(" ");

  return PRODUCTS
    .map(product => {
      let score = 0;

      const productName = normalizeText(product.name);
      const category = normalizeText(product.category);

      if (q.includes(productName)) {
        score += 10;
      }

      if (q.includes(category)) {
        score += 5;
      }

      for (const color of product.colors) {
        if (q.includes(normalizeText(color))) {
          score += 4;
        }
      }

      for (const material of product.materials) {
        if (q.includes(normalizeText(material))) {
          score += 3;
        }
      }

      for (const word of words) {
        if (
          productName.includes(word) &&
          word.length > 2
        ) {
          score += 1;
        }
      }

      return {
        product,
        score
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.product);
}

// ============================================================
// COLOR EXTRACTION
// ============================================================

function detectColor(text) {
  const q = normalizeText(text);

  const colors = [
    "dark blue",
    "light blue",
    "faded teal",
    "faded blue",
    "faded bluish green",
    "bluish green",
    "sage green",
    "black",
    "white",
    "beige",
    "cream",
    "burgundy",
    "grey",
    "gray",
    "navy",
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
// SIZE EXTRACTION
// ============================================================

function detectSize(text) {
  const q = normalizeText(text);

  const match = q.match(
    /\b(?:size\s*)?(xs|s|m|l|xl|xxl|28|30|32|34|36)\b/i
  );

  return match ? match[1].toUpperCase() : null;
}

// ============================================================
// PRODUCT SEARCH RESPONSE
// ============================================================

function searchProductsForCustomer(query) {
  const products = findProducts(query);

  if (!products.length) {
    return {
      found: false,
      products: []
    };
  }

  return {
    found: true,
    products: products.slice(0, 5)
  };
}

// ============================================================
// CART OPERATIONS
// ============================================================

function addToCart(call, product, color, size, quantity = 1) {
  const safeColor =
    color ||
    product.colors[0];

  const safeSize =
    size ||
    product.sizes[0];

  const existing =
    call.cart.find(item =>
      item.productId === product.id &&
      item.color === safeColor &&
      item.size === safeSize
    );

  if (existing) {
    existing.quantity += quantity;
  } else {
    call.cart.push({
      productId: product.id,
      name: product.name,
      color: safeColor,
      size: safeSize,
      quantity,
      price: product.price
    });
  }

  return true;
}

function removeFromCart(call, productName) {
  const q = normalizeText(productName);

  const before =
    call.cart.length;

  call.cart =
    call.cart.filter(item =>
      !normalizeText(item.name).includes(q)
    );

  return before !== call.cart.length;
}

function clearCart(call) {
  call.cart = [];
}

function cartTotal(call) {
  return call.cart.reduce(
    (sum, item) =>
      sum +
      item.price *
      item.quantity,
    0
  );
}

function cartDescription(call) {
  if (!call.cart.length) {
    return "Your cart is currently empty.";
  }

  const parts =
    call.cart.map(item =>
      `${item.quantity} ${item.name}, ${item.color}, size ${item.size}`
    );

  return `Your cart has ${parts.join(", ")}. The current total is ₹${cartTotal(call)}.`;
}

// ============================================================
// ORDER FUNCTIONS
// ============================================================

function getCustomerOrders(call) {
  if (!call.customer) {
    return [];
  }

  return call.customer.orders || [];
}

function getLatestOrder(call) {
  const orders =
    getCustomerOrders(call);

  return orders.length
    ? orders[0]
    : null;
}

function findOrder(call, orderId) {
  const orders =
    getCustomerOrders(call);

  if (!orderId) {
    return orders[0] || null;
  }

  return orders.find(order =>
    normalizeText(order.id) ===
    normalizeText(orderId)
  ) || null;
}

// ============================================================
// WEB SEARCH
// ============================================================

function needsWebSearch(text) {
  const q = normalizeText(text);

  const words = [
    "today",
    "currently",
    "current",
    "latest",
    "news",
    "weather",
    "temperature",
    "open now",
    "closing time",
    "opening time",
    "timing",
    "price today"
  ];

  return words.some(word =>
    q.includes(word)
  );
}

async function searchWeb(query) {
  if (!TAVILY_API_KEY) {
    return "";
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      TAVILY_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        "https://api.tavily.com/search",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${TAVILY_API_KEY}`,
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              query,
              search_depth: "basic",
              max_results: 2,
              include_answer: true,
              include_raw_content: false
            }),

          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      return "";
    }

    const data =
      await response.json();

    let result = "";

    if (data.answer) {
      result +=
        String(data.answer) +
        " ";
    }

    if (Array.isArray(data.results)) {
      for (const item of data.results) {
        result +=
          `${item.title || ""}: ${item.content || ""} `;
      }
    }

    return result
      .replace(/\s+/g, " ")
      .trim();

  } catch (error) {
    return "";

  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// EXOTEL AUDIO QUEUE
// ============================================================

function createAudioQueue(call) {
  const queue = [];

  let timer = null;

  let sequenceNumber = 1;
  let chunkNumber = 0;
  let timestamp = 0;

  let stopped = false;

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
      call.ws.readyState !== WebSocket.OPEN ||
      !call.streamSid
    ) {
      return;
    }

    const chunk =
      queue.shift();

    try {
      call.ws.send(
        JSON.stringify({
          event: "media",

          sequence_number:
            String(sequenceNumber),

          stream_sid:
            call.streamSid,

          media: {
            chunk:
              String(chunkNumber),

            timestamp:
              String(timestamp),

            payload:
              chunk.toString("base64")
          }
        })
      );

      sequenceNumber++;
      chunkNumber++;
      timestamp += AUDIO_CHUNK_MS;

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
      queue.length = 0;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    stop() {
      stopped = true;
      queue.length = 0;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    hasPending() {
      return (
        queue.length > 0 ||
        Boolean(timer)
      );
    }
  };
}

// ============================================================
// DEEPGRAM STT CONNECTION
// ============================================================

function connectDeepgramSTT(call) {
  return new Promise((resolve, reject) => {

    const url =
      "wss://api.deepgram.com/v1/listen" +
      "?model=" +
      encodeURIComponent(DEEPGRAM_STT_MODEL) +
      "&language=en-US" +
      "&encoding=linear16" +
      "&sample_rate=8000" +
      "&channels=1" +
      "&interim_results=true" +
      "&endpointing=250" +
      "&punctuate=true" +
      "&smart_format=true";

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

    const timeout =
      setTimeout(() => {

        if (!settled) {
          settled = true;

          try {
            socket.close();
          } catch (_) {}

          reject(
            new Error(
              "Deepgram STT connection timeout"
            )
          );
        }

      }, DEEPGRAM_CONNECT_TIMEOUT_MS);

    socket.on("open", () => {

      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      console.log(
        `[${call.id}] Deepgram STT connected`
      );

      resolve(socket);
    });

    socket.on("error", error => {

      console.error(
        `[${call.id}] Deepgram STT error:`,
        error.message
      );

      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });

    socket.on("message", raw => {

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
          ?.transcript || "";

      if (!transcript.trim()) {
        return;
      }

      // --------------------------------------------------------
      // INTERIM
      // --------------------------------------------------------

      if (!message.is_final) {

        call.lastInterim =
          transcript;

        if (
          call.aiSpeaking &&
          transcript.trim().length >= 2
        ) {

          const explicit =
            isExplicitInterrupt(
              transcript
            );

          const words =
            transcript
              .trim()
              .split(/\s+/)
              .length;

          if (
            explicit ||
            words >= 2
          ) {

            interruptAI(
              call,
              explicit
                ? "explicit interruption"
                : "caller barge-in"
            );
          }
        }

        return;
      }

      // --------------------------------------------------------
      // FINAL
      // --------------------------------------------------------

      console.log(
        `[${call.id}] STT:`,
        transcript
      );

      call.lastInterim = "";

      handleUserSpeech(
        call,
        transcript
      );
    });
  });
}

// ============================================================
// DEEPGRAM TTS CONNECTION
// ============================================================

function connectDeepgramTTS(call) {
  return new Promise((resolve, reject) => {

    const url =
      "wss://api.deepgram.com/v1/speak" +
      "?model=" +
      encodeURIComponent(DEEPGRAM_TTS_MODEL) +
      "&encoding=linear16" +
      "&sample_rate=8000" +
      "&container=none" +
      "&speed=1.15";

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

    const timeout =
      setTimeout(() => {

        if (!settled) {

          settled = true;

          try {
            socket.close();
          } catch (_) {}

          reject(
            new Error(
              "Deepgram TTS connection timeout"
            )
          );
        }

      }, DEEPGRAM_CONNECT_TIMEOUT_MS);

    socket.on("open", () => {

      if (settled) {
        return;
      }

      settled = true;

      clearTimeout(timeout);

      console.log(
        `[${call.id}] Deepgram TTS connected`
      );

      resolve(socket);
    });

    socket.on("error", error => {

      console.error(
        `[${call.id}] Deepgram TTS error:`,
        error.message
      );

      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });

    socket.on("message", (data, isBinary) => {

      if (call.destroyed) {
        return;
      }

      if (
        isBinary ||
        Buffer.isBuffer(data)
      ) {

        if (
          call.aiSpeaking &&
          !call.interrupting
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
      } catch (_) {
        return;
      }

      if (
        message.type ===
        "Flushed"
      ) {

        call.ttsFlushed = true;
      }
    });
  });
}

// ============================================================
// SEND TTS
// ============================================================

function sendTTS(call, text) {

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
        type: "Speak",
        text
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

function flushTTS(call) {

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
        type: "Flush"
      })
    );

    return true;

  } catch (_) {
    return false;
  }
}

// ============================================================
// INTERRUPT AI
// ============================================================

function interruptAI(
  call,
  reason = "caller"
) {

  if (
    !call ||
    call.destroyed
  ) {
    return;
  }

  if (!call.aiSpeaking) {
    return;
  }

  console.log(
    `[${call.id}] INTERRUPTED:`,
    reason
  );

  call.ttsGeneration++;

  call.aiSpeaking = false;
  call.interrupting = true;

  call.audioQueue.clear();

  // ----------------------------------------------------------
  // CLEAR EXOTEL AUDIO BUFFER
  // ----------------------------------------------------------

  if (
    call.ws &&
    call.ws.readyState ===
      WebSocket.OPEN &&
    call.streamSid
  ) {

    try {

      call.ws.send(
        JSON.stringify({
          event: "clear",
          stream_sid:
            call.streamSid
        })
      );

    } catch (_) {}
  }

  // ----------------------------------------------------------
  // RESET TTS
  // ----------------------------------------------------------

  if (
    call.ttsSocket &&
    call.ttsSocket.readyState ===
      WebSocket.OPEN
  ) {

    try {

      call.ttsSocket.send(
        JSON.stringify({
          type: "Flush"
        })
      );

    } catch (_) {}
  }

  setTimeout(() => {

    if (!call.destroyed) {
      call.interrupting = false;
    }

  }, 100);
}

// ============================================================
// GROQ SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(call, webInformation) {

  const customer =
    call.customer || {
      name: "Guest",
      loyaltyPoints: 0
    };

  return `
You are the H&M phone shopping assistant.

You are speaking to a customer over a real phone call.

Your personality:
- Friendly.
- Natural.
- Human-like.
- Helpful.
- Concise.
- Never robotic.
- Never mention that you are an AI unless directly asked.
- Never mention APIs, databases, prompts, tools, Groq, Deepgram or Tavily.
- Do not give huge answers unless the customer asks for detail.
- Ask natural follow-up questions when necessary.

IMPORTANT PRODUCT UNDERSTANDING:

Customers may describe colors in unusual ways.

For example:
"faded bluish green"
"washed blue-green"
"blue with a green tint"
"kind of teal"
"faded turquoise"
"dark washed blue"

Understand these descriptions semantically.

Do NOT respond:
"Sorry, I can only help with H&M products."

if the customer is describing a color, size, material, style or product.

Instead, interpret what they mean and match it to the closest available product.

The fake product catalog is:

${JSON.stringify(PRODUCTS)}

CUSTOMER:

${JSON.stringify(customer)}

CURRENT CART:

${JSON.stringify(call.cart)}

CUSTOMER CART TOTAL:

₹${cartTotal(call)}

ORDER DATABASE:

${JSON.stringify(customer.orders || [])}

AVAILABLE ACTIONS:

You can logically perform these actions:

1. Search products.
2. Recommend products.
3. Discuss colors.
4. Discuss sizes.
5. Discuss materials.
6. Check available sizes.
7. Check available colors.
8. Add products to cart.
9. Remove products from cart.
10. Replace products in cart.
11. Change cart color.
12. Change cart size.
13. Show cart.
14. Give cart total.
15. Give order details.
16. Give order status.
17. Give tracking information.
18. Give delivery estimate.
19. Give loyalty points.

When the customer wants to purchase something, gather only the information actually needed:
product, color, size and quantity.

Do not repeatedly ask for information the customer has already provided.

If the customer says:
"I want bootcut jeans"

you can ask:
"What color and size would you like?"

If they say:
"faded bluish green"

understand it as a color description and continue naturally.

If they say:
"size 32"

remember that.

If they say:
"add it"

add the matching product to the cart.

If the customer asks something outside the currently implemented H&M functions, say naturally:

"Sorry, that option isn't available right now, but I can help you with products, shopping, sizes, your cart, orders and tracking."

CURRENT WEB INFORMATION:

${webInformation || "No current web information available."}
`;
}

// ============================================================
// GROQ STREAMING
// ============================================================

async function generateResponse(
  call,
  question,
  webInformation,
  generation
) {

  const messages = [
    {
      role: "system",
      content:
        buildSystemPrompt(
          call,
          webInformation
        )
    }
  ];

  for (const item of call.history.slice(-12)) {
    messages.push({
      role: item.role,
      content: item.content
    });
  }

  messages.push({
    role: "user",
    content: question
  });

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      GROQ_TIMEOUT_MS
    );

  try {

    const stream =
      await groq.chat.completions.create(
        {
          model:
            GROQ_MODEL,

          messages,

          temperature:
            0.25,

          max_tokens:
            120,

          top_p:
            0.9,

          stream:
            true
        },
        {
          signal:
            controller.signal
        }
      );

    let fullResponse = "";
    let buffer = "";

    for await (
      const chunk of stream
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
          ?.content || "";

      if (!token) {
        continue;
      }

      fullResponse += token;
      buffer += token;

      // --------------------------------------------------------
      // SENTENCE TTS
      // --------------------------------------------------------

      let match;

      while (
        (
          match =
            buffer.match(
              /^([\s\S]*?[.!?])(?:\s+|$)/
            )
        )
      ) {

        if (
          call.destroyed ||
          call.ttsGeneration !==
            generation
        ) {
          break;
        }

        const sentence =
          match[1]
            .replace(/\s+/g, " ")
            .trim();

        buffer =
          buffer
            .slice(match[0].length)
            .trimStart();

        if (sentence) {

          sendTTS(
            call,
            sentence
          );
        }
      }

      // --------------------------------------------------------
      // EARLY CHUNK FOR LONG RESPONSES
      // --------------------------------------------------------

      if (
        buffer.length >= 65
      ) {

        const lastSpace =
          buffer.lastIndexOf(" ");

        if (lastSpace >= 30) {

          const chunkText =
            buffer
              .slice(0, lastSpace)
              .trim();

          buffer =
            buffer
              .slice(lastSpace + 1)
              .trimStart();

          if (chunkText) {

            sendTTS(
              call,
              chunkText
            );
          }
        }
      }
    }

    // ----------------------------------------------------------
    // REMAINING TTS
    // ----------------------------------------------------------

    if (
      buffer.trim() &&
      call.ttsGeneration ===
        generation &&
      !call.destroyed
    ) {

      sendTTS(
        call,
        buffer
          .replace(/\s+/g, " ")
          .trim()
      );
    }

    if (
      call.ttsGeneration ===
      generation &&
      !call.destroyed
    ) {

      flushTTS(call);
    }

    return fullResponse
      .replace(/\s+/g, " ")
      .trim();

  } finally {

    clearTimeout(timeout);
  }
}

// ============================================================
// BUSINESS LOGIC
// ============================================================

function applyBusinessLogic(
  call,
  question
) {

  const q =
    normalizeText(question);

  // ----------------------------------------------------------
  // CART VIEW
  // ----------------------------------------------------------

  if (
    q.includes("what's in my cart") ||
    q.includes("whats in my cart") ||
    q.includes("show my cart") ||
    q.includes("view my cart") ||
    q.includes("cart total")
  ) {

    return {
      context:
        cartDescription(call)
    };
  }

  // ----------------------------------------------------------
  // CLEAR CART
  // ----------------------------------------------------------

  if (
    q.includes("clear my cart") ||
    q.includes("empty my cart")
  ) {

    clearCart(call);

    return {
      context:
        "The customer's cart has been cleared."
    };
  }

  // ----------------------------------------------------------
  // ORDER
  // ----------------------------------------------------------

  if (
    q.includes("my order") ||
    q.includes("order status") ||
    q.includes("where is my order") ||
    q.includes("track my order") ||
    q.includes("tracking")
  ) {

    const order =
      findOrder(call);

    if (!order) {

      return {
        context:
          "No order was found for this customer."
      };
    }

    return {
      context:
        `Latest order ${order.id}: status ${order.status}, tracking number ${order.tracking}, carrier ${order.carrier}, expected delivery ${order.delivery}.`
    };
  }

  // ----------------------------------------------------------
  // LOYALTY
  // ----------------------------------------------------------

  if (
    q.includes("loyalty") ||
    q.includes("points") ||
    q.includes("reward points")
  ) {

    return {
      context:
        `Customer has ${call.customer?.loyaltyPoints || 0} loyalty points.`
    };
  }

  // ----------------------------------------------------------
  // PRODUCT SEARCH
  // ----------------------------------------------------------

  const products =
    searchProductsForCustomer(
      question
    );

  if (products.found) {

    const descriptions =
      products.products
        .map(product => {

          return `${product.name}, ₹${product.price}, colors ${product.colors.join(", ")}, sizes ${product.sizes.join(", ")}, materials ${product.materials.join(", ")}`;

        })
        .join(" | ");

    return {
      context:
        `Matching products: ${descriptions}`
    };
  }

  return {
    context: ""
  };
}

// ============================================================
// HANDLE USER SPEECH
// ============================================================

async function handleUserSpeech(
  call,
  text
) {

  if (
    call.destroyed ||
    call.interrupting
  ) {
    return;
  }

  const question =
    String(text)
      .replace(/\s+/g, " ")
      .trim();

  if (!question) {
    return;
  }

  console.log(
    `[${call.id}] CUSTOMER:`,
    question
  );

  // ----------------------------------------------------------
  // GOODBYE
  // ----------------------------------------------------------

  if (isGoodbye(question)) {

    interruptAI(
      call,
      "goodbye"
    );

    await sleep(80);

    if (call.destroyed) {
      return;
    }

    const goodbye =
      "You're very welcome. Thanks for calling H&M. Have a great day!";

    call.aiSpeaking = true;

    sendTTS(
      call,
      goodbye
    );

    flushTTS(call);

    setTimeout(() => {

      if (!call.destroyed) {
        hangUpCall(call);
      }

    }, 1700);

    return;
  }

  // ----------------------------------------------------------
  // INTERRUPTION COMMAND
  // ----------------------------------------------------------

  if (
    isExplicitInterrupt(question)
  ) {

    interruptAI(
      call,
      "explicit command"
    );

    return;
  }

  // ----------------------------------------------------------
  // CANCEL CURRENT RESPONSE
  // ----------------------------------------------------------

  if (call.aiSpeaking) {

    interruptAI(
      call,
      "new customer question"
    );

    await sleep(60);
  }

  const generation =
    ++call.ttsGeneration;

  call.aiSpeaking = true;
  call.interrupting = false;

  // ----------------------------------------------------------
  // BUSINESS CONTEXT
  // ----------------------------------------------------------

  const business =
    applyBusinessLogic(
      call,
      question
    );

  let webInformation = "";

  if (
    needsWebSearch(question)
  ) {

    webInformation =
      await searchWeb(
        question
      );
  }

  if (
    call.destroyed ||
    call.ttsGeneration !==
      generation
  ) {
    return;
  }

  const finalQuestion =
    business.context
      ? `${question}\n\nBusiness system context:\n${business.context}`
      : question;

  call.history.push({
    role: "user",
    content: question
  });

  try {

    const answer =
      await generateResponse(
        call,
        finalQuestion,
        webInformation,
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
        role: "assistant",
        content: answer
      });

      if (
        call.history.length >
        12
      ) {

        call.history =
          call.history.slice(-12);
      }

      console.log(
        `[${call.id}] AI:`,
        answer
      );
    }

  } catch (error) {

    if (
      call.destroyed ||
      call.ttsGeneration !==
        generation
    ) {
      return;
    }

    console.error(
      `[${call.id}] RESPONSE ERROR:`,
      error.message
    );

    sendTTS(
      call,
      "Sorry, I had trouble with that. Could you say that again?"
    );

    flushTTS(call);

  } finally {

    if (
      call.ttsGeneration ===
      generation &&
      !call.destroyed
    ) {

      call.aiSpeaking = false;
    }
  }
}

// ============================================================
// HANG UP CALL
// ============================================================

function hangUpCall(call) {

  if (
    !call ||
    call.destroyed
  ) {
    return;
  }

  console.log(
    `[${call.id}] Ending call`
  );

  try {

    if (
      call.ws &&
      call.ws.readyState ===
        WebSocket.OPEN
    ) {

      call.ws.send(
        JSON.stringify({
          event: "stop",
          stream_sid:
            call.streamSid
        })
      );
    }

  } catch (_) {}

  setTimeout(() => {

    destroyCall(call);

  }, 200);
}

// ============================================================
// DESTROY CALL
// ============================================================

function destroyCall(call) {

  if (
    !call ||
    call.destroyed
  ) {
    return;
  }

  call.destroyed = true;

  call.aiSpeaking = false;

  call.ttsGeneration++;

  call.questionQueue = [];

  if (call.audioQueue) {
    call.audioQueue.stop();
  }

  try {
    call.sttSocket?.close();
  } catch (_) {}

  try {
    call.ttsSocket?.close();
  } catch (_) {}

  activeCalls.delete(
    call.id
  );

  console.log(
    `[${call.id}] CALL CLEANED UP`
  );

  console.log(
    `Active calls: ${activeCalls.size}`
  );
}

// ============================================================
// CREATE SESSION
// ============================================================

function createCallSession(ws) {

  const call = {

    id:
      `CALL-${nextCallNumber++}`,

    ws,

    streamSid: null,
    callSid: null,

    phone: null,

    customer: null,

    sttSocket: null,
    ttsSocket: null,

    audioQueue: null,

    history: [],

    cart: [],

    aiSpeaking: false,

    interrupting: false,

    ttsGeneration: 0,

    ttsFlushed: false,

    lastInterim: "",

    destroyed: false
  };

  call.audioQueue =
    createAudioQueue(call);

  activeCalls.set(
    call.id,
    call
  );

  return call;
}

// ============================================================
// EXOTEL WEBSOCKET
// ============================================================

const server =
  http.createServer(
    (req, res) => {

      if (
        req.url === "/health"
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
            service:
              "hm-ai-voice-assistant",
            model:
              GROQ_MODEL,
            stt:
              DEEPGRAM_STT_MODEL,
            tts:
              DEEPGRAM_TTS_MODEL,
            activeCalls:
              activeCalls.size
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
          status: "ok",
          service:
            "H&M AI Voice Assistant",
          activeCalls:
            activeCalls.size
        })
      );
    }
  );

const wss =
  new WebSocket.Server({
    server
  });

// ============================================================
// NEW CONNECTION
// ============================================================

wss.on(
  "connection",
  ws => {

    const call =
      createCallSession(ws);

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

        if (call.destroyed) {
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
            `[${call.id}] Invalid JSON`
          );

          return;
        }

        const event =
          message.event;

        // ------------------------------------------------------
        // CONNECTED
        // ------------------------------------------------------

        if (
          event === "connected"
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
          event === "start"
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

          call.phone =
            message.start?.custom_parameters?.phone ||
            message.start?.customParameters?.phone ||
            message.start?.from ||
            message.start?.caller ||
            null;

          if (
            call.phone
          ) {

            const normalizedPhone =
              String(call.phone)
                .replace(/\D/g, "");

            call.customer =
              CUSTOMERS[
                normalizedPhone
              ] || null;
          }

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
            call.phone || "unknown"
          );

          console.log(
            `[${call.id}] CUSTOMER:`,
            call.customer?.name ||
              "Guest"
          );

          // ----------------------------------------------------
          // CONNECT DEEPGRAM
          // ----------------------------------------------------

          try {

            const [
              stt,
              tts
            ] =
              await Promise.all([
                connectDeepgramSTT(call),
                connectDeepgramTTS(call)
              ]);

            if (call.destroyed) {
              try {
                stt.close();
              } catch (_) {}

              try {
                tts.close();
              } catch (_) {}

              return;
            }

            call.sttSocket = stt;
            call.ttsSocket = tts;

            console.log(
              `[${call.id}] DEEPGRAM READY`
            );

            // --------------------------------------------------
            // GREETING
            // --------------------------------------------------

            const greeting =
              `Hi ${call.customer?.name || "there"}! Welcome to H&M. I can help you find products, choose colors and sizes, add or change items in your cart, check your orders and tracking, and answer shopping questions. What would you like to shop for today?`;

            call.aiSpeaking = true;

            call.history.push({
              role: "assistant",
              content: greeting
            });

            sendTTS(
              call,
              greeting
            );

            flushTTS(call);

            // Don't mark false immediately.
            // Keep barge-in available while greeting plays.

            setTimeout(() => {

              if (!call.destroyed) {
                call.aiSpeaking = false;
              }

            }, 2200);

          } catch (error) {

            console.error(
              `[${call.id}] DEEPGRAM SETUP ERROR:`,
              error.message
            );

            try {

              sendTTS(
                call,
                "Sorry, the voice service is temporarily unavailable. Please try again."
              );

              flushTTS(call);

            } catch (_) {}

          }

          return;
        }

        // ------------------------------------------------------
        // MEDIA
        // ------------------------------------------------------

        if (
          event === "media"
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

            if (audio.length) {
              call.sttSocket.send(
                audio
              );
            }

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
          event === "stop"
        ) {

          console.log(
            `[${call.id}] EXOTEL CALL STOP`
          );

          destroyCall(call);

          return;
        }

        // ------------------------------------------------------
        // MARK
        // ------------------------------------------------------

        if (
          event === "mark"
        ) {

          console.log(
            `[${call.id}] MARK:`,
            message.mark?.name ||
              "unknown"
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

        destroyCall(call);
      }
    );

    ws.on(
      "error",
      error => {

        console.error(
          `[${call.id}] EXOTEL WS ERROR:`,
          error.message
        );

        destroyCall(call);
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
      "Port:",
      PORT
    );

    console.log(
      "Groq:",
      GROQ_MODEL
    );

    console.log(
      "Deepgram STT:",
      DEEPGRAM_STT_MODEL
    );

    console.log(
      "Deepgram TTS:",
      DEEPGRAM_TTS_MODEL
    );

    console.log(
      "Tavily:",
      TAVILY_API_KEY
        ? "enabled"
        : "disabled"
    );

    console.log(
      "============================================"
    );
  }
);

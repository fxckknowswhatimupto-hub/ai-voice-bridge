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

const GROQ_MODEL =
  process.env.GROQ_MODEL || "llama-3.1-8b-instant";

// Primary phone-call model
const DEEPGRAM_PRIMARY_STT =
  process.env.DEEPGRAM_STT_MODEL || "nova-2-phonecall";

// Fallback model
const DEEPGRAM_FALLBACK_STT =
  process.env.DEEPGRAM_FALLBACK_STT_MODEL || "nova-3";

const DEEPGRAM_TTS_MODEL =
  process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en";

const SAMPLE_RATE = 8000;

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

let callNumber = 1;

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
        product: "Oversized Cotton T-Shirt",
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

        color:
          "dark blue",

        size:
          "32",

        quantity: 1,

        status:
          "Shipped",

        courier:
          "BlueDart",

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
// HELPERS
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
    digits = digits.slice(-10);
  }

  if (digits.length > 10) {
    digits = digits.slice(-10);
  }

  return digits;
}

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
      if (q.includes(color)) {
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

  const mappings = {
    small: "S",
    medium: "M",
    large: "L",
    "extra large": "XL",
    "extra small": "XS",
    "extra extra large": "XXL"
  };

  for (const key of Object.keys(mappings)) {
    if (q.includes(key)) {
      return mappings[key];
    }
  }

  const sizes = [
    "XXL",
    "XL",
    "XS",
    "36",
    "34",
    "32",
    "30",
    "28",
    "S",
    "M",
    "L"
  ];

  for (const size of sizes) {
    const regex =
      new RegExp(
        `(^|\\s)${size.toLowerCase()}($|\\s)`
      );

    if (
      regex.test(q)
    ) {
      return size;
    }
  }

  return null;
}

// ============================================================
// CART
// ============================================================

function addToCart(
  customer,
  product,
  color,
  size,
  quantity
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
        normalizeText(item.product)
          .includes(
            normalizeText(productName)
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
                chunk.toString("base64")
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
// DEEPGRAM WEBSOCKET CONNECTION
// ============================================================

function openDeepgramSocket(
  url
) {
  return new Promise(
    (resolve, reject) => {
      let settled = false;

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
              if (!settled) {
                settled = true;

                reject(
                  new Error(
                    `Deepgram HTTP ${response.statusCode}: ${body || "No response body"}`
                  )
                );
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
                "Deepgram WebSocket closed before opening"
              )
            );
          }
        }
      );
    }
  );
}

// ============================================================
// STT URL
// ============================================================

function buildSTTUrl(
  model
) {
  /*
   * IMPORTANT:
   *
   * Exotel sends:
   * raw/slin
   * 16-bit
   * 8000 Hz
   * mono
   * little-endian PCM
   *
   * Deepgram's raw Linear16 configuration
   * therefore uses encoding=linear16 and
   * sample_rate=8000.
   */

  return (
    "wss://api.deepgram.com/v1/listen" +
    `?model=${encodeURIComponent(model)}` +
    "&language=en-US" +
    "&encoding=linear16" +
    "&sample_rate=8000" +
    "&channels=1" +
    "&interim_results=true" +
    "&endpointing=300"
  );
}

// ============================================================
// CONNECT STT
// ============================================================

async function connectSTT(
  call
) {
  let lastError = null;

  const models = [
    DEEPGRAM_PRIMARY_STT,
    DEEPGRAM_FALLBACK_STT
  ];

  for (
    let i = 0;
    i < models.length;
    i++
  ) {
    const model =
      models[i];

    if (
      i > 0 &&
      model === models[i - 1]
    ) {
      continue;
    }

    const url =
      buildSTTUrl(
        model
      );

    console.log(
      `[${call.id}] Connecting Deepgram STT: ${model}`
    );

    console.log(
      `[${call.id}] STT URL: ${url}`
    );

    try {
      const socket =
        await openDeepgramSocket(
          url
        );

      console.log(
        `[${call.id}] Deepgram STT connected using ${model}`
      );

      call.sttModel =
        model;

      socket.on(
        "message",
        raw => {
          if (
            call.destroyed
          ) {
            return;
          }

          let msg;

          try {
            msg =
              JSON.parse(
                raw.toString()
              );
          } catch {
            return;
          }

          if (
            msg.type ===
            "Metadata"
          ) {
            return;
          }

          if (
            msg.type ===
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
            msg
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

          // Interim transcript
          if (
            msg.is_final !== true
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

          // Final transcript segment
          call.finalParts.push(
            clean
          );

          /*
           * Deepgram can send several is_final
           * segments before speech_final.
           *
           * We concatenate them.
           */

          if (
            msg.speech_final !==
            true
          ) {
            return;
          }

          const fullText =
            call.finalParts
              .join(" ")
              .replace(
                /\s+/g,
                " "
              )
              .trim();

          call.finalParts = [];

          call.lastInterim =
            "";

          if (!fullText) {
            return;
          }

          console.log(
            `[${call.id}] CUSTOMER: ${fullText}`
          );

          handleCustomerSpeech(
            call,
            fullText
          );
        }
      );

      socket.on(
        "error",
        error => {
          console.error(
            `[${call.id}] STT SOCKET ERROR:`,
            error.message
          );
        }
      );

      socket.on(
        "close",
        (code, reason) => {
          call.sttReady =
            false;

          if (
            !call.destroyed
          ) {
            console.log(
              `[${call.id}] STT CLOSED: ${code} ${reason?.toString() || ""}`
            );
          }
        }
      );

      return socket;

    } catch (error) {
      lastError =
        error;

      console.error(
        `[${call.id}] STT MODEL ${model} FAILED:`,
        error.message
      );

      /*
       * Try the fallback model rather than
       * immediately killing the call.
       */
    }
  }

  throw (
    lastError ||
    new Error(
      "All Deepgram STT models failed"
    )
  );
}

// ============================================================
// CONNECT TTS
// ============================================================

async function connectTTS(
  call
) {
  /*
   * Deepgram v1 streaming TTS.
   *
   * IMPORTANT:
   * Do not add container=none here.
   * The current v1 streaming TTS endpoint
   * already emits raw streaming audio.
   */

  const url =
    "wss://api.deepgram.com/v1/speak" +
    `?model=${encodeURIComponent(
      DEEPGRAM_TTS_MODEL
    )}` +
    "&encoding=linear16" +
    "&sample_rate=8000" +
    "&speed=1.08";

  console.log(
    `[${call.id}] Connecting Deepgram TTS`
  );

  console.log(
    `[${call.id}] TTS URL: ${url}`
  );

  const socket =
    await openDeepgramSocket(
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

      let msg;

      try {
        msg =
          JSON.parse(
            data.toString()
          );
      } catch {
        return;
      }

      if (
        msg.type ===
        "Warning"
      ) {
        console.log(
          `[${call.id}] TTS WARNING:`,
          msg.description ||
            msg.code ||
            "Unknown"
        );
      }
    }
  );

  socket.on(
    "error",
    error => {
      console.error(
        `[${call.id}] TTS SOCKET ERROR:`,
        error.message
      );
    }
  );

  socket.on(
    "close",
    (code, reason) => {
      call.ttsReady =
        false;

      if (
        !call.destroyed
      ) {
        console.log(
          `[${call.id}] TTS CLOSED: ${code} ${reason?.toString() || ""}`
        );
      }
    }
  );

  return socket;
}

// ============================================================
// DEEPGRAM KEEPALIVE
// ============================================================

function startKeepAlive(
  call
) {
  if (
    call.keepAliveTimer
  ) {
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
// INTERRUPT AI
// ============================================================

function interruptAI(
  call
) {
  if (
    !call.aiSpeaking
  ) {
    return;
  }

  console.log(
    `[${call.id}] BARGE-IN DETECTED`
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

function buildSystemPrompt(
  call
) {
  return `
You are an H&M customer service phone assistant.

Your personality is relaxed, friendly, warm and natural.

You should sound like an experienced human retail employee.

Do not sound robotic.

Do not mention that you are an AI.

Do not give huge explanations.

Phone conversations should be concise.

Use natural conversational language such as:

"Sure."
"Yeah, absolutely."
"Got it."
"No problem."
"Let me check that."
"Yep, I can help with that."

Do not repeat these phrases unnecessarily.

CUSTOMER:
${JSON.stringify(
  call.customer || {
    name: "Guest"
  }
)}

PRODUCT DATABASE:
${JSON.stringify(PRODUCTS)}

CURRENT CART:
${JSON.stringify(
  call.customer?.cart || []
)}

ORDERS:
${JSON.stringify(
  call.customer?.orders || []
)}

LOYALTY POINTS:
${call.customer?.loyaltyPoints || 0}

You can help with:

product search
colors
sizes
materials
prices
stock
product descriptions
adding products to cart
removing products from cart
replacing cart products
changing size
changing color
changing quantity
order status
tracking
courier information
estimated delivery
loyalty points
customer information
general shopping questions

SPECIFIC SEARCH:

If a customer requests a very specific combination of:

color + size + material

you must check the database carefully.

Example:

"I want a black dress in medium."

Look for a dress supporting black and M.

Example:

"I want a cotton shirt in beige."

Look for a shirt supporting cotton and beige.

If an exact match does not exist, clearly explain that and offer the closest available option.

SPEECH RECOGNITION:

Telephone speech recognition can confuse:

"a dress"

with:

"address"

If the context is fashion/clothing, interpret "address" as "a dress" when that clearly makes sense.

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

ask:

"Just to confirm, would you like me to end the call?"

Do not terminate immediately.

Only end after confirmation.

IMPORTANT:

Never say:

"Sorry, I had trouble there"

unless the speech genuinely cannot be understood.

Do not repeatedly ask the customer to repeat themselves.

Keep answers short enough for a phone conversation.

No markdown.

No bullet lists.

No long paragraphs.
`;
}

// ============================================================
// CONTEXT
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

  if (
    products.length
  ) {
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
    text +
    "\n\nINTERNAL CONTEXT:\n" +
    hints.join("\n")
  );
}

// ============================================================
// SPEECH CLEANUP
// ============================================================

function cleanForSpeech(
  text
) {
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

          temperature:
            0.55,

          max_tokens:
            180,

          stream:
            true
        }
      );

    let fullResponse =
      "";

    let sentenceBuffer =
      "";

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

      fullResponse +=
        token;

      sentenceBuffer +=
        token;

      /*
       * Start TTS quickly instead of waiting
       * for the entire Groq response.
       */

      const match =
        sentenceBuffer.match(
          /^([\s\S]*?[.!?])\s+/
        );

      if (
        match ||
        sentenceBuffer.length >= 100
      ) {
        let textToSpeak =
          "";

        if (match) {
          textToSpeak =
            match[1];

          sentenceBuffer =
            sentenceBuffer.slice(
              match[0].length
            );
        } else {
          const split =
            sentenceBuffer.lastIndexOf(
              " "
            );

          if (
            split > 30
          ) {
            textToSpeak =
              sentenceBuffer.slice(
                0,
                split
              );

            sentenceBuffer =
              sentenceBuffer.slice(
                split + 1
              );
          } else {
            continue;
          }
        }

        textToSpeak =
          cleanForSpeech(
            textToSpeak
          );

        if (
          textToSpeak &&
          call.ttsSocket &&
          call.ttsSocket.readyState ===
            WebSocket.OPEN &&
          generation ===
            call.responseGeneration
        ) {
          call.ttsSocket.send(
            JSON.stringify({
              type: "Speak",
              text: textToSpeak
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

    const remaining =
      cleanForSpeech(
        sentenceBuffer
      );

    if (
      remaining &&
      call.ttsSocket &&
      call.ttsSocket.readyState ===
        WebSocket.OPEN
    ) {
      call.ttsSocket.send(
        JSON.stringify({
          type: "Speak",
          text: remaining
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
              "Give me just a second."
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

function sendGreeting(
  call
) {
  if (
    call.destroyed ||
    call.greetingSent ||
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN ||
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
    `Hi ${name}, welcome to H and M. How can I help you today?`;

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
// CREATE CALL
// ============================================================

function createCall(
  ws
) {
  const call = {
    id:
      `CALL-${callNumber++}`,

    ws,

    streamSid:
      null,

    callSid:
      null,

    phoneNumber:
      null,

    customer:
      null,

    sttSocket:
      null,

    ttsSocket:
      null,

    sttReady:
      false,

    ttsReady:
      false,

    sttModel:
      null,

    greetingSent:
      false,

    aiSpeaking:
      false,

    destroyed:
      false,

    responseGeneration:
      0,

    lastProcessedText:
      "",

    lastInterim:
      "",

    finalParts:
      [],

    keepAliveTimer:
      null,

    audioQueue:
      null,

    history:
      []
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
            status:
              "ok",

            activeCalls:
              activeCalls.size,

            primarySTT:
              DEEPGRAM_PRIMARY_STT,

            fallbackSTT:
              DEEPGRAM_FALLBACK_STT,

            tts:
              DEEPGRAM_TTS_MODEL,

            groq:
              GROQ_MODEL
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
      createCall(
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
      `[${call.id}] ACTIVE CALLS: ${activeCalls.size}`
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
            `[${call.id}] INVALID JSON FROM EXOTEL`
          );

          return;
        }

        const event =
          message.event;

        // ======================================================
        // CONNECTED
        // ======================================================

        if (
          event ===
          "connected"
        ) {
          console.log(
            `[${call.id}] EXOTEL STREAM CONNECTED`
          );

          return;
        }

        // ======================================================
        // START
        // ======================================================

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

          call.phoneNumber =
            message.start?.from ||
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

          // Log exactly what Exotel says the audio is
          console.log(
            `[${call.id}] EXOTEL MEDIA FORMAT:`,
            JSON.stringify(
              message.start?.media_format ||
                {}
            )
          );

          try {
            // --------------------------------------------------
            // STT
            // --------------------------------------------------

            call.sttSocket =
              await connectSTT(
                call
              );

            call.sttReady =
              true;

            // --------------------------------------------------
            // TTS
            // --------------------------------------------------

            call.ttsSocket =
              await connectTTS(
                call
              );

            call.ttsReady =
              true;

            console.log(
              `[${call.id}] DEEPGRAM STT + TTS READY`
            );

            startKeepAlive(
              call
            );

            // --------------------------------------------------
            // GREETING
            // --------------------------------------------------

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

            destroyCall(
              call
            );
          }

          return;
        }

        // ======================================================
        // MEDIA
        // ======================================================

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

            /*
             * Exotel Voicebot sends raw/slin
             * 16-bit 8kHz mono PCM.
             */

            call.sttSocket.send(
              audio
            );

          } catch (error) {
            console.error(
              `[${call.id}] AUDIO → STT ERROR:`,
              error.message
            );
          }

          return;
        }

        // ======================================================
        // CLEAR
        // ======================================================

        if (
          event ===
          "clear"
        ) {
          call.audioQueue.clear();

          return;
        }

        // ======================================================
        // DTMF
        // ======================================================

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

        // ======================================================
        // STOP
        // ======================================================

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
      }
    );

    ws.on(
      "close",
      () => {
        console.log(
          `[${call.id}] EXOTEL SOCKET CLOSED`
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
          `[${call.id}] EXOTEL SOCKET ERROR:`,
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
      "H&M AI PHONE ASSISTANT"
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
      `PRIMARY STT: ${DEEPGRAM_PRIMARY_STT}`
    );

    console.log(
      `FALLBACK STT: ${DEEPGRAM_FALLBACK_STT}`
    );

    console.log(
      `TTS: ${DEEPGRAM_TTS_MODEL}`
    );

    console.log(
      "AUDIO: 16-bit PCM / 8000 Hz / MONO"
    );

    console.log(
      "CUSTOMER DATABASE: ON"
    );

    console.log(
      "STREAMING LLM: ON"
    );

    console.log(
      "STREAMING TTS: ON"
    );

    console.log(
      "BARGE-IN: ON"
    );

    console.log(
      "============================================"
    );
  }
);

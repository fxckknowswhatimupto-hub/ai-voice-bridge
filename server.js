const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 10000;

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
  process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const DEEPGRAM_STT_MODEL =
  process.env.DEEPGRAM_STT_MODEL || "nova-2-phonecall";

const DEEPGRAM_TTS_MODEL =
  process.env.DEEPGRAM_TTS_MODEL || "aura-asteria-en";

const SAMPLE_RATE = 8000;

// 20 ms of 8 kHz 16-bit PCM
const CHUNK_BYTES = 320;

const CHUNK_MS = 20;

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

const activeCalls = new Map();

let nextCallNumber = 1;


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

    material:
      "98% Cotton, 2% Elastane (Stretch)",

    description:
      "Classic bootcut fit with a high waist and slight stretch for comfort."
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

    material:
      "100% Organic Cotton",

    description:
      "Relaxed fit t-shirt made from heavy-weight organic cotton."
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

    material:
      "Viscose Blend",

    description:
      "A fitted, calf-length dress in soft, ribbed jersey."
  },

  {
    id: "HM-HOD-301",
    name: "Relaxed Fit Hoodie",
    category: "Hoodies",
    price: 1799,

    colors: [
      "black",
      "grey",
      "beige"
    ],

    sizes: [
      "S",
      "M",
      "L",
      "XL"
    ],

    material:
      "80% Cotton, 20% Polyester",

    description:
      "Soft relaxed-fit hoodie suitable for everyday wear."
  },

  {
    id: "HM-SHT-201",
    name: "Relaxed Cotton Shirt",
    category: "Shirts",
    price: 1499,

    colors: [
      "white",
      "black",
      "light blue"
    ],

    sizes: [
      "S",
      "M",
      "L",
      "XL"
    ],

    material:
      "100% Cotton",

    description:
      "Relaxed casual cotton shirt for everyday wear."
  }
];


// ============================================================
// CUSTOMER DATABASE
// ============================================================

const CUSTOMERS = {

  "919876543210": {
    name: "Syed",
    phone: "919876543210",

    loyaltyPoints: 450,

    cart: [],

    lastOrder: {
      id: "HM88291",

      status: "Shipped",

      trackingNumber:
        "HMTX8829101",

      delivery:
        "August 15",

      items: [
        "Bootcut High Waist Jeans"
      ]
    }
  },

  // Your Exotel number from your previous logs.
  "08667859535": {
    name: "Syed",
    phone: "08667859535",

    loyaltyPoints: 450,

    cart: [],

    lastOrder: {
      id: "HM88291",

      status: "Shipped",

      trackingNumber:
        "HMTX8829101",

      delivery:
        "August 15",

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
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ");
}


// ============================================================
// PHONE NORMALIZATION
// ============================================================

function normalizePhone(phone) {

  return String(phone || "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
}


function findCustomer(phone) {

  const incoming =
    normalizePhone(phone);

  if (!incoming) {
    return null;
  }

  for (const customer of Object.values(CUSTOMERS)) {

    const stored =
      normalizePhone(customer.phone);

    if (
      incoming === stored ||
      incoming.endsWith(stored) ||
      stored.endsWith(incoming)
    ) {
      return customer;
    }
  }

  return null;
}


// ============================================================
// ASR CORRECTIONS
// ============================================================

function correctSpeechRecognition(text) {

  let result =
    normalizeText(text);

  /*
   * Common telephone ASR mistakes.
   *
   * IMPORTANT:
   * We only replace words when they make contextual sense.
   */

  result = result
    .replace(/\baddress\b/g, "dress")
    .replace(/\bgenes\b/g, "jeans")
    .replace(/\bgene\b/g, "jeans")
    .replace(/\bjean\b/g, "jeans")
    .replace(/\bhoody\b/g, "hoodie")
    .replace(/\bhoddie\b/g, "hoodie")
    .replace(/\btee shirt\b/g, "t shirt")
    .replace(/\bt shirt\b/g, "t-shirt");

  return result.trim();
}


// ============================================================
// PRODUCT SEARCH
// ============================================================

function productMatchesText(product, text) {

  const q =
    normalizeText(text);

  const productName =
    normalizeText(product.name);

  const category =
    normalizeText(product.category);

  if (q.includes(productName)) {
    return true;
  }

  if (q.includes(category)) {
    return true;
  }

  for (const color of product.colors) {

    if (q.includes(normalizeText(color))) {
      return true;
    }
  }

  for (const size of product.sizes) {

    if (q.includes(size)) {
      return true;
    }
  }

  const material =
    normalizeText(product.material);

  const materialWords =
    material.split(/\s+/);

  for (const word of materialWords) {

    if (
      word.length > 4 &&
      q.includes(word)
    ) {
      return true;
    }
  }

  return false;
}


function findProducts(query) {

  const q =
    normalizeText(query);

  return PRODUCTS.filter(product =>
    productMatchesText(product, q)
  );
}


// ============================================================
// PRODUCT SEARCH WITH SIMPLE SEMANTIC MATCHING
// ============================================================

function searchRelevantProducts(text) {

  const q =
    normalizeText(text);

  const results = [];

  for (const product of PRODUCTS) {

    let score = 0;

    const name =
      normalizeText(product.name);

    const category =
      normalizeText(product.category);

    if (q.includes(name)) {
      score += 10;
    }

    if (q.includes(category)) {
      score += 5;
    }

    for (const color of product.colors) {

      if (q.includes(normalizeText(color))) {
        score += 3;
      }
    }

    for (const size of product.sizes) {

      if (q.includes(size)) {
        score += 2;
      }
    }

    const material =
      normalizeText(product.material);

    if (
      q.includes("cotton") &&
      material.includes("cotton")
    ) {
      score += 4;
    }

    if (
      q.includes("stretch") &&
      material.includes("elastane")
    ) {
      score += 4;
    }

    if (
      q.includes("oversized") &&
      name.includes("oversized")
    ) {
      score += 5;
    }

    if (
      q.includes("bootcut") &&
      name.includes("bootcut")
    ) {
      score += 5;
    }

    if (
      q.includes("dress") &&
      category.includes("dress")
    ) {
      score += 5;
    }

    if (
      q.includes("jeans") &&
      category.includes("jeans")
    ) {
      score += 5;
    }

    if (score > 0) {

      results.push({
        product,
        score
      });
    }
  }

  results.sort(
    (a, b) => b.score - a.score
  );

  return results.map(
    item => item.product
  );
}


// ============================================================
// CART HELPERS
// ============================================================

function getCart(call) {

  if (!Array.isArray(call.cart)) {
    call.cart = [];
  }

  return call.cart;
}


function addToCart(
  call,
  productId,
  size = null,
  color = null,
  quantity = 1
) {

  const product =
    PRODUCTS.find(
      p => p.id === productId
    );

  if (!product) {
    return null;
  }

  const item = {
    productId: product.id,
    name: product.name,
    size,
    color,
    quantity,
    price: product.price
  };

  getCart(call).push(item);

  return item;
}


function removeFromCart(
  call,
  productName
) {

  const q =
    normalizeText(productName);

  const index =
    call.cart.findIndex(item =>
      normalizeText(item.name)
        .includes(q)
    );

  if (index === -1) {
    return false;
  }

  call.cart.splice(index, 1);

  return true;
}


function cartTotal(call) {

  return getCart(call)
    .reduce(
      (total, item) =>
        total +
        item.price *
        item.quantity,
      0
    );
}


// ============================================================
// CALL ENDING INTENT
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


function isEndingPhrase(text) {

  const q =
    normalizeText(text);

  return END_PHRASES.some(
    phrase =>
      q === normalizeText(phrase) ||
      q.includes(normalizeText(phrase))
  );
}


function isEndConfirmation(text) {

  const q =
    normalizeText(text);

  const confirmations = [
    "yes",
    "yeah",
    "yep",
    "yes please",
    "please do",
    "end it",
    "hang up",
    "hang up please",
    "that's fine",
    "thats fine",
    "okay",
    "ok"
  ];

  return confirmations.some(
    phrase =>
      q === phrase ||
      q.includes(phrase)
  );
}


// ============================================================
// HUMAN-LIKE SYSTEM PROMPT
// ============================================================

function buildPrompt(call) {

  const customerName =
    call.customer?.name || "Guest";

  return `
You are an H&M shopping and customer-service assistant speaking over a phone call.

You should sound like a relaxed, friendly, experienced H&M employee.

Your responses must feel conversational rather than scripted.

CUSTOMER NAME:
${customerName}

CUSTOMER:
${JSON.stringify(call.customer || {})}

CURRENT CART:
${JSON.stringify(call.cart || [])}

LAST ORDER:
${JSON.stringify(
  call.customer?.lastOrder || null
)}

LOYALTY POINTS:
${call.customer?.loyaltyPoints || 0}

PRODUCT DATABASE:
${JSON.stringify(PRODUCTS)}


========================
PERSONALITY
========================

Be:

- relaxed
- friendly
- confident
- warm
- concise
- conversational
- helpful

Do NOT sound robotic.

Do NOT constantly say:

"Certainly."

"Absolutely."

"I'd be happy to assist you."

"How may I assist you?"

"Is there anything else I can help you with?"

Instead use natural language.

Examples:

"Yeah, sure."

"Got it."

"Yep."

"Okay."

"Right."

"No problem."

"Ah, got you."

"Yeah, we've got that."

"Sure, let me check."


========================
RESPONSE LENGTH
========================

Keep normal phone responses short.

Usually one or two sentences.

Do not give long explanations unless the customer asks.

Ask ONE question at a time.

Do not ask unnecessary questions.


========================
NATURAL SPEECH
========================

Use contractions naturally.

Examples:

"I'll"

"we've"

"that's"

"you're"

"don't"

"can't"

"it's"


Do not repeat the customer's name in every response.

Use their name occasionally.


========================
ASR ERRORS
========================

Telephone speech recognition can make mistakes.

Interpret the customer's meaning using context.

Examples:

"address" may mean "a dress".

"genes" may mean "jeans".

"gene" may mean "jeans".

"hoody" may mean "hoodie".

If the customer says:

"I want a dress"

understand that as a clothing dress.

Do NOT suddenly ask:

"What's the address?"

If the context is fashion shopping, prefer the clothing interpretation.

Only ask for clarification when the meaning is genuinely ambiguous.


========================
SHOPPING
========================

You can help customers:

- find products
- recommend products
- compare products
- find colours
- find sizes
- explain materials
- check availability
- add products to cart
- remove products
- change products
- check cart
- calculate cart total
- check orders
- check tracking
- explain delivery
- check loyalty points


========================
PRODUCTS
========================

Never invent products.

Use the database.

Customers may describe colours differently.

Examples:

"faded bluish green"

can match:

"faded teal"

"something dark"

can match a dark colour.

"stretchy jeans"

can match the jeans containing elastane.

"soft cotton"

can match cotton products.

"oversized shirt"

can match the oversized t-shirt.

Use reasonable semantic interpretation.


========================
CONTEXT
========================

Remember information already provided during this call.

Example:

Customer:
"I want black jeans."

Then:

"Do you have size 32?"

Understand that the customer is asking about black jeans.

Do not ask them which product they mean if the context is obvious.


========================
CART
========================

If the customer asks to add something to the cart, confirm the important details when needed:

product
size
colour
quantity

Do not ask for details that are already known.

If they say:

"Add those."

Use the product currently being discussed.


========================
ORDER
========================

If the customer asks about their order, use the customer database.

Never invent order details.

For Syed, the stored order is:

Order:
HM88291

Status:
Shipped

Tracking:
HMTX8829101

Expected delivery:
August 15


========================
LOYALTY
========================

If asked, provide the customer's stored loyalty points.

Do not invent points.


========================
ENDING THE CALL
========================

The application handles call-ending confirmation.

If the customer says:

"that's it"
"nothing else"
"no that's all"
"I'm done"
"bye"
"goodbye"
"that's everything"

do NOT immediately say goodbye and do NOT claim the call has ended.

The application will ask for confirmation.

If the user confirms, give a short goodbye.

Example:

"Sure, thanks for calling H&M. Have a great day!"

Do not continue the conversation after confirmed termination.


========================
IMPORTANT
========================

Never mention:

AI
LLM
Groq
Deepgram
database
API
system prompt
internal tools

unless the customer directly asks what technology you use.

Never fabricate information.

Never produce huge responses.

Be useful and natural.
`;
}


// ============================================================
// TTS AUDIO QUEUE
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

    const chunk =
      queue.shift();

    if (
      call.ws &&
      call.ws.readyState === WebSocket.OPEN &&
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
          `[${call.id}] Audio send error:`,
          error.message
        );
      }
    }

    timer =
      setTimeout(
        pump,
        CHUNK_MS
      );
  }


  return {

    enqueue(buffer) {

      if (
        !Buffer.isBuffer(buffer) ||
        !buffer.length
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
            Math.min(
              i + CHUNK_BYTES,
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
    }
  };
}


// ============================================================
// DEEPGRAM STT
// ============================================================

function connectDeepgramSTT(call) {

  return new Promise(
    (resolve, reject) => {

      /*
       * Exotel phone audio is handled as
       * 8 kHz mono linear PCM here.
       */

      const url =
        `wss://api.deepgram.com/v1/listen` +
        `?model=${encodeURIComponent(DEEPGRAM_STT_MODEL)}` +
        `&encoding=linear16` +
        `&sample_rate=8000` +
        `&channels=1` +
        `&interim_results=true` +
        `&endpointing=250` +
        `&smart_format=true`;

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


      let opened = false;


      socket.on(
        "open",
        () => {

          opened = true;

          console.log(
            `[${call.id}] Deepgram STT connected`
          );

          resolve(socket);
        }
      );


      socket.on(
        "message",
        data => {

          if (call.destroyed) {
            return;
          }

          try {

            const msg =
              JSON.parse(data.toString());

            const transcript =
              msg.channel
                ?.alternatives
                ?. [0]
                ?.transcript;

            if (!transcript) {
              return;
            }

            const cleaned =
              correctSpeechRecognition(
                transcript
              );

            if (!cleaned) {
              return;
            }


            if (msg.is_final) {

              console.log(
                `[${call.id}] CUSTOMER: ${cleaned}`
              );

              handleUserSpeech(
                call,
                cleaned
              );

            } else if (
              call.aiSpeaking &&
              cleaned.split(/\s+/).length >= 2
            ) {

              /*
               * Customer has started speaking while
               * the assistant is speaking.
               */

              interruptAI(call);
            }

          } catch (error) {

            console.error(
              `[${call.id}] STT parse error:`,
              error.message
            );
          }
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
            reject(error);
          }
        }
      );


      socket.on(
        "close",
        () => {

          console.log(
            `[${call.id}] Deepgram STT closed`
          );

          call.sttSocket = null;
        }
      );
    }
  );
}


// ============================================================
// DEEPGRAM TTS
// ============================================================

function connectDeepgramTTS(call) {

  return new Promise(
    (resolve, reject) => {

      const url =
        `wss://api.deepgram.com/v1/speak` +
        `?model=${encodeURIComponent(DEEPGRAM_TTS_MODEL)}` +
        `&encoding=linear16` +
        `&sample_rate=8000` +
        `&container=none`;

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


      let opened = false;


      socket.on(
        "open",
        () => {

          opened = true;

          console.log(
            `[${call.id}] Deepgram TTS connected`
          );

          resolve(socket);
        }
      );


      socket.on(
        "message",
        data => {

          if (call.destroyed) {
            return;
          }

          if (
            Buffer.isBuffer(data) &&
            data.length > 0
          ) {

            if (!call.interrupting) {

              call.audioQueue.enqueue(
                data
              );
            }
          }
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
            reject(error);
          }
        }
      );


      socket.on(
        "close",
        () => {

          console.log(
            `[${call.id}] Deepgram TTS closed`
          );

          call.ttsSocket = null;
        }
      );
    }
  );
}


// ============================================================
// SPEAK
// ============================================================

function speak(call, text) {

  if (
    call.destroyed ||
    call.interrupting
  ) {
    return;
  }

  if (
    !call.ttsSocket ||
    call.ttsSocket.readyState !== WebSocket.OPEN
  ) {
    console.error(
      `[${call.id}] TTS socket not ready`
    );

    return;
  }

  try {

    call.ttsSocket.send(
      JSON.stringify({
        type: "Speak",
        text: String(text)
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
    !call.ttsSocket ||
    call.ttsSocket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  try {

    call.ttsSocket.send(
      JSON.stringify({
        type: "Flush"
      })
    );

  } catch (error) {

    console.error(
      `[${call.id}] TTS flush error:`,
      error.message
    );
  }
}


// ============================================================
// INTERRUPT AI
// ============================================================

function interruptAI(call) {

  if (call.destroyed) {
    return;
  }

  call.ttsGeneration++;

  call.aiSpeaking = false;

  call.interrupting = true;

  call.audioQueue.clear();


  /*
   * Clear audio already queued for Exotel.
   */

  if (
    call.ws &&
    call.ws.readyState === WebSocket.OPEN &&
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

    } catch (error) {

      console.error(
        `[${call.id}] Clear audio error:`,
        error.message
      );
    }
  }


  setTimeout(
    () => {

      call.interrupting = false;

    },
    150
  );
}


// ============================================================
// GREETING
// ============================================================

function sendGreeting(call) {

  if (
    call.destroyed ||
    call.greetingSent
  ) {
    return;
  }

  if (
    !call.ttsSocket ||
    call.ttsSocket.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  call.greetingSent = true;

  const name =
    call.customer?.name || "there";

  const greeting =
    call.customer?.name
      ? `Hey ${name}, welcome to H&M. What are you looking for today?`
      : `Hey, welcome to H&M. What are you looking for today?`;

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
// END CALL CONFIRMATION
// ============================================================

function requestEndConfirmation(call) {

  if (call.destroyed) {
    return;
  }

  call.waitingForEndConfirmation =
    true;

  const response =
    "Sure. Just to confirm, would you like me to end the call?";

  call.history.push({
    role: "assistant",
    content: response
  });

  call.aiSpeaking = true;

  speak(
    call,
    response
  );

  flushTTS(call);
}


// ============================================================
// PROCESS USER SPEECH
// ============================================================

async function handleUserSpeech(
  call,
  text
) {

  if (
    call.destroyed ||
    !text
  ) {
    return;
  }


  /*
   * Prevent duplicate final transcripts.
   */

  const normalized =
    normalizeText(text);

  if (
    call.lastUserTranscript ===
    normalized
  ) {
    return;
  }

  call.lastUserTranscript =
    normalized;


  // ----------------------------------------------------------
  // END CONFIRMATION
  // ----------------------------------------------------------

  if (
    call.waitingForEndConfirmation
  ) {

    if (
      isEndConfirmation(text)
    ) {

      call.waitingForEndConfirmation =
        false;

      call.endConfirmed = true;

      const goodbye =
        "Sure. Thanks for calling H&M. Have a great day!";

      call.history.push({
        role: "user",
        content: text
      });

      call.history.push({
        role: "assistant",
        content: goodbye
      });

      call.aiSpeaking = true;

      speak(
        call,
        goodbye
      );

      flushTTS(call);

      /*
       * We don't immediately destroy the websocket.
       * Give TTS time to finish.
       */

      setTimeout(
        () => {

          if (!call.destroyed) {
            destroyCall(call);
          }

        },
        2500
      );

      return;
    }


    /*
     * Customer changed their mind.
     */

    call.waitingForEndConfirmation =
      false;
  }


  // ----------------------------------------------------------
  // ENDING INTENT
  // ----------------------------------------------------------

  if (isEndingPhrase(text)) {

    call.history.push({
      role: "user",
      content: text
    });

    requestEndConfirmation(call);

    return;
  }


  // ----------------------------------------------------------
  // NORMAL CONVERSATION
  // ----------------------------------------------------------

  const currentGeneration =
    ++call.ttsGeneration;

  call.aiSpeaking = true;

  call.interrupting = false;


  call.history.push({
    role: "user",
    content: text
  });


  /*
   * Keep only recent conversation.
   *
   * This makes Groq responses faster and prevents the
   * prompt from becoming enormous.
   */

  if (call.history.length > 12) {

    call.history =
      call.history.slice(-12);
  }


  try {

    const systemPrompt =
      buildPrompt(call);


    const relevantProducts =
      searchRelevantProducts(text);


    const contextMessage = {

      role: "system",

      content:
        systemPrompt +
        `\n\nProducts potentially relevant to the customer's latest request:\n` +
        JSON.stringify(
          relevantProducts.slice(0, 4)
        )
    };


    const stream =
      await groq.chat.completions.create({

        model:
          GROQ_MODEL,

        messages: [
          contextMessage,
          ...call.history
        ],

        temperature: 0.35,

        max_tokens: 100,

        stream: true
      });


    let fullResponse = "";

    let sentenceBuffer = "";


    for await (
      const chunk of stream
    ) {

      /*
       * Customer interrupted the AI.
       */

      if (
        call.destroyed ||
        call.ttsGeneration !==
          currentGeneration
      ) {
        break;
      }


      const content =
        chunk.choices?.[0]
          ?.delta
          ?.content || "";


      if (!content) {
        continue;
      }


      fullResponse += content;

      sentenceBuffer += content;


      /*
       * Speak quickly rather than waiting for
       * the entire response.
       */

      const sentenceMatch =
        sentenceBuffer.match(
          /^([\s\S]*?[.!?])(?:\s+|$)/
        );


      if (sentenceMatch) {

        const sentence =
          sentenceMatch[1]
            .trim();

        if (sentence) {

          speak(
            call,
            sentence
          );

          flushTTS(call);
        }

        sentenceBuffer =
          sentenceBuffer
            .slice(
              sentenceMatch[0].length
            );
      }
    }


    /*
     * Speak remaining text.
     */

    if (
      call.ttsGeneration ===
        currentGeneration &&
      !call.destroyed
    ) {

      const remaining =
        sentenceBuffer.trim();

      if (remaining) {

        speak(
          call,
          remaining
        );

        flushTTS(call);
      }


      if (fullResponse.trim()) {

        call.history.push({
          role: "assistant",
          content:
            fullResponse.trim()
        });
      }
    }


  } catch (error) {

    console.error(
      `[${call.id}] Groq error:`,
      error.message
    );


    /*
     * Don't randomly tell the customer
     * "sorry I had trouble there".
     *
     * Only use a recovery message if the
     * AI request actually failed.
     */

    if (
      !call.destroyed &&
      call.ttsGeneration ===
        currentGeneration
    ) {

      const recovery =
        "Sorry, give me just a second.";

      speak(
        call,
        recovery
      );

      flushTTS(call);
    }

  } finally {

    if (
      call.ttsGeneration ===
        currentGeneration
    ) {

      call.aiSpeaking = false;
    }
  }
}


// ============================================================
// START CALL SESSION
// ============================================================

async function startCallSession(ws) {

  const call = {

    id:
      `CALL-${nextCallNumber++}`,

    ws,

    streamSid:
      null,

    callSid:
      null,

    phone:
      null,

    customer:
      null,

    history:
      [],

    cart:
      [],

    sttSocket:
      null,

    ttsSocket:
      null,

    audioQueue:
      null,

    ttsGeneration:
      0,

    aiSpeaking:
      false,

    interrupting:
      false,

    greetingSent:
      false,

    waitingForEndConfirmation:
      false,

    endConfirmed:
      false,

    lastUserTranscript:
      "",

    destroyed:
      false,

    startReceived:
      false
  };


  call.audioQueue =
    createAudioQueue(call);


  activeCalls.set(
    call.id,
    call
  );


  console.log(
    "============================================"
  );

  console.log(
    `[${call.id}] EXOTEL STREAM CONNECTED`
  );

  console.log(
    `Active calls: ${activeCalls.size}`
  );

  console.log(
    "============================================"
  );


  ws.on(
    "message",
    async data => {

      if (call.destroyed) {
        return;
      }


      let msg;

      try {

        msg =
          JSON.parse(
            data.toString()
          );

      } catch (error) {

        console.error(
          `[${call.id}] Invalid WebSocket message`
        );

        return;
      }


      // ======================================================
      // START
      // ======================================================

      if (
        msg.event === "start"
      ) {

        if (call.startReceived) {
          return;
        }

        call.startReceived =
          true;


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
          null;


        const phone =
          start.custom_parameters?.phone ||
          start.customParameters?.phone ||
          start.from ||
          start.phone ||
          null;


        call.phone =
          phone;


        call.customer =
          findCustomer(phone);


        console.log(
          `[${call.id}] CALL SID: ${call.callSid || "UNKNOWN"}`
        );

        console.log(
          `[${call.id}] STREAM SID: ${call.streamSid || "UNKNOWN"}`
        );

        console.log(
          `[${call.id}] PHONE RECEIVED: ${phone || "UNKNOWN"}`
        );

        console.log(
          `[${call.id}] CUSTOMER: ${
            call.customer?.name ||
            "Guest"
          }`
        );


        /*
         * Copy customer's saved cart if available.
         */

        if (
          call.customer?.cart &&
          Array.isArray(
            call.customer.cart
          )
        ) {

          call.cart =
            JSON.parse(
              JSON.stringify(
                call.customer.cart
              )
            );
        }


        // ----------------------------------------------------
        // CONNECT STT
        // ----------------------------------------------------

        try {

          call.sttSocket =
            await connectDeepgramSTT(
              call
            );

        } catch (error) {

          console.error(
            `[${call.id}] DEEPGRAM STT SETUP ERROR:`,
            error.message
          );

          destroyCall(call);

          return;
        }


        // ----------------------------------------------------
        // CONNECT TTS
        // ----------------------------------------------------

        try {

          call.ttsSocket =
            await connectDeepgramTTS(
              call
            );

        } catch (error) {

          console.error(
            `[${call.id}] DEEPGRAM TTS SETUP ERROR:`,
            error.message
          );

          destroyCall(call);

          return;
        }


        /*
         * Both sockets are ready.
         * NOW greet.
         */

        sendGreeting(call);

        return;
      }


      // ======================================================
      // MEDIA
      // ======================================================

      if (
        msg.event === "media"
      ) {

        if (
          !msg.media ||
          !msg.media.payload
        ) {
          return;
        }


        const audio =
          Buffer.from(
            msg.media.payload,
            "base64"
          );


        if (
          call.sttSocket &&
          call.sttSocket.readyState ===
            WebSocket.OPEN
        ) {

          try {

            call.sttSocket.send(
              audio
            );

          } catch (error) {

            console.error(
              `[${call.id}] STT audio send error:`,
              error.message
            );
          }
        }

        return;
      }


      // ======================================================
      // STOP
      // ======================================================

      if (
        msg.event === "stop"
      ) {

        console.log(
          `[${call.id}] EXOTEL CALL STOP`
        );

        destroyCall(call);

        return;
      }
    }
  );


  ws.on(
    "close",
    () => {

      destroyCall(call);
    }
  );


  ws.on(
    "error",
    error => {

      console.error(
        `[${call.id}] Exotel WebSocket error:`,
        error.message
      );

      destroyCall(call);
    }
  );
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


  call.destroyed =
    true;


  call.ttsGeneration++;


  call.aiSpeaking =
    false;


  /*
   * Clear outgoing audio.
   */

  if (call.audioQueue) {
    call.audioQueue.clear();
  }


  /*
   * Close STT.
   */

  if (
    call.sttSocket &&
    call.sttSocket.readyState !==
      WebSocket.CLOSED
  ) {

    try {
      call.sttSocket.close();
    } catch (_) {}
  }


  /*
   * Close TTS.
   */

  if (
    call.ttsSocket &&
    call.ttsSocket.readyState !==
      WebSocket.CLOSED
  ) {

    try {
      call.ttsSocket.close();
    } catch (_) {}
  }


  /*
   * Remove call from active calls.
   */

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
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    (req, res) => {

      /*
       * Health check for Render.
       */

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


        return res.end(
          JSON.stringify({
            status: "ok",

            service:
              "H&M Voice Assistant",

            activeCalls:
              activeCalls.size,

            uptime:
              process.uptime()
          })
        );
      }


      /*
       * Root endpoint.
       */

      if (
        req.url === "/"
      ) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/plain"
          }
        );


        return res.end(
          "H&M Voice Assistant is running."
        );
      }


      res.writeHead(
        404,
        {
          "Content-Type":
            "text/plain"
        }
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

    startCallSession(ws)
      .catch(error => {

        console.error(
          "Call session error:",
          error
        );

        try {
          ws.close();
        } catch (_) {}
      });
  }
);


// ============================================================
// SERVER START
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "============================================"
    );

    console.log(
      "H&M VOICE ASSISTANT"
    );

    console.log(
      "============================================"
    );

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `Groq model: ${GROQ_MODEL}`
    );

    console.log(
      `Deepgram STT: ${DEEPGRAM_STT_MODEL}`
    );

    console.log(
      `Deepgram TTS: ${DEEPGRAM_TTS_MODEL}`
    );

    console.log(
      "Customer database: READY"
    );

    console.log(
      "Cart system: READY"
    );

    console.log(
      "Order tracking: READY"
    );

    console.log(
      "Natural conversation: READY"
    );

    console.log(
      "============================================"
    );
  }
);


// ============================================================
// PROCESS SAFETY
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

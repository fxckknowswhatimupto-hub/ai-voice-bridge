"use strict";

const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 10000);

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";

const GROQ_MODEL =
  process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const DEEPGRAM_STT_MODEL =
  process.env.DEEPGRAM_STT_MODEL || "nova-2-phonecall";

const DEEPGRAM_TTS_MODEL =
  process.env.DEEPGRAM_TTS_MODEL || "aura-2-asteria-en";

const SAMPLE_RATE =
  Number(process.env.EXOTEL_SAMPLE_RATE || 8000);

const AUDIO_ENCODING =
  String(
    process.env.EXOTEL_AUDIO_ENCODING || "linear16"
  ).toLowerCase();

const CHANNELS = 1;

const ENDPOINTING_MS =
  Number(
    process.env.DEEPGRAM_ENDPOINTING_MS || 200
  );

const TTS_SPEED =
  Number(
    process.env.DEEPGRAM_TTS_SPEED || 1.15
  );

const AUDIO_CHUNK_MS = 20;

const AUDIO_BYTES_PER_SAMPLE =
  AUDIO_ENCODING === "mulaw" ||
  AUDIO_ENCODING === "alaw"
    ? 1
    : 2;

const AUDIO_CHUNK_BYTES =
  Math.round(
    SAMPLE_RATE *
      (AUDIO_CHUNK_MS / 1000) *
      AUDIO_BYTES_PER_SAMPLE
  );


// ============================================================
// GROQ CLIENT
// ============================================================

const groq = GROQ_API_KEY
  ? new Groq({
      apiKey: GROQ_API_KEY
    })
  : null;


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
    material:
      "98% Cotton, 2% Elastane",
    description:
      "Classic high-waist bootcut jeans with slight stretch."
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
    material:
      "Viscose Blend",
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
    material:
      "100% Organic Cotton",
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
    sizes: [
      "S",
      "M",
      "L",
      "XL",
      "XXL"
    ],
    materials: [
      "cotton",
      "fleece"
    ],
    material:
      "Cotton Fleece",
    description:
      "Warm relaxed-fit hoodie with soft fleece interior."
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
    sizes: [
      "S",
      "M",
      "L",
      "XL"
    ],
    materials: [
      "denim",
      "cotton"
    ],
    material:
      "100% Cotton Denim",
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
// ASR CORRECTION
// ============================================================

function correctTranscript(text) {
  let t = normalizeText(text);

  const corrections = [
    [
      /\baddress\b/g,
      "dress"
    ],

    [
      /\badress\b/g,
      "dress"
    ],

    [
      /\bgenes\b/g,
      "jeans"
    ],

    [
      /\bjean's\b/g,
      "jeans"
    ],

    [
      /\bt ?shirt\b/g,
      "t-shirt"
    ],

    [
      /\btee shirt\b/g,
      "t-shirt"
    ],

    [
      /\btshirt\b/g,
      "t-shirt"
    ],

    [
      /\bhodie\b/g,
      "hoodie"
    ],

    [
      /\bhoody\b/g,
      "hoodie"
    ],

    [
      /\bblueish green\b/g,
      "bluish green"
    ],

    [
      /\bbluishgreen\b/g,
      "bluish green"
    ],

    [
      /\bblue green\b/g,
      "bluish green"
    ],

    [
      /\bfaded blue green\b/g,
      "faded bluish green"
    ]
  ];

  for (const [regex, replacement] of corrections) {
    t = t.replace(regex, replacement);
  }

  return t;
}


// ============================================================
// CUSTOMER LOOKUP
// ============================================================

function findCustomer(phone) {
  if (!phone) return null;

  const normalized =
    String(phone).replace(/\D/g, "");

  for (const key of Object.keys(CUSTOMERS)) {
    const candidate =
      key.replace(/\D/g, "");

    if (
      candidate === normalized ||
      candidate.endsWith(normalized) ||
      normalized.endsWith(candidate)
    ) {
      return CUSTOMERS[key];
    }
  }

  return null;
}


// ============================================================
// END-CALL LOGIC
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

  return END_PHRASES.some(
    phrase =>
      t === phrase ||
      t.includes(phrase)
  );
}

function isYes(text) {
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
    "absolutely"
  ].includes(normalizeText(text));
}

function isNo(text) {
  return [
    "no",
    "nope",
    "not yet",
    "no thanks",
    "keep it open",
    "don't",
    "dont"
  ].includes(normalizeText(text));
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
      queue.length === 0
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
              payload:
                chunk.toString("base64")
            }
          })
        );
      } catch (error) {
        console.error(
          `[${call.id}] Audio output error:`,
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
      if (
        !Buffer.isBuffer(buffer) ||
        buffer.length === 0
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

function connectSTT(call) {
  if (!DEEPGRAM_API_KEY) {
    return Promise.reject(
      new Error(
        "DEEPGRAM_API_KEY missing"
      )
    );
  }

  const params =
    new URLSearchParams({
      model: DEEPGRAM_STT_MODEL,
      encoding: AUDIO_ENCODING,
      sample_rate:
        String(SAMPLE_RATE),
      channels:
        String(CHANNELS),
      interim_results: "true",
      endpointing:
        String(ENDPOINTING_MS),
      smart_format: "false",
      punctuate: "true",
      language: "en-US"
    });

  const url =
    `wss://api.deepgram.com/v1/listen?${params.toString()}`;

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

      socket.on(
        "open",
        () => {
          opened = true;

          console.log(
            `[${call.id}] STT READY`
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
              JSON.parse(
                data.toString()
              );

            if (
              msg.type !== "Results"
            ) {
              return;
            }

            const transcript =
              msg.channel
                ?.alternatives?.[0]
                ?.transcript
                ?.trim() || "";

            if (!transcript) {
              return;
            }

            // Interrupt AI immediately
            // when customer starts talking.
            if (
              !msg.is_final &&
              call.aiSpeaking &&
              transcript.split(/\s+/).length >= 2
            ) {
              interruptAI(call);
            }

            if (
              msg.is_final &&
              msg.speech_final
            ) {
              const corrected =
                correctTranscript(
                  transcript
                );

              console.log(
                `[${call.id}] CUSTOMER: ${transcript}`
              );

              if (
                corrected !== transcript
              ) {
                console.log(
                  `[${call.id}] CORRECTED: ${corrected}`
                );
              }

              handleUserSpeech(
                call,
                corrected
              ).catch(error => {
                console.error(
                  `[${call.id}] Speech handler:`,
                  error.message
                );
              });
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
            `[${call.id}] STT ERROR:`,
            error.message
          );

          if (!opened) {
            reject(error);
          }
        }
      );

      socket.on(
        "close",
        (code, reason) => {
          console.log(
            `[${call.id}] STT CLOSED: ${code}`
          );

          if (!opened) {
            reject(
              new Error(
                `STT closed before opening: ${code}`
              )
            );
          }
        }
      );
    }
  );
}


// ============================================================
// DEEPGRAM TTS
// ============================================================

function connectTTS(call) {
  if (!DEEPGRAM_API_KEY) {
    return Promise.reject(
      new Error(
        "DEEPGRAM_API_KEY missing"
      )
    );
  }

  const params =
    new URLSearchParams({
      model:
        DEEPGRAM_TTS_MODEL,

      encoding:
        "linear16",

      sample_rate:
        String(SAMPLE_RATE),

      speed:
        String(TTS_SPEED)
    });

  const url =
    `wss://api.deepgram.com/v1/speak?${params.toString()}`;

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

      socket.on(
        "open",
        () => {
          opened = true;

          console.log(
            `[${call.id}] TTS READY`
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
            Buffer.isBuffer(data)
          ) {
            if (
              !call.interrupting
            ) {
              call.audioQueue.enqueue(
                data
              );
            }

            return;
          }

          try {
            const msg =
              JSON.parse(
                data.toString()
              );

            if (
              msg.type === "Error"
            ) {
              console.error(
                `[${call.id}] TTS protocol error:`,
                msg
              );
            }
          } catch (_) {}
        }
      );

      socket.on(
        "error",
        error => {
          console.error(
            `[${call.id}] TTS ERROR:`,
            error.message
          );

          if (!opened) {
            reject(error);
          }
        }
      );

      socket.on(
        "close",
        (code, reason) => {
          console.log(
            `[${call.id}] TTS CLOSED: ${code}`
          );

          if (!opened) {
            reject(
              new Error(
                `TTS closed before opening: ${code}`
              )
            );
          }
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
    return false;
  }

  const clean =
    String(text || "")
      .replace(/\s+/g, " ")
      .trim();

  if (!clean) {
    return false;
  }

  if (
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
        text: clean
      })
    );

    return true;
  } catch (error) {
    console.error(
      `[${call.id}] Speak error:`,
      error.message
    );

    return false;
  }
}


function flushTTS(call) {
  if (
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  try {
    call.ttsSocket.send(
      JSON.stringify({
        type: "Flush"
      })
    );
  } catch (_) {}
}


// ============================================================
// INTERRUPT
// ============================================================

function interruptAI(call) {
  if (call.destroyed) {
    return;
  }

  call.interrupting = true;
  call.aiSpeaking = false;
  call.responseGeneration++;

  if (call.ttsTimer) {
    clearTimeout(
      call.ttsTimer
    );

    call.ttsTimer = null;
  }

  call.audioQueue.clear();

  if (
    call.exotelWs &&
    call.exotelWs.readyState ===
      WebSocket.OPEN
  ) {
    try {
      call.exotelWs.send(
        JSON.stringify({
          event: "clear",
          stream_sid:
            call.streamSid
        })
      );
    } catch (_) {}
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
    } catch (_) {}
  }

  setTimeout(
    () => {
      if (!call.destroyed) {
        call.interrupting = false;
      }
    },
    100
  );
}


// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildPrompt(call) {
  return `
You are a highly capable human-like H&M telephone shopping assistant.

Speak naturally like a real retail employee.

RULES:

Keep responses short and fast.

Usually respond with one or two natural sentences.

Never give long explanations unless the customer asks.

Ask one useful question at a time.

Never use bullet points while speaking.

Remember information from the conversation.

Understand natural descriptions.

Examples:

"faded bluish green"
"washed blue"
"dark wine"
"soft beige"
"slightly greyish blue"

ASR can make mistakes.

"address" can mean "a dress".

"genes" can mean "jeans".

Use context to understand the customer's intent.

Do not say "I had trouble there" unless there is genuinely no way to understand.

If something is unclear, ask naturally:

"Sorry, did you mean a dress?"

Do not reject a product request simply because the exact wording doesn't match the database.

PRODUCT DATABASE:

${JSON.stringify(PRODUCTS)}

CUSTOMER:

${JSON.stringify(
  call.customer || {
    name: "Guest"
  }
)}

CURRENT CART:

${JSON.stringify(
  call.cart
)}

ORDER:

${JSON.stringify(
  call.customer?.lastOrder || null
)}

You can help with:

product discovery,
recommendations,
sizes,
colours,
materials,
fit,
cart changes,
cart totals,
orders,
tracking,
delivery,
loyalty points,
and general H&M questions.

For unavailable products, offer the closest available alternative.

For unrelated harmless questions, answer briefly and naturally return to H&M.

Never invent product availability, order details, or tracking information.
`;
}


// ============================================================
// FAST GROQ RESPONSE
// ============================================================

async function generateAIResponse(
  call,
  userText
) {
  const generation =
    ++call.responseGeneration;

  call.aiSpeaking = true;

  call.history.push({
    role: "user",
    content: userText
  });

  if (!groq) {
    const fallback =
      "I can help you with H&M products, your cart, or your order. What would you like to do?";

    speak(
      call,
      fallback
    );

    flushTTS(call);

    call.history.push({
      role: "assistant",
      content: fallback
    });

    call.aiSpeaking = false;

    return;
  }

  try {
    const stream =
      await groq.chat.completions.create({
        model:
          GROQ_MODEL,

        messages: [
          {
            role: "system",
            content:
              buildPrompt(call)
          },

          ...call.history.slice(-10)
        ],

        temperature: 0.25,

        max_tokens: 90,

        stream: true
      });

    let fullText = "";
    let buffer = "";

    let firstAudioSent = false;

    for await (
      const chunk of stream
    ) {
      if (
        call.destroyed ||
        call.interrupting ||
        generation !==
          call.responseGeneration
      ) {
        break;
      }

      const token =
        chunk.choices?.[0]
          ?.delta?.content || "";

      if (!token) {
        continue;
      }

      fullText += token;
      buffer += token;

      const trimmed =
        buffer.trim();

      const punctuation =
        /[.!?]\s*$/.test(
          trimmed
        );

      // Start speaking sooner.
      const shortChunk =
        !firstAudioSent &&
        trimmed.length >= 28;

      if (
        punctuation ||
        shortChunk
      ) {
        speak(
          call,
          trimmed
        );

        buffer = "";

        firstAudioSent = true;
      }
    }

    if (
      !call.destroyed &&
      !call.interrupting &&
      generation ===
        call.responseGeneration
    ) {
      if (buffer.trim()) {
        speak(
          call,
          buffer.trim()
        );
      }

      flushTTS(call);

      if (fullText.trim()) {
        call.history.push({
          role: "assistant",
          content:
            fullText.trim()
        });
      }

      setTimeout(
        () => {
          if (
            !call.destroyed &&
            generation ===
              call.responseGeneration
          ) {
            call.aiSpeaking =
              false;
          }
        },
        250
      );
    }

  } catch (error) {
    console.error(
      `[${call.id}] GROQ ERROR:`,
      error.message
    );

    if (
      !call.destroyed &&
      generation ===
        call.responseGeneration
    ) {
      const fallback =
        "Sure. Could you tell me a little more about what you're looking for?";

      speak(
        call,
        fallback
      );

      flushTTS(call);

      call.history.push({
        role: "assistant",
        content: fallback
      });

      call.aiSpeaking = false;
    }
  }
}


// ============================================================
// END CALL
// ============================================================

function requestEndConfirmation(call) {
  if (
    call.endConfirmationPending ||
    call.endConfirmed
  ) {
    return;
  }

  call.endConfirmationPending =
    true;

  const text =
    "Just to confirm, would you like me to end the call?";

  call.history.push({
    role: "assistant",
    content: text
  });

  call.aiSpeaking = true;

  speak(
    call,
    text
  );

  flushTTS(call);

  setTimeout(
    () => {
      if (!call.destroyed) {
        call.endConfirmationPending =
          false;
      }
    },
    1500
  );
}


// ============================================================
// USER SPEECH
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

  const cleaned =
    correctTranscript(text);

  if (!cleaned) {
    return;
  }

  // ------------------------------------------
  // END CONFIRMATION
  // ------------------------------------------

  if (
    call.endConfirmationPending
  ) {
    call.endConfirmationPending =
      false;

    if (isYes(cleaned)) {
      call.endConfirmed =
        true;

      const goodbye =
        "Absolutely. Thanks for calling H&M. Have a great day!";

      call.history.push({
        role: "assistant",
        content: goodbye
      });

      speak(
        call,
        goodbye
      );

      flushTTS(call);

      return;
    }

    if (isNo(cleaned)) {
      const continueText =
        "Of course. What else can I help you with?";

      call.history.push({
        role: "assistant",
        content: continueText
      });

      speak(
        call,
        continueText
      );

      flushTTS(call);

      return;
    }
  }

  // ------------------------------------------
  // END INTENT
  // ------------------------------------------

  if (isEndIntent(cleaned)) {
    requestEndConfirmation(call);
    return;
  }

  // ------------------------------------------
  // NORMAL AI
  // ------------------------------------------

  await generateAIResponse(
    call,
    cleaned
  );
}


// ============================================================
// GREETING
// ============================================================

function sendGreeting(call) {
  if (
    call.greetingSent
  ) {
    return;
  }

  if (
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  call.greetingSent =
    true;

  const name =
    call.customer?.name ||
    "there";

  const greeting =
    call.customer
      ? `Hi ${name}! Thanks for calling H&M. I can help you find products, check sizes and colours, manage your cart, or check an order. What would you like to shop for today?`
      : `Hi there! Thanks for calling H&M. I can help you find products, check sizes and colours, manage your cart, or check an order. What would you like to shop for today?`;

  call.history.push({
    role: "assistant",
    content: greeting
  });

  call.aiSpeaking =
    true;

  speak(
    call,
    greeting
  );

  flushTTS(call);
}


// ============================================================
// CALL SESSION
// ============================================================

async function startCallSession(
  exotelWs
) {
  const call = {
    id:
      `CALL-${nextCallNumber++}`,

    exotelWs,

    streamSid: null,

    callSid: null,

    customer: null,

    cart: [],

    history: [],

    destroyed: false,

    greetingSent: false,

    aiSpeaking: false,

    interrupting: false,

    responseGeneration: 0,

    endConfirmationPending:
      false,

    endConfirmed: false,

    sttSocket: null,

    ttsSocket: null,

    audioQueue: null,

    audioBuffer: [],

    audioBufferTimer: null
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
    `[${call.id}] STARTING DEEPGRAM CONNECTIONS IMMEDIATELY`
  );

  console.log(
    "============================================"
  );


  // ==========================================================
  // CRITICAL LATENCY CHANGE:
  //
  // Start STT + TTS immediately.
  //
  // DO NOT wait for Exotel's "start" event.
  // DO NOT wait for STT before TTS.
  // ==========================================================

  const sttPromise =
    connectSTT(call);

  const ttsPromise =
    connectTTS(call);


  sttPromise
    .then(socket => {

      if (call.destroyed) {
        try {
          socket.close();
        } catch (_) {}
        return;
      }

      call.sttSocket =
        socket;

      // Send any audio that arrived
      // while STT was connecting.
      flushBufferedAudio(call);
    })
    .catch(error => {

      console.error(
        `[${call.id}] STT startup failed:`,
        error.message
      );
    });


  ttsPromise
    .then(socket => {

      if (call.destroyed) {
        try {
          socket.close();
        } catch (_) {}
        return;
      }

      call.ttsSocket =
        socket;

      // GREET IMMEDIATELY
      //
      // This no longer waits for STT.
      sendGreeting(call);
    })
    .catch(error => {

      console.error(
        `[${call.id}] TTS startup failed:`,
        error.message
      );
    });


  // ==========================================================
  // EXOTEL MESSAGES
  // ==========================================================

  exotelWs.on(
    "message",
    async data => {

      if (call.destroyed) {
        return;
      }

      try {
        const msg =
          JSON.parse(
            data.toString()
          );

        // --------------------------------------------
        // START
        // --------------------------------------------

        if (
          msg.event === "start"
        ) {
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

          call.cart =
            JSON.parse(
              JSON.stringify(
                call.customer?.cart ||
                  []
              )
            );

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
              call.customer?.name ||
              "Guest"
            }`
          );

          // If TTS was already ready,
          // greeting may already have gone out.
          //
          // If not, this will send it as soon
          // as TTS becomes available.
          sendGreeting(call);

          return;
        }


        // --------------------------------------------
        // MEDIA
        // --------------------------------------------

        if (
          msg.event === "media"
        ) {
          const payload =
            msg.media?.payload;

          if (!payload) {
            return;
          }

          const audio =
            Buffer.from(
              payload,
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
                `[${call.id}] STT SEND ERROR:`,
                error.message
              );
            }
          } else {
            // Buffer a small amount of audio
            // during STT startup.
            bufferAudio(
              call,
              audio
            );
          }

          return;
        }


        // --------------------------------------------
        // STOP
        // --------------------------------------------

        if (
          msg.event === "stop"
        ) {
          console.log(
            `[${call.id}] EXOTEL CALL STOP`
          );

          destroyCall(call);

          return;
        }

      } catch (error) {
        console.error(
          `[${call.id}] EXOTEL MESSAGE ERROR:`,
          error.message
        );
      }
    }
  );


  exotelWs.on(
    "close",
    () => {
      console.log(
        `[${call.id}] EXOTEL WS CLOSED`
      );

      destroyCall(call);
    }
  );


  exotelWs.on(
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


// ============================================================
// AUDIO BUFFER
// ============================================================

function bufferAudio(
  call,
  audio
) {
  if (
    call.destroyed
  ) {
    return;
  }

  // Don't buffer indefinitely.
  //
  // Maximum approximately 1 second.
  if (
    call.audioBuffer.length >= 50
  ) {
    return;
  }

  call.audioBuffer.push(
    audio
  );
}


function flushBufferedAudio(call) {
  if (
    !call.sttSocket ||
    call.sttSocket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  if (
    call.audioBuffer.length === 0
  ) {
    return;
  }

  console.log(
    `[${call.id}] FLUSHING ${
      call.audioBuffer.length
    } BUFFERED AUDIO PACKETS`
  );

  for (
    const audio of call.audioBuffer
  ) {
    try {
      call.sttSocket.send(
        audio
      );
    } catch (_) {
      break;
    }
  }

  call.audioBuffer =
    [];
}


// ============================================================
// CLEANUP
// ============================================================

function destroyCall(call) {
  if (
    call.destroyed
  ) {
    return;
  }

  call.destroyed =
    true;

  call.audioQueue?.clear();

  call.audioBuffer =
    [];

  if (call.audioBufferTimer) {
    clearTimeout(
      call.audioBufferTimer
    );
  }

  try {
    if (
      call.sttSocket &&
      call.sttSocket.readyState ===
        WebSocket.OPEN
    ) {
      call.sttSocket.close();
    }
  } catch (_) {}

  try {
    if (
      call.ttsSocket &&
      call.ttsSocket.readyState ===
        WebSocket.OPEN
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
}


// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    (req, res) => {

      if (
        req.url === "/" ||
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
              "H&M AI Voice Assistant",

            activeCalls:
              activeCalls.size,

            uptime:
              Math.floor(
                process.uptime()
              ),

            node:
              process.version,

            groq:
              Boolean(
                GROQ_API_KEY
              ),

            deepgram:
              Boolean(
                DEEPGRAM_API_KEY
              ),

            stt:
              DEEPGRAM_STT_MODEL,

            tts:
              DEEPGRAM_TTS_MODEL,

            audio: {
              encoding:
                AUDIO_ENCODING,

              sampleRate:
                SAMPLE_RATE,

              channels:
                CHANNELS
            }
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

    startCallSession(
      ws
    ).catch(error => {

      console.error(
        "CALL SESSION ERROR:",
        error.message
      );

      try {
        ws.close();
      } catch (_) {}
    });
  }
);


// ============================================================
// GLOBAL ERROR PROTECTION
// ============================================================

process.on(
  "uncaughtException",
  error => {

    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );

    // IMPORTANT:
    // Don't kill Render for one bad call.
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

    console.log(
      "============================================"
    );

    console.log(
      "H&M AI VOICE ASSISTANT ONLINE"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `NODE: ${process.version}`
    );

    console.log(
      `GROQ: ${
        GROQ_API_KEY
          ? "READY"
          : "MISSING"
      }`
    );

    console.log(
      `DEEPGRAM: ${
        DEEPGRAM_API_KEY
          ? "READY"
          : "MISSING"
      }`
    );

    console.log(
      `STT: ${DEEPGRAM_STT_MODEL}`
    );

    console.log(
      `TTS: ${DEEPGRAM_TTS_MODEL}`
    );

    console.log(
      `AUDIO: ${
        AUDIO_ENCODING
      } / ${
        SAMPLE_RATE
      } Hz`
    );

    console.log(
      `ENDPOINTING: ${
        ENDPOINTING_MS
      } ms`
    );

    console.log(
      `TTS SPEED: ${
        TTS_SPEED
      }`
    );

    console.log(
      "============================================"
    );
  }
);

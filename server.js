"use strict";

const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = Number(process.env.PORT || 10000);

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";

const GROQ_MODEL =
  process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const STT_MODEL =
  process.env.DEEPGRAM_STT_MODEL || "nova-2-phonecall";

const TTS_MODEL =
  process.env.DEEPGRAM_TTS_MODEL || "aura-2-asteria-en";

// IMPORTANT:
// This must match the audio Exotel actually sends.
//
// Default:
// linear16 / 8000 Hz / mono
//
// If your Exotel stream is G.711 μ-law instead, set:
//
// EXOTEL_AUDIO_ENCODING=mulaw
//
const AUDIO_ENCODING =
  (process.env.EXOTEL_AUDIO_ENCODING || "linear16").toLowerCase();

const SAMPLE_RATE =
  Number(process.env.EXOTEL_SAMPLE_RATE || 8000);

const CHANNELS =
  Number(process.env.EXOTEL_CHANNELS || 1);

// Lower = faster response.
// 250 ms is a good starting point for phone calls.
const ENDPOINTING_MS =
  Number(process.env.DEEPGRAM_ENDPOINTING_MS || 250);

// 20 ms audio packets.
const AUDIO_CHUNK_MS = 20;

const AUDIO_CHUNK_BYTES =
  AUDIO_ENCODING === "mulaw" ||
  AUDIO_ENCODING === "alaw"
    ? Math.round(SAMPLE_RATE * 0.02)
    : Math.round(SAMPLE_RATE * 0.02 * 2);


// ============================================================
// GROQ
// ============================================================

const groq = GROQ_API_KEY
  ? new Groq({
      apiKey: GROQ_API_KEY
    })
  : null;


// ============================================================
// ACTIVE CALLS
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

    sizes: [
      "28",
      "30",
      "32",
      "34",
      "36"
    ],

    materials: [
      "cotton",
      "stretch cotton",
      "elastane"
    ],

    material:
      "98% Cotton, 2% Elastane",

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
// FAKE CUSTOMERS
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
    .replace(/\s+/g, " ");
}


// ============================================================
// ASR CORRECTION
// ============================================================

function correctShoppingTranscript(text) {

  let t = normalizeText(text);

  const rules = [

    // "a dress" -> "address"
    [
      /\b(address|adress)\b/g,
      "dress"
    ],

    // jeans -> genes
    [
      /\bgenes\b/g,
      "jeans"
    ],

    [
      /\bjean's\b/g,
      "jeans"
    ],

    // T-shirt variations
    [
      /\b(t shirt|tee shirt|tshirt)\b/g,
      "t-shirt"
    ],

    // hoodie variations
    [
      /\b(hodie|hoody)\b/g,
      "hoodie"
    ],

    // colour variations
    [
      /\b(blueish green|bluishgreen|blue green)\b/g,
      "bluish green"
    ],

    [
      /\b(faded blue green|faded bluishgreen)\b/g,
      "faded bluish green"
    ]
  ];

  for (const rule of rules) {

    t = t.replace(
      rule[0],
      rule[1]
    );
  }

  return t;
}


// ============================================================
// CUSTOMER LOOKUP
// ============================================================

function findCustomer(phone) {

  if (!phone) {
    return null;
  }

  const raw =
    String(phone)
      .replace(/\D/g, "");

  for (const key of Object.keys(CUSTOMERS)) {

    const normalizedKey =
      key.replace(/\D/g, "");

    if (
      normalizedKey === raw ||
      normalizedKey.endsWith(raw) ||
      raw.endsWith(normalizedKey)
    ) {

      return CUSTOMERS[key];
    }
  }

  return null;
}


// ============================================================
// END CALL PHRASES
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

  const t =
    normalizeText(text);

  return END_PHRASES.some(
    phrase =>
      t === phrase ||
      (
        t.length <= phrase.length + 12 &&
        t.includes(phrase)
      )
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

  ].includes(
    normalizeText(text)
  );
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

  ].includes(
    normalizeText(text)
  );
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

You are the H&M telephone shopping and customer-service assistant.

You are speaking to a real customer over a phone call.

SPEAKING STYLE:

- Sound like a warm, capable human retail employee.
- Be natural and conversational.
- Never sound robotic.
- Keep answers short.
- Usually use 1 to 3 short spoken sentences.
- Ask one useful follow-up question at a time.
- Do not use bullet points when speaking.
- Do not repeat the customer's entire sentence.
- Move the conversation forward naturally.

IMPORTANT:

Phone speech recognition can make mistakes.

For example:

"a dress" may be recognized as "address".

"jeans" may be recognized as "genes".

Use the conversation context.

If the customer is obviously discussing clothing, prefer the clothing interpretation.

Natural colour descriptions are valid.

Examples:

"faded bluish green"
"washed blue"
"dark wine"
"soft beige"
"slightly greyish blue"

Do not reject a customer simply because their description does not exactly match a database string.

PRODUCT DATABASE:

${JSON.stringify(PRODUCTS)}

CUSTOMER:

${JSON.stringify(customer)}

CURRENT CART:

${JSON.stringify(call.cart)}

CURRENT ORDER:

${JSON.stringify(
  customer.lastOrder || null
)}

YOU CAN HELP WITH:

- finding products
- recommendations
- sizes
- colours
- materials
- fit
- adding products to cart
- removing products from cart
- changing cart details
- cart totals
- order details
- tracking details
- loyalty points

If something is unavailable:

Do not invent it.

Offer the closest available alternative.

If something is ambiguous:

Ask a natural clarification.

If the customer asks a harmless unrelated question:

Answer briefly, then naturally return to H&M.

Do NOT repeatedly say:

"Sorry, I had trouble there."

If something is unclear, simply ask the customer to clarify.

The application handles call-ending confirmation separately.

Do not claim the call has ended yourself.

`;
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


    const chunk =
      queue.shift();


    if (
      call.exotelWs &&
      call.exotelWs.readyState ===
        WebSocket.OPEN &&
      call.streamSid
    ) {

      try {

        call.exotelWs.send(
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
        AUDIO_CHUNK_MS
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

function connectDeepgramSTT(call) {

  if (!DEEPGRAM_API_KEY) {

    return Promise.reject(
      new Error(
        "DEEPGRAM_API_KEY is missing"
      )
    );
  }


  return new Promise(
    (resolve, reject) => {

      const params =
        new URLSearchParams({

          model:
            STT_MODEL,

          encoding:
            AUDIO_ENCODING,

          sample_rate:
            String(SAMPLE_RATE),

          channels:
            String(CHANNELS),

          interim_results:
            "true",

          endpointing:
            String(ENDPOINTING_MS),

          smart_format:
            "false",

          punctuate:
            "true",

          language:
            "en-US"
        });


      const url =
        `wss://api.deepgram.com/v1/listen?${params.toString()}`;


      console.log(
        `[${call.id}] Connecting Deepgram STT (${AUDIO_ENCODING}/${SAMPLE_RATE})...`
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
              JSON.parse(
                data.toString()
              );


            if (
              msg.type !==
              "Results"
            ) {

              return;
            }


            const transcript =
              msg.channel
                ?.alternatives
                ?.[0]
                ?.transcript
                ?.trim() || "";


            if (!transcript) {

              return;
            }


            // BARGE-IN
            if (
              !msg.is_final &&
              call.aiSpeaking &&
              transcript
                .split(/\s+/)
                .length >= 2
            ) {

              console.log(
                `[${call.id}] BARGE-IN: ${transcript}`
              );

              interruptAI(call);
            }


            // FINAL SPEECH
            if (
              msg.is_final &&
              msg.speech_final
            ) {

              const corrected =
                correctShoppingTranscript(
                  transcript
                );


              console.log(
                `[${call.id}] CUSTOMER: ${transcript}`
              );


              if (
                corrected !==
                transcript
              ) {

                console.log(
                  `[${call.id}] ASR CORRECTED: ${corrected}`
                );
              }


              handleUserSpeech(
                call,
                corrected
              ).catch(
                error => {

                  console.error(
                    `[${call.id}] Speech handler error:`,
                    error.message
                  );
                }
              );
            }

          } catch (error) {

            console.error(
              `[${call.id}] STT message error:`,
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
        (code, reason) => {

          console.log(
            `[${call.id}] Deepgram STT closed code=${code} reason=${reason?.toString() || "none"}`
          );


          if (!opened) {

            reject(
              new Error(
                `Deepgram STT closed before connection (code ${code})`
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

function connectDeepgramTTS(call) {

  if (!DEEPGRAM_API_KEY) {

    return Promise.reject(
      new Error(
        "DEEPGRAM_API_KEY is missing"
      )
    );
  }


  return new Promise(
    (resolve, reject) => {

      const params =
        new URLSearchParams({

          model:
            TTS_MODEL,

          encoding:
            "linear16",

          sample_rate:
            String(SAMPLE_RATE)
        });


      const url =
        `wss://api.deepgram.com/v1/speak?${params.toString()}`;


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
              msg.type ===
              "Error"
            ) {

              console.error(
                `[${call.id}] Deepgram TTS protocol error:`,
                msg
              );
            }

          } catch (_) {

            // Ignore non-JSON control messages.
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
        (code, reason) => {

          console.log(
            `[${call.id}] Deepgram TTS closed code=${code} reason=${reason?.toString() || "none"}`
          );


          if (!opened) {

            reject(
              new Error(
                `Deepgram TTS closed before connection (code ${code})`
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

    return;
  }


  const clean =
    String(text || "")
      .replace(/\s+/g, " ")
      .trim();


  if (!clean) {

    return;
  }


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

  } catch (_) {

    // Ignore.
  }
}


// ============================================================
// INTERRUPT AI
// ============================================================

function interruptAI(call) {

  if (call.destroyed) {

    return;
  }


  call.interrupting = true;

  call.aiSpeaking = false;

  call.responseGeneration++;


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

    } catch (_) {

      // Ignore.
    }
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

    } catch (_) {

      // Ignore.
    }
  }


  setTimeout(
    () => {

      if (!call.destroyed) {

        call.interrupting = false;
      }

    },
    80
  );
}


// ============================================================
// GROQ RESPONSE
// ============================================================

async function generateResponse(
  call,
  userText
) {

  // If Groq isn't configured, don't kill the server.
  if (!groq) {

    const fallback =
      "I can help with H&M products, your cart, or your order. What would you like to do?";


    speak(
      call,
      fallback
    );

    flushTTS(call);


    call.history.push({

      role: "assistant",

      content: fallback
    });


    return fallback;
  }


  const generation =
    ++call.responseGeneration;


  call.aiSpeaking = true;


  call.history.push({

    role: "user",

    content: userText
  });


  try {

    const stream =
      await groq.chat.completions.create({

        model:
          GROQ_MODEL,

        messages: [

          {
            role: "system",

            content:
              buildSystemPrompt(call)
          },

          ...call.history.slice(-12)

        ],

        temperature:
          0.35,

        max_tokens:
          100,

        stream:
          true
      });


    let fullResponse = "";

    let sentenceBuffer = "";


    for await (
      const chunk of stream
    ) {

      if (
        call.destroyed ||
        generation !==
          call.responseGeneration ||
        call.interrupting
      ) {

        break;
      }


      const token =
        chunk
          .choices
          ?.[0]
          ?.delta
          ?.content || "";


      if (!token) {

        continue;
      }


      fullResponse += token;

      sentenceBuffer += token;


      const trimmed =
        sentenceBuffer.trim();


      const sentenceEnd =
        /[.!?]\s*$/.test(
          trimmed
        );


      const naturalChunk =
        trimmed.length >= 45 &&
        /[,;:]\s*$/.test(
          trimmed
        );


      // Start TTS before the whole
      // LLM response is complete.
      if (
        sentenceEnd ||
        naturalChunk
      ) {

        speak(
          call,
          trimmed
        );


        sentenceBuffer = "";
      }
    }


    if (
      !call.destroyed &&
      generation ===
        call.responseGeneration &&
      !call.interrupting
    ) {

      if (
        sentenceBuffer.trim()
      ) {

        speak(
          call,
          sentenceBuffer.trim()
        );
      }


      flushTTS(call);


      if (
        fullResponse.trim()
      ) {

        call.history.push({

          role: "assistant",

          content:
            fullResponse.trim()
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
        350
      );
    }


    return fullResponse;

  } catch (error) {

    console.error(
      `[${call.id}] Groq error:`,
      error.message
    );


    if (
      !call.destroyed &&
      generation ===
        call.responseGeneration
    ) {

      const recovery =
        "Could you say that one more time?";


      speak(
        call,
        recovery
      );

      flushTTS(call);


      call.history.push({

        role: "assistant",

        content: recovery
      });


      call.aiSpeaking =
        false;
    }


    return null;
  }
}


// ============================================================
// END CALL CONFIRMATION
// ============================================================

async function handleEndIntent(call) {

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


  call.aiSpeaking =
    true;


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
    correctShoppingTranscript(
      text
    );


  if (!cleaned) {

    return;
  }


  // ----------------------------------------
  // END CONFIRMATION
  // ----------------------------------------

  if (
    call.endConfirmationPending
  ) {

    call.endConfirmationPending =
      false;


    if (
      isYes(cleaned)
    ) {

      call.endConfirmed =
        true;


      const goodbye =
        "Absolutely. Thanks for calling H&M. Have a great day?";


      call.history.push({

        role: "assistant",

        content: goodbye
      });


      speak(
        call,
        "Absolutely. Thanks for calling H&M. Have a great day!"
      );


      flushTTS(call);


      return;
    }


    if (
      isNo(cleaned)
    ) {

      const keepGoing =
        "Of course. What else can I help you with?";


      call.history.push({

        role: "assistant",

        content: keepGoing
      });


      speak(
        call,
        keepGoing
      );


      flushTTS(call);


      return;
    }
  }


  // ----------------------------------------
  // END INTENT
  // ----------------------------------------

  if (
    isEndIntent(cleaned)
  ) {

    await handleEndIntent(
      call
    );

    return;
  }


  // ----------------------------------------
  // NORMAL CONVERSATION
  // ----------------------------------------

  await generateResponse(
    call,
    cleaned
  );
}


// ============================================================
// GREETING
// ============================================================

function sendGreeting(call) {

  const name =
    call.customer?.name ||
    "there";


  const greeting =
    `Hi ${name}! Thanks for calling H&M. I can help you find products, check sizes and colours, manage your cart, or check an existing order. What would you like to shop for today?`;


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
// EXOTEL CALL SESSION
// ============================================================

async function startCallSession(
  exotelWs
) {

  const call = {

    id:
      `CALL-${nextCallNumber++}`,

    exotelWs,

    streamSid:
      null,

    callSid:
      null,

    destroyed:
      false,

    customer:
      null,

    history:
      [],

    cart:
      [],

    aiSpeaking:
      false,

    interrupting:
      false,

    responseGeneration:
      0,

    endConfirmationPending:
      false,

    endConfirmed:
      false,

    sttSocket:
      null,

    ttsSocket:
      null,

    audioQueue:
      null
  };


  call.audioQueue =
    createAudioQueue(
      call
    );


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
    "============================================"
  );


  exotelWs.on(
    "message",
    async data => {

      if (
        call.destroyed
      ) {

        return;
      }


      try {

        const msg =
          JSON.parse(
            data.toString()
          );


        // ========================================
        // START
        // ========================================

        if (
          msg.event ===
          "start"
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
            findCustomer(
              phone
            );


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
            `[${call.id}] CUSTOMER: ${call.customer?.name || "Guest"}`
          );


          if (!GROQ_API_KEY) {

            console.warn(
              `[${call.id}] WARNING: GROQ_API_KEY is missing.`
            );
          }


          if (!DEEPGRAM_API_KEY) {

            console.error(
              `[${call.id}] DEEPGRAM_API_KEY is missing.`
            );


            destroyCall(
              call
            );


            return;
          }


          try {

            // Connect both services
            // at the same time.

            const [
              stt,
              tts
            ] =
              await Promise.all([

                connectDeepgramSTT(
                  call
                ),

                connectDeepgramTTS(
                  call
                )

              ]);


            if (
              call.destroyed
            ) {

              return;
            }


            call.sttSocket =
              stt;


            call.ttsSocket =
              tts;


            console.log(
              `[${call.id}] Deepgram STT/TTS READY`
            );


            sendGreeting(
              call
            );

          } catch (
            error
          ) {

            console.error(
              `[${call.id}] DEEPGRAM SETUP ERROR:`,
              error.message
            );


            destroyCall(
              call
            );
          }


          return;
        }


        // ========================================
        // MEDIA
        // ========================================

        if (
          msg.event ===
          "media"
        ) {

          const payload =
            msg.media?.payload;


          if (!payload) {

            return;
          }


          if (
            call.sttSocket &&
            call.sttSocket.readyState ===
              WebSocket.OPEN
          ) {

            try {

              call.sttSocket.send(

                Buffer.from(
                  payload,
                  "base64"
                )
              );

            } catch (
              error
            ) {

              console.error(
                `[${call.id}] STT audio send error:`,
                error.message
              );
            }
          }


          return;
        }


        // ========================================
        // STOP
        // ========================================

        if (
          msg.event ===
          "stop"
        ) {

          console.log(
            `[${call.id}] EXOTEL CALL STOP`
          );


          destroyCall(
            call
          );
        }

      } catch (
        error
      ) {

        console.error(
          `[${call.id}] Exotel message error:`,
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


      destroyCall(
        call
      );
    }
  );


  exotelWs.on(
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

      // ----------------------------------------
      // HEALTH CHECK
      // ----------------------------------------

      if (
        req.url === "/" ||
        req.url === "/health"
      ) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json; charset=utf-8"
          }
        );


        res.end(

          JSON.stringify({

            status:
              "ok",

            service:
              "H&M AI Voice Assistant",

            activeCalls:
              activeCalls.size,

            uptime:
              Math.round(
                process.uptime()
              ),

            node:
              process.version,

            groqConfigured:
              Boolean(
                GROQ_API_KEY
              ),

            deepgramConfigured:
              Boolean(
                DEEPGRAM_API_KEY
              ),

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


      // ----------------------------------------
      // 404
      // ----------------------------------------

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

    startCallSession(
      ws
    ).catch(
      error => {

        console.error(
          "Session startup error:",
          error
        );


        try {

          ws.close();

        } catch (_) {}
      }
    );
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
      "H&M AI VOICE ASSISTANT STARTED"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `NODE: ${process.version}`
    );

    console.log(
      `GROQ MODEL: ${GROQ_MODEL}`
    );

    console.log(
      `DEEPGRAM STT: ${STT_MODEL}`
    );

    console.log(
      `DEEPGRAM TTS: ${TTS_MODEL}`
    );

    console.log(
      `AUDIO: ${AUDIO_ENCODING}/${SAMPLE_RATE}/${CHANNELS}`
    );

    console.log(
      `GROQ KEY: ${
        GROQ_API_KEY
          ? "FOUND"
          : "MISSING"
      }`
    );

    console.log(
      `DEEPGRAM KEY: ${
        DEEPGRAM_API_KEY
          ? "FOUND"
          : "MISSING"
      }`
    );

    console.log(
      "============================================"
    );
  }
);

const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 10000;

const PUBLIC_URL =
  "https://ai-voice-bridge-q8qv.onrender.com";

const WS_URL =
  PUBLIC_URL.replace("https://", "wss://");

const GROQ_MODEL =
  "llama-3.1-8b-instant";

const DEEPGRAM_STT_MODEL =
  "nova-3";

const DEEPGRAM_TTS_MODEL =
  "aura-2-thalia-en";

const TAVILY_TIMEOUT_MS =
  1200;

const GROQ_TIMEOUT_MS =
  10000;

// ============================================================
// PHONE AUDIO
// ============================================================

const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;

const AUDIO_CHUNK_SIZE =
  160 * BYTES_PER_SAMPLE;

const AUDIO_INTERVAL_MS = 20;

// ============================================================
// ENVIRONMENT
// ============================================================

const GROQ_API_KEY =
  process.env.GROQ_API_KEY;

const DEEPGRAM_API_KEY =
  process.env.DEEPGRAM_API_KEY;

const TAVILY_API_KEY =
  process.env.TAVILY_API_KEY;

if (!GROQ_API_KEY) {
  throw new Error(
    "GROQ_API_KEY is missing"
  );
}

if (!DEEPGRAM_API_KEY) {
  throw new Error(
    "DEEPGRAM_API_KEY is missing"
  );
}

if (!TAVILY_API_KEY) {
  console.log(
    "WARNING: TAVILY_API_KEY is missing"
  );
}

// ============================================================
// GROQ
// ============================================================

const groq =
  new Groq({
    apiKey: GROQ_API_KEY
  });

// ============================================================
// CALL MANAGEMENT
// ============================================================

const activeCalls = new Map();

let nextCallNumber = 1;

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    (req, res) => {

      if (req.url === "/health") {

        res.writeHead(200, {
          "Content-Type":
            "application/json"
        });

        res.end(
          JSON.stringify({
            status: "ok",
            service:
              "hm-ai-voice-assistant",
            model:
              GROQ_MODEL,
            activeCalls:
              activeCalls.size
          })
        );

        return;
      }

      res.writeHead(200, {
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok",
          service:
            "hm-ai-voice-assistant",
          websocket:
            WS_URL,
          activeCalls:
            activeCalls.size
        })
      );
    }
  );

// ============================================================
// WEBSOCKET
// ============================================================

const wss =
  new WebSocket.Server({
    server
  });

// ============================================================
// H&M OPENING
// ============================================================

const HM_GREETING =
  "Hi, welcome to H&M. I can help you find products, choose styles and colours, check sizes, and help you with your shopping. What would you like to purchase today?";

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

// ============================================================
// INTERRUPTION PHRASES
// ============================================================

const INTERRUPT_PHRASES = [
  "stop",
  "wait",
  "hold on",
  "hang on",
  "no wait",
  "that's enough",
  "thats enough",
  "enough",
  "pause",
  "be quiet"
];

// ============================================================
// PRODUCT / SHOPPING DETECTION
// ============================================================

function isShoppingQuestion(
  question
) {

  const q =
    question
      .toLowerCase()
      .trim();

  const shoppingWords = [
    "buy",
    "purchase",
    "product",
    "products",
    "jeans",
    "shirt",
    "shirts",
    "tshirt",
    "t-shirt",
    "dress",
    "dresses",
    "hoodie",
    "hoodies",
    "jacket",
    "jackets",
    "coat",
    "trousers",
    "pants",
    "shorts",
    "skirt",
    "skirts",
    "sweater",
    "sweatshirt",
    "top",
    "tops",
    "shoes",
    "shoe",
    "boots",
    "boot",
    "sneakers",
    "sandals",
    "size",
    "sizes",
    "colour",
    "color",
    "fit",
    "style",
    "wear",
    "clothing",
    "clothes",
    "available",
    "availability",
    "stock",
    "in stock",
    "looking for",
    "looking something",
    "find me",
    "show me",
    "recommend",
    "recommendation",
    "shopping"
  ];

  return shoppingWords.some(
    word =>
      q.includes(word)
  );
}

// ============================================================
// NON-SHOPPING FEATURE DETECTION
// ============================================================

function isUnavailableFeature(
  question
) {

  const q =
    question
      .toLowerCase()
      .trim();

  const unavailable = [
    "return",
    "returns",
    "refund",
    "exchange",
    "delivery",
    "shipping",
    "order status",
    "track my order",
    "store location",
    "stores",
    "opening hours",
    "opening time",
    "payment",
    "pay",
    "membership",
    "account",
    "gift card",
    "customer service",
    "complaint",
    "cancel order",
    "cancel my order"
  ];

  return unavailable.some(
    word =>
      q.includes(word)
  );
}

// ============================================================
// LIVE SEARCH DETECTION
// ============================================================

function needsWebSearch(
  question
) {

  const q =
    question
      .toLowerCase()
      .trim();

  const words = [
    "available",
    "availability",
    "in stock",
    "stock",
    "price",
    "prices",
    "cost",
    "how much",
    "product",
    "products",
    "jeans",
    "shirt",
    "dress",
    "hoodie",
    "jacket",
    "coat",
    "trousers",
    "pants",
    "shoes",
    "boots",
    "sneakers",
    "size",
    "sizes",
    "colour",
    "color",
    "buy",
    "purchase",
    "find me",
    "recommend"
  ];

  return words.some(
    word =>
      q.includes(word)
  );
}

// ============================================================
// TAVILY
// ============================================================

async function searchWeb(
  question
) {

  if (!TAVILY_API_KEY) {
    return "";
  }

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => {
        controller.abort();
      },
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
              "Bearer " +
              TAVILY_API_KEY,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              query:
                "H&M " +
                question,

              search_depth:
                "basic",

              topic:
                "general",

              max_results:
                2,

              include_answer:
                true,

              include_raw_content:
                false
            }),

          signal:
            controller.signal
        }
      );

    if (!response.ok) {

      console.log(
        "Tavily HTTP:",
        response.status
      );

      return "";
    }

    const data =
      await response.json();

    let information =
      "";

    if (
      data &&
      data.answer
    ) {

      information +=
        String(
          data.answer
        ) + " ";
    }

    if (
      Array.isArray(
        data.results
      )
    ) {

      for (
        const result of
          data.results
      ) {

        information +=
          (
            result.title ||
            ""
          ) +
          ": " +
          (
            result.content ||
            ""
          ) +
          " ";
      }
    }

    return information
      .replace(/\s+/g, " ")
      .trim();

  } catch (error) {

    if (
      error.name ===
      "AbortError"
    ) {

      console.log(
        "Tavily timeout"
      );

    } else {

      console.log(
        "Tavily error:",
        error.message
      );
    }

    return "";

  } finally {

    clearTimeout(
      timer
    );
  }
}

// ============================================================
// DEEPGRAM STT
// ============================================================

function createDeepgramSTT() {

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
        "&punctuate=true" +
        "&endpointing=180" +
        "&smart_format=true";

      const socket =
        new WebSocket(
          url,
          {
            headers: {
              Authorization:
                "Token " +
                DEEPGRAM_API_KEY
            }
          }
        );

      let finished =
        false;

      const timeout =
        setTimeout(
          () => {

            if (!finished) {

              try {
                socket.close();
              } catch (_) {}

              reject(
                new Error(
                  "STT connection timeout"
                )
              );
            }

          },
          7000
        );

      socket.once(
        "open",
        () => {

          finished =
            true;

          clearTimeout(
            timeout
          );

          resolve(
            socket
          );
        }
      );

      socket.once(
        "error",
        error => {

          if (!finished) {

            finished =
              true;

            clearTimeout(
              timeout
            );

            reject(
              error
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

function createDeepgramTTS() {

  return new Promise(
    (resolve, reject) => {

      const url =
        "wss://api.deepgram.com/v1/speak" +
        "?model=" +
        encodeURIComponent(
          DEEPGRAM_TTS_MODEL
        ) +
        "&encoding=linear16" +
        "&sample_rate=8000" +
        "&container=none";

      const socket =
        new WebSocket(
          url,
          {
            headers: {
              Authorization:
                "Token " +
                DEEPGRAM_API_KEY
            }
          }
        );

      let finished =
        false;

      const timeout =
        setTimeout(
          () => {

            if (!finished) {

              try {
                socket.close();
              } catch (_) {}

              reject(
                new Error(
                  "TTS connection timeout"
                )
              );
            }

          },
          7000
        );

      socket.once(
        "open",
        () => {

          finished =
            true;

          clearTimeout(
            timeout
          );

          resolve(
            socket
          );
        }
      );

      socket.once(
        "error",
        error => {

          if (!finished) {

            finished =
              true;

            clearTimeout(
              timeout
            );

            reject(
              error
            );
          }
        }
      );
    }
  );
}

// ============================================================
// AUDIO QUEUE
// ============================================================

function createAudioQueue(
  call
) {

  const queue = [];

  let timer =
    null;

  let sequence =
    1;

  let chunk =
    0;

  let timestamp =
    0;

  let stopped =
    false;

  function clear() {

    queue.length =
      0;

    if (timer) {

      clearTimeout(
        timer
      );

      timer =
        null;
    }
  }

  function stop() {

    stopped =
      true;

    clear();
  }

  function sendNext() {

    timer =
      null;

    if (
      stopped ||
      call.destroyed
    ) {

      return;
    }

    if (
      !call.ws ||
      call.ws.readyState !==
        WebSocket.OPEN
    ) {

      clear();

      return;
    }

    if (
      !call.streamSid
    ) {

      return;
    }

    if (
      queue.length ===
      0
    ) {

      return;
    }

    const audio =
      queue.shift();

    const part =
      audio.subarray(
        0,
        AUDIO_CHUNK_SIZE
      );

    if (
      audio.length >
      AUDIO_CHUNK_SIZE
    ) {

      queue.unshift(
        audio.subarray(
          AUDIO_CHUNK_SIZE
        )
      );
    }

    try {

      call.ws.send(
        JSON.stringify({

          event:
            "media",

          sequence_number:
            String(
              sequence
            ),

          stream_sid:
            call.streamSid,

          media: {

            chunk:
              String(
                chunk
              ),

            timestamp:
              String(
                timestamp
              ),

            payload:
              part.toString(
                "base64"
              )
          }
        })
      );

      sequence++;
      chunk++;

      timestamp +=
        AUDIO_INTERVAL_MS;

    } catch (error) {

      console.log(
        `[${call.id}] audio error:`,
        error.message
      );

      return;
    }

    if (
      queue.length > 0
    ) {

      timer =
        setTimeout(
          sendNext,
          AUDIO_INTERVAL_MS
        );
    }
  }

  function enqueue(
    buffer
  ) {

    if (
      stopped ||
      call.destroyed ||
      !buffer ||
      buffer.length ===
        0
    ) {

      return;
    }

    for (
      let offset = 0;
      offset < buffer.length;
      offset +=
        AUDIO_CHUNK_SIZE
    ) {

      queue.push(
        buffer.subarray(
          offset,
          Math.min(
            offset +
              AUDIO_CHUNK_SIZE,
            buffer.length
          )
        )
      );
    }

    if (!timer) {
      sendNext();
    }
  }

  function hasPending() {

    return (
      queue.length > 0 ||
      timer !== null
    );
  }

  return {
    enqueue,
    clear,
    stop,
    hasPending
  };
}

// ============================================================
// EXOTEL CLEAR
// ============================================================

function clearExotelAudio(
  call
) {

  if (
    !call.ws ||
    call.ws.readyState !==
      WebSocket.OPEN
  ) {

    return;
  }

  try {

    call.ws.send(
      JSON.stringify({

        event:
          "clear",

        stream_sid:
          call.streamSid
      })
    );

  } catch (error) {

    console.log(
      `[${call.id}] clear error:`,
      error.message
    );
  }
}

// ============================================================
// SEND TTS
// ============================================================

function sendTTS(
  call,
  text,
  generation
) {

  if (
    call.destroyed ||
    call.interrupting ||
    generation !==
      call.ttsGeneration
  ) {

    return false;
  }

  if (
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {

    console.log(
      `[${call.id}] TTS NOT READY`
    );

    return false;
  }

  try {

    call.ttsSocket.send(
      JSON.stringify({

        type:
          "Speak",

        text:
          text
      })
    );

    return true;

  } catch (error) {

    console.log(
      `[${call.id}] TTS SEND ERROR:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// FLUSH TTS
// ============================================================

function flushTTS(
  call
) {

  if (
    call.destroyed ||
    !call.ttsSocket ||
    call.ttsSocket.readyState !==
      WebSocket.OPEN
  ) {

    return;
  }

  try {

    call.ttsSocket.send(
      JSON.stringify({
        type:
          "Flush"
      })
    );

  } catch (error) {

    console.log(
      `[${call.id}] TTS FLUSH ERROR:`,
      error.message
    );
  }
}

// ============================================================
// INTERRUPTION
// ============================================================

function interruptAI(
  call,
  reason
) {

  if (
    call.destroyed ||
    !call.aiSpeaking
  ) {

    return;
  }

  console.log(
    `[${call.id}] 🔴 BARGE-IN:`,
    reason
  );

  // Make all old response tokens invalid.
  call.ttsGeneration++;

  call.aiSpeaking =
    false;

  call.interrupting =
    true;

  // Kill audio waiting locally.
  if (
    call.audioQueue
  ) {

    call.audioQueue.clear();
  }

  // Tell Exotel to stop queued audio.
  clearExotelAudio(
    call
  );

  // Stop current Deepgram TTS generation.
  if (
    call.ttsSocket &&
    call.ttsSocket.readyState ===
      WebSocket.OPEN
  ) {

    try {

      call.ttsSocket.send(
        JSON.stringify({
          type:
            "Flush"
        })
      );

    } catch (_) {}
  }

  // Don't leave this state stuck.
  setTimeout(
    () => {

      if (
        !call.destroyed
      ) {

        call.interrupting =
          false;
      }

    },
    30
  );
}

// ============================================================
// END PHRASE DETECTION
// ============================================================

function isEndPhrase(
  text
) {

  const q =
    text
      .toLowerCase()
      .replace(
        /[.!?,]/g,
        ""
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  return END_PHRASES.includes(
    q
  );
}

// ============================================================
// EXPLICIT INTERRUPTION
// ============================================================

function isExplicitInterrupt(
  text
) {

  const q =
    text
      .toLowerCase()
      .replace(
        /[.!?,]/g,
        ""
      )
      .trim();

  return INTERRUPT_PHRASES.some(
    phrase =>
      q === phrase ||
      q.startsWith(
        phrase + " "
      )
  );
}

// ============================================================
// GREETING
// ============================================================

async function playGreeting(
  call
) {

  // Wait for TTS to be ready.
  const started =
    Date.now();

  while (
    !call.destroyed &&
    (
      !call.ttsSocket ||
      call.ttsSocket.readyState !==
        WebSocket.OPEN
    )
  ) {

    if (
      Date.now() -
        started >
      5000
    ) {

      console.log(
        `[${call.id}] greeting TTS timeout`
      );

      return;
    }

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          50
        )
    );
  }

  if (
    call.destroyed
  ) {

    return;
  }

  console.log(
    `[${call.id}] 🔊 GREETING`
  );

  call.aiSpeaking =
    true;

  const generation =
    ++call.ttsGeneration;

  const ok =
    sendTTS(
      call,
      HM_GREETING,
      generation
    );

  if (!ok) {

    call.aiSpeaking =
      false;

    return;
  }

  flushTTS(
    call
  );
}

// ============================================================
// STREAM GROQ
// ============================================================

async function streamGroq(
  call,
  question,
  webInformation,
  generation
) {

  const messages = [

    {
      role:
        "system",

      content:
        `
You are the H&M phone shopping assistant.

You are speaking to a customer on a real phone call.

Your job is ONLY to actively help with:
- H&M products
- clothing
- shopping
- product recommendations
- styles
- fits
- colours
- sizes
- product availability when information is available
- helping the customer decide what to purchase

The customer can describe colours naturally.
Examples:
- faded bluish-green
- dark washed blue
- light beige
- dusty pink
- olive green
- black
- off-white
- charcoal grey

Do NOT reject a colour just because it is not an exact catalogue colour name.

Interpret natural language intelligently.

If the customer says:
"I want bootcut jeans"
understand that they want bootcut jeans.

If they then say:
"faded bluish-green"
understand that this is the desired colour for those jeans.

Remember previous product preferences during the entire call.

For example:
Customer: "I want bootcut jeans."
Customer: "faded bluish-green."
You should understand that the colour applies to the jeans.

If the customer gives a size, remember it.

If the customer gives a fit, remember it.

If the customer changes one preference, update the previous preference rather than forgetting everything.

Keep responses conversational and fast.

Do not unnecessarily repeat questions the customer already answered.

Ask only for information that is actually missing.

For shopping:
- identify the product
- understand style
- understand colour
- understand size
- understand fit
- use available current information when supplied
- help the customer choose

If current web information is supplied, use it naturally.

Never mention Tavily.
Never mention APIs.
Never mention Deepgram.
Never mention Groq.
Never mention internal tools.

IMPORTANT:
Only H&M shopping/product functionality is active right now.

If the customer asks about:
returns,
refunds,
delivery,
shipping,
store locations,
opening hours,
payments,
membership,
accounts,
complaints,
order tracking,
or another unavailable service,

say naturally:

"Sorry, that option isn't available right now, but I can help you with H&M products, shopping, styles, colours, fits and sizes."

Do NOT provide made-up company policies.

For unrelated questions, politely redirect to H&M shopping.

For simple questions, answer in 1-2 short sentences.

For product questions, be useful but concise.

Do not sound like a script.

Do not repeatedly say "I'm sorry".

Never say:
"I can only help with H&M products"
when the customer's statement is simply a product description.

If the customer says "faded bluish-green", treat it as a colour preference.

`
    }
  ];

  // ==========================================================
  // MEMORY
  // ==========================================================

  for (
    const item of
      call.conversationHistory
  ) {

    messages.push({
      role:
        item.role,

      content:
        item.content
    });
  }

  // ==========================================================
  // WEB DATA
  // ==========================================================

  if (
    webInformation
  ) {

    messages.push({

      role:
        "system",

      content:
        `
CURRENT H&M INFORMATION:

${webInformation}

Use this information when relevant.
Do not mention where it came from.
Do not invent information that is not present.
`
    });
  }

  // ==========================================================
  // USER
  // ==========================================================

  messages.push({

    role:
      "user",

    content:
      question
  });

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      GROQ_TIMEOUT_MS
    );

  try {

    const stream =
      await groq.chat.completions.create(
        {

          model:
            GROQ_MODEL,

          messages:
            messages,

          temperature:
            0.25,

          max_tokens:
            150,

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

    let answer =
      "";

    let pending =
      "";

    for await (
      const part of
        stream
    ) {

      // ========================================================
      // BARGE-IN CHECK
      // ========================================================

      if (
        call.destroyed ||
        generation !==
          call.ttsGeneration
      ) {

        console.log(
          `[${call.id}] OLD RESPONSE STOPPED`
        );

        break;
      }

      const token =
        part
          ?.choices?.[0]
          ?.delta
          ?.content || "";

      if (!token) {
        continue;
      }

      answer +=
        token;

      pending +=
        token;

      // ========================================================
      // SENTENCE
      // ========================================================

      let match;

      while (
        (
          match =
            pending.match(
              /^([\s\S]*?[.!?])(?:\s+|$)/
            )
        )
      ) {

        if (
          call.destroyed ||
          generation !==
            call.ttsGeneration
        ) {

          break;
        }

        const sentence =
          match[1]
            .replace(
              /\s+/g,
              " "
            )
            .trim();

        pending =
          pending
            .slice(
              match[0].length
            )
            .trimStart();

        if (
          sentence
        ) {

          const sent =
            sendTTS(
              call,
              sentence,
              generation
            );

          if (sent) {

            call.aiSpeaking =
              true;
          }
        }
      }

      // ========================================================
      // EARLY CHUNK
      // ========================================================

      if (
        pending.length >=
        42
      ) {

        const lastSpace =
          pending.lastIndexOf(
            " "
          );

        if (
          lastSpace >=
          20
        ) {

          const piece =
            pending
              .slice(
                0,
                lastSpace
              )
              .trim();

          pending =
            pending
              .slice(
                lastSpace + 1
              )
              .trimStart();

          if (
            piece &&
            generation ===
              call.ttsGeneration
          ) {

            const sent =
              sendTTS(
                call,
                piece,
                generation
              );

            if (sent) {

              call.aiSpeaking =
                true;
            }
          }
        }
      }
    }

    // ========================================================
    // REMAINING
    // ========================================================

    if (
      pending.trim() &&
      !call.destroyed &&
      generation ===
        call.ttsGeneration
    ) {

      const finalText =
        pending
          .replace(
            /\s+/g,
            " "
          )
          .trim();

      if (
        finalText
      ) {

        const sent =
          sendTTS(
            call,
            finalText,
            generation
          );

        if (sent) {

          call.aiSpeaking =
            true;
        }
      }
    }

    return answer
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
// PROCESS QUESTION
// ============================================================

async function processQuestion(
  call,
  question
) {

  if (
    call.destroyed
  ) {

    return;
  }

  const clean =
    question
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (!clean) {
    return;
  }

  console.log(
    `[${call.id}] USER:`,
    clean
  );

  // ==========================================================
  // END CALL
  // ==========================================================

  if (
    isEndPhrase(
      clean
    )
  ) {

    console.log(
      `[${call.id}] END PHRASE DETECTED`
    );

    // Confirm once.
    const generation =
      ++call.ttsGeneration;

    call.aiSpeaking =
      true;

    sendTTS(
      call,
      "Sure, have a great day!",
      generation
    );

    flushTTS(
      call
    );

    call.pendingHangup =
      true;

    return;
  }

  // ==========================================================
  // UNAVAILABLE FEATURES
  // ==========================================================

  if (
    isUnavailableFeature(
      clean
    )
  ) {

    const generation =
      ++call.ttsGeneration;

    call.aiSpeaking =
      true;

    sendTTS(
      call,
      "Sorry, that option isn't available right now, but I can help you with H&M products, shopping, styles, colours, fits and sizes.",
      generation
    );

    flushTTS(
      call
    );

    return;
  }

  // ==========================================================
  // NEW RESPONSE GENERATION
  // ==========================================================

  const generation =
    ++call.ttsGeneration;

  call.aiSpeaking =
    true;

  call.interrupting =
    false;

  const start =
    Date.now();

  try {

    // ========================================================
    // WEB SEARCH
    // ========================================================

    let webInformation =
      "";

    if (
      isShoppingQuestion(
        clean
      ) &&
      needsWebSearch(
        clean
      )
    ) {

      console.log(
        `[${call.id}] PRODUCT SEARCH`
      );

      webInformation =
        await searchWeb(
          clean
        );
    }

    if (
      call.destroyed ||
      generation !==
        call.ttsGeneration
    ) {

      return;
    }

    // ========================================================
    // GROQ
    // ========================================================

    const answer =
      await streamGroq(
        call,
        clean,
        webInformation,
        generation
      );

    if (
      call.destroyed ||
      generation !==
        call.ttsGeneration
    ) {

      return;
    }

    // ========================================================
    // FLUSH
    // ========================================================

    flushTTS(
      call
    );

    // ========================================================
    // MEMORY
    // ========================================================

    if (
      answer
    ) {

      call.conversationHistory.push({

        role:
          "user",

        content:
          clean
      });

      call.conversationHistory.push({

        role:
          "assistant",

        content:
          answer
      });

      // Keep latest 10 messages.
      if (
        call.conversationHistory.length >
        10
      ) {

        call.conversationHistory =
          call.conversationHistory.slice(
            -10
          );
      }
    }

    console.log(
      `[${call.id}] AI:`,
      answer
    );

    console.log(
      `[${call.id}] RESPONSE TIME:`,
      Date.now() -
        start,
      "ms"
    );

  } catch (error) {

    if (
      call.destroyed ||
      generation !==
        call.ttsGeneration
    ) {

      return;
    }

    console.log(
      `[${call.id}] PROCESS ERROR:`,
      error.message
    );

    const fallbackGeneration =
      call.ttsGeneration;

    sendTTS(
      call,
      "Sorry, I couldn't process that. Could you say it again?",
      fallbackGeneration
    );

    flushTTS(
      call
    );

  } finally {

    // Don't mark a newer response as finished.
    if (
      generation ===
      call.ttsGeneration
    ) {

      // Keep true until TTS flush is handled.
      setTimeout(
        () => {

          if (
            !call.destroyed &&
            generation ===
              call.ttsGeneration &&
            !call.pendingHangup
          ) {

            call.aiSpeaking =
              false;
          }

        },
        400
      );
    }
  }
}

// ============================================================
// QUESTION QUEUE
// ============================================================

async function runQueue(
  call
) {

  if (
    call.queueRunning ||
    call.destroyed
  ) {

    return;
  }

  call.queueRunning =
    true;

  try {

    while (
      call.questionQueue.length >
        0 &&
      !call.destroyed
    ) {

      const question =
        call.questionQueue.shift();

      await processQuestion(
        call,
        question
      );
    }

  } catch (error) {

    console.log(
      `[${call.id}] QUEUE ERROR:`,
      error.message
    );

  } finally {

    call.queueRunning =
      false;
  }
}

// ============================================================
// ENQUEUE QUESTION
// ============================================================

function enqueueQuestion(
  call,
  question
) {

  if (
    call.destroyed
  ) {

    return;
  }

  const clean =
    question
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (!clean) {
    return;
  }

  // ==========================================================
  // IF AI IS TALKING, THIS IS A BARGE-IN
  // ==========================================================

  if (
    call.aiSpeaking
  ) {

    interruptAI(
      call,
      "caller started speaking"
    );

    // New question has priority.
    call.questionQueue =
      [];
  }

  call.questionQueue.push(
    clean
  );

  runQueue(
    call
  );
}

// ============================================================
// CREATE CALL
// ============================================================

function createCall(
  ws
) {

  const id =
    "CALL-" +
    nextCallNumber++;

  const call = {

    id,

    ws,

    destroyed:
      false,

    streamSid:
      null,

    callSid:
      null,

    sttSocket:
      null,

    ttsSocket:
      null,

    sttReady:
      false,

    ttsReady:
      false,

    audioQueue:
      null,

    speechFinalParts:
      [],

    lastInterim:
      "",

    conversationHistory:
      [],

    questionQueue:
      [],

    queueRunning:
      false,

    aiSpeaking:
      false,

    interrupting:
      false,

    ttsGeneration:
      0,

    pendingHangup:
      false,

    greetingPlayed:
      false
  };

  call.audioQueue =
    createAudioQueue(
      call
    );

  return call;
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

  console.log(
    `[${call.id}] CLEANUP`
  );

  call.destroyed =
    true;

  call.aiSpeaking =
    false;

  call.ttsGeneration++;

  call.questionQueue =
    [];

  call.speechFinalParts =
    [];

  call.conversationHistory =
    [];

  if (
    call.audioQueue
  ) {

    call.audioQueue.stop();
  }

  closeSocket(
    call.sttSocket
  );

  closeSocket(
    call.ttsSocket
  );

  call.sttSocket =
    null;

  call.ttsSocket =
    null;

  activeCalls.delete(
    call.id
  );

  console.log(
    `[${call.id}] ACTIVE CALLS:`,
    activeCalls.size
  );
}

// ============================================================
// CLOSE SOCKET
// ============================================================

function closeSocket(
  socket
) {

  if (!socket) {
    return;
  }

  try {

    if (
      socket.readyState ===
      WebSocket.OPEN
    ) {

      socket.send(
        JSON.stringify({
          type:
            "Close"
        })
      );
    }

  } catch (_) {}

  try {
    socket.close();
  } catch (_) {}
}

// ============================================================
// SETUP DEEPGRAM
// ============================================================

async function setupDeepgram(
  call
) {

  try {

    const [
      stt,
      tts
    ] =
      await Promise.all([
        createDeepgramSTT(),
        createDeepgramTTS()
      ]);

    if (
      call.destroyed
    ) {

      closeSocket(
        stt
      );

      closeSocket(
        tts
      );

      return;
    }

    call.sttSocket =
      stt;

    call.ttsSocket =
      tts;

    call.sttReady =
      true;

    call.ttsReady =
      true;

    console.log(
      `[${call.id}] DEEPGRAM READY`
    );

    // ========================================================
    // STT
    // ========================================================

    stt.on(
      "message",
      raw => {

        if (
          call.destroyed
        ) {

          return;
        }

        try {

          const data =
            JSON.parse(
              raw.toString()
            );

          const transcript =
            data
              ?.channel
              ?.alternatives?.[0]
              ?.transcript || "";

          if (!transcript) {
            return;
          }

          // ====================================================
          // INTERIM
          // ====================================================

          if (
            !data.is_final
          ) {

            call.lastInterim =
              transcript;

            // ==================================================
            // BARGE-IN
            // ==================================================

            if (
              call.aiSpeaking &&
              transcript.trim().length >= 2
            ) {

              const lower =
                transcript
                  .toLowerCase()
                  .trim();

              const explicit =
                isExplicitInterrupt(
                  lower
                );

              // Any meaningful speech while AI
              // is talking should interrupt.
              if (
                explicit ||
                lower.length >= 3
              ) {

                interruptAI(
                  call,
                  explicit
                    ? "explicit stop"
                    : "natural barge-in"
                );
              }
            }

            return;
          }

          // ====================================================
          // FINAL
          // ====================================================

          call.speechFinalParts.push(
            transcript
          );

          call.lastInterim =
            "";

          if (
            data.speech_final
          ) {

            const question =
              call.speechFinalParts
                .join(" ")
                .replace(
                  /\s+/g,
                  " "
                )
                .trim();

            call.speechFinalParts =
              [];

            if (
              question
            ) {

              console.log(
                `[${call.id}] FINAL:`,
                question
              );

              enqueueQuestion(
                call,
                question
              );
            }
          }

        } catch (error) {

          console.log(
            `[${call.id}] STT PARSE ERROR:`,
            error.message
          );
        }
      }
    );

    // ========================================================
    // TTS
    // ========================================================

    tts.on(
      "message",
      (data, isBinary) => {

        if (
          call.destroyed
        ) {

          return;
        }

        try {

          // ====================================================
          // AUDIO
          // ====================================================

          if (
            isBinary ||
            Buffer.isBuffer(data)
          ) {

            const audio =
              Buffer.from(
                data
              );

            if (
              audio.length > 0
            ) {

              // IMPORTANT:
              // Audio is allowed to reach the phone
              // even during the tiny transition between
              // streamed chunks.
              if (
                call.aiSpeaking
              ) {

                call.audioQueue.enqueue(
                  audio
                );
              }
            }

            return;
          }

          // ====================================================
          // JSON
          // ====================================================

          let message;

          try {

            message =
              JSON.parse(
                data.toString()
              );

          } catch (_) {

            return;
          }

          // ====================================================
          // FLUSH COMPLETE
          // ====================================================

          if (
            message.type ===
            "Flushed"
          ) {

            // Final audio is already in our queue.
            // Don't clear it here.
            waitForAudioDrain(
              call
            );
          }

        } catch (error) {

          console.log(
            `[${call.id}] TTS MESSAGE ERROR:`,
            error.message
          );
        }
      }
    );

    // ========================================================
    // SOCKET EVENTS
    // ========================================================

    stt.on(
      "close",
      () => {

        call.sttReady =
          false;

        console.log(
          `[${call.id}] STT CLOSED`
        );
      }
    );

    tts.on(
      "close",
      () => {

        call.ttsReady =
          false;

        console.log(
          `[${call.id}] TTS CLOSED`
        );
      }
    );

    stt.on(
      "error",
      error => {

        console.log(
          `[${call.id}] STT ERROR:`,
          error.message
        );
      }
    );

    tts.on(
      "error",
      error => {

        console.log(
          `[${call.id}] TTS ERROR:`,
          error.message
        );
      }
    );

    // ========================================================
    // GREETING ONLY AFTER TTS IS READY
    // ========================================================

    if (
      call.streamSid &&
      !call.greetingPlayed
    ) {

      call.greetingPlayed =
        true;

      await playGreeting(
        call
      );
    }

  } catch (error) {

    console.log(
      `[${call.id}] DEEPGRAM SETUP ERROR:`,
      error.message
    );
  }
}

// ============================================================
// WAIT FOR AUDIO DRAIN
// ============================================================

function waitForAudioDrain(
  call
) {

  if (
    call.destroyed
  ) {

    return;
  }

  if (
    !call.audioQueue.hasPending()
  ) {

    // ========================================================
    // END CALL AFTER FINAL GOODBYE
    // ========================================================

    if (
      call.pendingHangup
    ) {

      call.pendingHangup =
        false;

      call.aiSpeaking =
        false;

      console.log(
        `[${call.id}] FINAL RESPONSE FINISHED`
      );

      /*
       * IMPORTANT:
       *
       * This is intentionally NOT closing the WebSocket.
       *
       * Closing the media WebSocket does not reliably
       * terminate the actual Exotel phone call.
       *
       * Put your Exotel call-control/hangup endpoint here
       * once you provide the exact Exotel call-control
       * configuration you're using.
       */
    }

    return;
  }

  setTimeout(
    () => {

      waitForAudioDrain(
        call
      );

    },
    30
  );
}

// ============================================================
// EXOTEL CONNECTION
// ============================================================

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
      "=============================================="
    );

    console.log(
      `[${call.id}] 📞 EXOTEL CONNECTED`
    );

    console.log(
      `[${call.id}] ACTIVE CALLS:`,
      activeCalls.size
    );

    console.log(
      "=============================================="
    );

    // ========================================================
    // START DEEPGRAM IMMEDIATELY
    // ========================================================

    setupDeepgram(
      call
    );

    // ========================================================
    // EXOTEL MESSAGES
    // ========================================================

    ws.on(
      "message",
      data => {

        if (
          call.destroyed
        ) {

          return;
        }

        try {

          const message =
            JSON.parse(
              data.toString()
            );

          const event =
            message.event;

          // ==================================================
          // CONNECTED
          // ==================================================

          if (
            event ===
            "connected"
          ) {

            console.log(
              `[${call.id}] EXOTEL STREAM CONNECTED`
            );

            return;
          }

          // ==================================================
          // START
          // ==================================================

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

            console.log(
              `[${call.id}] CALL START:`,
              call.callSid
            );

            console.log(
              `[${call.id}] STREAM:`,
              call.streamSid
            );

            // =================================================
            // If TTS became ready before Exotel start.
            // =================================================

            if (
              call.ttsReady &&
              !call.greetingPlayed
            ) {

              call.greetingPlayed =
                true;

              playGreeting(
                call
              );
            }

            return;
          }

          // ==================================================
          // MEDIA
          // ==================================================

          if (
            event ===
            "media"
          ) {

            const payload =
              message.media?.payload;

            if (
              !payload
            ) {

              return;
            }

            // STT may still be connecting during the first
            // few milliseconds. We simply skip that packet.
            if (
              !call.sttSocket ||
              call.sttSocket.readyState !==
                WebSocket.OPEN
            ) {

              return;
            }

            const audio =
              Buffer.from(
                payload,
                "base64"
              );

            try {

              call.sttSocket.send(
                audio
              );

            } catch (error) {

              console.log(
                `[${call.id}] STT SEND ERROR:`,
                error.message
              );
            }

            return;
          }

          // ==================================================
          // CLEAR
          // ==================================================

          if (
            event ===
            "clear"
          ) {

            call.speechFinalParts =
              [];

            call.lastInterim =
              "";

            return;
          }

          // ==================================================
          // STOP
          // ==================================================

          if (
            event ===
            "stop"
          ) {

            console.log(
              `[${call.id}] 📵 CALL STOP`
            );

            destroyCall(
              call
            );

            return;
          }

        } catch (error) {

          console.log(
            `[${call.id}] EXOTEL MESSAGE ERROR:`,
            error.message
          );
        }
      }
    );

    // ========================================================
    // CLOSE
    // ========================================================

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

    // ========================================================
    // ERROR
    // ========================================================

    ws.on(
      "error",
      error => {

        console.log(
          `[${call.id}] EXOTEL ERROR:`,
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
      "================================================"
    );

    console.log(
      "        H&M AI SHOPPING VOICE ASSISTANT"
    );

    console.log(
      "================================================"
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
      "WebSocket:",
      WS_URL
    );

    console.log(
      "================================================"
    );
  }
);

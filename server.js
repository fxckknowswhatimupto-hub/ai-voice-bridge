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

// ------------------------------------------------------------
// AI
// ------------------------------------------------------------

const GROQ_MODEL =
  "llama-3.1-8b-instant";

const DEEPGRAM_STT_MODEL =
  "nova-3";

const DEEPGRAM_TTS_MODEL =
  "aura-2-thalia-en";

// ------------------------------------------------------------
// SPEED
// ------------------------------------------------------------

const TAVILY_TIMEOUT_MS =
  1200;

const GROQ_TIMEOUT_MS =
  9000;

// ------------------------------------------------------------
// PHONE AUDIO
// ------------------------------------------------------------

const SAMPLE_RATE =
  8000;

const BYTES_PER_SAMPLE =
  2;

// 20ms @ 8kHz, 16-bit, mono
const AUDIO_CHUNK_SIZE =
  160 * BYTES_PER_SAMPLE;

const AUDIO_INTERVAL_MS =
  20;

// ------------------------------------------------------------
// BARGE-IN
// ------------------------------------------------------------

// Do not interpret tiny STT fragments as interruption.
const MIN_BARGE_IN_CHARS =
  3;

// Caller must have speech lasting roughly this long
// before we interrupt AI.
const BARGE_IN_MIN_DURATION_MS =
  250;

// After AI starts sending audio, ignore very early
// STT fragments. This prevents the assistant from
// interrupting itself immediately.
const AI_AUDIO_GUARD_MS =
  450;

// Explicit words can interrupt immediately after
// the guard period.
const INTERRUPT_WORDS = [
  "stop",
  "wait",
  "hold on",
  "hang on",
  "no wait",
  "actually",
  "excuse me",
  "sorry",
  "one second",
  "pause"
];

// ------------------------------------------------------------
// END CALL
// ------------------------------------------------------------

const END_CONFIRM_TIMEOUT_MS =
  8000;

// ============================================================
// ENVIRONMENT
// ============================================================

const GROQ_API_KEY =
  process.env.GROQ_API_KEY;

const DEEPGRAM_API_KEY =
  process.env.DEEPGRAM_API_KEY;

const TAVILY_API_KEY =
  process.env.TAVILY_API_KEY;

// ------------------------------------------------------------
// Exotel credentials
// ------------------------------------------------------------
//
// These are only required for REAL API hangup.
// Add them in Render Environment Variables:
//
// EXOTEL_API_KEY
// EXOTEL_API_TOKEN
// EXOTEL_ACCOUNT_SID
//
// For Mumbai Exotel:
// api.in.exotel.com
//
// For Singapore:
// api.exotel.com
//

const EXOTEL_API_KEY =
  process.env.EXOTEL_API_KEY;

const EXOTEL_API_TOKEN =
  process.env.EXOTEL_API_TOKEN;

const EXOTEL_ACCOUNT_SID =
  process.env.EXOTEL_ACCOUNT_SID;

const EXOTEL_API_HOST =
  process.env.EXOTEL_API_HOST ||
  "api.in.exotel.com";

// ============================================================
// VALIDATE
// ============================================================

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

if (
  !EXOTEL_API_KEY ||
  !EXOTEL_API_TOKEN ||
  !EXOTEL_ACCOUNT_SID
) {
  console.log(
    "WARNING: Exotel hangup API credentials are missing. " +
    "Confirmed end-call requests will close the stream, " +
    "but a real telephone hangup may require Exotel API credentials."
  );
}

// ============================================================
// GROQ CLIENT
// ============================================================

const groq =
  new Groq({
    apiKey: GROQ_API_KEY
  });

// ============================================================
// ACTIVE CALLS
// ============================================================

const activeCalls =
  new Map();

let nextCallNumber =
  1;

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
              "h-and-m-ai-voice-assistant",

            model:
              GROQ_MODEL,

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

          status:
            "ok",

          service:
            "H&M AI Voice Assistant",

          websocket:
            WS_URL,

          model:
            GROQ_MODEL,

          activeCalls:
            activeCalls.size
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

// ============================================================
// NORMALIZE TEXT
// ============================================================

function normalizeText(
  text
) {

  return String(
    text || ""
  )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

// ============================================================
// END CALL PHRASE DETECTION
// ============================================================

function isEndCallRequest(
  text
) {

  const q =
    normalizeText(
      text
    ).toLowerCase();

  if (!q) {
    return false;
  }

  // These are deliberately exact-ish.
  // We do NOT want:
  //
  // "thanks, what sizes do you have?"
  //
  // to end the call.

  const patterns = [

    /^that's it[.!]?$/,

    /^thats it[.!]?$/,

    /^nothing else[.!]?$/,

    /^no that's all[.!]?$/,

    /^no thats all[.!]?$/,

    /^i'm done[.!]?$/,

    /^im done[.!]?$/,

    /^bye[.!]?$/,

    /^goodbye[.!]?$/,

    /^that's everything[.!]?$/,

    /^thats everything[.!]?$/
  ];

  return patterns.some(
    pattern =>
      pattern.test(q)
  );
}

// ============================================================
// END CALL CONFIRMATION
// ============================================================

function isEndCallConfirmation(
  text
) {

  const q =
    normalizeText(
      text
    ).toLowerCase();

  if (!q) {
    return false;
  }

  const yesPatterns = [

    /^yes[.!]?$/,

    /^yes please[.!]?$/,

    /^yeah[.!]?$/,

    /^yep[.!]?$/,

    /^yup[.!]?$/,

    /^sure[.!]?$/,

    /^go ahead[.!]?$/,

    /^end it[.!]?$/,

    /^you can end the call[.!]?$/,

    /^please end the call[.!]?$/,

    /^that's fine[.!]?$/,

    /^thats fine[.!]?$/
  ];

  return yesPatterns.some(
    pattern =>
      pattern.test(q)
  );
}

// ============================================================
// END CALL NEGATIVE
// ============================================================

function isEndCallRejection(
  text
) {

  const q =
    normalizeText(
      text
    ).toLowerCase();

  const patterns = [

    /^no[.!]?$/,

    /^nope[.!]?$/,

    /^not yet[.!]?$/,

    /^wait[.!]?$/,

    /^actually no[.!]?$/,

    /^i have another question[.!]?$/,

    /^one more question[.!]?$/
  ];

  return patterns.some(
    pattern =>
      pattern.test(q)
  );
}

// ============================================================
// SHOPPING STATE
// ============================================================

function createShoppingState() {

  return {

    product:
      null,

    category:
      null,

    color:
      null,

    size:
      null,

    gender:
      null,

    fit:
      null,

    budget:
      null,

    quantity:
      1,

    lastAskedField:
      null
  };
}

// ============================================================
// SHOPPING STATE DISPLAY
// ============================================================

function shoppingStateText(
  call
) {

  const s =
    call.shoppingState;

  return JSON.stringify(
    {
      product:
        s.product,

      category:
        s.category,

      color:
        s.color,

      size:
        s.size,

      gender:
        s.gender,

      fit:
        s.fit,

      budget:
        s.budget,

      quantity:
        s.quantity,

      lastAskedField:
        s.lastAskedField
    },
    null,
    2
  );
}

// ============================================================
// SIZE DETECTION
// ============================================================

function extractSize(
  text
) {

  const q =
    normalizeText(
      text
    ).toLowerCase();

  const patterns = [

    {
      regex:
        /\b(?:size\s*)?(xxs|2xs)\b/i,

      value:
        "XXS"
    },

    {
      regex:
        /\b(?:size\s*)?(xs)\b/i,

      value:
        "XS"
    },

    {
      regex:
        /\b(?:size\s*)?(small|s)\b/i,

      value:
        "S"
    },

    {
      regex:
        /\b(?:size\s*)?(medium|med|m)\b/i,

      value:
        "M"
    },

    {
      regex:
        /\b(?:size\s*)?(large|lg|l)\b/i,

      value:
        "L"
    },

    {
      regex:
        /\b(?:size\s*)?(extra large|xlarge|xl)\b/i,

      value:
        "XL"
    },

    {
      regex:
        /\b(?:size\s*)?(xxl|2xl)\b/i,

      value:
        "XXL"
    }
  ];

  for (
    const item of
      patterns
  ) {

    if (
      item.regex.test(q)
    ) {

      return item.value;
    }
  }

  return null;
}

// ============================================================
// COLOR DETECTION
// ============================================================

function extractColor(
  text
) {

  const q =
    normalizeText(
      text
    ).toLowerCase();

  const colors = [

    "black",
    "white",
    "red",
    "blue",
    "green",
    "yellow",
    "orange",
    "pink",
    "purple",
    "brown",
    "beige",
    "cream",
    "grey",
    "gray",
    "navy",
    "maroon",
    "burgundy",
    "khaki",
    "olive",
    "teal",
    "turquoise",
    "cyan",
    "lime",
    "silver",
    "gold",
    "washed blue",
    "light blue",
    "dark blue",
    "light green",
    "dark green",
    "bluish green",
    "greenish blue",
    "faded blue",
    "faded green",
    "faded bluish-green",
    "faded bluish green"
  ];

  for (
    const color of
      colors
  ) {

    if (
      q.includes(color)
    ) {

      return color;
    }
  }

  return null;
}

// ============================================================
// PRODUCT DETECTION
// ============================================================

function extractProduct(
  text
) {

  const q =
    normalizeText(
      text
    ).toLowerCase();

  const products = [

    "bootcut jeans",
    "straight jeans",
    "skinny jeans",
    "baggy jeans",
    "wide leg jeans",
    "mom jeans",
    "jeans",
    "t shirt",
    "t-shirt",
    "shirt",
    "hoodie",
    "sweatshirt",
    "jacket",
    "denim jacket",
    "leather jacket",
    "coat",
    "dress",
    "skirt",
    "shorts",
    "trousers",
    "pants",
    "cargo pants",
    "leggings",
    "sweater",
    "cardigan",
    "top",
    "blouse",
    "blazer",
    "shoes",
    "sneakers",
    "sandals",
    "boots"
  ];

  // Longest first.
  products.sort(
    (a, b) =>
      b.length -
      a.length
  );

  for (
    const product of
      products
  ) {

    if (
      q.includes(product)
    ) {

      return product;
    }
  }

  return null;
}

// ============================================================
// BUDGET DETECTION
// ============================================================

function extractBudget(
  text
) {

  const q =
    normalizeText(
      text
    ).toLowerCase();

  const match =
    q.match(
      /(?:under|below|less than|around|about|budget of|within)\s*(?:₹|rs\.?|inr)?\s*([0-9,]+)/i
    );

  if (!match) {
    return null;
  }

  return (
    "₹" +
    match[1]
  );
}

// ============================================================
// UPDATE SHOPPING STATE
// ============================================================

function updateShoppingState(
  call,
  text
) {

  const q =
    normalizeText(
      text
    );

  if (!q) {
    return;
  }

  const state =
    call.shoppingState;

  // ----------------------------------------------------------
  // If AI just asked for a color, interpret the next answer
  // as the color even if the exact color isn't in our list.
  //
  // This is what fixes:
  //
  // "faded bluish-green"
  // ----------------------------------------------------------

  if (
    state.lastAskedField ===
    "color"
  ) {

    const detectedColor =
      extractColor(q);

    state.color =
      detectedColor ||
      q;

    state.lastAskedField =
      null;
  }

  // ----------------------------------------------------------
  // SIZE
  // ----------------------------------------------------------

  if (
    state.lastAskedField ===
    "size"
  ) {

    const detectedSize =
      extractSize(q);

    if (
      detectedSize
    ) {

      state.size =
        detectedSize;

      state.lastAskedField =
        null;
    }
  }

  // ----------------------------------------------------------
  // BUDGET
  // ----------------------------------------------------------

  if (
    state.lastAskedField ===
    "budget"
  ) {

    const detectedBudget =
      extractBudget(q);

    if (
      detectedBudget
    ) {

      state.budget =
        detectedBudget;

      state.lastAskedField =
        null;
    }
  }

  // ----------------------------------------------------------
  // PRODUCT
  // ----------------------------------------------------------

  const product =
    extractProduct(q);

  if (
    product
  ) {

    state.product =
      product;

    state.category =
      product;
  }

  // ----------------------------------------------------------
  // COLOR
  // ----------------------------------------------------------

  const color =
    extractColor(q);

  if (
    color
  ) {

    state.color =
      color;
  }

  // ----------------------------------------------------------
  // SIZE
  // ----------------------------------------------------------

  const size =
    extractSize(q);

  if (
    size
  ) {

    state.size =
      size;
  }

  // ----------------------------------------------------------
  // BUDGET
  // ----------------------------------------------------------

  const budget =
    extractBudget(q);

  if (
    budget
  ) {

    state.budget =
      budget;
  }

  // ----------------------------------------------------------
  // SIMPLE GENDER
  // ----------------------------------------------------------

  if (
    /\b(?:men|men's|mens|male)\b/i.test(q)
  ) {

    state.gender =
      "men";
  }

  if (
    /\b(?:women|women's|womens|female)\b/i.test(q)
  ) {

    state.gender =
      "women";
  }

  // ----------------------------------------------------------
  // FIT
  // ----------------------------------------------------------

  const fits = [
    "slim fit",
    "regular fit",
    "relaxed fit",
    "oversized",
    "loose fit",
    "straight fit",
    "skinny fit",
    "wide leg"
  ];

  for (
    const fit of
      fits
  ) {

    if (
      q.toLowerCase()
        .includes(fit)
    ) {

      state.fit =
        fit;

      break;
    }
  }
}

// ============================================================
// WEB SEARCH DETECTION
// ============================================================

function needsWebSearch(
  question
) {

  const q =
    normalizeText(
      question
    ).toLowerCase();

  // ----------------------------------------------------------
  // DO NOT SEARCH DURING SIMPLE SHOPPING DIALOGUE
  // ----------------------------------------------------------

  const shoppingConversationWords = [

    "i want",
    "i need",
    "looking for",
    "i'm looking",
    "im looking",
    "show me",
    "i'd like",
    "id like",
    "i would like",
    "what color",
    "what colour",
    "what size",
    "my size",
    "medium",
    "small",
    "large",
    "xl",
    "xxl",
    "black",
    "white",
    "blue",
    "green",
    "faded",
    "bluish",
    "greenish",
    "red",
    "pink",
    "brown",
    "beige"
  ];

  const looksLikeBasicShopping =
    shoppingConversationWords.some(
      word =>
        q.includes(word)
    );

  if (
    looksLikeBasicShopping &&
    !q.includes("price") &&
    !q.includes("available") &&
    !q.includes("availability") &&
    !q.includes("in stock") &&
    !q.includes("stock") &&
    !q.includes("today") &&
    !q.includes("latest")
  ) {

    return false;
  }

  // ----------------------------------------------------------
  // CURRENT INFORMATION
  // ----------------------------------------------------------

  const liveWords = [

    "today",
    "tonight",
    "tomorrow",
    "now",
    "currently",
    "current",
    "latest",
    "recent",
    "news",
    "weather",
    "temperature",
    "price",
    "prices",
    "cost",
    "how much",
    "available",
    "availability",
    "in stock",
    "stock",
    "opening hours",
    "opening time",
    "timing",
    "timings"
  ];

  for (
    const word of
      liveWords
  ) {

    if (
      q.includes(word)
    ) {

      return true;
    }
  }

  return false;
}

// ============================================================
// TAVILY SEARCH
// ============================================================

async function searchWeb(
  question
) {

  if (
    !TAVILY_API_KEY
  ) {

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

          method:
            "POST",

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

    if (
      !response.ok
    ) {

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
      data?.answer
    ) {

      information +=
        data.answer +
        " ";
    }

    if (
      Array.isArray(
        data?.results
      )
    ) {

      for (
        const result of
          data.results
      ) {

        information +=
          (
            result?.title ||
            ""
          ) +
          ": " +
          (
            result?.content ||
            ""
          ) +
          " ";
      }
    }

    return information
      .replace(
        /\s+/g,
        " "
      )
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

      let settled =
        false;

      const timeout =
        setTimeout(
          () => {

            if (
              !settled
            ) {

              try {
                socket.close();
              } catch (_) {}

              reject(
                new Error(
                  "Deepgram STT connection timeout"
                )
              );
            }

          },
          7000
        );

      socket.once(
        "open",
        () => {

          settled =
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

          if (
            !settled
          ) {

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
        "&container=none" +
        "&speed=1.15";

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

      let settled =
        false;

      const timeout =
        setTimeout(
          () => {

            if (
              !settled
            ) {

              try {
                socket.close();
              } catch (_) {}

              reject(
                new Error(
                  "Deepgram TTS connection timeout"
                )
              );
            }

          },
          7000
        );

      socket.once(
        "open",
        () => {

          settled =
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

          if (
            !settled
          ) {

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
// CLOSE DEEPGRAM
// ============================================================

function closeDeepgramSocket(
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
// EXOTEL AUDIO QUEUE
// ============================================================

function createAudioQueue(
  call
) {

  const queue =
    [];

  let timer =
    null;

  let stopped =
    false;

  let sequenceNumber =
    1;

  let chunkNumber =
    0;

  let timestamp =
    0;

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

      queue.length =
        0;

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

    // --------------------------------------------------------
    // If AI was interrupted, NEVER send old audio.
    // --------------------------------------------------------

    if (
      !call.aiSpeaking
    ) {

      queue.length =
        0;

      return;
    }

    const chunk =
      queue.shift();

    if (!chunk) {
      return;
    }

    try {

      call.ws.send(
        JSON.stringify({

          event:
            "media",

          sequence_number:
            String(
              sequenceNumber++
            ),

          stream_sid:
            call.streamSid,

          media: {

            chunk:
              String(
                chunkNumber++
              ),

            timestamp:
              String(
                timestamp
              ),

            payload:
              chunk.toString(
                "base64"
              )
          }
        })
      );

      timestamp +=
        AUDIO_INTERVAL_MS;

      // ------------------------------------------------------
      // Tell barge-in logic that AI audio is active.
      // ------------------------------------------------------

      call.lastTTSAudioAt =
        Date.now();

      call.ignoreBargeInUntil =
        Date.now() +
        AI_AUDIO_GUARD_MS;

    } catch (error) {

      console.log(
        `[${call.id}] AUDIO SEND ERROR:`,
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
    pcmBuffer
  ) {

    if (
      stopped ||
      call.destroyed ||
      !pcmBuffer ||
      pcmBuffer.length ===
        0
    ) {

      return;
    }

    // --------------------------------------------------------
    // If AI is no longer speaking, don't queue anything.
    // --------------------------------------------------------

    if (
      !call.aiSpeaking
    ) {

      return;
    }

    for (
      let offset = 0;
      offset < pcmBuffer.length;
      offset += AUDIO_CHUNK_SIZE
    ) {

      queue.push(
        pcmBuffer.subarray(
          offset,
          Math.min(
            offset +
              AUDIO_CHUNK_SIZE,
            pcmBuffer.length
          )
        )
      );
    }

    if (!timer) {

      sendNext();
    }
  }

  function clear() {

    queue.length =
      0;

    if (
      timer
    ) {

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

  function hasPendingAudio() {

    return (
      queue.length >
        0 ||
      Boolean(timer)
    );
  }

  return {

    enqueue,

    clear,

    stop,

    hasPendingAudio
  };
}

// ============================================================
// CLEAR EXOTEL AUDIO
// ============================================================

function clearExotelAudio(
  call
) {

  if (
    !call.ws ||
    call.ws.readyState !==
      WebSocket.OPEN ||
    !call.streamSid
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
      `[${call.id}] CLEAR ERROR:`,
      error.message
    );
  }
}

// ============================================================
// SEND TTS TEXT
// ============================================================

function sendTextToTTS(
  call,
  text
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
          "Speak",

        text:
          text
      })
    );

    call.lastTTSTextAt =
      Date.now();

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

  } catch (error) {

    console.log(
      `[${call.id}] TTS FLUSH ERROR:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// INTERRUPT AI
// ============================================================

function interruptAI(
  call,
  reason
) {

  if (
    !call ||
    call.destroyed
  ) {

    return;
  }

  if (
    !call.aiSpeaking
  ) {

    return;
  }

  console.log(
    `[${call.id}] 🔴 INTERRUPT: ${reason}`
  );

  // ----------------------------------------------------------
  // INVALIDATE OLD GROQ RESPONSE
  // ----------------------------------------------------------

  call.ttsGeneration++;

  call.aiSpeaking =
    false;

  call.interrupting =
    true;

  // ----------------------------------------------------------
  // CLEAR LOCAL AUDIO QUEUE
  // ----------------------------------------------------------

  if (
    call.audioQueue
  ) {

    call.audioQueue.clear();
  }

  // ----------------------------------------------------------
  // CLEAR EXOTEL BUFFER
  // ----------------------------------------------------------

  clearExotelAudio(
    call
  );

  // ----------------------------------------------------------
  // IMPORTANT:
  // DO NOT CLOSE OR RESTART TTS.
  //
  // Restarting the TTS socket was causing the lag.
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // RESET SPEECH STATE
  // ----------------------------------------------------------

  call.lastTTSAudioAt =
    0;

  call.ignoreBargeInUntil =
    Date.now() +
    150;

  call.interrupting =
    false;
}

// ============================================================
// WAIT FOR TTS AUDIO TO DRAIN
// ============================================================

function waitForAudioDrain(
  call,
  callback
) {

  if (
    call.destroyed
  ) {

    return;
  }

  if (
    !call.audioQueue.hasPendingAudio()
  ) {

    if (callback) {
      callback();
    }

    return;
  }

  setTimeout(
    () => {

      waitForAudioDrain(
        call,
        callback
      );

    },
    30
  );
}

// ============================================================
// EXOTEL MARK
// ============================================================

function sendExotelMark(
  call
) {

  if (
    call.destroyed ||
    !call.ws ||
    call.ws.readyState !==
      WebSocket.OPEN ||
    !call.streamSid
  ) {

    return;
  }

  try {

    call.ws.send(
      JSON.stringify({

        event:
          "mark",

        stream_sid:
          call.streamSid,

        mark: {

          name:
            "ai_response_complete"
        }
      })
    );

  } catch (_) {}
}

// ============================================================
// STREAM GROQ
// ============================================================

async function streamGroq(
  call,
  question,
  webInformation,
  onText,
  generation
) {

  const messages = [

    {
      role:
        "system",

      content:
`
You are the H&M phone shopping assistant.

You are speaking to a real customer on a telephone call.

Your job is to help with:
- H&M products
- shopping
- product recommendations
- colors
- sizes
- fits
- basic product information

Products, shopping, colors and sizes are FUNCTIONAL.

Other H&M services such as:
- returns
- refunds
- complaints
- store-specific support
- account problems
- payment support
- delivery disputes
- loyalty support
- corporate questions

are currently unavailable.

If the customer asks about one of those unavailable services, say naturally:

"Sorry, this option is unavailable right now."

Do NOT repeatedly say:
"Sorry, I can only help with H&M products."

That is important.

---

SHOPPING CONVERSATION

Maintain context.

If the customer says:

"I want bootcut jeans."

Then ask something useful such as:

"Sure. What color would you like?"

If the customer says:

"faded bluish-green"

understand that as a COLOR.

Do not reject it just because "faded bluish-green" is not an exact predefined color.

If the customer says:

"make it black"

understand that they are changing the current product's color.

If the customer says:

"medium"

understand that as the size when size is being discussed.

If the customer says:

"same thing but black"

keep the current product and change the color.

If the customer says:

"what about blue?"

understand that this refers to the current shopping context.

---

CONVERSATION MEMORY

Remember information already provided during this call.

For example:

Customer:
"I want bootcut jeans."

Customer:
"Faded bluish-green."

Customer:
"Medium."

Customer:
"Actually make them black."

You should understand:

product = bootcut jeans
color = black
size = medium

Do not ask for information the customer already gave you.

---

VOICE STYLE

Speak naturally.

Use short spoken sentences.

Do not sound like a script.

Do not use bullet points while speaking.

Do not use markdown.

Do not mention:
- APIs
- prompts
- models
- Tavily
- Deepgram
- Groq
- internal tools
- web search

For simple questions, answer quickly.

For shopping conversations, ask ONE useful follow-up question at a time.

Do not ask five questions at once.

---

END CALL

If the customer clearly says:

"that's it"
"nothing else"
"no that's all"
"I'm done"
"bye"
"goodbye"
"that's everything"

the application will handle the confirmation.

Do not independently terminate the call.

---

CURRENT SHOPPING STATE:

${shoppingStateText(call)}

CURRENT WEB INFORMATION:

${webInformation || "No live web information was requested."}
`
    }
  ];

  // ----------------------------------------------------------
  // MEMORY
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // QUESTION
  // ----------------------------------------------------------

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
            0.2,

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

    let fullAnswer =
      "";

    let pendingText =
      "";

    for await (
      const chunk of
        stream
    ) {

      // ------------------------------------------------------
      // CALL ENDED
      // ------------------------------------------------------

      if (
        call.destroyed
      ) {

        break;
      }

      // ------------------------------------------------------
      // OLD RESPONSE
      // ------------------------------------------------------

      if (
        call.ttsGeneration !==
        generation
      ) {

        console.log(
          `[${call.id}] OLD GROQ RESPONSE DISCARDED`
        );

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

      fullAnswer +=
        token;

      pendingText +=
        token;

      // ------------------------------------------------------
      // SENTENCE STREAMING
      // ------------------------------------------------------

      while (true) {

        const match =
          pendingText.match(
            /^([\s\S]*?[.!?])(?:\s+|$)/
          );

        if (
          !match
        ) {

          break;
        }

        const sentence =
          normalizeText(
            match[1]
          );

        pendingText =
          pendingText
            .slice(
              match[0].length
            )
            .trimStart();

        if (
          !sentence
        ) {

          continue;
        }

        if (
          call.destroyed ||
          call.ttsGeneration !==
            generation
        ) {

          break;
        }

        await onText(
          sentence
        );
      }

      // ------------------------------------------------------
      // EARLY CHUNK
      //
      // Don't wait for punctuation forever.
      // ------------------------------------------------------

      if (
        pendingText.length >=
        40
      ) {

        const lastSpace =
          pendingText.lastIndexOf(
            " "
          );

        if (
          lastSpace >=
          20
        ) {

          const chunkText =
            normalizeText(
              pendingText.slice(
                0,
                lastSpace
              )
            );

          pendingText =
            pendingText
              .slice(
                lastSpace + 1
              )
              .trimStart();

          if (
            chunkText &&
            !call.destroyed &&
            call.ttsGeneration ===
              generation
          ) {

            await onText(
              chunkText
            );
          }
        }
      }
    }

    // --------------------------------------------------------
    // REMAINING TEXT
    // --------------------------------------------------------

    if (
      pendingText.trim() &&
      !call.destroyed &&
      call.ttsGeneration ===
        generation
    ) {

      await onText(
        normalizeText(
          pendingText
        )
      );
    }

    return normalizeText(
      fullAnswer
    );

  } finally {

    clearTimeout(
      timeout
    );
  }
}

// ============================================================
// H&M GREETING
// ============================================================

async function speakGreeting(
  call
) {

  if (
    call.destroyed ||
    call.greetingPlayed
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

  call.greetingPlayed =
    true;

  call.aiSpeaking =
    true;

  call.ttsGeneration++;

  const generation =
    call.ttsGeneration;

  sendTextToTTS(
    call,
    "Hi, welcome to H and M. How can I help you today?"
  );

  flushTTS(
    call
  );

  // Prevent greeting audio from being interpreted
  // as a caller interruption.
  call.ignoreBargeInUntil =
    Date.now() +
    1800;

  // Wait until greeting finishes.
  waitForAudioDrain(
    call,
    () => {

      if (
        call.destroyed ||
        call.ttsGeneration !==
          generation
      ) {

        return;
      }

      call.aiSpeaking =
        false;

      console.log(
        `[${call.id}] GREETING COMPLETE`
      );
    }
  );
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

  const cleanQuestion =
    normalizeText(
      question
    );

  if (
    !cleanQuestion
  ) {

    return;
  }

  console.log(
    `[${call.id}] QUESTION:`,
    cleanQuestion
  );

  // ==========================================================
  // END CALL CONFIRMATION
  // ==========================================================

  if (
    call.awaitingEndConfirmation
  ) {

    if (
      isEndCallConfirmation(
        cleanQuestion
      )
    ) {

      call.awaitingEndConfirmation =
        false;

      if (
        call.endConfirmationTimer
      ) {

        clearTimeout(
          call.endConfirmationTimer
        );

        call.endConfirmationTimer =
          null;
      }

      console.log(
        `[${call.id}] END CALL CONFIRMED`
      );

      await sayGoodbyeAndHangup(
        call
      );

      return;
    }

    if (
      isEndCallRejection(
        cleanQuestion
      )
    ) {

      call.awaitingEndConfirmation =
        false;

      if (
        call.endConfirmationTimer
      ) {

        clearTimeout(
          call.endConfirmationTimer
        );

        call.endConfirmationTimer =
          null;
      }

      console.log(
        `[${call.id}] END CALL CANCELLED`
      );

      // Continue normally.
    }
  }

  // ==========================================================
  // END CALL REQUEST
  // ==========================================================

  if (
    isEndCallRequest(
      cleanQuestion
    )
  ) {

    call.awaitingEndConfirmation =
      true;

    console.log(
      `[${call.id}] END CALL REQUEST DETECTED`
    );

    await speakSingleResponse(
      call,
      "Just to confirm, would you like me to end the call?"
    );

    call.endConfirmationTimer =
      setTimeout(
        () => {

          if (
            call.destroyed
          ) {

            return;
          }

          call.awaitingEndConfirmation =
            false;

          call.endConfirmationTimer =
            null;

          console.log(
            `[${call.id}] END CONFIRMATION EXPIRED`
          );

        },
        END_CONFIRM_TIMEOUT_MS
      );

    return;
  }

  // ==========================================================
  // UPDATE SHOPPING MEMORY
  // ==========================================================

  updateShoppingState(
    call,
    cleanQuestion
  );

  console.log(
    `[${call.id}] SHOPPING STATE:`,
    call.shoppingState
  );

  // ==========================================================
  // NEW RESPONSE
  // ==========================================================

  const generation =
    ++call.ttsGeneration;

  call.aiSpeaking =
    true;

  call.interrupting =
    false;

  let sentTTS =
    false;

  const startedAt =
    Date.now();

  try {

    // ========================================================
    // SEARCH
    // ========================================================

    let webInformation =
      "";

    if (
      needsWebSearch(
        cleanQuestion
      )
    ) {

      console.log(
        `[${call.id}] LIVE SEARCH`
      );

      webInformation =
        await searchWeb(
          cleanQuestion
        );

    } else {

      console.log(
        `[${call.id}] NO SEARCH`
      );
    }

    // ========================================================
    // CALL MAY HAVE BEEN INTERRUPTED DURING SEARCH
    // ========================================================

    if (
      call.destroyed ||
      call.ttsGeneration !==
        generation
    ) {

      return;
    }

    // ========================================================
    // TTS CALLBACK
    // ========================================================

    const sendText =
      async text => {

        if (
          call.destroyed ||
          call.interrupting ||
          call.ttsGeneration !==
            generation
        ) {

          return;
        }

        const ok =
          sendTextToTTS(
            call,
            text
          );

        if (
          ok
        ) {

          sentTTS =
            true;

          call.aiSpeaking =
            true;
        }
      };

    // ========================================================
    // GROQ
    // ========================================================

    const answer =
      await streamGroq(
        call,
        cleanQuestion,
        webInformation,
        sendText,
        generation
      );

    // ========================================================
    // RESPONSE INVALIDATED
    // ========================================================

    if (
      call.destroyed ||
      call.ttsGeneration !==
        generation
    ) {

      console.log(
        `[${call.id}] RESPONSE INVALIDATED`
      );

      return;
    }

    // ========================================================
    // FLUSH
    // ========================================================

    if (
      sentTTS
    ) {

      flushTTS(
        call
      );
    }

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
          cleanQuestion
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
        startedAt,
      "ms"
    );

    // --------------------------------------------------------
    // AI remains speaking until TTS finishes.
    // --------------------------------------------------------

    if (
      sentTTS
    ) {

      waitForAudioDrain(
        call,
        () => {

          if (
            call.destroyed
          ) {

            return;
          }

          if (
            call.ttsGeneration !==
            generation
          ) {

            return;
          }

          call.aiSpeaking =
            false;

          console.log(
            `[${call.id}] TTS COMPLETE`
          );
        }
      );

    } else {

      call.aiSpeaking =
        false;
    }

  } catch (error) {

    if (
      call.destroyed
    ) {

      return;
    }

    if (
      call.ttsGeneration !==
      generation
    ) {

      return;
    }

    console.log(
      `[${call.id}] PROCESSING ERROR:`,
      error.message
    );

    try {

      sendTextToTTS(
        call,
        "Sorry, I had trouble answering that."
      );

      flushTTS(
        call
      );

    } catch (_) {}

  }
}

// ============================================================
// SIMPLE TTS RESPONSE
// ============================================================

async function speakSingleResponse(
  call,
  text
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

  call.audioQueue.clear();

  clearExotelAudio(
    call
  );

  sendTextToTTS(
    call,
    text
  );

  flushTTS(
    call
  );

  call.ignoreBargeInUntil =
    Date.now() +
    500;

  waitForAudioDrain(
    call,
    () => {

      if (
        call.destroyed ||
        call.ttsGeneration !==
          generation
      ) {

        return;
      }

      call.aiSpeaking =
        false;
    }
  );
}

// ============================================================
// GET EXOTEL ACTIVE LEGS
// ============================================================

async function getActiveExotelLegs(
  callSid
) {

  if (
    !EXOTEL_API_KEY ||
    !EXOTEL_API_TOKEN ||
    !EXOTEL_ACCOUNT_SID
  ) {

    return [];
  }

  const url =
    `https://${EXOTEL_API_HOST}` +
    `/v1/Accounts/` +
    encodeURIComponent(
      EXOTEL_ACCOUNT_SID
    ) +
    `/Calls/` +
    encodeURIComponent(
      callSid
    ) +
    `/ActiveLegs.json`;

  const basicAuth =
    Buffer.from(
      EXOTEL_API_KEY +
      ":" +
      EXOTEL_API_TOKEN
    ).toString(
      "base64"
    );

  try {

    const response =
      await fetch(
        url,
        {

          method:
            "GET",

          headers: {

            Authorization:
              "Basic " +
              basicAuth
          }
        }
      );

    if (
      !response.ok
    ) {

      console.log(
        `[${call.id}] ACTIVE LEGS HTTP:`,
        response.status
      );

      return [];
    }

    const data =
      await response.json();

    return (
      data?.Legs ||
      data?.legs ||
      []
    );

  } catch (error) {

    console.log(
      `[${call.id}] ACTIVE LEGS ERROR:`,
      error.message
    );

    return [];
  }
}

// ============================================================
// HANGUP EXOTEL LEG
// ============================================================

async function hangupExotelLeg(
  call,
  legSid
) {

  if (
    !EXOTEL_API_KEY ||
    !EXOTEL_API_TOKEN ||
    !EXOTEL_ACCOUNT_SID
  ) {

    console.log(
      `[${call.id}] Exotel hangup credentials missing`
    );

    return false;
  }

  if (
    !call.callSid ||
    !legSid
  ) {

    console.log(
      `[${call.id}] Missing CallSid or LegSid`
    );

    return false;
  }

  const url =
    `https://${EXOTEL_API_HOST}` +
    `/v1/Accounts/` +
    encodeURIComponent(
      EXOTEL_ACCOUNT_SID
    ) +
    `/Calls/` +
    encodeURIComponent(
      call.callSid
    ) +
    `/Legs/` +
    encodeURIComponent(
      legSid
    );

  const basicAuth =
    Buffer.from(
      EXOTEL_API_KEY +
      ":" +
      EXOTEL_API_TOKEN
    ).toString(
      "base64"
    );

  try {

    const response =
      await fetch(
        url,
        {

          method:
            "PUT",

          headers: {

            Authorization:
              "Basic " +
              basicAuth,

            "Content-Type":
              "application/x-www-form-urlencoded"
          },

          body:
            "Action=hangup"
        }
      );

    const body =
      await response.text();

    console.log(
      `[${call.id}] EXOTEL HANGUP HTTP:`,
      response.status
    );

    if (
      body
    ) {

      console.log(
        `[${call.id}] EXOTEL HANGUP RESPONSE:`,
        body.slice(
          0,
          500
        )
      );
    }

    return response.ok;

  } catch (error) {

    console.log(
      `[${call.id}] EXOTEL HANGUP ERROR:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// REAL EXOTEL HANGUP
// ============================================================

async function hangupCall(
  call
) {

  if (
    call.destroyed
  ) {

    return;
  }

  call.ending =
    true;

  call.aiSpeaking =
    false;

  call.ttsGeneration++;

  if (
    call.audioQueue
  ) {

    call.audioQueue.clear();
  }

  clearExotelAudio(
    call
  );

  // ----------------------------------------------------------
  // If Exotel included leg SID in start event, use it.
  // ----------------------------------------------------------

  let legSid =
    call.legSid;

  // ----------------------------------------------------------
  // Otherwise ask Exotel for active legs.
  // ----------------------------------------------------------

  if (
    !legSid &&
    call.callSid
  ) {

    const legs =
      await getActiveExotelLegs(
        call.callSid
      );

    if (
      Array.isArray(legs) &&
      legs.length > 0
    ) {

      // Prefer an in-progress inbound/customer leg.
      const preferred =
        legs.find(
          leg =>
            leg?.Status ===
              "in-progress" &&
            (
              String(
                leg?.Origin ||
                ""
              )
                .toLowerCase()
                .includes(
                  "inbound"
                )
            )
        );

      legSid =
        preferred?.Sid ||
        legs.find(
          leg =>
            leg?.Status ===
            "in-progress"
        )?.Sid ||
        legs[0]?.Sid ||
        null;
    }
  }

  // ----------------------------------------------------------
  // Real Exotel hangup.
  // ----------------------------------------------------------

  let hungUp =
    false;

  if (
    legSid
  ) {

    hungUp =
      await hangupExotelLeg(
        call,
        legSid
      );
  }

  // ----------------------------------------------------------
  // Fallback.
  //
  // Closing the WebSocket stops our stream, but whether this
  // terminates the actual PSTN call depends on the Exotel flow.
  // ----------------------------------------------------------

  if (
    !hungUp
  ) {

    console.log(
      `[${call.id}] Falling back to closing Exotel stream`
    );
  }

  // ----------------------------------------------------------
  // Clean up our side.
  // ----------------------------------------------------------

  setTimeout(
    () => {

      destroyCall(
        call
      );

    },
    hungUp
      ? 250
      : 100
  );
}

// ============================================================
// GOODBYE + HANGUP
// ============================================================

async function sayGoodbyeAndHangup(
  call
) {

  if (
    call.destroyed
  ) {

    return;
  }

  console.log(
    `[${call.id}] SAYING GOODBYE`
  );

  const generation =
    ++call.ttsGeneration;

  call.aiSpeaking =
    true;

  call.audioQueue.clear();

  clearExotelAudio(
    call
  );

  const goodbye =
    "Alright, thank you for calling H and M. Have a great day!";

  sendTextToTTS(
    call,
    goodbye
  );

  flushTTS(
    call
  );

  // Give Deepgram a moment to generate the final audio,
  // then wait for our Exotel audio queue to drain.
  setTimeout(
    () => {

      if (
        call.destroyed ||
        call.ttsGeneration !==
          generation
      ) {

        return;
      }

      waitForAudioDrain(
        call,
        () => {

          if (
            call.destroyed ||
            call.ttsGeneration !==
              generation
          ) {

            return;
          }

          call.aiSpeaking =
            false;

          console.log(
            `[${call.id}] GOODBYE AUDIO COMPLETE`
          );

          hangupCall(
            call
          );
        }
      );

    },
    250
  );
}

// ============================================================
// QUESTION QUEUE
// ============================================================

function enqueueQuestion(
  call,
  question
) {

  if (
    call.destroyed ||
    call.ending
  ) {

    return;
  }

  const clean =
    normalizeText(
      question
    );

  if (
    !clean
  ) {

    return;
  }

  // ----------------------------------------------------------
  // If AI is speaking and this is a real caller utterance,
  // interrupt the AI first.
  // ----------------------------------------------------------

  if (
    call.aiSpeaking
  ) {

    interruptAI(
      call,
      "caller started speaking"
    );

    call.questionQueue =
      [];
  }

  // Latest question gets priority.
  call.questionQueue.unshift(
    clean
  );

  runQuestionQueue(
    call
  );
}

// ============================================================
// QUESTION QUEUE RUNNER
// ============================================================

async function runQuestionQueue(
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
// CREATE CALL SESSION
// ============================================================

function createCallSession(
  ws
) {

  const id =
    "CALL-" +
    String(
      nextCallNumber++
    );

  const call = {

    id,

    ws,

    destroyed:
      false,

    ending:
      false,

    streamSid:
      null,

    callSid:
      null,

    legSid:
      null,

    sttSocket:
      null,

    ttsSocket:
      null,

    sttReady:
      false,

    ttsReady:
      false,

    speechFinalParts:
      [],

    lastInterim:
      "",

    conversationHistory:
      [],

    shoppingState:
      createShoppingState(),

    questionQueue:
      [],

    queueRunning:
      false,

    audioQueue:
      null,

    // --------------------------------------------------------
    // AI SPEAKING
    // --------------------------------------------------------

    aiSpeaking:
      false,

    interrupting:
      false,

    ttsGeneration:
      0,

    lastTTSAudioAt:
      0,

    lastTTSTextAt:
      0,

    ignoreBargeInUntil:
      0,

    // --------------------------------------------------------
    // CALLER SPEECH
    // --------------------------------------------------------

    callerSpeechStartedAt:
      0,

    lastSpeechTime:
      0,

    // --------------------------------------------------------
    // END CALL
    // --------------------------------------------------------

    awaitingEndConfirmation:
      false,

    endConfirmationTimer:
      null,

    // --------------------------------------------------------
    // GREETING
    // --------------------------------------------------------

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

  call.destroyed =
    true;

  call.aiSpeaking =
    false;

  call.ttsGeneration++;

  console.log(
    `[${call.id}] CLEANING UP CALL`
  );

  if (
    call.endConfirmationTimer
  ) {

    clearTimeout(
      call.endConfirmationTimer
    );

    call.endConfirmationTimer =
      null;
  }

  call.questionQueue =
    [];

  call.speechFinalParts =
    [];

  call.lastInterim =
    "";

  if (
    call.audioQueue
  ) {

    call.audioQueue.stop();
  }

  closeDeepgramSocket(
    call.sttSocket
  );

  closeDeepgramSocket(
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
// DEEPGRAM SETUP
// ============================================================

async function setupDeepgram(
  call
) {

  try {

    const [
      sttSocket,
      ttsSocket
    ] =
      await Promise.all([

        createDeepgramSTT(),

        createDeepgramTTS()

      ]);

    if (
      call.destroyed
    ) {

      closeDeepgramSocket(
        sttSocket
      );

      closeDeepgramSocket(
        ttsSocket
      );

      return;
    }

    call.sttSocket =
      sttSocket;

    call.ttsSocket =
      ttsSocket;

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

    sttSocket.on(
      "message",
      raw => {

        if (
          call.destroyed ||
          call.ending
        ) {

          return;
        }

        try {

          const message =
            JSON.parse(
              raw.toString()
            );

          const alternative =
            message
              ?.channel
              ?.alternatives?.[0];

          const transcript =
            alternative
              ?.transcript || "";

          if (
            !transcript
          ) {

            return;
          }

          const cleanTranscript =
            normalizeText(
              transcript
            );

          if (
            !cleanTranscript
          ) {

            return;
          }

          // ==================================================
          // INTERIM
          // ==================================================

          if (
            !message.is_final
          ) {

            call.lastInterim =
              cleanTranscript;

            call.lastSpeechTime =
              Date.now();

            // ------------------------------------------------
            // BARGE-IN
            // ------------------------------------------------

            if (
              call.aiSpeaking
            ) {

              const now =
                Date.now();

              // Ignore audio immediately after AI begins.
              if (
                now <
                call.ignoreBargeInUntil
              ) {

                return;
              }

              if (
                cleanTranscript.length <
                MIN_BARGE_IN_CHARS
              ) {

                return;
              }

              // Track start of caller speech.
              if (
                !call.callerSpeechStartedAt
              ) {

                call.callerSpeechStartedAt =
                  now;
              }

              const speechDuration =
                now -
                call.callerSpeechStartedAt;

              const lower =
                cleanTranscript
                  .toLowerCase();

              const explicitInterrupt =
                INTERRUPT_WORDS.some(
                  word =>
                    lower === word ||
                    lower.startsWith(
                      word + " "
                    )
                );

              // ------------------------------------------------
              // Only interrupt after sustained speech,
              // unless the phrase is an explicit command.
              // ------------------------------------------------

              if (
                explicitInterrupt ||
                speechDuration >=
                  BARGE_IN_MIN_DURATION_MS
              ) {

                interruptAI(
                  call,
                  explicitInterrupt
                    ? "explicit interrupt"
                    : "natural barge-in"
                );

                call.callerSpeechStartedAt =
                  0;
              }
            }

            return;
          }

          // ==================================================
          // FINAL SEGMENT
          // ==================================================

          call.speechFinalParts.push(
            cleanTranscript
          );

          call.lastInterim =
            "";

          // Speech has ended.
          call.callerSpeechStartedAt =
            0;

          // ==================================================
          // SPEECH FINAL
          // ==================================================

          if (
            message.speech_final
          ) {

            const question =
              normalizeText(
                call.speechFinalParts
                  .join(" ")
              );

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
            `[${call.id}] STT MESSAGE ERROR:`,
            error.message
          );
        }
      }
    );

    // ========================================================
    // TTS AUDIO
    // ========================================================

    ttsSocket.on(
      "message",
      (data, isBinary) => {

        if (
          call.destroyed
        ) {

          return;
        }

        try {

          // --------------------------------------------------
          // AUDIO
          // --------------------------------------------------

          if (
            isBinary ||
            Buffer.isBuffer(data)
          ) {

            const audio =
              Buffer.from(
                data
              );

            if (
              audio.length > 0 &&
              call.aiSpeaking
            ) {

              call.audioQueue.enqueue(
                audio
              );
            }

            return;
          }

          // --------------------------------------------------
          // JSON
          // --------------------------------------------------

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

            // Audio queue will drain naturally.
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

    sttSocket.on(
      "close",
      () => {

        call.sttReady =
          false;

        console.log(
          `[${call.id}] STT CLOSED`
        );

        // Do not immediately kill the call.
        // Exotel may continue sending audio.
      }
    );

    ttsSocket.on(
      "close",
      () => {

        call.ttsReady =
          false;

        console.log(
          `[${call.id}] TTS CLOSED`
        );
      }
    );

    sttSocket.on(
      "error",
      error => {

        console.log(
          `[${call.id}] STT ERROR:`,
          error.message
        );
      }
    );

    ttsSocket.on(
      "error",
      error => {

        console.log(
          `[${call.id}] TTS ERROR:`,
          error.message
        );
      }
    );

    // ========================================================
    // GREETING
    // ========================================================

    if (
      call.streamSid &&
      !call.greetingPlayed
    ) {

      setTimeout(
        () => {

          speakGreeting(
            call
          );

        },
        250
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
// EXOTEL CONNECTION
// ============================================================

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
      "=============================================="
    );

    console.log(
      `[${call.id}] EXOTEL CONNECTED`
    );

    console.log(
      `[${call.id}] ACTIVE CALLS:`,
      activeCalls.size
    );

    console.log(
      "=============================================="
    );

    // --------------------------------------------------------
    // Start STT/TTS immediately.
    // --------------------------------------------------------

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
              message.call_sid ||
              message.start?.call_sid ||
              message.start?.callSid ||
              null;

            // Exotel versions/configurations may expose
            // leg SID under different names.
            call.legSid =
              message.leg_sid ||
              message.start?.leg_sid ||
              message.start?.legSid ||
              message.start?.stream?.leg_sid ||
              null;

            console.log(
              `[${call.id}] CALL SID:`,
              call.callSid
            );

            console.log(
              `[${call.id}] STREAM SID:`,
              call.streamSid
            );

            console.log(
              `[${call.id}] LEG SID:`,
              call.legSid || "not provided"
            );

            // ------------------------------------------------
            // If Deepgram already connected, greet now.
            // ------------------------------------------------

            if (
              call.ttsReady &&
              !call.greetingPlayed
            ) {

              setTimeout(
                () => {

                  speakGreeting(
                    call
                  );

                },
                250
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

            if (
              !message.media?.payload
            ) {

              return;
            }

            if (
              !call.sttSocket ||
              call.sttSocket.readyState !==
                WebSocket.OPEN
            ) {

              return;
            }

            const audio =
              Buffer.from(
                message.media.payload,
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
              `[${call.id}] CALL STOP`
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
    // WEBSOCKET CLOSE
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
    // WEBSOCKET ERROR
    // ========================================================

    ws.on(
      "error",
      error => {

        console.log(
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
      "=============================================="
    );

    console.log(
      "      H&M FAST AI VOICE ASSISTANT"
    );

    console.log(
      "=============================================="
    );

    console.log(
      "Model:",
      GROQ_MODEL
    );

    console.log(
      "STT:",
      DEEPGRAM_STT_MODEL
    );

    console.log(
      "TTS:",
      DEEPGRAM_TTS_MODEL
    );

    console.log(
      "Tavily:",
      TAVILY_API_KEY
        ? "enabled"
        : "disabled"
    );

    console.log(
      "Exotel Hangup API:",
      (
        EXOTEL_API_KEY &&
        EXOTEL_API_TOKEN &&
        EXOTEL_ACCOUNT_SID
      )
        ? "enabled"
        : "disabled"
    );

    console.log(
      "WebSocket:",
      WS_URL
    );

    console.log(
      "=============================================="
    );
  }
);

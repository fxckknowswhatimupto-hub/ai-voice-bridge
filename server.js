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

// ============================================================
// PERFORMANCE
// ============================================================

const TAVILY_TIMEOUT_MS = 1200;

const GROQ_TIMEOUT_MS = 8000;

const STT_ENDPOINTING_MS = 180;

const TTS_SPEED = 1.15;

// ============================================================
// PHONE AUDIO
// ============================================================

const SAMPLE_RATE = 8000;

const BYTES_PER_SAMPLE = 2;

const EXOTEL_CHUNK_SIZE =
  160 * BYTES_PER_SAMPLE;

const EXOTEL_INTERVAL_MS = 20;

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
  throw new Error("GROQ_API_KEY is missing");
}

if (!DEEPGRAM_API_KEY) {
  throw new Error("DEEPGRAM_API_KEY is missing");
}

if (!TAVILY_API_KEY) {
  console.log(
    "WARNING: TAVILY_API_KEY is missing"
  );
}

// ============================================================
// CLIENT
// ============================================================

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

// ============================================================
// CALL MANAGEMENT
// ============================================================

const activeCalls = new Map();

let callCounter = 1;

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(
  (req, res) => {

    if (req.url === "/health") {

      res.writeHead(200, {
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok",
          service: "hm-voice-assistant",
          model: GROQ_MODEL,
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
        websocket: WS_URL,
        model: GROQ_MODEL,
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
// H&M SCOPE DETECTION
// ============================================================

function isHMScope(question) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

  const hmWords = [

    // Products
    "product",
    "products",
    "shirt",
    "shirts",
    "t-shirt",
    "tshirt",
    "top",
    "tops",
    "hoodie",
    "hoodies",
    "jacket",
    "jackets",
    "coat",
    "coats",
    "dress",
    "dresses",
    "jeans",
    "pants",
    "trousers",
    "shorts",
    "skirt",
    "skirts",
    "sweater",
    "sweaters",
    "shoes",
    "shoe",
    "socks",
    "bag",
    "bags",
    "accessories",
    "clothes",
    "clothing",
    "kids",
    "men",
    "women",
    "baby",

    // Shopping
    "buy",
    "purchase",
    "shop",
    "shopping",
    "available",
    "availability",
    "stock",
    "price",
    "cost",
    "sale",
    "discount",
    "offer",
    "offers",
    "collection",
    "new collection",
    "order",
    "orders",
    "cart",

    // Sizes
    "size",
    "sizes",
    "small",
    "medium",
    "large",
    "xl",
    "xxl",
    "xs",
    "fit",
    "fitting",
    "waist",
    "chest",
    "length",

    // H&M specific
    "h&m",
    "hm",
    "fashion",
    "fashionable"
  ];

  for (const word of hmWords) {

    if (q.includes(word)) {
      return true;
    }
  }

  return false;
}

// ============================================================
// LIVE SEARCH DETECTION
// ============================================================

function needsWebSearch(question) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

  const liveWords = [

    "available",
    "availability",
    "stock",
    "in stock",
    "price",
    "cost",
    "sale",
    "discount",
    "offer",
    "offers",
    "latest",
    "new",
    "current",
    "currently",
    "today",
    "now",
    "collection",
    "product",
    "products",
    "buy",
    "purchase",
    "shop",
    "shopping",
    "where can i buy",
    "which store",
    "store"
  ];

  for (const word of liveWords) {

    if (q.includes(word)) {
      return true;
    }
  }

  return false;
}

// ============================================================
// TAVILY
// ============================================================

async function searchWeb(question) {

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
        "TAVILY HTTP:",
        response.status
      );

      return "";
    }

    const data =
      await response.json();

    let information =
      "";

    if (data?.answer) {

      information +=
        data.answer + " ";
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
          `${result?.title || ""}: ` +
          `${result?.content || ""} `;
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
        "TAVILY TIMEOUT"
      );

    } else {

      console.log(
        "TAVILY ERROR:",
        error.message
      );
    }

    return "";

  } finally {

    clearTimeout(timeout);
  }
}

// ============================================================
// CREATE DEEPGRAM STT
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
        "&endpointing=" +
        STT_ENDPOINTING_MS +
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

      const timeout =
        setTimeout(
          () => {

            try {
              socket.close();
            } catch (_) {}

            reject(
              new Error(
                "Deepgram STT timeout"
              )
            );

          },
          7000
        );

      socket.once(
        "open",
        () => {

          clearTimeout(timeout);

          resolve(socket);
        }
      );

      socket.once(
        "error",
        (error) => {

          clearTimeout(timeout);

          reject(error);
        }
      );
    }
  );
}

// ============================================================
// CREATE DEEPGRAM TTS
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
        "&speed=" +
        TTS_SPEED;

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

      const timeout =
        setTimeout(
          () => {

            try {
              socket.close();
            } catch (_) {}

            reject(
              new Error(
                "Deepgram TTS timeout"
              )
            );

          },
          7000
        );

      socket.once(
        "open",
        () => {

          clearTimeout(timeout);

          resolve(socket);
        }
      );

      socket.once(
        "error",
        (error) => {

          clearTimeout(timeout);

          reject(error);
        }
      );
    }
  );
}

// ============================================================
// CLOSE SOCKET
// ============================================================

function closeSocket(socket) {

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
          type: "Close"
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

function createAudioQueue(call) {

  const queue = [];

  let timer = null;

  let sequenceNumber = 1;

  let chunkNumber = 0;

  let timestamp = 0;

  let stopped = false;

  function sendNext() {

    timer = null;

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
      queue.length = 0;
      return;
    }

    if (!call.streamSid) {
      return;
    }

    if (queue.length === 0) {
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
              chunk.toString(
                "base64"
              )
          }
        })
      );

      sequenceNumber++;

      chunkNumber++;

      timestamp +=
        EXOTEL_INTERVAL_MS;

    } catch (error) {

      console.log(
        `[${call.id}] AUDIO ERROR:`,
        error.message
      );

      return;
    }

    if (queue.length > 0) {

      timer =
        setTimeout(
          sendNext,
          EXOTEL_INTERVAL_MS
        );
    }
  }

  function enqueue(buffer) {

    if (
      stopped ||
      call.destroyed ||
      !buffer ||
      buffer.length === 0
    ) {
      return;
    }

    for (
      let offset = 0;
      offset < buffer.length;
      offset += EXOTEL_CHUNK_SIZE
    ) {

      const chunk =
        buffer.subarray(
          offset,
          Math.min(
            offset +
              EXOTEL_CHUNK_SIZE,
            buffer.length
          )
        );

      queue.push(chunk);
    }

    if (!timer) {
      sendNext();
    }
  }

  function clear() {

    queue.length = 0;

    if (timer) {

      clearTimeout(timer);

      timer = null;
    }
  }

  function stop() {

    stopped = true;

    clear();
  }

  function hasPending() {

    return (
      queue.length > 0 ||
      Boolean(timer)
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

function clearExotelAudio(call) {

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

        event: "clear",

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
// TTS SEND
// ============================================================

function sendTTS(call, text) {

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

        type: "Speak",

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
// TTS FLUSH
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

  } catch (error) {

    console.log(
      `[${call.id}] TTS FLUSH ERROR:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// RECREATE TTS AFTER INTERRUPTION
// ============================================================

async function restartTTS(call) {

  const oldSocket =
    call.ttsSocket;

  call.ttsSocket = null;

  closeSocket(oldSocket);

  try {

    const socket =
      await createDeepgramTTS();

    if (call.destroyed) {

      closeSocket(socket);

      return;
    }

    call.ttsSocket =
      socket;

    attachTTSEvents(
      call,
      socket
    );

    console.log(
      `[${call.id}] TTS RESTARTED`
    );

  } catch (error) {

    console.log(
      `[${call.id}] TTS RESTART ERROR:`,
      error.message
    );
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
    call.destroyed
  ) {
    return;
  }

  console.log(
    `[${call.id}] 🔴 INTERRUPT:`,
    reason
  );

  // ========================================================
  // INVALIDATE OLD RESPONSE
  // ========================================================

  call.responseGeneration++;

  call.aiSpeaking =
    false;

  // ========================================================
  // ABORT GROQ
  // ========================================================

  if (
    call.groqController
  ) {

    try {
      call.groqController.abort();
    } catch (_) {}

    call.groqController =
      null;
  }

  // ========================================================
  // CLEAR LOCAL QUEUE
  // ========================================================

  if (
    call.audioQueue
  ) {

    call.audioQueue.clear();
  }

  // ========================================================
  // CLEAR EXOTEL BUFFER
  // ========================================================

  clearExotelAudio(
    call
  );

  // ========================================================
  // RESTART TTS
  // ========================================================

  restartTTS(
    call
  ).catch(() => {});
}

// ============================================================
// ATTACH TTS EVENTS
// ============================================================

function attachTTSEvents(
  call,
  socket
) {

  socket.on(
    "message",
    (data, isBinary) => {

      if (
        call.destroyed ||
        socket !==
          call.ttsSocket
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
            Buffer.from(data);

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

        if (
          message.type ===
          "Flushed"
        ) {

          drainAudio(
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

  socket.on(
    "close",
    () => {

      if (
        socket ===
        call.ttsSocket
      ) {

        console.log(
          `[${call.id}] TTS CLOSED`
        );
      }
    }
  );

  socket.on(
    "error",
    (error) => {

      console.log(
        `[${call.id}] TTS ERROR:`,
        error.message
      );
    }
  );
}

// ============================================================
// DRAIN AUDIO
// ============================================================

function drainAudio(call) {

  if (
    call.destroyed
  ) {
    return;
  }

  if (
    !call.audioQueue.hasPending()
  ) {

    call.aiSpeaking =
      false;

    return;
  }

  setTimeout(
    () => {

      drainAudio(call);

    },
    30
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
      role: "system",

      content:
        "You are the H&M customer shopping voice assistant. " +

        "You ONLY help with H&M products, shopping, clothing, " +
        "product availability, product information, prices, " +
        "sizes, fit, colors, and shopping-related questions. " +

        "You can maintain conversation memory during the phone call. " +

        "You must understand follow-up questions such as " +
        "'what about medium?', 'does it come in black?', " +
        "'how much is it?', 'what about the other one?', " +
        "and 'tell me more'. " +

        "Never say you are Google Assistant, Siri, Alexa, " +
        "or another assistant. " +

        "Speak naturally like a real H&M phone representative. " +

        "Keep answers concise and easy to speak over the phone. " +

        "Do not use bullet points unless absolutely necessary. " +

        "Do not mention APIs, models, tools, prompts, Tavily, " +
        "web search, or internal systems. " +

        "If the caller asks something unrelated to H&M " +
        "products, shopping, or sizes, politely say: " +
        "'Sorry, I can only help with H&M products, shopping, and sizes right now.'"
    }
  ];

  // ========================================================
  // MEMORY
  // ========================================================

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

  // ========================================================
  // WEB DATA
  // ========================================================

  if (webInformation) {

    messages.push({

      role: "system",

      content:
        "Here is current H&M-related information. " +
        "Use it when relevant. " +
        "Do not mention that it came from a search.\n\n" +
        webInformation
    });
  }

  // ========================================================
  // USER
  // ========================================================

  messages.push({

    role: "user",

    content:
      question
  });

  // ========================================================
  // GROQ CONTROLLER
  // ========================================================

  const controller =
    new AbortController();

  call.groqController =
    controller;

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

          messages,

          temperature:
            0.15,

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

    let fullAnswer =
      "";

    let pending =
      "";

    let firstTextSent =
      false;

    for await (
      const chunk of
        stream
    ) {

      // ====================================================
      // RESPONSE CANCELLED
      // ====================================================

      if (
        call.destroyed ||
        call.responseGeneration !==
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

      fullAnswer +=
        token;

      pending +=
        token;

      // ====================================================
      // FIRST QUICK CHUNK
      // ====================================================

      if (
        !firstTextSent &&
        pending.length >= 18
      ) {

        const firstSpace =
          pending.lastIndexOf(" ");

        if (
          firstSpace >= 10
        ) {

          const piece =
            pending
              .slice(
                0,
                firstSpace
              )
              .trim();

          pending =
            pending
              .slice(
                firstSpace + 1
              )
              .trimStart();

          if (piece) {

            if (
              call.responseGeneration !==
              generation
            ) {
              break;
            }

            sendTTS(
              call,
              piece
            );

            firstTextSent =
              true;

            call.aiSpeaking =
              true;
          }
        }
      }

      // ====================================================
      // SENTENCE CHUNKS
      // ====================================================

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
          call.responseGeneration !==
            generation
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

        if (!sentence) {
          continue;
        }

        sendTTS(
          call,
          sentence
        );

        call.aiSpeaking =
          true;
      }

      // ====================================================
      // MEDIUM CHUNK
      // ====================================================

      if (
        pending.length >= 45
      ) {

        const lastSpace =
          pending.lastIndexOf(" ");

        if (
          lastSpace >= 20
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
            call.responseGeneration ===
              generation
          ) {

            sendTTS(
              call,
              piece
            );

            call.aiSpeaking =
              true;
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
      call.responseGeneration ===
        generation
    ) {

      sendTTS(
        call,
        pending.trim()
      );

      call.aiSpeaking =
        true;
    }

    return fullAnswer
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  } finally {

    clearTimeout(timeout);

    if (
      call.groqController ===
      controller
    ) {

      call.groqController =
        null;
    }
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

  const cleanQuestion =
    String(question)
      .replace(/\s+/g, " ")
      .trim();

  if (!cleanQuestion) {
    return;
  }

  console.log(
    `[${call.id}] QUESTION:`,
    cleanQuestion
  );

  const generation =
    ++call.responseGeneration;

  call.aiSpeaking =
    false;

  const started =
    Date.now();

  try {

    // ========================================================
    // SCOPE CHECK
    // ========================================================

    if (
      !isHMScope(
        cleanQuestion
      )
    ) {

      const fallback =
        "Sorry, I can only help with H&M products, shopping, and sizes right now.";

      sendTTS(
        call,
        fallback
      );

      call.aiSpeaking =
        true;

      flushTTS(
        call
      );

      console.log(
        `[${call.id}] OUT OF SCOPE`
      );

      return;
    }

    // ========================================================
    // WEB SEARCH
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

    if (
      call.destroyed ||
      call.responseGeneration !==
        generation
    ) {

      return;
    }

    // ========================================================
    // GROQ
    // ========================================================

    const answer =
      await streamGroq(
        call,
        cleanQuestion,
        webInformation,
        generation
      );

    // ========================================================
    // CANCELLED
    // ========================================================

    if (
      call.destroyed ||
      call.responseGeneration !==
        generation
    ) {

      console.log(
        `[${call.id}] RESPONSE CANCELLED`
      );

      return;
    }

    // ========================================================
    // FLUSH TTS
    // ========================================================

    flushTTS(
      call
    );

    // ========================================================
    // MEMORY
    // ========================================================

    if (answer) {

      call.conversationHistory.push({

        role: "user",

        content:
          cleanQuestion
      });

      call.conversationHistory.push({

        role: "assistant",

        content:
          answer
      });

      // Keep last 5 exchanges.
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
        started,
      "ms"
    );

  } catch (error) {

    if (
      call.destroyed ||
      call.responseGeneration !==
        generation
    ) {

      return;
    }

    console.log(
      `[${call.id}] PROCESS ERROR:`,
      error.message
    );

    const fallback =
      "Sorry, I couldn't process that right now.";

    sendTTS(
      call,
      fallback
    );

    flushTTS(
      call
    );

  } finally {

    // Don't mark false immediately if TTS
    // is still draining.
  }
}

// ============================================================
// QUESTION QUEUE
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
    String(question)
      .replace(/\s+/g, " ")
      .trim();

  if (!clean) {
    return;
  }

  // ========================================================
  // INTERRUPT CURRENT AI
  // ========================================================

  if (
    call.aiSpeaking
  ) {

    interruptAI(
      call,
      "caller speech"
    );
  }

  // Newest question gets priority.
  call.questionQueue =
    [clean];

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
      call.questionQueue.length > 0 &&
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
// CREATE CALL
// ============================================================

function createCall(ws) {

  const id =
    "CALL-" +
    String(
      callCounter++
    );

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

    responseGeneration:
      0,

    groqController:
      null
  };

  call.audioQueue =
    createAudioQueue(
      call
    );

  return call;
}

// ============================================================
// GREETING
// ============================================================

function speakGreeting(call) {

  if (
    call.destroyed
  ) {
    return;
  }

  const greeting =
    "Hi! Welcome to H&M. How can I help you with products, shopping, or sizes today?";

  sendTTS(
    call,
    greeting
  );

  call.aiSpeaking =
    true;

  flushTTS(
    call
  );
}

// ============================================================
// SETUP DEEPGRAM
// ============================================================

async function setupDeepgram(
  call
) {

  try {

    const stt =
      await createDeepgramSTT();

    if (call.destroyed) {

      closeSocket(stt);

      return;
    }

    call.sttSocket =
      stt;

    call.sttReady =
      true;

    // ========================================================
    // STT MESSAGE
    // ========================================================

    stt.on(
      "message",
      (raw) => {

        if (
          call.destroyed
        ) {
          return;
        }

        try {

          const message =
            JSON.parse(
              raw.toString()
            );

          const transcript =
            message
              ?.channel
              ?.alternatives?.[0]
              ?.transcript || "";

          if (!transcript) {
            return;
          }

          // ==================================================
          // INTERIM
          // ==================================================

          if (
            !message.is_final
          ) {

            call.lastInterim =
              transcript;

            // =================================================
            // BARGE-IN
            // =================================================

            if (
              call.aiSpeaking &&
              transcript
                .trim()
                .length >= 2
            ) {

              const text =
                transcript
                  .toLowerCase()
                  .trim();

              const explicitStop =
                /^(stop|wait|hold on|hang on|no wait|that's enough|enough|pause|be quiet|stop talking)\b/i
                  .test(text);

              // We interrupt on ANY meaningful speech.
              // This makes the assistant feel like a real
              // phone conversation.
              const naturalInterrupt =
                text.length >= 3;

              if (
                explicitStop ||
                naturalInterrupt
              ) {

                interruptAI(
                  call,
                  explicitStop
                    ? "explicit stop"
                    : "natural barge-in"
                );
              }
            }

            return;
          }

          // ==================================================
          // FINAL
          // ==================================================

          call.speechFinalParts.push(
            transcript
          );

          call.lastInterim =
            "";

          if (
            message.speech_final
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

            if (question) {

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
    // STT CLOSE
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

    stt.on(
      "error",
      (error) => {

        console.log(
          `[${call.id}] STT ERROR:`,
          error.message
        );
      }
    );

    // ========================================================
    // TTS
    // ========================================================

    const tts =
      await createDeepgramTTS();

    if (call.destroyed) {

      closeSocket(tts);

      return;
    }

    call.ttsSocket =
      tts;

    call.ttsReady =
      true;

    attachTTSEvents(
      call,
      tts
    );

    console.log(
      `[${call.id}] DEEPGRAM READY`
    );

    // ========================================================
    // AI SPEAKS FIRST
    // ========================================================

    if (
      call.streamSid
    ) {

      speakGreeting(
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

  call.responseGeneration++;

  if (
    call.groqController
  ) {

    try {
      call.groqController.abort();
    } catch (_) {}
  }

  call.questionQueue =
    [];

  call.speechFinalParts =
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
    `[${call.id}] CALL DESTROYED`
  );

  console.log(
    "ACTIVE CALLS:",
    activeCalls.size
  );
}

// ============================================================
// EXOTEL CONNECTION
// ============================================================

wss.on(
  "connection",
  (ws) => {

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
      `[${call.id}] NEW CALL`
    );

    console.log(
      "ACTIVE CALLS:",
      activeCalls.size
    );

    console.log(
      "============================================"
    );

    // ========================================================
    // CONNECT DEEPGRAM
    // ========================================================

    setupDeepgram(
      call
    ).catch(
      (error) => {

        console.log(
          `[${call.id}] SETUP ERROR:`,
          error.message
        );
      }
    );

    // ========================================================
    // EXOTEL MESSAGE
    // ========================================================

    ws.on(
      "message",
      (data) => {

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
              `[${call.id}] EXOTEL CONNECTED`
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
              `[${call.id}] CALL SID:`,
              call.callSid
            );

            console.log(
              `[${call.id}] STREAM SID:`,
              call.streamSid
            );

            // If Deepgram finished before
            // Exotel START arrived, speak now.
            if (
              call.ttsReady &&
              call.streamSid &&
              !call.aiSpeaking
            ) {

              speakGreeting(
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
                `[${call.id}] AUDIO -> STT ERROR:`,
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
            `[${call.id}] EXOTEL ERROR:`,
            error.message
          );
        }
      }
    );

    // ========================================================
    // WS CLOSE
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
    // WS ERROR
    // ========================================================

    ws.on(
      "error",
      (error) => {

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
  (error) => {

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
      "H&M FAST AI VOICE ASSISTANT"
    );

    console.log(
      "============================================"
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
      "Active calls:",
      activeCalls.size
    );

    console.log(
      "============================================"
    );
  }
);

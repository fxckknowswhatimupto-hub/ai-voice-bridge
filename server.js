const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ==================================================
// CONFIG
// ==================================================

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

// ==================================================
// PERFORMANCE
// ==================================================

const TAVILY_TIMEOUT_MS = 1800;
const GROQ_TIMEOUT_MS = 10000;

const AUDIO_CHUNK_SIZE = 320;
const AUDIO_INTERVAL_MS = 20;

// ==================================================
// ENVIRONMENT
// ==================================================

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
  console.log("WARNING: TAVILY_API_KEY is missing");
}

// ==================================================
// CLIENT
// ==================================================

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

// ==================================================
// ACTIVE CALLS
// ==================================================

const activeCalls = new Map();

let nextCallNumber = 1;

// ==================================================
// HTTP SERVER
// ==================================================

const server = http.createServer((req, res) => {

  if (req.url === "/health") {

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      status: "ok",
      service: "hm-ai-shopping-assistant",
      model: GROQ_MODEL,
      activeCalls: activeCalls.size
    }));

    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json"
  });

  res.end(JSON.stringify({
    status: "ok",
    service: "H&M AI Shopping Assistant",
    websocket: WS_URL,
    model: GROQ_MODEL,
    activeCalls: activeCalls.size
  }));
});

// ==================================================
// WEBSOCKET SERVER
// ==================================================

const wss = new WebSocket.Server({
  server
});

// ==================================================
// H&M SUPPORTED INTENTS
// ==================================================

function isUnsupportedRequest(question) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

  const unsupportedPatterns = [

    "return",
    "returns",
    "refund",
    "refunds",
    "exchange",
    "exchanges",

    "delivery status",
    "track my order",
    "track order",
    "where is my order",
    "order status",

    "payment",
    "payments",
    "credit card",
    "debit card",
    "upi",
    "cash on delivery",

    "complaint",
    "complaints",
    "customer service complaint",

    "cancel my order",
    "cancel order",

    "store location",
    "store locations",
    "nearest store",
    "find a store",
    "stores near me",

    "opening hours",
    "opening time",
    "store timing",
    "store timings",

    "gift card",
    "gift cards",

    "membership",
    "member account",
    "account problem",

    "contact customer service",
    "speak to an employee",
    "speak to a human",
    "human agent",

    "shipping",
    "delivery",
    "deliver my order",

    "invoice",
    "receipt",

    "damaged product",
    "wrong product",
    "missing product"
  ];

  return unsupportedPatterns.some(
    pattern => q.includes(pattern)
  );
}

// ==================================================
// H&M PRODUCT / SHOPPING DETECTION
// ==================================================

function needsProductSearch(question) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

  const productWords = [

    "product",
    "products",
    "clothes",
    "clothing",

    "shirt",
    "shirts",
    "tshirt",
    "t-shirt",
    "t shirts",

    "hoodie",
    "hoodies",

    "sweater",
    "sweaters",

    "jacket",
    "jackets",

    "coat",
    "coats",

    "jeans",
    "pants",
    "trousers",

    "shorts",

    "dress",
    "dresses",

    "skirt",
    "skirts",

    "top",
    "tops",

    "blouse",
    "blouses",

    "suit",
    "suits",

    "shoes",
    "shoe",

    "sneakers",
    "boots",

    "sandals",

    "bag",
    "bags",

    "accessories",

    "kids",
    "women",
    "womens",
    "women's",

    "men",
    "mens",
    "men's"
  ];

  const shoppingWords = [

    "buy",
    "want",
    "looking for",
    "looking to buy",
    "find me",
    "recommend",
    "recommendation",
    "suggest",
    "suggestion",

    "available",
    "availability",

    "price",
    "prices",
    "cost",

    "cheap",
    "affordable",

    "under",
    "budget",

    "black",
    "white",
    "blue",
    "red",
    "green",
    "brown",
    "pink",

    "size",
    "sizes",
    "fit",
    "fitting",
    "medium",
    "small",
    "large",
    "xl",
    "xxl"
  ];

  return (
    productWords.some(
      word => q.includes(word)
    ) ||
    shoppingWords.some(
      word => q.includes(word)
    )
  );
}

// ==================================================
// TAVILY SEARCH
// ==================================================

async function searchHM(question) {

  if (!TAVILY_API_KEY) {
    return "";
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, TAVILY_TIMEOUT_MS);

  try {

    const searchQuery =
      `H&M official products shopping sizes ${question}`;

    const response =
      await fetch(
        "https://api.tavily.com/search",
        {
          method: "POST",

          headers: {
            Authorization:
              "Bearer " + TAVILY_API_KEY,

            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            query:
              searchQuery,

            search_depth:
              "basic",

            topic:
              "general",

            max_results:
              3,

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

    let information = "";

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
        const result of data.results
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
      error.name === "AbortError"
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

    clearTimeout(timeout);
  }
}

// ==================================================
// DEEPGRAM STT
// ==================================================

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
        "&endpointing=200" +
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

      let settled = false;

      const timeout =
        setTimeout(() => {

          if (!settled) {

            try {
              socket.close();
            } catch (_) {}

            reject(
              new Error(
                "Deepgram STT timeout"
              )
            );
          }

        }, 7000);

      socket.once(
        "open",
        () => {

          settled = true;

          clearTimeout(timeout);

          resolve(socket);
        }
      );

      socket.once(
        "error",
        error => {

          if (!settled) {

            clearTimeout(timeout);

            reject(error);
          }
        }
      );
    }
  );
}

// ==================================================
// DEEPGRAM TTS
// ==================================================

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

      let settled = false;

      const timeout =
        setTimeout(() => {

          if (!settled) {

            try {
              socket.close();
            } catch (_) {}

            reject(
              new Error(
                "Deepgram TTS timeout"
              )
            );
          }

        }, 7000);

      socket.once(
        "open",
        () => {

          settled = true;

          clearTimeout(timeout);

          resolve(socket);
        }
      );

      socket.once(
        "error",
        error => {

          if (!settled) {

            clearTimeout(timeout);

            reject(error);
          }
        }
      );
    }
  );
}

// ==================================================
// CLOSE DEEPGRAM
// ==================================================

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
          type: "Close"
        })
      );
    }

  } catch (_) {}

  try {
    socket.close();
  } catch (_) {}
}

// ==================================================
// AUDIO QUEUE
// ==================================================

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

    const audio =
      queue.shift();

    const chunk =
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

          event: "media",

          sequence_number:
            String(
              sequenceNumber
            ),

          stream_sid:
            call.streamSid,

          media: {

            chunk:
              String(
                chunkNumber
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

      sequenceNumber++;
      chunkNumber++;

      timestamp +=
        AUDIO_INTERVAL_MS;

    } catch (error) {

      console.log(
        `[${call.id}] AUDIO ERROR:`,
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
      pcmBuffer.length === 0
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

  function hasPendingAudio() {

    return (
      queue.length > 0 ||
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

// ==================================================
// EXOTEL MARK
// ==================================================

function sendExotelMark(call) {

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

        event: "mark",

        stream_sid:
          call.streamSid,

        mark: {
          name:
            "ai_response_complete"
        }
      })
    );

  } catch (error) {

    console.log(
      `[${call.id}] MARK ERROR:`,
      error.message
    );
  }
}

// ==================================================
// SEND TTS
// ==================================================

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

        type: "Speak",

        text
      })
    );

    return true;

  } catch (error) {

    console.log(
      `[${call.id}] TTS ERROR:`,
      error.message
    );

    return false;
  }
}

// ==================================================
// FLUSH TTS
// ==================================================

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

// ==================================================
// INTERRUPT AI
// ==================================================

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

  if (!call.aiSpeaking) {
    return;
  }

  console.log(
    `[${call.id}] 🔴 INTERRUPTED: ${reason}`
  );

  // Invalidate old response.
  call.ttsGeneration++;

  call.aiSpeaking = false;

  // Stop local queue.
  if (call.audioSender) {
    call.audioSender.clear();
  }

  // Tell Exotel to clear queued audio.
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

    } catch (_) {}
  }

  // Flush Deepgram TTS.
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
}

// ==================================================
// WAIT FOR AUDIO
// ==================================================

function waitForAudioDrain(call) {

  if (
    call.destroyed
  ) {
    return;
  }

  if (
    !call.audioSender.hasPendingAudio()
  ) {

    sendExotelMark(call);

    return;
  }

  setTimeout(
    () => {
      waitForAudioDrain(call);
    },
    40
  );
}

// ==================================================
// STREAM GROQ
// ==================================================

async function streamGroq(
  call,
  question,
  webInformation,
  onText,
  generation
) {

  const messages = [

    {
      role: "system",

      content:

        "You are the official-style H&M AI shopping assistant. " +

        "You help callers with H&M products, shopping and sizes. " +

        "You are NOT Google Assistant, Siri or Alexa. " +

        "Never claim to be a human. " +

        "Speak naturally like a real phone shopping assistant. " +

        "The caller can interrupt you at any time. " +

        "Answer the latest question and continue the conversation naturally. " +

        "Remember everything relevant from the current phone call. " +

        "For product questions, help identify clothing and suitable options. " +

        "For shopping questions, help the customer decide what to buy. " +

        "For size questions, explain sizing and fit using available information. " +

        "If current product information is supplied, use it. " +

        "Never invent exact availability, prices or stock. " +

        "Keep simple answers short and natural. " +

        "Do not mention Tavily, Groq, Deepgram, APIs or internal systems. " +

        "Do not give long unnecessary introductions."
    }
  ];

  // ==================================================
  // MEMORY
  // ==================================================

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

  // ==================================================
  // WEB INFORMATION
  // ==================================================

  if (webInformation) {

    messages.push({

      role: "system",

      content:
        "CURRENT H&M PRODUCT INFORMATION:\n" +
        webInformation +
        "\n\n" +
        "Use this information when relevant. " +
        "Do not mention that you searched the web."
    });
  }

  // ==================================================
  // USER
  // ==================================================

  messages.push({

    role: "user",

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

          messages,

          temperature:
            0.2,

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

    let fullAnswer = "";
    let pendingText = "";

    for await (
      const chunk of stream
    ) {

      // Old response?
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

      fullAnswer += token;
      pendingText += token;

      // ==================================================
      // SENTENCES
      // ==================================================

      let match;

      while (
        (
          match =
            pendingText.match(
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
            .replace(
              /\s+/g,
              " "
            )
            .trim();

        pendingText =
          pendingText
            .slice(
              match[0].length
            )
            .trimStart();

        if (sentence) {

          await onText(
            sentence
          );
        }
      }

      // ==================================================
      // EARLY CHUNK
      // ==================================================

      if (
        pendingText.length >= 45
      ) {

        const lastSpace =
          pendingText.lastIndexOf(
            " "
          );

        if (
          lastSpace >= 20
        ) {

          const chunkText =
            pendingText
              .slice(
                0,
                lastSpace
              )
              .trim();

          pendingText =
            pendingText
              .slice(
                lastSpace + 1
              )
              .trimStart();

          if (chunkText) {

            await onText(
              chunkText
            );
          }
        }
      }
    }

    // ==================================================
    // REMAINING TEXT
    // ==================================================

    if (
      pendingText.trim() &&
      !call.destroyed &&
      call.ttsGeneration ===
      generation
    ) {

      await onText(
        pendingText
          .replace(
            /\s+/g,
            " "
          )
          .trim()
      );
    }

    return fullAnswer
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  } finally {

    clearTimeout(timeout);
  }
}

// ==================================================
// PROCESS QUESTION
// ==================================================

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
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (!cleanQuestion) {
    return;
  }

  console.log(
    `[${call.id}] CUSTOMER:`,
    cleanQuestion
  );

  // ==================================================
  // UNSUPPORTED REQUEST
  // ==================================================

  if (
    isUnsupportedRequest(
      cleanQuestion
    )
  ) {

    const generation =
      ++call.ttsGeneration;

    call.aiSpeaking = true;

    sendTextToTTS(
      call,
      "Sorry, this option is unavailable right now."
    );

    flushTTS(call);

    call.conversationHistory.push({

      role: "user",

      content:
        cleanQuestion
    });

    call.conversationHistory.push({

      role: "assistant",

      content:
        "Sorry, this option is unavailable right now."
    });

    if (
      call.conversationHistory.length >
      10
    ) {

      call.conversationHistory =
        call.conversationHistory.slice(
          -10
        );
    }

    console.log(
      `[${call.id}] UNSUPPORTED REQUEST`
    );

    return;
  }

  // ==================================================
  // NEW RESPONSE
  // ==================================================

  const generation =
    ++call.ttsGeneration;

  call.aiSpeaking = true;

  let sentTTS = false;

  try {

    // ==================================================
    // SEARCH
    // ==================================================

    let webInformation = "";

    if (
      needsProductSearch(
        cleanQuestion
      )
    ) {

      console.log(
        `[${call.id}] H&M PRODUCT SEARCH`
      );

      webInformation =
        await searchHM(
          cleanQuestion
        );
    }

    if (
      call.destroyed ||
      call.ttsGeneration !==
      generation
    ) {
      return;
    }

    // ==================================================
    // STREAM TO TTS
    // ==================================================

    const sendText =
      async text => {

        if (
          call.destroyed ||
          call.ttsGeneration !==
          generation ||
          !call.aiSpeaking
        ) {
          return;
        }

        const sent =
          sendTextToTTS(
            call,
            text
          );

        if (sent) {
          sentTTS = true;
        }
      };

    // ==================================================
    // GROQ
    // ==================================================

    const answer =
      await streamGroq(
        call,
        cleanQuestion,
        webInformation,
        sendText,
        generation
      );

    if (
      call.destroyed ||
      call.ttsGeneration !==
      generation
    ) {
      return;
    }

    // ==================================================
    // FLUSH
    // ==================================================

    if (sentTTS) {
      flushTTS(call);
    }

    // ==================================================
    // MEMORY
    // ==================================================

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
      `[${call.id}] H&M AI:`,
      answer
    );

  } catch (error) {

    if (
      call.destroyed ||
      call.ttsGeneration !==
      generation
    ) {
      return;
    }

    console.log(
      `[${call.id}] PROCESS ERROR:`,
      error.message
    );

    sendTextToTTS(
      call,
      "Sorry, I had trouble helping with that."
    );

    flushTTS(call);

  } finally {

    if (
      call.ttsGeneration ===
      generation
    ) {

      call.aiSpeaking = false;
    }
  }
}

// ==================================================
// QUESTION QUEUE
// ==================================================

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
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (!clean) {
    return;
  }

  // If AI is talking, interrupt it.
  if (
    call.aiSpeaking
  ) {

    interruptAI(
      call,
      "caller interruption"
    );

    call.questionQueue = [];
  }

  // Latest question has priority.
  call.questionQueue.unshift(
    clean
  );

  runQuestionQueue(call);
}

// ==================================================
// QUESTION QUEUE RUNNER
// ==================================================

async function runQuestionQueue(
  call
) {

  if (
    call.queueRunning ||
    call.destroyed
  ) {
    return;
  }

  call.queueRunning = true;

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

    call.queueRunning = false;
  }
}

// ==================================================
// CREATE CALL
// ==================================================

function createCallSession(ws) {

  const id =
    "CALL-" +
    nextCallNumber++;

  const call = {

    id,

    ws,

    destroyed: false,

    streamSid: null,

    callSid: null,

    sttSocket: null,

    ttsSocket: null,

    sttReady: false,

    ttsReady: false,

    speechFinalParts: [],

    lastInterim: "",

    conversationHistory: [],

    questionQueue: [],

    queueRunning: false,

    aiSpeaking: false,

    ttsGeneration: 0,

    audioSender: null
  };

  call.audioSender =
    createAudioQueue(call);

  return call;
}

// ==================================================
// GREETING
// ==================================================

function sendGreeting(call) {

  if (
    call.destroyed
  ) {
    return;
  }

  const generation =
    ++call.ttsGeneration;

  call.aiSpeaking = true;

  const greeting =
    "Hi! Welcome to H&M. I'm your AI shopping assistant. I can help you find products, choose what to buy, and help with sizes. What are you looking for today?";

  sendTextToTTS(
    call,
    greeting
  );

  flushTTS(call);

  call.conversationHistory.push({

    role: "assistant",

    content:
      greeting
  });

  console.log(
    `[${call.id}] GREETING SENT`
  );
}

// ==================================================
// DESTROY CALL
// ==================================================

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

  call.speechFinalParts = [];

  call.lastInterim = "";

  if (
    call.audioSender
  ) {

    call.audioSender.stop();
  }

  closeDeepgramSocket(
    call.sttSocket
  );

  closeDeepgramSocket(
    call.ttsSocket
  );

  call.sttSocket = null;
  call.ttsSocket = null;

  activeCalls.delete(
    call.id
  );

  console.log(
    `[${call.id}] CALL CLEANED`
  );

  console.log(
    "ACTIVE CALLS:",
    activeCalls.size
  );
}

// ==================================================
// SETUP DEEPGRAM
// ==================================================

async function setupDeepgram(call) {

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

    call.sttReady = true;
    call.ttsReady = true;

    console.log(
      `[${call.id}] DEEPGRAM READY`
    );

    // ==================================================
    // STT
    // ==================================================

    sttSocket.on(
      "message",
      raw => {

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

              const explicitInterrupt =
                /^(stop|wait|hold on|hang on|no|no wait|enough|that's enough|pause)\b/i
                  .test(lower);

              const naturalBargeIn =
                lower.length >= 3;

              if (
                explicitInterrupt ||
                naturalBargeIn
              ) {

                interruptAI(
                  call,
                  explicitInterrupt
                    ? "explicit stop"
                    : "caller started speaking"
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

          call.lastInterim = "";

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

            call.speechFinalParts = [];

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

    // ==================================================
    // TTS AUDIO
    // ==================================================

    ttsSocket.on(
      "message",
      (data, isBinary) => {

        if (
          call.destroyed
        ) {
          return;
        }

        try {

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

              call.audioSender.enqueue(
                audio
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

    // ==================================================
    // SOCKET EVENTS
    // ==================================================

    sttSocket.on(
      "close",
      () => {

        call.sttReady = false;

        console.log(
          `[${call.id}] STT CLOSED`
        );
      }
    );

    ttsSocket.on(
      "close",
      () => {

        call.ttsReady = false;

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

    // ==================================================
    // GREETING AFTER TTS READY
    // ==================================================

    setTimeout(
      () => {

        if (
          !call.destroyed &&
          call.streamSid
        ) {

          sendGreeting(call);
        }

      },
      250
    );

  } catch (error) {

    console.log(
      `[${call.id}] DEEPGRAM SETUP ERROR:`,
      error.message
    );
  }
}

// ==================================================
// EXOTEL CONNECTION
// ==================================================

wss.on(
  "connection",
  ws => {

    const call =
      createCallSession(ws);

    activeCalls.set(
      call.id,
      call
    );

    console.log(
      "======================================"
    );

    console.log(
      `[${call.id}] H&M CALL CONNECTED`
    );

    console.log(
      "ACTIVE CALLS:",
      activeCalls.size
    );

    console.log(
      "======================================"
    );

    // ==================================================
    // START DEEPGRAM
    // ==================================================

    setupDeepgram(call);

    // ==================================================
    // EXOTEL EVENTS
    // ==================================================

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
            event === "connected"
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

            console.log(
              `[${call.id}] CALL START:`,
              call.callSid
            );

            console.log(
              `[${call.id}] STREAM:`,
              call.streamSid
            );

            // Greeting is triggered here
            // if Deepgram is already ready.
            if (
              call.ttsReady
            ) {

              setTimeout(
                () => {

                  if (
                    !call.destroyed
                  ) {

                    sendGreeting(call);
                  }

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
            event === "media"
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
          // STOP
          // ==================================================

          if (
            event === "stop"
          ) {

            console.log(
              `[${call.id}] CALL STOP`
            );

            destroyCall(call);

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

    // ==================================================
    // CLOSE
    // ==================================================

    ws.on(
      "close",
      () => {

        console.log(
          `[${call.id}] EXOTEL DISCONNECTED`
        );

        destroyCall(call);
      }
    );

    // ==================================================
    // ERROR
    // ==================================================

    ws.on(
      "error",
      error => {

        console.log(
          `[${call.id}] EXOTEL ERROR:`,
          error.message
        );

        destroyCall(call);
      }
    );
  }
);

// ==================================================
// SERVER ERROR
// ==================================================

server.on(
  "error",
  error => {

    console.error(
      "SERVER ERROR:",
      error
    );
  }
);

// ==================================================
// START SERVER
// ==================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "======================================"
    );

    console.log(
      "        H&M AI SHOPPING ASSISTANT"
    );

    console.log(
      "======================================"
    );

    console.log(
      "Groq:",
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
      "WebSocket:",
      WS_URL
    );

    console.log(
      "======================================"
    );
  }
);

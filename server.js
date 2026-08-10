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

const SAMPLE_RATE = 8000;

// 20ms phone audio = 160 samples * 2 bytes
const AUDIO_CHUNK_SIZE = 320;
const AUDIO_INTERVAL = 20;

// ============================================================
// TIMEOUTS
// ============================================================

const TAVILY_TIMEOUT = 1800;
const GROQ_TIMEOUT = 12000;
const DEEPGRAM_CONNECT_TIMEOUT = 7000;

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
  console.log("WARNING: TAVILY_API_KEY missing");
}

// ============================================================
// CLIENTS
// ============================================================

const groq =
  new Groq({
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

const server =
  http.createServer((req, res) => {

    res.setHeader(
      "Content-Type",
      "application/json"
    );

    if (req.url === "/health") {

      res.writeHead(200);

      res.end(
        JSON.stringify({
          status: "ok",
          service: "h-and-m-ai-assistant",
          model: GROQ_MODEL,
          activeCalls: activeCalls.size
        })
      );

      return;
    }

    res.writeHead(200);

    res.end(
      JSON.stringify({
        status: "ok",
        websocket: WS_URL,
        activeCalls: activeCalls.size
      })
    );
  });

// ============================================================
// WEBSOCKET SERVER
// ============================================================

const wss =
  new WebSocket.Server({
    server
  });

// ============================================================
// H&M SYSTEM PROMPT
// ============================================================

const HM_SYSTEM_PROMPT = `
You are an AI phone assistant for H&M.

You are friendly, natural, fast and conversational.

You are speaking to the customer on a PHONE CALL.

IMPORTANT PHONE BEHAVIOR:

- Speak naturally.
- Keep responses short enough for a phone conversation.
- Do not give giant paragraphs.
- Usually answer in 1-3 short sentences.
- Never sound like a robotic script.
- Understand normal conversational language.
- Understand incomplete sentences.
- Understand accents and imperfect speech.
- Understand follow-up questions using conversation memory.
- If the customer describes a product naturally, understand what they mean.

You help customers with:

1. H&M products
2. Clothing
3. Jeans
4. Dresses
5. Shirts
6. T-shirts
7. Jackets
8. Hoodies
9. Shoes
10. Accessories
11. Colours
12. Sizes
13. Product recommendations
14. Shopping assistance
15. Product availability when current information is provided
16. General H&M shopping questions

PRODUCT UNDERSTANDING:

If the customer says things such as:

"bootcut jeans"
"faded bluish green bootcut jeans"
"dark blue jeans"
"loose black hoodie"
"oversized white t shirt"
"something beige"
"blue jeans for a casual outfit"

UNDERSTAND THE DESCRIPTION.

Do NOT respond with:
"Sorry, I can only help with H&M products."

Instead, interpret the description and continue helping.

For example:

Customer:
"I want faded bluish-green bootcut jeans."

You can respond:
"Sure. You're looking for faded bluish-green bootcut jeans. What size are you looking for?"

If the customer gives a colour that isn't an exact catalogue colour, interpret it naturally.

Examples:

bluish-green → blue-green / teal-like
off-white → cream / ivory
dark blue → navy / dark denim
light blue → light denim
faded black → washed black
brownish beige → beige/tan

SIZES:

Understand:
XS
S
M
L
XL
XXL
small
medium
large
extra large
size 30
size 32
size 34
etc.

If the customer hasn't given a size when one is needed, naturally ask for it.

SHOPPING:

If the customer says they want to buy something, help them narrow it down.

Ask only one useful question at a time.

Example:

Customer:
"I want bootcut jeans."

Assistant:
"Sure. What colour are you looking for?"

Customer:
"Faded bluish-green."

Assistant:
"Got it. What size do you need?"

Customer:
"32."

Assistant:
"Perfect. I'll look for faded bluish-green bootcut jeans in size 32."

Do not repeatedly ask the customer the same question.

CURRENT INFORMATION:

If current product availability, price, store information, opening hours, latest information or other live information is supplied to you, use it.

Never mention Tavily, APIs, web searches, tools or internal systems.

UNAVAILABLE SERVICES:

For services outside the currently implemented H&M shopping functionality, say naturally:

"Sorry, that option isn't available right now."

Do not invent unavailable functionality.

CONVERSATION MEMORY:

Remember what the customer has already told you during this call.

For example:

Customer:
"I want men's jeans."

Later:
"What colours do you have?"

Understand that "you" means the men's jeans being discussed.

If the customer says:
"what about black?"
understand that black refers to the product currently being discussed.

CALL ENDING:

The customer may end the conversation using:

"that's it"
"nothing else"
"no that's all"
"I'm done"
"bye"
"goodbye"
"that's everything"

When the customer clearly uses one of these endings, respond briefly and politely.

Example:
"You're welcome. Have a great day!"

Then the phone system will end the call.

Do not keep asking questions after the customer clearly ends the conversation.

GENERAL QUESTIONS:

The customer may ask unrelated questions.

Answer them naturally when possible.

Do not falsely claim that every question must be about H&M.

However, if the customer asks for an H&M service that is not implemented, say that the option is unavailable right now.

IMPORTANT:

Never say:
"I am an AI language model."

Never mention:
Groq
Deepgram
Tavily
APIs
web search
internal tools

You are simply the H&M phone assistant.
`;

// ============================================================
// WEB SEARCH DETECTION
// ============================================================

function needsWebSearch(question) {

  const q =
    question
      .toLowerCase()
      .trim();

  const words = [
    "today",
    "tonight",
    "tomorrow",
    "now",
    "currently",
    "current",
    "latest",
    "recent",
    "price",
    "prices",
    "cost",
    "available",
    "availability",
    "in stock",
    "stock",
    "store",
    "stores",
    "opening",
    "open now",
    "closed",
    "near me",
    "nearby",
    "location",
    "where is",
    "where are"
  ];

  return words.some(
    word => q.includes(word)
  );
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
    setTimeout(() => {
      controller.abort();
    }, TAVILY_TIMEOUT);

  try {

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
            query: question,
            search_depth: "basic",
            topic: "general",
            max_results: 2,
            include_answer: true,
            include_raw_content: false
          }),

          signal: controller.signal
        }
      );

    if (!response.ok) {
      return "";
    }

    const data =
      await response.json();

    let result = "";

    if (data?.answer) {
      result += data.answer + " ";
    }

    if (Array.isArray(data?.results)) {

      for (
        const item of data.results
      ) {

        result +=
          `${item.title || ""}: ` +
          `${item.content || ""} `;
      }
    }

    return result
      .replace(/\s+/g, " ")
      .trim();

  } catch (error) {

    if (
      error.name !== "AbortError"
    ) {
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

      let settled = false;

      const timer =
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

        }, DEEPGRAM_CONNECT_TIMEOUT);

      socket.once(
        "open",
        () => {

          settled = true;

          clearTimeout(timer);

          resolve(socket);
        }
      );

      socket.once(
        "error",
        error => {

          if (!settled) {

            clearTimeout(timer);

            reject(error);
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

      let settled = false;

      const timer =
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

        }, DEEPGRAM_CONNECT_TIMEOUT);

      socket.once(
        "open",
        () => {

          settled = true;

          clearTimeout(timer);

          resolve(socket);
        }
      );

      socket.once(
        "error",
        error => {

          if (!settled) {

            clearTimeout(timer);

            reject(error);
          }
        }
      );
    }
  );
}

// ============================================================
// CLOSE DEEPGRAM
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
//
// IMPORTANT:
// Deepgram may generate audio faster than the phone can play it.
//
// We therefore pace the audio at exactly 20ms per chunk.
// This prevents audio buildup and massive delay.
// ============================================================

function createAudioQueue(call) {

  const queue = [];

  let timer = null;

  let stopped = false;

  let sequence = 1;

  let chunkNumber = 0;

  let timestamp = 0;

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
      clear();
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
            String(sequence++),

          stream_sid:
            call.streamSid,

          media: {

            chunk:
              String(chunkNumber++),

            timestamp:
              String(timestamp),

            payload:
              chunk.toString(
                "base64"
              )
          }
        })
      );

      timestamp +=
        AUDIO_INTERVAL;

    } catch (error) {

      console.log(
        `[${call.id}] audio send error:`,
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
          AUDIO_INTERVAL
        );
    }
  }

  function enqueue(buffer) {

    if (
      stopped ||
      call.destroyed ||
      !buffer ||
      !buffer.length
    ) {
      return;
    }

    for (
      let offset = 0;
      offset < buffer.length;
      offset += AUDIO_CHUNK_SIZE
    ) {

      const chunk =
        buffer.subarray(
          offset,
          Math.min(
            offset +
              AUDIO_CHUNK_SIZE,
            buffer.length
          )
        );

      queue.push(chunk);
    }

    if (!timer) {
      sendNext();
    }
  }

  function pending() {
    return (
      queue.length > 0 ||
      timer !== null
    );
  }

  return {
    enqueue,
    clear,
    stop,
    pending
  };
}

// ============================================================
// CLEAR EXOTEL AUDIO
// ============================================================

function clearExotelAudio(call) {

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

        event: "clear",

        stream_sid:
          call.streamSid
      })
    );

  } catch (_) {}
}

// ============================================================
// INTERRUPT CURRENT AI
// ============================================================

function interruptAI(
  call,
  reason = "barge-in"
) {

  if (
    call.destroyed
  ) {
    return;
  }

  if (
    !call.aiSpeaking &&
    !call.groqRunning
  ) {
    return;
  }

  console.log(
    `[${call.id}] 🔴 INTERRUPT: ${reason}`
  );

  // Invalidate everything currently running.
  call.generation++;

  call.aiSpeaking = false;

  call.groqRunning = false;

  // Destroy queued TTS audio.
  call.audioQueue.clear();

  // Tell Exotel to immediately stop playback.
  clearExotelAudio(call);

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

// ============================================================
// END CALL DETECTION
// ============================================================

function isEndingPhrase(text) {

  const q =
    text
      .toLowerCase()
      .replace(/[.!?,]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const endings = [
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

  return endings.includes(q);
}

// ============================================================
// HANG UP
// ============================================================
//
// Exotel call termination is normally controlled by the
// Exotel call-flow / stream configuration.
//
// We send a clean close signal to our stream and then close
// the WebSocket. If your Exotel flow has an explicit hangup
// instruction, that flow should terminate the call.
// ============================================================

function endCall(call) {

  if (
    call.destroyed
  ) {
    return;
  }

  if (
    call.ending
  ) {
    return;
  }

  call.ending = true;

  console.log(
    `[${call.id}] ☎️ ENDING CALL`
  );

  interruptAI(
    call,
    "customer ended conversation"
  );

  setTimeout(() => {

    if (
      call.ws &&
      call.ws.readyState ===
        WebSocket.OPEN
    ) {

      try {
        call.ws.close();
      } catch (_) {}
    }

  }, 900);
}

// ============================================================
// STREAM GROQ
// ============================================================

async function streamGroq(
  call,
  question,
  webInfo,
  generation,
  onText
) {

  const messages = [

    {
      role: "system",
      content: HM_SYSTEM_PROMPT
    }
  ];

  // ==========================================================
  // MEMORY
  // ==========================================================

  for (
    const item of
      call.history
  ) {

    messages.push({
      role: item.role,
      content: item.content
    });
  }

  // ==========================================================
  // WEB DATA
  // ==========================================================

  if (webInfo) {

    messages.push({

      role: "system",

      content:
        "Current information:\n" +
        webInfo
    });
  }

  // ==========================================================
  // USER
  // ==========================================================

  messages.push({

    role: "user",

    content:
      question
  });

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, GROQ_TIMEOUT);

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

    let answer = "";

    let pending = "";

    for await (
      const chunk of stream
    ) {

      // ======================================================
      // BARGE-IN CHECK
      // ======================================================

      if (
        call.destroyed ||
        call.generation !==
          generation
      ) {

        console.log(
          `[${call.id}] OLD GROQ STREAM STOPPED`
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

      answer += token;

      pending += token;

      // ======================================================
      // SENTENCE
      // ======================================================

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
          call.generation !==
          generation
        ) {
          break;
        }

        const text =
          match[1]
            .replace(/\s+/g, " ")
            .trim();

        pending =
          pending
            .slice(
              match[0].length
            )
            .trimStart();

        if (text) {

          await onText(
            text
          );
        }
      }

      // ======================================================
      // EARLY CHUNK
      // ======================================================
      //
      // Don't wait for a whole long paragraph.
      // ======================================================

      if (
        pending.length >= 42
      ) {

        const lastSpace =
          pending.lastIndexOf(" ");

        if (
          lastSpace >= 22
        ) {

          const text =
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

          if (text) {

            await onText(
              text
            );
          }
        }
      }
    }

    // ======================================================
    // REMAINING TEXT
    // ======================================================

    if (
      pending.trim() &&
      call.generation ===
        generation
    ) {

      await onText(
        pending
          .replace(/\s+/g, " ")
          .trim()
      );
    }

    return answer
      .replace(/\s+/g, " ")
      .trim();

  } finally {

    clearTimeout(timeout);
  }
}

// ============================================================
// SEND TEXT TO TTS
// ============================================================

function sendTTS(
  call,
  text,
  generation
) {

  if (
    call.destroyed ||
    call.generation !==
      generation
  ) {
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

        text:
          text
      })
    );

    return true;

  } catch (error) {

    console.log(
      `[${call.id}] TTS error:`,
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
// PROCESS QUESTION
// ============================================================

async function processQuestion(
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
    String(question)
      .replace(/\s+/g, " ")
      .trim();

  if (!clean) {
    return;
  }

  console.log(
    `[${call.id}] 👤 CUSTOMER: ${clean}`
  );

  // ==========================================================
  // ENDING
  // ==========================================================

  if (
    isEndingPhrase(clean)
  ) {

    console.log(
      `[${call.id}] CUSTOMER WANTS TO END`
    );

    const generation =
      ++call.generation;

    call.aiSpeaking = true;

    const goodbye =
      "You're welcome. Have a great day!";

    sendTTS(
      call,
      goodbye,
      generation
    );

    flushTTS(call);

    setTimeout(() => {

      endCall(call);

    }, 1800);

    return;
  }

  // ==========================================================
  // NEW RESPONSE GENERATION
  // ==========================================================

  const generation =
    ++call.generation;

  call.aiSpeaking = true;

  call.groqRunning = true;

  let sentAudio = false;

  try {

    // ========================================================
    // SEARCH
    // ========================================================

    let webInfo = "";

    if (
      needsWebSearch(clean)
    ) {

      console.log(
        `[${call.id}] 🌐 LIVE SEARCH`
      );

      webInfo =
        await searchWeb(clean);

    }

    // Caller may have interrupted while Tavily was running.
    if (
      call.destroyed ||
      call.generation !==
        generation
    ) {
      return;
    }

    // ========================================================
    // TTS CALLBACK
    // ========================================================

    const onText =
      async text => {

        if (
          call.destroyed ||
          call.generation !==
            generation
        ) {
          return;
        }

        const ok =
          sendTTS(
            call,
            text,
            generation
          );

        if (ok) {
          sentAudio = true;
        }
      };

    // ========================================================
    // GROQ
    // ========================================================

    const answer =
      await streamGroq(
        call,
        clean,
        webInfo,
        generation,
        onText
      );

    // ========================================================
    // INTERRUPTED
    // ========================================================

    if (
      call.destroyed ||
      call.generation !==
        generation
    ) {

      return;
    }

    // ========================================================
    // FLUSH TTS
    // ========================================================

    if (sentAudio) {

      flushTTS(call);
    }

    // ========================================================
    // MEMORY
    // ========================================================

    if (
      answer &&
      call.generation ===
        generation
    ) {

      call.history.push({

        role:
          "user",

        content:
          clean
      });

      call.history.push({

        role:
          "assistant",

        content:
          answer
      });

      // Keep last 6 exchanges.
      if (
        call.history.length >
        12
      ) {

        call.history =
          call.history.slice(-12);
      }
    }

    console.log(
      `[${call.id}] 🤖 AI: ${answer}`
    );

  } catch (error) {

    if (
      call.generation !==
      generation
    ) {
      return;
    }

    if (
      call.destroyed
    ) {
      return;
    }

    console.log(
      `[${call.id}] PROCESS ERROR:`,
      error.message
    );

    sendTTS(
      call,
      "Sorry, I had trouble answering that.",
      generation
    );

    flushTTS(call);

  } finally {

    if (
      call.generation ===
      generation
    ) {

      call.aiSpeaking = false;

      call.groqRunning = false;
    }
  }
}

// ============================================================
// QUESTION QUEUE
// ============================================================

function addQuestion(
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
    String(question)
      .replace(/\s+/g, " ")
      .trim();

  if (!clean) {
    return;
  }

  // If AI is speaking, immediately interrupt it.
  if (
    call.aiSpeaking ||
    call.groqRunning
  ) {

    interruptAI(
      call,
      "customer spoke"
    );

    call.questionQueue.length = 0;
  }

  // Newest question gets priority.
  call.questionQueue.unshift(
    clean
  );

  runQueue(call);
}

// ============================================================
// RUN QUEUE
// ============================================================

async function runQueue(call) {

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
      !call.destroyed &&
      !call.ending
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

// ============================================================
// CREATE CALL
// ============================================================

function createCall(ws) {

  const call = {

    id:
      "CALL-" +
      callCounter++,

    ws,

    destroyed:
      false,

    ending:
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

    history:
      [],

    questionQueue:
      [],

    queueRunning:
      false,

    aiSpeaking:
      false,

    groqRunning:
      false,

    generation:
      0,

    speechParts:
      [],

    lastInterim:
      "",

    lastSpeechTime:
      0,

    audioQueue:
      null
  };

  call.audioQueue =
    createAudioQueue(call);

  return call;
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

  call.generation++;

  call.aiSpeaking = false;

  call.groqRunning = false;

  call.questionQueue = [];

  call.speechParts = [];

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

  activeCalls.delete(
    call.id
  );

  console.log(
    `[${call.id}] ☎️ CALL CLEANED`
  );

  console.log(
    `ACTIVE CALLS: ${activeCalls.size}`
  );
}

// ============================================================
// SETUP DEEPGRAM
// ============================================================

async function setupDeepgram(call) {

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

      closeSocket(stt);
      closeSocket(tts);

      return;
    }

    call.sttSocket = stt;
    call.ttsSocket = tts;

    call.sttReady = true;
    call.ttsReady = true;

    console.log(
      `[${call.id}] 🎙️ DEEPGRAM READY`
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

          // ==================================================
          // INTERIM
          // ==================================================

          if (
            !data.is_final
          ) {

            call.lastInterim =
              transcript;

            call.lastSpeechTime =
              Date.now();

            // ================================================
            // BARGE-IN
            // ================================================

            if (
              call.aiSpeaking ||
              call.groqRunning
            ) {

              const text =
                transcript
                  .toLowerCase()
                  .trim();

              if (
                text.length >= 2
              ) {

                const explicit =
                  /^(stop|wait|hold on|hang on|pause|no wait|be quiet|that's enough|thats enough|enough)\b/i
                    .test(text);

                // Any real speech during AI playback
                // counts as a barge-in.
                if (
                  explicit ||
                  text.length >= 3
                ) {

                  interruptAI(
                    call,
                    explicit
                      ? "explicit stop"
                      : "natural barge-in"
                  );
                }
              }
            }

            return;
          }

          // ==================================================
          // FINAL
          // ==================================================

          call.speechParts.push(
            transcript
          );

          call.lastInterim = "";

          if (
            data.speech_final
          ) {

            const question =
              call.speechParts
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();

            call.speechParts = [];

            if (question) {

              console.log(
                `[${call.id}] 🎤 FINAL: ${question}`
              );

              addQuestion(
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
    // SOCKET CLOSE
    // ========================================================

    stt.on(
      "close",
      () => {

        call.sttReady = false;

        console.log(
          `[${call.id}] STT CLOSED`
        );
      }
    );

    tts.on(
      "close",
      () => {

        call.ttsReady = false;

        console.log(
          `[${call.id}] TTS CLOSED`
        );
      }
    );

    // ========================================================
    // ERRORS
    // ========================================================

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
      createCall(ws);

    activeCalls.set(
      call.id,
      call
    );

    console.log(
      "================================================"
    );

    console.log(
      `[${call.id}] ☎️ EXOTEL CONNECTED`
    );

    console.log(
      `ACTIVE CALLS: ${activeCalls.size}`
    );

    console.log(
      "================================================"
    );

    // ========================================================
    // START DEEPGRAM IMMEDIATELY
    // ========================================================

    setupDeepgram(call);

    // ========================================================
    // EXOTEL EVENTS
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
                `[${call.id}] AUDIO → STT ERROR:`,
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

            call.speechParts = [];

            call.lastInterim = "";

            return;
          }

          // ==================================================
          // MARK
          // ==================================================

          if (
            event ===
            "mark"
          ) {

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
              `[${call.id}] EXOTEL STOP`
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

    // ========================================================
    // WS CLOSE
    // ========================================================

    ws.on(
      "close",
      () => {

        console.log(
          `[${call.id}] EXOTEL DISCONNECTED`
        );

        destroyCall(call);
      }
    );

    // ========================================================
    // WS ERROR
    // ========================================================

    ws.on(
      "error",
      error => {

        console.log(
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
      "================================================"
    );

    console.log(
      "        H&M AI VOICE ASSISTANT"
    );

    console.log(
      "================================================"
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
      "================================================"
    );
  }
);

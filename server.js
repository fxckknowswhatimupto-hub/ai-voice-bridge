const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 10000;

const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  "https://ai-voice-bridge-q8qv.onrender.com";

const WS_URL =
  PUBLIC_URL.replace(/^https:/, "wss:");

const GROQ_MODEL =
  "llama-3.1-8b-instant";

const DEEPGRAM_STT_MODEL =
  "nova-3";

const DEEPGRAM_TTS_MODEL =
  "aura-2-thalia-en";

// ============================================================
// AUDIO
// ============================================================

const SAMPLE_RATE = 8000;

// 16-bit mono PCM
const BYTES_PER_SAMPLE = 2;

// 20 ms @ 8kHz
// 8000 samples/sec * 0.02 sec * 2 bytes
const AUDIO_CHUNK_SIZE =
  160 * BYTES_PER_SAMPLE;

const AUDIO_INTERVAL_MS = 20;

// ============================================================
// TIMEOUTS
// ============================================================

const TAVILY_TIMEOUT_MS = 1800;
const GROQ_TIMEOUT_MS = 12000;

const DEEPGRAM_CONNECT_TIMEOUT_MS = 7000;

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
// CLIENT
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

let nextCallId = 1;

// ============================================================
// HTTP SERVER
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
          status: "ok",
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
// SEARCH DETECTION
// ============================================================

function needsWebSearch(
  question
) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

  const words = [

    "today",
    "tonight",
    "tomorrow",
    "latest",
    "current",
    "currently",
    "now",
    "recent",
    "news",
    "weather",
    "temperature",

    "price",
    "prices",
    "cost",

    "available",
    "availability",
    "in stock",
    "stock",

    "store",
    "stores",
    "shop",
    "shops",
    "mall",

    "near me",
    "nearby",
    "location",

    "opening",
    "closing",
    "hours",
    "timing",
    "timings"
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

  if (
    !TAVILY_API_KEY
  ) {
    return "";
  }

  const controller =
    new AbortController();

  const timeout =
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
              `Bearer ${TAVILY_API_KEY}`,

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

    let result =
      "";

    if (
      data?.answer
    ) {

      result +=
        String(
          data.answer
        ) + " ";
    }

    if (
      Array.isArray(
        data?.results
      )
    ) {

      for (
        const item of
          data.results
      ) {

        result +=
          `${item?.title || ""}: ${
            item?.content || ""
          } `;
      }
    }

    return result
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
      timeout
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
                `Token ${DEEPGRAM_API_KEY}`
            }
          }
        );

      let settled =
        false;

      const timeout =
        setTimeout(
          () => {

            if (!settled) {

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
          DEEPGRAM_CONNECT_TIMEOUT_MS
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

          if (!settled) {

            settled =
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

      let settled =
        false;

      const timeout =
        setTimeout(
          () => {

            if (!settled) {

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
          DEEPGRAM_CONNECT_TIMEOUT_MS
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

          if (!settled) {

            settled =
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
// SAFE SOCKET CLOSE
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

  function schedule() {

    if (
      timer ||
      stopped
    ) {
      return;
    }

    timer =
      setTimeout(
        () => {

          timer =
            null;

          sendNext();

        },
        AUDIO_INTERVAL_MS
      );
  }

  function sendNext() {

    if (
      stopped ||
      call.destroyed
    ) {

      return;
    }

    if (
      queue.length === 0
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

      schedule();

      return;
    }

    const audio =
      queue.shift();

    if (
      !audio ||
      audio.length === 0
    ) {

      schedule();

      return;
    }

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

      schedule();
    }
  }

  function enqueue(
    buffer
  ) {

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
      offset += AUDIO_CHUNK_SIZE
    ) {

      queue.push(
        Buffer.from(
          buffer.subarray(
            offset,
            Math.min(
              offset +
                AUDIO_CHUNK_SIZE,
              buffer.length
            )
          )
        )
      );
    }

    sendNext();
  }

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

  function pending() {

    return (
      queue.length > 0 ||
      Boolean(timer)
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
// EXOTEL CLEAR AUDIO
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

    console.log(
      `[${call.id}] 🔥 Exotel audio cleared`
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

function sendTTS(
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
// INTERRUPT
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

  if (
    !call.aiGenerating &&
    !call.aiPlaying
  ) {

    return;
  }

  console.log(
    `[${call.id}] 🛑 INTERRUPT: ${reason}`
  );

  // Invalidate current generation.
  call.responseGeneration++;

  call.aiGenerating =
    false;

  call.aiPlaying =
    false;

  // Stop queued local audio.
  call.audioQueue.clear();

  // Stop anything already buffered by Exotel.
  clearExotelAudio(
    call
  );

  // Clear Deepgram TTS text buffer.
  if (
    call.ttsSocket &&
    call.ttsSocket.readyState ===
      WebSocket.OPEN
  ) {

    try {

      call.ttsSocket.send(
        JSON.stringify({
          type:
            "Clear"
        })
      );

    } catch (_) {}
  }
}

// ============================================================
// END CALL DETECTION
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
      .trim();

  const phrases = [

    "that's it",
    "thats it",

    "nothing else",

    "no that's all",
    "no thats all",

    "i'm done",
    "im done",

    "bye",
    "goodbye",

    "that's everything",
    "thats everything"
  ];

  return phrases.some(
    phrase =>
      q === phrase ||
      q.endsWith(
        ` ${phrase}`
      )
  );
}

// ============================================================
// MEMORY
// ============================================================

function addMemory(
  call,
  role,
  content
) {

  call.conversationHistory.push({
    role,
    content
  });

  // Keep 8 messages = 4 exchanges.
  if (
    call.conversationHistory.length >
    8
  ) {

    call.conversationHistory =
      call.conversationHistory.slice(
        -8
      );
  }
}

// ============================================================
// GROQ STREAM
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
      role:
        "system",

      content:

        "You are an H&M phone shopping assistant. " +

        "Speak naturally like a real helpful human phone assistant. " +

        "You are allowed to understand normal human language, slang, descriptions, colors, clothing styles, sizes, budgets and follow-up questions. " +

        "Do NOT reject a customer simply because they use an unusual color name or clothing description. " +

        "For example, if someone says faded bluish-green, understand it as a color description and continue naturally. " +

        "Never say that you can only understand official H&M product names. " +

        "If the customer describes something approximately, interpret what they mean. " +

        "Remember the conversation and use previous answers when answering follow-up questions. " +

        "The assistant currently supports product questions, shopping help and size guidance. " +

        "For unrelated H&M services such as returns, refunds, payments, account issues, store complaints or delivery support, politely say that service is currently unavailable. " +

        "Keep answers short because this is a phone conversation. " +

        "Do not use markdown. " +

        "Do not mention APIs, Tavily, Groq, Deepgram, tools or internal systems. " +

        "Do not say 'as an AI'. " +

        "Ask only one question at a time. " +

        "If the customer is choosing a product, help narrow it down naturally."
    }
  ];

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

  if (
    webInfo
  ) {

    messages.push({

      role:
        "system",

      content:
        "Current web information:\n" +
        webInfo +
        "\nUse it when useful. Do not mention the search."
    });
  }

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

    let answer =
      "";

    let pending =
      "";

    for await (
      const chunk of
        stream
    ) {

      // Current response invalidated.
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

      if (
        !token
      ) {
        continue;
      }

      answer +=
        token;

      pending +=
        token;

      // ----------------------------------------------------
      // SENTENCE
      // ----------------------------------------------------

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

        if (
          sentence
        ) {

          await onText(
            sentence
          );
        }
      }

      // ----------------------------------------------------
      // EARLY CHUNK
      // ----------------------------------------------------

      if (
        pending.length >=
        55
      ) {

        const lastSpace =
          pending.lastIndexOf(
            " "
          );

        if (
          lastSpace >= 25
        ) {

          const chunkText =
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
            chunkText
          ) {

            await onText(
              chunkText
            );
          }
        }
      }
    }

    if (
      pending.trim() &&
      !call.destroyed &&
      call.responseGeneration ===
        generation
    ) {

      await onText(
        pending
          .replace(
            /\s+/g,
            " "
          )
          .trim()
      );
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
    String(question)
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (
    !clean
  ) {
    return;
  }

  console.log(
    `[${call.id}] 👤 USER:`,
    clean
  );

  // ----------------------------------------------------------
  // END PHRASE
  // ----------------------------------------------------------

  if (
    isEndPhrase(
      clean
    )
  ) {

    console.log(
      `[${call.id}] CALL END PHRASE`
    );

    const generation =
      ++call.responseGeneration;

    call.aiGenerating =
      false;

    call.aiPlaying =
      true;

    call.audioQueue.clear();

    clearExotelAudio(
      call
    );

    sendTTS(
      call,
      "You're welcome. Have a great day!"
    );

    flushTTS(
      call
    );

    // We don't immediately destroy the websocket.
    // Give Exotel a moment to receive the goodbye.
    setTimeout(
      () => {

        if (
          !call.destroyed &&
          call.responseGeneration ===
            generation
        ) {

          destroyCall(
            call
          );
        }

      },
      1800
    );

    return;
  }

  // ----------------------------------------------------------
  // NEW GENERATION
  // ----------------------------------------------------------

  const generation =
    ++call.responseGeneration;

  call.aiGenerating =
    true;

  call.aiPlaying =
    false;

  // ----------------------------------------------------------
  // SEARCH
  // ----------------------------------------------------------

  let webInfo =
    "";

  if (
    needsWebSearch(
      clean
    )
  ) {

    console.log(
      `[${call.id}] 🌐 SEARCH`
    );

    webInfo =
      await searchWeb(
        clean
      );
  }

  if (
    call.destroyed ||
    call.responseGeneration !==
      generation
  ) {

    return;
  }

  // ----------------------------------------------------------
  // TTS
  // ----------------------------------------------------------

  let sentAnything =
    false;

  const sendText =
    async text => {

      if (
        call.destroyed ||
        call.responseGeneration !==
          generation
      ) {

        return;
      }

      if (
        !text
      ) {
        return;
      }

      const sent =
        sendTTS(
          call,
          text
        );

      if (
        sent
      ) {

        sentAnything =
          true;

        call.aiPlaying =
          true;
      }
    };

  try {

    const answer =
      await streamGroq(
        call,
        clean,
        webInfo,
        generation,
        sendText
      );

    if (
      call.destroyed ||
      call.responseGeneration !==
        generation
    ) {

      return;
    }

    if (
      sentAnything
    ) {

      flushTTS(
        call
      );
    }

    if (
      answer
    ) {

      addMemory(
        call,
        "user",
        clean
      );

      addMemory(
        call,
        "assistant",
        answer
      );
    }

    console.log(
      `[${call.id}] 🤖 AI:`,
      answer
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
      `[${call.id}] GROQ ERROR:`,
      error.message
    );

    sendTTS(
      call,
      "Sorry, I had trouble with that. Could you try again?"
    );

    flushTTS(
      call
    );

  } finally {

    if (
      call.responseGeneration ===
      generation
    ) {

      call.aiGenerating =
        false;
    }
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
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (
    !clean
  ) {
    return;
  }

  // If AI is currently speaking/generating,
  // caller has barged in.
  if (
    call.aiPlaying ||
    call.aiGenerating
  ) {

    interruptAI(
      call,
      "caller spoke"
    );

    call.questionQueue =
      [];
  }

  call.questionQueue.push(
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

function createCall(
  ws
) {

  const id =
    `CALL-${nextCallId++}`;

  const call = {

    id,

    ws,

    destroyed:
      false,

    streamSid:
      null,

    callSid:
      null,

    started:
      false,

    greeted:
      false,

    sttSocket:
      null,

    ttsSocket:
      null,

    sttReady:
      false,

    ttsReady:
      false,

    // --------------------------------------------------------
    // IMPORTANT:
    // AUDIO THAT ARRIVES BEFORE DEEPGRAM IS READY
    // IS BUFFERED INSTEAD OF DROPPED.
    // --------------------------------------------------------

    pendingInboundAudio:
      [],

    pendingInboundBytes:
      0,

    maxPendingInboundBytes:
      8000 * 2 * 3,

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

    audioQueue:
      null,

    aiGenerating:
      false,

    aiPlaying:
      false,

    responseGeneration:
      0,

    sttKeepAlive:
      null,

    ttsKeepAlive:
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

async function greetCall(
  call
) {

  if (
    call.destroyed ||
    call.greeted ||
    !call.started ||
    !call.ttsReady
  ) {

    return;
  }

  call.greeted =
    true;

  console.log(
    `[${call.id}] 🔊 SENDING GREETING`
  );

  const generation =
    ++call.responseGeneration;

  call.aiPlaying =
    true;

  const greeting =
    "Hi! Welcome to H and M. I can help you find products, choose styles and colors, and help with sizes. What would you like to shop for today?";

  if (
    !sendTTS(
      call,
      greeting
    )
  ) {

    call.greeted =
      false;

    call.aiPlaying =
      false;

    console.log(
      `[${call.id}] GREETING FAILED - TTS NOT READY`
    );

    return;
  }

  flushTTS(
    call
  );

  setTimeout(
    () => {

      if (
        !call.destroyed &&
        call.responseGeneration ===
          generation
      ) {

        call.aiPlaying =
          false;
      }

    },
    3500
  );
}

// ============================================================
// SETUP DEEPGRAM
// ============================================================

async function setupDeepgram(
  call
) {

  try {

    console.log(
      `[${call.id}] Connecting Deepgram...`
    );

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
      `[${call.id}] ✅ DEEPGRAM READY`
    );

    // ========================================================
    // STT MESSAGE
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

          const message =
            JSON.parse(
              raw.toString()
            );

          const transcript =
            message
              ?.channel
              ?.alternatives?.[0]
              ?.transcript || "";

          if (
            !transcript
          ) {

            return;
          }

          // --------------------------------------------------
          // INTERIM
          // --------------------------------------------------

          if (
            !message.is_final
          ) {

            call.lastInterim =
              transcript;

            // BARGE-IN
            if (
              (
                call.aiPlaying ||
                call.aiGenerating
              ) &&
              transcript
                .trim()
                .length >= 2
            ) {

              const text =
                transcript
                  .toLowerCase()
                  .trim();

              const explicitStop =
                /^(stop|wait|hold on|hang on|be quiet|enough|pause|that's enough|thats enough)\b/i
                  .test(
                    text
                  );

              interruptAI(
                call,
                explicitStop
                  ? "explicit interruption"
                  : "caller started speaking"
              );
            }

            return;
          }

          // --------------------------------------------------
          // FINAL
          // --------------------------------------------------

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

            if (
              question
            ) {

              console.log(
                `[${call.id}] 🎤 FINAL:`,
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
    // TTS MESSAGE
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
              audio.length > 0
            ) {

              // IMPORTANT:
              // Do NOT require aiPlaying here.
              // Greeting and streamed TTS both need audio.
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

            console.log(
              `[${call.id}] TTS FLUSHED`
            );
          }

          if (
            message.type ===
            "Metadata"
          ) {

            console.log(
              `[${call.id}] TTS METADATA`
            );
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

    // ========================================================
    // SOCKET ERROR
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

    // ========================================================
    // KEEPALIVE
    // ========================================================

    call.sttKeepAlive =
      setInterval(
        () => {

          if (
            call.destroyed ||
            !call.sttSocket ||
            call.sttSocket.readyState !==
              WebSocket.OPEN
          ) {

            return;
          }

          try {

            call.sttSocket.send(
              JSON.stringify({
                type:
                  "KeepAlive"
              })
            );

          } catch (_) {}

        },
        8000
      );

    call.ttsKeepAlive =
      setInterval(
        () => {

          if (
            call.destroyed ||
            !call.ttsSocket ||
            call.ttsSocket.readyState !==
              WebSocket.OPEN
          ) {

            return;
          }

          try {

            call.ttsSocket.ping();

          } catch (_) {}

        },
        20000
      );

    // ========================================================
    // FLUSH BUFFERED INBOUND AUDIO
    // ========================================================

    if (
      call.pendingInboundAudio.length > 0 &&
      call.sttSocket.readyState ===
        WebSocket.OPEN
    ) {

      console.log(
        `[${call.id}] 🔄 FLUSHING BUFFERED CALL AUDIO:`,
        call.pendingInboundAudio.length
      );

      for (
        const audio of
          call.pendingInboundAudio
      ) {

        try {

          call.sttSocket.send(
            audio
          );

        } catch (_) {
          break;
        }
      }

      call.pendingInboundAudio =
        [];

      call.pendingInboundBytes =
        0;
    }

    // ========================================================
    // GREETING
    // ========================================================

    await greetCall(
      call
    );

  } catch (error) {

    console.log(
      `[${call.id}] ❌ DEEPGRAM SETUP ERROR:`,
      error.message
    );

    // Retry once.
    if (
      !call.destroyed &&
      !call.deepgramRetried
    ) {

      call.deepgramRetried =
        true;

      console.log(
        `[${call.id}] Retrying Deepgram...`
      );

      setTimeout(
        () => {

          setupDeepgram(
            call
          );

        },
        1000
      );
    }
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

  console.log(
    `[${call.id}] 🧹 CLEANING CALL`
  );

  call.destroyed =
    true;

  call.aiPlaying =
    false;

  call.aiGenerating =
    false;

  call.responseGeneration++;

  call.questionQueue =
    [];

  call.speechFinalParts =
    [];

  call.pendingInboundAudio =
    [];

  if (
    call.sttKeepAlive
  ) {

    clearInterval(
      call.sttKeepAlive
    );

    call.sttKeepAlive =
      null;
  }

  if (
    call.ttsKeepAlive
  ) {

    clearInterval(
      call.ttsKeepAlive
    );

    call.ttsKeepAlive =
      null;
  }

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
      "=========================================="
    );

    console.log(
      `[${call.id}] 📞 EXOTEL CONNECTED`
    );

    console.log(
      `[${call.id}] ACTIVE CALLS:`,
      activeCalls.size
    );

    console.log(
      "=========================================="
    );

    // ========================================================
    // CONNECT DEEPGRAM IMMEDIATELY
    // ========================================================

    setupDeepgram(
      call
    );

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
              `[${call.id}] Exotel stream connected`
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

            call.started =
              true;

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
              `[${call.id}] 🚀 CALL START`
            );

            console.log(
              `[${call.id}] CALL SID:`,
              call.callSid
            );

            console.log(
              `[${call.id}] STREAM SID:`,
              call.streamSid
            );

            console.log(
              `[${call.id}] MEDIA FORMAT:`,
              message.start?.media_format
            );

            // ------------------------------------------------
            // If TTS already connected, greet now.
            // Otherwise setupDeepgram will greet once ready.
            // ------------------------------------------------

            if (
              call.ttsReady &&
              !call.greeted
            ) {

              greetCall(
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

            const audio =
              Buffer.from(
                payload,
                "base64"
              );

            if (
              !audio.length
            ) {
              return;
            }

            // ------------------------------------------------
            // STT READY
            // ------------------------------------------------

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

                console.log(
                  `[${call.id}] STT SEND ERROR:`,
                  error.message
                );
              }

              return;
            }

            // ------------------------------------------------
            // STT NOT READY
            //
            // BUFFER IT.
            // DO NOT DROP THE CALLER'S FIRST WORDS.
            // ------------------------------------------------

            if (
              call.pendingInboundBytes +
                audio.length <=
              call.maxPendingInboundBytes
            ) {

              call.pendingInboundAudio.push(
                audio
              );

              call.pendingInboundBytes +=
                audio.length;
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
          // MARK
          // ==================================================

          if (
            event ===
            "mark"
          ) {

            console.log(
              `[${call.id}] Exotel MARK:`,
              message.mark?.name
            );

            return;
          }

          // ==================================================
          // DTMF
          // ==================================================

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

          // ==================================================
          // STOP
          // ==================================================

          if (
            event ===
            "stop"
          ) {

            console.log(
              `[${call.id}] 📴 CALL STOP`
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
          `[${call.id}] 📞 EXOTEL DISCONNECTED`
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
// START
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      ""
    );

    console.log(
      "=========================================="
    );

    console.log(
      "     H&M AI VOICE ASSISTANT"
    );

    console.log(
      "=========================================="
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
      "Port:",
      PORT
    );

    console.log(
      "=========================================="
    );

    console.log(
      "READY FOR CALLS 🚀"
    );

    console.log(
      "=========================================="
    );
  }
);

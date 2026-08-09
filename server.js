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

// Maximum time Tavily is allowed to hold up a response.
const TAVILY_TIMEOUT_MS = 1500;

// Maximum time external AI requests can run.
const GROQ_TIMEOUT_MS = 10000;

// Phone audio.
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2;

// 20 ms of 8 kHz 16-bit mono PCM = 320 bytes.
const EXOTEL_AUDIO_CHUNK_SIZE =
  160 * BYTES_PER_SAMPLE;

const EXOTEL_AUDIO_INTERVAL_MS = 20;

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

// ==================================================
// CLIENT
// ==================================================

const groq =
  new Groq({
    apiKey: GROQ_API_KEY
  });

// ==================================================
// ACTIVE CALLS
// ==================================================
//
// IMPORTANT:
// This Map only contains references to independent
// call sessions.
//
// Every caller has completely separate:
// - WebSocket
// - STT
// - TTS
// - memory
// - audio queue
// - timers
// - processing state
//
// Nothing from one call is reused by another.
//

const activeCalls =
  new Map();

let nextCallNumber = 1;

// ==================================================
// HTTP SERVER
// ==================================================

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
              "ai-voice-bridge",
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

// ==================================================
// EXOTEL WEBSOCKET SERVER
// ==================================================

const wss =
  new WebSocket.Server({
    server
  });

// ==================================================
// WEB SEARCH DETECTION
// ==================================================

function needsWebSearch(
  question
) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

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
    "open now",
    "closed now",
    "opening hours",
    "opening time",
    "timing",
    "timings",
    "price",
    "prices",
    "cost",
    "score",
    "scores",
    "schedule",
    "scheduled",
    "traffic",
    "event",
    "events"
  ];

  for (
    const word of liveWords
  ) {

    if (
      q.includes(word)
    ) {
      return true;
    }
  }

  const localWords = [

    "best restaurant",
    "best restaurants",
    "best cafe",
    "best cafes",
    "best hotel",
    "best hotels",
    "restaurant",
    "restaurants",
    "cafe",
    "cafes",
    "hotel",
    "hotels",
    "mall",
    "cinema",
    "hospital",
    "airport",
    "shop",
    "shops",
    "store",
    "stores",
    "where is",
    "where are",
    "located",
    "location",
    "near me",
    "nearby",
    "how far",
    "distance",
    "directions",
    "recommend",
    "recommendation"
  ];

  for (
    const word of localWords
  ) {

    if (
      q.includes(word)
    ) {
      return true;
    }
  }

  return false;
}

// ==================================================
// TAVILY SEARCH
// ==================================================

async function searchWeb(
  question
) {

  if (!TAVILY_API_KEY) {
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
        data?.results
      )
    ) {

      for (
        const result of
          data.results
      ) {

        const title =
          result?.title ||
          "";

        const content =
          result?.content ||
          "";

        information +=
          title +
          ": " +
          content +
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
      timeout
    );
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
        (error) => {

          if (!settled) {

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
        (error) => {

          if (!settled) {

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
// CREATE EXOTEL AUDIO QUEUE
// ==================================================
//
// IMPORTANT:
//
// Audio is queued PER CALL.
//
// Call A gets Queue A.
// Call B gets Queue B.
//
// One caller can never block another caller.
//

function createExotelAudioQueue(
  call
) {

  const queue = [];

  let timer =
    null;

  let sequenceNumber =
    1;

  let chunkNumber =
    0;

  let timestamp =
    0;

  let stopped =
    false;

  function sendNext() {

    timer =
      null;

    if (stopped) {
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

    if (
      !call.streamSid
    ) {

      return;
    }

    if (
      queue.length === 0
    ) {

      return;
    }

    const audio =
      queue.shift();

    const chunk =
      audio.subarray(
        0,
        EXOTEL_AUDIO_CHUNK_SIZE
      );

    if (
      audio.length >
      EXOTEL_AUDIO_CHUNK_SIZE
    ) {

      queue.unshift(
        audio.subarray(
          EXOTEL_AUDIO_CHUNK_SIZE
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
        EXOTEL_AUDIO_INTERVAL_MS;

    } catch (error) {

      console.log(
        `[${call.id}] Exotel audio send error:`,
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
          EXOTEL_AUDIO_INTERVAL_MS
        );
    }
  }

  function enqueue(
    pcmBuffer
  ) {

    if (
      stopped ||
      !pcmBuffer ||
      pcmBuffer.length === 0
    ) {

      return;
    }

    for (
      let offset = 0;
      offset < pcmBuffer.length;
      offset +=
        EXOTEL_AUDIO_CHUNK_SIZE
    ) {

      queue.push(
        pcmBuffer.subarray(
          offset,
          Math.min(
            offset +
              EXOTEL_AUDIO_CHUNK_SIZE,
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

function sendExotelMark(
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
          "mark",

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
      `[${call.id}] Mark error:`,
      error.message
    );
  }
}

// ==================================================
// TTS SEND
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

        type:
          "Speak",

        text:
          text
      })
    );

    return true;

  } catch (error) {

    console.log(
      `[${call.id}] TTS send error:`,
      error.message
    );

    return false;
  }
}

// ==================================================
// TTS FLUSH
// ==================================================

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
      `[${call.id}] TTS flush error:`,
      error.message
    );

    return false;
  }
}

// ==================================================
// STREAM GROQ
// ==================================================

async function streamGroq(
  call,
  question,
  webInformation,
  onText
) {

  const messages = [

    {
      role:
        "system",

      content:
        "You are a fast, friendly phone AI assistant. " +
        "Never say you are Google Assistant, Siri or Alexa. " +
        "Speak naturally and casually. " +
        "Do not mention internal tools, APIs or web searches. " +
        "Use current web information when it is provided. " +
        "For simple questions, answer briefly. " +
        "For bigger questions, give the useful information without unnecessary detail. " +
        "Remember the conversation during this phone call. " +
        "Understand follow-up questions."
    }
  ];

  // ------------------------------------------------
  // MEMORY
  // ------------------------------------------------

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

  // ------------------------------------------------
  // WEB INFORMATION
  // ------------------------------------------------

  if (webInformation) {

    messages.push({

      role:
        "system",

      content:
        "CURRENT WEB INFORMATION:\n" +
        webInformation +
        "\n\nUse it when relevant. " +
        "Do not mention the search itself."
    });
  }

  // ------------------------------------------------
  // USER
  // ------------------------------------------------

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

    let pendingText =
      "";

    for await (
      const chunk of
        stream
    ) {

      if (
        call.destroyed
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

      pendingText +=
        token;

      // --------------------------------------------
      // SENTENCE
      // --------------------------------------------

      let match;

      while (
        (
          match =
            pendingText.match(
              /^([\s\S]*?[.!?])(?:\s+|$)/
            )
        )
      ) {

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

        if (
          sentence
        ) {

          await onText(
            sentence
          );
        }
      }

      // --------------------------------------------
      // EARLY CHUNK
      // --------------------------------------------

      if (
        pendingText.length >=
        55
      ) {

        const lastSpace =
          pendingText.lastIndexOf(
            " "
          );

        if (
          lastSpace >= 25
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
      pendingText.trim() &&
      !call.destroyed
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

    clearTimeout(
      timeout
    );
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
      .replace(/\s+/g, " ")
      .trim();

  if (
    !cleanQuestion
  ) {

    return;
  }

  console.log(
    `[${call.id}] QUESTION:`,
    cleanQuestion
  );

  const startedAt =
    Date.now();

  try {

    // ==================================================
    // TAVILY
    // ==================================================

    let webInformation =
      "";

    if (
      needsWebSearch(
        cleanQuestion
      )
    ) {

      console.log(
        `[${call.id}] LIVE SEARCH: YES`
      );

      webInformation =
        await searchWeb(
          cleanQuestion
        );

      if (
        webInformation
      ) {

        console.log(
          `[${call.id}] WEB INFO READY`
        );

      } else {

        console.log(
          `[${call.id}] WEB INFO EMPTY`
        );
      }

    } else {

      console.log(
        `[${call.id}] LIVE SEARCH: NO`
      );
    }

    if (
      call.destroyed
    ) {

      return;
    }

    // ==================================================
    // TTS STREAM
    // ==================================================

    let sentTTS =
      false;

    const sendText =
      async (text) => {

        if (
          call.destroyed
        ) {

          return;
        }

        const sent =
          sendTextToTTS(
            call,
            text
          );

        if (sent) {
          sentTTS =
            true;
        }
      };

    // ==================================================
    // GROQ STREAM
    // ==================================================

    const answer =
      await streamGroq(
        call,
        cleanQuestion,
        webInformation,
        sendText
      );

    if (
      call.destroyed
    ) {

      return;
    }

    // ==================================================
    // FLUSH TTS
    // ==================================================

    if (
      sentTTS
    ) {

      flushTTS(
        call
      );
    }

    // ==================================================
    // MEMORY
    // ==================================================

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

      // Keep latest 5 exchanges.
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
      `[${call.id}] PROCESSING TIME:`,
      Date.now() -
        startedAt,
      "ms"
    );

  } catch (error) {

    if (
      call.destroyed
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

// ==================================================
// CALL QUESTION QUEUE
// ==================================================
//
// Each call has its OWN queue.
//
// Call A's slow question cannot block Call B.
//
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

  call.questionQueue.push(
    question
  );

  runQuestionQueue(
    call
  );
}

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

// ==================================================
// CREATE CALL SESSION
// ==================================================

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

    audioSender:
      null
  };

  call.audioSender =
    createExotelAudioQueue(
      call
    );

  return call;
}

// ==================================================
// DESTROY CALL SESSION
// ==================================================

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

  console.log(
    `[${call.id}] CLEANING UP CALL`
  );

  call.questionQueue =
    [];

  call.speechFinalParts =
    [];

  call.lastInterim =
    "";

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

  call.sttSocket =
    null;

  call.ttsSocket =
    null;

  if (
    activeCalls.has(
      call.id
    )
  ) {

    activeCalls.delete(
      call.id
    );
  }

  console.log(
    `[${call.id}] ACTIVE CALLS:`,
    activeCalls.size
  );
}

// ==================================================
// SETUP DEEPGRAM FOR CALL
// ==================================================

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

    // ==================================================
    // STT MESSAGES
    // ==================================================

    sttSocket.on(
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

          // Interim result.
          if (
            !message.is_final
          ) {

            call.lastInterim =
              transcript;

            return;
          }

          // Final segment.
          call.speechFinalParts.push(
            transcript
          );

          call.lastInterim =
            "";

          // Deepgram says this utterance is complete.
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
                `[${call.id}] FINAL TRANSCRIPT:`,
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
              Buffer.from(
                data
              );

            if (
              audio.length > 0
            ) {

              call.audioSender.enqueue(
                audio
              );
            }

            return;
          }

          const text =
            data.toString();

          let message;

          try {

            message =
              JSON.parse(
                text
              );

          } catch (_) {

            return;
          }

          if (
            message.type ===
            "Flushed"
          ) {

            // Deepgram confirms all TTS
            // text has been processed.
            //
            // The audio queue may still contain
            // PCM waiting to be played, so wait
            // until the queue drains before mark.
            waitForAudioDrain(
              call
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

    // ==================================================
    // STT CLOSE
    // ==================================================

    sttSocket.on(
      "close",
      () => {

        call.sttReady =
          false;

        console.log(
          `[${call.id}] STT CLOSED`
        );
      }
    );

    // ==================================================
    // TTS CLOSE
    // ==================================================

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

    // ==================================================
    // ERRORS
    // ==================================================

    sttSocket.on(
      "error",
      (error) => {

        console.log(
          `[${call.id}] STT ERROR:`,
          error.message
        );
      }
    );

    ttsSocket.on(
      "error",
      (error) => {

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

// ==================================================
// WAIT FOR AUDIO QUEUE
// ==================================================

function waitForAudioDrain(
  call
) {

  if (
    call.destroyed
  ) {

    return;
  }

  if (
    !call.audioSender.hasPendingAudio()
  ) {

    sendExotelMark(
      call
    );

    return;
  }

  setTimeout(
    () => {

      waitForAudioDrain(
        call
      );

    },
    40
  );
}

// ==================================================
// EXOTEL CONNECTION
// ==================================================

wss.on(
  "connection",
  (ws) => {

    const call =
      createCallSession(
        ws
      );

    activeCalls.set(
      call.id,
      call
    );

    console.log(
      "======================================"
    );

    console.log(
      `[${call.id}] EXOTEL CONNECTED`
    );

    console.log(
      `[${call.id}] ACTIVE CALLS:`,
      activeCalls.size
    );

    console.log(
      "======================================"
    );

    // ==================================================
    // START DEEPGRAM IMMEDIATELY
    // ==================================================

    setupDeepgram(
      call
    );

    // ==================================================
    // EXOTEL MESSAGE
    // ==================================================

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

          // --------------------------------------------
          // CONNECTED
          // --------------------------------------------

          if (
            event ===
            "connected"
          ) {

            console.log(
              `[${call.id}] EXOTEL STREAM CONNECTED`
            );

            return;
          }

          // --------------------------------------------
          // START
          // --------------------------------------------

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
              `[${call.id}] STREAM SID:`,
              call.streamSid
            );

            return;
          }

          // --------------------------------------------
          // MEDIA
          // --------------------------------------------

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

          // --------------------------------------------
          // DTMF
          // --------------------------------------------

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

          // --------------------------------------------
          // CLEAR
          // --------------------------------------------

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

          // --------------------------------------------
          // MARK
          // --------------------------------------------

          if (
            event ===
            "mark"
          ) {

            console.log(
              `[${call.id}] EXOTEL MARK:`,
              message.mark?.name
            );

            return;
          }

          // --------------------------------------------
          // STOP
          // --------------------------------------------

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

    // ==================================================
    // CLOSE
    // ==================================================

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

    // ==================================================
    // ERROR
    // ==================================================

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

// ==================================================
// SERVER ERROR
// ==================================================

server.on(
  "error",
  (error) => {

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
      "FAST MULTI-CALL AI VOICE BRIDGE"
    );

    console.log(
      "======================================"
    );

    console.log(
      "Model:",
      GROQ_MODEL
    );

    console.log(
      "Streaming STT:",
      DEEPGRAM_STT_MODEL
    );

    console.log(
      "Streaming TTS:",
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

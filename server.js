```js
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

// ==================================================
// ENVIRONMENT VARIABLES
// ==================================================

const GROQ_API_KEY =
  process.env.GROQ_API_KEY;

const DEEPGRAM_API_KEY =
  process.env.DEEPGRAM_API_KEY;

const TAVILY_API_KEY =
  process.env.TAVILY_API_KEY;

// ==================================================
// REQUIRED KEYS
// ==================================================

if (!GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is missing");
}

if (!DEEPGRAM_API_KEY) {
  throw new Error("DEEPGRAM_API_KEY is missing");
}

if (!TAVILY_API_KEY) {
  console.warn(
    "WARNING: TAVILY_API_KEY is missing. Live web search will be disabled."
  );
}

// ==================================================
// CLIENTS
// ==================================================

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

// ==================================================
// HTTP SERVER
// ==================================================

const server = http.createServer(
  async (req, res) => {

    console.log(
      "HTTP request:",
      req.method,
      req.url
    );

    if (req.url === "/health") {

      res.writeHead(200, {
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok",
          service: "ai-voice-bridge",
          groq: "configured",
          deepgram: "configured",
          tavily:
            TAVILY_API_KEY
              ? "configured"
              : "missing"
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
        websocket: WS_URL
      })
    );
  }
);

// ==================================================
// WEBSOCKET
// ==================================================

const wss =
  new WebSocket.Server({
    server
  });

// ==================================================
// AUDIO LEVEL
// ==================================================

function getAudioLevel(buffer) {

  if (
    !buffer ||
    buffer.length < 2
  ) {
    return 0;
  }

  let total = 0;

  const samples =
    Math.floor(
      buffer.length / 2
    );

  for (
    let i = 0;
    i < samples;
    i++
  ) {

    total += Math.abs(
      buffer.readInt16LE(
        i * 2
      )
    );
  }

  return (
    total / samples
  );
}

// ==================================================
// DEEPGRAM STT
// ==================================================

async function transcribeAudio(
  pcmBuffer
) {

  console.log("");
  console.log(
    "================================"
  );
  console.log(
    "DEEPGRAM SPEECH TO TEXT"
  );
  console.log(
    "================================"
  );

  const url =
    "https://api.deepgram.com/v1/listen" +
    "?model=nova-3" +
    "&language=en" +
    "&encoding=linear16" +
    "&sample_rate=8000" +
    "&channels=1" +
    "&smart_format=true" +
    "&punctuate=true";

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          Authorization:
            `Token ${DEEPGRAM_API_KEY}`,

          "Content-Type":
            "audio/raw"
        },

        body:
          pcmBuffer
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Deepgram STT ${response.status}: ${errorText}`
    );
  }

  const data =
    await response.json();

  const transcript =
    data
      ?.results
      ?.channels?.[0]
      ?.alternatives?.[0]
      ?.transcript ||
    "";

  const text =
    String(transcript)
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "TRANSCRIPTION:",
    text
  );

  return text;
}

// ==================================================
// DETECT LIVE / CURRENT INFORMATION
// ==================================================

function needsLiveSearch(
  question
) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

  const liveKeywords = [

    // Time / date
    "right now",
    "currently",
    "current",
    "today",
    "tonight",
    "this morning",
    "this evening",
    "tomorrow",
    "yesterday",

    // Recency
    "latest",
    "recent",
    "recently",
    "newest",
    "breaking",
    "just happened",
    "what happened",

    // News
    "news",
    "headline",
    "headlines",
    "update",
    "updates",

    // Weather
    "weather",
    "temperature",
    "forecast",
    "rain",
    "raining",

    // Sports
    "score",
    "scores",
    "match",
    "game",
    "live score",
    "standings",
    "fixture",

    // Money / markets
    "stock price",
    "share price",
    "stock",
    "shares",
    "bitcoin price",
    "crypto price",
    "exchange rate",
    "currency rate",
    "price of",
    "cost of",

    // Traffic / travel
    "traffic",
    "flight status",
    "flight",
    "train status",
    "train",
    "bus status",

    // Availability
    "available now",
    "open now",
    "is it open",
    "opening hours",

    // Explicit web requests
    "search the web",
    "look it up",
    "look online",
    "check online",
    "on the internet",
    "online",

    // Current people / positions
    "who is the current",
    "who is currently",
    "who currently",

    // Explicit temporal phrases
    "as of today",
    "as of now",
    "at the moment"
  ];

  return liveKeywords.some(
    keyword =>
      q.includes(keyword)
  );
}

// ==================================================
// TAVILY WEB SEARCH
// ==================================================

async function searchWeb(
  question
) {

  if (!TAVILY_API_KEY) {

    console.log(
      "Tavily key missing. Skipping web search."
    );

    return null;
  }

  console.log("");
  console.log(
    "================================"
  );
  console.log(
    "TAVILY LIVE WEB SEARCH"
  );
  console.log(
    "================================"
  );

  console.log(
    "Search:",
    question
  );

  const response =
    await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",

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
              "fast",

            topic:
              "general",

            max_results:
              4,

            include_answer:
              "basic",

            include_raw_content:
              false
          })
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Tavily ${response.status}: ${errorText}`
    );
  }

  const data =
    await response.json();

  const answer =
    data?.answer || "";

  const results =
    Array.isArray(
      data?.results
    )
      ? data.results
      : [];

  console.log(
    "Tavily results:",
    results.length
  );

  if (answer) {

    console.log(
      "Tavily answer:",
      answer
    );
  }

  // ----------------------------------------------
  // Build compact search context.
  // Keeping this short reduces Groq latency.
  // ----------------------------------------------

  const sources =
    results
      .slice(0, 4)
      .map(
        (result, index) => {

          return (
            `[Source ${index + 1}] ` +
            `${result.title || ""}\n` +
            `${result.url || ""}\n` +
            `${result.content || ""}`
          );
        }
      )
      .join("\n\n");

  if (
    !answer &&
    !sources
  ) {

    console.log(
      "Tavily returned no useful results."
    );

    return null;
  }

  return {
    answer:
      String(answer)
        .replace(/\s+/g, " ")
        .trim(),

    sources
  };
}

// ==================================================
// GROQ LLM
// ==================================================

async function askGroq(
  question,
  webContext = null
) {

  console.log("");
  console.log(
    "================================"
  );
  console.log(
    "GROQ GPT-OSS 20B"
  );
  console.log(
    "================================"
  );

  const liveSearchUsed =
    Boolean(webContext);

  let userPrompt;

  // ----------------------------------------------
  // NORMAL QUESTION
  // ----------------------------------------------

  if (!webContext) {

    userPrompt =
      `Caller question:\n${question}\n\n` +
      "Answer the caller directly. " +
      "Keep it short and natural for a phone call.";
  }

  // ----------------------------------------------
  // LIVE WEB QUESTION
  // ----------------------------------------------

  else {

    userPrompt =
      `Caller question:\n${question}\n\n` +

      "This question requires current information. " +
      "Use ONLY the web information below for current facts. " +
      "Do not invent current information.\n\n" +

      `Tavily answer:\n${
        webContext.answer || "No direct answer."
      }\n\n` +

      `Web sources:\n${
        webContext.sources || "No source snippets."
      }\n\n` +

      "Give the caller a concise spoken answer. " +
      "Do not mention Tavily, sources, searching, prompts, " +
      "or internal processing. " +
      "If the web information is uncertain, say so briefly.";
  }

  const systemPrompt =
    "You are a fast phone voice assistant. " +
    "Return ONLY the final answer to speak aloud. " +
    "Never return reasoning or internal thoughts. " +
    "Never use markdown, bullet points, emojis, headings, " +
    "or long explanations. " +
    "Normally answer in one to three short sentences. " +
    "Be direct and conversational.";

  let completion;

  try {

    completion =
      await groq.chat.completions.create({

        model:
          "openai/gpt-oss-20b",

        messages: [

          {
            role: "system",
            content:
              systemPrompt
          },

          {
            role: "user",
            content:
              userPrompt
          }

        ],

        temperature:
          0.2,

        max_completion_tokens:
          500,

        reasoning_effort:
          "low",

        include_reasoning:
          false,

        stream:
          false
      });

  } catch (error) {

    console.error(
      "GPT-OSS request failed:",
      error
    );

    throw error;
  }

  const choice =
    completion
      ?.choices?.[0];

  const finishReason =
    choice
      ?.finish_reason;

  console.log(
    "Groq finish reason:",
    finishReason
  );

  console.log(
    "Groq usage:",
    JSON.stringify(
      completion?.usage || {}
    )
  );

  let answer =
    choice
      ?.message
      ?.content || "";

  answer =
    String(answer)
      .replace(/\s+/g, " ")
      .trim();

  // ----------------------------------------------
  // GPT-OSS SOMETIMES RETURNS EMPTY CONTENT
  // ----------------------------------------------

  if (!answer) {

    console.error(
      "GPT-OSS returned empty content."
    );

    console.error(
      "Raw Groq message:",
      JSON.stringify(
        choice?.message || {}
      )
    );

    // --------------------------------------------
    // FAST FALLBACK
    // --------------------------------------------

    console.log(
      "Trying fast Groq fallback model..."
    );

    const fallback =
      await groq.chat.completions.create({

        model:
          "llama-3.1-8b-instant",

        messages: [

          {
            role: "system",
            content:
              "You are a fast phone assistant. " +
              "Answer only the caller's question. " +
              "Be concise. No markdown. No reasoning."
          },

          {
            role: "user",
            content:
              userPrompt
          }

        ],

        temperature:
          0.2,

        max_completion_tokens:
          250,

        stream:
          false
      });

    let fallbackAnswer =
      fallback
        ?.choices?.[0]
        ?.message
        ?.content || "";

    fallbackAnswer =
      String(fallbackAnswer)
        .replace(/\s+/g, " ")
        .trim();

    console.log(
      "Fallback finish reason:",
      fallback
        ?.choices?.[0]
        ?.finish_reason
    );

    console.log(
      "Fallback answer:",
      fallbackAnswer
    );

    if (!fallbackAnswer) {

      // ------------------------------------------
      // ABSOLUTE LAST RESORT
      // ------------------------------------------

      return liveSearchUsed
        ? "I couldn't get the latest information right now. Please try again."
        : "Sorry, I couldn't process that question. Please try again.";
    }

    return fallbackAnswer;
  }

  console.log(
    "Groq answer:",
    answer
  );

  return answer;
}

// ==================================================
// DEEPGRAM TTS
// ==================================================

async function synthesizeSpeech(
  text
) {

  console.log("");
  console.log(
    "================================"
  );
  console.log(
    "DEEPGRAM TEXT TO SPEECH"
  );
  console.log(
    "================================"
  );

  let cleanText =
    String(text)
      .replace(/\s+/g, " ")
      .trim();

  // Keep phone responses short.
  cleanText =
    cleanText.slice(0, 1000);

  console.log(
    "TTS:",
    cleanText
  );

  const url =
    "https://api.deepgram.com/v1/speak" +
    "?model=aura-2-thalia-en" +
    "&encoding=linear16" +
    "&sample_rate=8000" +
    "&container=none";

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          Authorization:
            `Token ${DEEPGRAM_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            text:
              cleanText
          })
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Deepgram TTS ${response.status}: ${errorText}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  const audioBuffer =
    Buffer.from(
      arrayBuffer
    );

  console.log(
    "TTS PCM:",
    audioBuffer.length,
    "bytes"
  );

  return audioBuffer;
}

// ==================================================
// SEND AUDIO TO EXOTEL
// ==================================================

function sendAudioToExotel(
  ws,
  streamSid,
  pcmBuffer
) {

  if (
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {

    console.log(
      "Cannot send audio: WebSocket closed."
    );

    return;
  }

  /*
   * 8000 Hz
   * 16-bit
   * mono
   *
   * 20 ms =
   * 160 samples
   *
   * 160 * 2 =
   * 320 bytes
   */

  const CHUNK_SIZE =
    320;

  let sequenceNumber =
    1;

  let chunkNumber =
    0;

  let timestamp =
    0;

  for (
    let offset = 0;
    offset < pcmBuffer.length;
    offset += CHUNK_SIZE
  ) {

    const chunk =
      pcmBuffer.subarray(
        offset,
        Math.min(
          offset + CHUNK_SIZE,
          pcmBuffer.length
        )
      );

    ws.send(
      JSON.stringify({

        event:
          "media",

        sequence_number:
          String(
            sequenceNumber
          ),

        stream_sid:
          streamSid,

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
    timestamp += 20;
  }

  console.log(
    "Sent",
    chunkNumber,
    "audio chunks to Exotel."
  );

  // ----------------------------------------------
  // MARK RESPONSE COMPLETE
  // ----------------------------------------------

  ws.send(
    JSON.stringify({

      event:
        "mark",

      stream_sid:
        streamSid,

      mark: {

        name:
          "ai_response_complete"
      }
    })
  );
}

// ==================================================
// PROCESS QUESTION
// ==================================================

async function processQuestion(
  ws,
  streamSid,
  audioBuffer
) {

  try {

    console.log("");
    console.log(
      "################################"
    );
    console.log(
      "PROCESSING CALLER QUESTION"
    );
    console.log(
      "################################"
    );

    const startTime =
      Date.now();

    if (
      !audioBuffer ||
      audioBuffer.length < 4000
    ) {

      console.log(
        "Audio too short."
      );

      return;
    }

    // ==============================================
    // STT
    // ==============================================

    const question =
      await transcribeAudio(
        audioBuffer
      );

    if (!question) {

      console.log(
        "No speech detected."
      );

      return;
    }

    console.log(
      "CALLER:",
      question
    );

    // ==============================================
    // DETERMINE WHETHER WEB SEARCH IS NEEDED
    // ==============================================

    const live =
      needsLiveSearch(
        question
      );

    console.log(
      "LIVE SEARCH:",
      live
    );

    // ==============================================
    // TAVILY
    // ==============================================

    let webContext =
      null;

    if (live) {

      try {

        webContext =
          await searchWeb(
            question
          );

      } catch (error) {

        console.error(
          "Tavily search failed:",
          error.message
        );

        // Do NOT kill the call.
        webContext =
          null;
      }
    }

    // ==============================================
    // GROQ
    // ==============================================

    const answer =
      await askGroq(
        question,
        webContext
      );

    // ==============================================
    // TTS
    // ==============================================

    const speech =
      await synthesizeSpeech(
        answer
      );

    // ==============================================
    // EXOTEL
    // ==============================================

    sendAudioToExotel(
      ws,
      streamSid,
      speech
    );

    const totalTime =
      Date.now() -
      startTime;

    console.log("");
    console.log(
      "================================"
    );

    console.log(
      "ANSWER SENT TO CALLER"
    );

    console.log(
      "Total processing time:",
      totalTime,
      "ms"
    );

    console.log(
      "================================"
    );

  } catch (error) {

    console.log("");
    console.log(
      "################################"
    );

    console.log(
      "VOICE PROCESSING ERROR"
    );

    console.log(
      "################################"
    );

    console.error(
      error
    );

    // ----------------------------------------------
    // IMPORTANT:
    // Never let one failed question
    // crash the Render server.
    // ----------------------------------------------
  }
}

// ==================================================
// EXOTEL WEBSOCKET CONNECTION
// ==================================================

wss.on(
  "connection",
  (ws) => {

    console.log("");
    console.log(
      "================================"
    );

    console.log(
      "EXOTEL WEBSOCKET CONNECTED"
    );

    console.log(
      "================================"
    );

    let streamSid =
      null;

    let callSid =
      null;

    let audioChunks =
      [];

    let speechStarted =
      false;

    let silenceFrames =
      0;

    let processing =
      false;

    /*
     * Exotel frames are approximately
     * 20 ms in your current setup.
     *
     * 20 frames = ~400 ms silence.
     *
     * This is faster than the old
     * 35-frame / ~700 ms setting.
     */

    const SILENCE_FRAME_LIMIT =
      20;

    /*
     * Caller speech threshold.
     *
     * If your calls accidentally
     * cut off quiet speech,
     * lower this to 250.
     */

    const SPEECH_THRESHOLD =
      350;

    // ==============================================
    // RESET
    // ==============================================

    function resetSpeech() {

      audioChunks =
        [];

      speechStarted =
        false;

      silenceFrames =
        0;
    }

    // ==============================================
    // FINISH SPEECH
    // ==============================================

    async function finishSpeech() {

      if (processing) {
        return;
      }

      if (
        audioChunks.length === 0
      ) {

        resetSpeech();

        return;
      }

      processing =
        true;

      const fullAudio =
        Buffer.concat(
          audioChunks
        );

      console.log("");
      console.log(
        "================================"
      );

      console.log(
        "END OF SPEECH"
      );

      console.log(
        "Audio:",
        fullAudio.length,
        "bytes"
      );

      console.log(
        "================================"
      );

      resetSpeech();

      try {

        await processQuestion(
          ws,
          streamSid,
          fullAudio
        );

      } finally {

        processing =
          false;
      }
    }

    // ==============================================
    // MESSAGE
    // ==============================================

    ws.on(
      "message",
      async (data) => {

        try {

          const message =
            JSON.parse(
              data.toString()
            );

          const event =
            message.event;

          console.log(
            "Event:",
            event
          );

          // ========================================
          // CONNECTED
          // ========================================

          if (
            event ===
            "connected"
          ) {

            console.log(
              "Exotel WebSocket connected."
            );

            return;
          }

          // ========================================
          // START
          // ========================================

          if (
            event ===
            "start"
          ) {

            streamSid =
              message.stream_sid ||
              message.start?.stream_sid ||
              message.start?.streamSid ||
              null;

            callSid =
              message.start?.call_sid ||
              message.start?.callSid ||
              null;

            console.log(
              "Stream SID:",
              streamSid
            );

            console.log(
              "Call SID:",
              callSid
            );

            console.log(
              "Audio format:",
              message.start?.media_format
            );

            resetSpeech();

            return;
          }

          // ========================================
          // MEDIA
          // ========================================

          if (
            event ===
            "media"
          ) {

            if (
              !message.media?.payload
            ) {

              return;
            }

            const audio =
              Buffer.from(
                message.media.payload,
                "base64"
              );

            const level =
              getAudioLevel(
                audio
              );

            console.log(
              "Audio:",
              audio.length,
              "bytes | level:",
              Math.round(level)
            );

            // --------------------------------------
            // DON'T LISTEN WHILE PROCESSING
            // --------------------------------------

            if (processing) {

              return;
            }

            // --------------------------------------
            // SPEECH START
            // --------------------------------------

            if (
              level >
              SPEECH_THRESHOLD
            ) {

              if (
                !speechStarted
              ) {

                console.log(
                  ">>> SPEECH STARTED"
                );

                speechStarted =
                  true;
              }

              silenceFrames =
                0;

              audioChunks.push(
                audio
              );

              return;
            }

            // --------------------------------------
            // SPEECH CONTINUATION
            // --------------------------------------

            if (
              speechStarted
            ) {

              audioChunks.push(
                audio
              );

              silenceFrames++;

              console.log(
                "Silence:",
                silenceFrames,
                "/",
                SILENCE_FRAME_LIMIT
              );

              if (
                silenceFrames >=
                SILENCE_FRAME_LIMIT
              ) {

                await finishSpeech();
              }
            }

            return;
          }

          // ========================================
          // DTMF
          // ========================================

          if (
            event ===
            "dtmf"
          ) {

            console.log(
              "DTMF:",
              message.dtmf?.digit
            );

            return;
          }

          // ========================================
          // MARK
          // ========================================

          if (
            event ===
            "mark"
          ) {

            console.log(
              "Exotel mark:",
              message.mark?.name
            );

            return;
          }

          // ========================================
          // CLEAR
          // ========================================

          if (
            event ===
            "clear"
          ) {

            console.log(
              "Exotel CLEAR received."
            );

            resetSpeech();

            return;
          }

          // ========================================
          // STOP
          // ========================================

          if (
            event ===
            "stop"
          ) {

            console.log(
              "Stream stopped."
            );

            resetSpeech();

            return;
          }

        } catch (error) {

          console.log(
            "Message parsing error:",
            error.message
          );
        }
      }
    );

    // ==============================================
    // CLOSE
    // ==============================================

    ws.on(
      "close",
      () => {

        console.log(
          "Exotel WebSocket disconnected."
        );
      }
    );

    // ==============================================
    // ERROR
    // ==============================================

    ws.on(
      "error",
      (error) => {

        console.log(
          "WebSocket error:",
          error.message
        );
      }
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

    console.log("");
    console.log(
      "--------------------------------"
    );

    console.log(
      "AI VOICE BRIDGE"
    );

    console.log(
      "--------------------------------"
    );

    console.log(
      "HTTP:",
      `http://localhost:${PORT}`
    );

    console.log(
      "WebSocket:",
      `ws://localhost:${PORT}`
    );

    console.log(
      "Public WebSocket:",
      WS_URL
    );

    console.log("");

    console.log(
      "Groq LLM: openai/gpt-oss-20b"
    );

    console.log(
      "Groq fallback: llama-3.1-8b-instant"
    );

    console.log(
      "Deepgram: STT + TTS"
    );

    console.log(
      "Tavily:",
      TAVILY_API_KEY
        ? "LIVE WEB ENABLED"
        : "DISABLED"
    );

    console.log("");

    console.log(
      "Waiting for Exotel..."
    );

    console.log("");
  }
);
```

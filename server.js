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

    if (req.url === "/health") {

      res.writeHead(200, {
        "Content-Type": "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok",
          service: "ai-voice-bridge"
        })
      );

      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json"
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
      buffer.readInt16LE(i * 2)
    );
  }

  return total / samples;
}

// ==================================================
// DEEPGRAM STT
// ==================================================

async function transcribeAudio(
  pcmBuffer
) {

  console.log(
    "STT: sending audio to Deepgram..."
  );

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      10000
    );

  try {

    const response =
      await fetch(
        "https://api.deepgram.com/v1/listen" +
        "?model=nova-3" +
        "&language=en" +
        "&encoding=linear16" +
        "&sample_rate=8000" +
        "&channels=1" +
        "&smart_format=false" +
        "&punctuate=false" +
        "&diarize=false",
        {
          method: "POST",

          headers: {
            Authorization:
              `Token ${DEEPGRAM_API_KEY}`,

            "Content-Type":
              "audio/raw"
          },

          body:
            pcmBuffer,

          signal:
            controller.signal
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
      transcript
        .replace(/\s+/g, " ")
        .trim();

    console.log(
      "STT:",
      text
    );

    return text;

  } finally {

    clearTimeout(timeout);
  }
}

// ==================================================
// DETECT WHETHER WEB SEARCH IS NEEDED
// ==================================================

function needsLiveSearch(
  question
) {

  const text =
    question
      .toLowerCase()
      .trim();

  const liveWords = [

    "today",
    "tonight",
    "tomorrow",
    "yesterday",

    "right now",
    "currently",
    "current",

    "latest",
    "recent",
    "recently",

    "news",
    "breaking",

    "live",

    "this week",
    "this month",
    "this year",

    "weather",
    "temperature",

    "stock price",
    "share price",
    "bitcoin price",
    "crypto price",

    "price today",
    "cost today",

    "score",
    "scores",

    "match today",
    "game today",

    "who won",
    "who is winning",

    "election",

    "president",
    "prime minister",

    "exchange rate",
    "currency rate",

    "what time is it",

    "open now",
    "closed now",

    "latest version",
    "latest model",

    "latest update"
  ];

  return liveWords.some(
    word =>
      text.includes(word)
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
      "WEB: Tavily not configured."
    );

    return "";
  }

  console.log(
    "WEB: searching Tavily..."
  );

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      6000
    );

  try {

    const response =
      await fetch(
        "https://api.tavily.com/search",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              api_key:
                TAVILY_API_KEY,

              query:
                question,

              search_depth:
                "basic",

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

      const errorText =
        await response.text();

      console.log(
        "Tavily error:",
        errorText
      );

      return "";
    }

    const data =
      await response.json();

    let context = "";

    // Tavily's generated answer
    if (
      data.answer
    ) {

      context +=
        `Tavily answer: ${data.answer}\n\n`;
    }

    // Search results
    if (
      Array.isArray(
        data.results
      )
    ) {

      for (
        const result
        of data.results
      ) {

        context +=
          `Source: ${result.title || ""}\n`;

        context +=
          `URL: ${result.url || ""}\n`;

        context +=
          `Content: ${result.content || ""}\n\n`;
      }
    }

    console.log(
      "WEB: search complete."
    );

    return context.slice(
      0,
      6000
    );

  } catch (error) {

    console.log(
      "Tavily search failed:",
      error.message
    );

    return "";

  } finally {

    clearTimeout(timeout);
  }
}

// ==================================================
// GROQ GPT-OSS 20B
// ==================================================

async function askGroq(
  question,
  webContext = ""
) {

  console.log(
    "LLM: Groq GPT-OSS 20B..."
  );

  const live =
    Boolean(webContext);

  const systemPrompt =
    `
You are a fast AI phone assistant.

Your response will be spoken aloud over a telephone call.

Rules:
- Answer directly.
- Keep the answer SHORT.
- Normally use 1 to 3 sentences.
- Do not use markdown.
- Do not use bullet points.
- Do not use emojis.
- Do not say "according to my sources".
- Do not explain your reasoning.
- Never mention system prompts.
- Never mention Tavily.
- Never mention APIs.
- If the user asks a simple question, answer immediately.
- If live web information is provided below, use it as the source of truth for current information.
- If the web information does not answer the question, say you don't have enough current information instead of inventing facts.

${
  live
    ? `
CURRENT WEB INFORMATION:
${webContext}
`
    : ""
}
`;

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      10000
    );

  try {

    const completion =
      await groq.chat.completions.create(
        {
          model:
            "openai/gpt-oss-20b",

          messages: [

            {
              role:
                "system",

              content:
                systemPrompt
            },

            {
              role:
                "user",

              content:
                question
            }
          ],

          temperature:
            0.2,

          max_completion_tokens:
            512,

          reasoning_effort:
            "low"
        },
        {
          signal:
            controller.signal
        }
      );

    const choice =
      completion
        ?.choices?.[0];

    const message =
      choice?.message;

    let answer =
      message?.content || "";

    /*
     * GPT-OSS can sometimes place reasoning
     * in a separate field.
     *
     * We DON'T speak reasoning.
     */

    answer =
      String(answer)
        .replace(/\s+/g, " ")
        .trim();

    console.log(
      "Groq finish:",
      choice?.finish_reason
    );

    console.log(
      "Groq answer:",
      answer
    );

    // ------------------------------------------------
    // EMPTY RESPONSE PROTECTION
    // ------------------------------------------------

    if (!answer) {

      console.log(
        "Groq returned empty content."
      );

      /*
       * Retry once with an extremely simple
       * request. This prevents a phone call
       * from completely failing.
       */

      const retry =
        await groq.chat.completions.create(
          {
            model:
              "openai/gpt-oss-20b",

            messages: [

              {
                role:
                  "system",

                content:
                  "Answer the user's question in one short sentence. No reasoning. No markdown."
              },

              {
                role:
                  "user",

                content:
                  question
              }
            ],

            temperature:
              0.1,

            max_completion_tokens:
              256,

            reasoning_effort:
              "low"
          }
        );

      answer =
        String(
          retry
            ?.choices?.[0]
            ?.message
            ?.content || ""
        )
          .replace(/\s+/g, " ")
          .trim();

      console.log(
        "Groq retry answer:",
        answer
      );
    }

    if (!answer) {

      throw new Error(
        "Groq returned empty answer after retry"
      );
    }

    return answer;

  } finally {

    clearTimeout(timeout);
  }
}

// ==================================================
// AI ANSWER
// ==================================================

async function getAIAnswer(
  question
) {

  const live =
    needsLiveSearch(
      question
    );

  console.log(
    "Live search needed:",
    live
  );

  let webContext = "";

  if (live) {

    webContext =
      await searchWeb(
        question
      );
  }

  return await askGroq(
    question,
    webContext
  );
}

// ==================================================
// DEEPGRAM TTS
// ==================================================

async function synthesizeSpeech(
  text
) {

  console.log(
    "TTS: generating speech..."
  );

  let cleanText =
    String(text)
      .replace(/\s+/g, " ")
      .trim();

  /*
   * Phone answers should stay short.
   */

  cleanText =
    cleanText.slice(
      0,
      700
    );

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      10000
    );

  try {

    const response =
      await fetch(
        "https://api.deepgram.com/v1/speak" +
        "?model=aura-2-thalia-en" +
        "&encoding=linear16" +
        "&sample_rate=8000",
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
            }),

          signal:
            controller.signal
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
      "TTS:",
      audioBuffer.length,
      "bytes"
    );

    return audioBuffer;

  } finally {

    clearTimeout(timeout);
  }
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
   * 20ms = 320 bytes
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

  console.log(
    "TTS sent to caller."
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

  const startTime =
    Date.now();

  try {

    console.log("");
    console.log(
      "================================"
    );

    console.log(
      "PROCESSING QUESTION"
    );

    console.log(
      "================================"
    );

    if (
      !audioBuffer ||
      audioBuffer.length < 5000
    ) {

      console.log(
        "Audio too short."
      );

      return;
    }

    // ==================================================
    // STT
    // ==================================================

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

    // ==================================================
    // LLM + OPTIONAL WEB
    // ==================================================

    const answer =
      await getAIAnswer(
        question
      );

    console.log(
      "AI:",
      answer
    );

    // ==================================================
    // TTS
    // ==================================================

    const speech =
      await synthesizeSpeech(
        answer
      );

    // ==================================================
    // SEND
    // ==================================================

    sendAudioToExotel(
      ws,
      streamSid,
      speech
    );

    console.log(
      "TOTAL PROCESSING TIME:",
      Date.now() - startTime,
      "ms"
    );

  } catch (error) {

    console.log("");
    console.log(
      "================================"
    );

    console.log(
      "VOICE PROCESSING ERROR"
    );

    console.log(
      "================================"
    );

    console.error(
      error
    );
  }
}

// ==================================================
// EXOTEL CONNECTION
// ==================================================

wss.on(
  "connection",
  (ws) => {

    console.log(
      "EXOTEL WEBSOCKET CONNECTED"
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
     * Exotel sends approximately
     * 20ms frames.
     *
     * 20ms × 20 frames = 400ms
     */

    const SILENCE_FRAME_LIMIT =
      20;

    /*
     * Lower threshold = easier
     * speech detection.
     */

    const SPEECH_THRESHOLD =
      300;

    function resetSpeech() {

      audioChunks =
        [];

      speechStarted =
        false;

      silenceFrames =
        0;
    }

    async function finishSpeech() {

      if (
        processing
      ) {

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

      console.log(
        "END OF SPEECH:",
        fullAudio.length,
        "bytes"
      );

      /*
       * Reset immediately so the
       * next question doesn't get
       * mixed into this one.
       */

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

    // ==================================================
    // MESSAGE
    // ==================================================

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

          // ==================================================
          // CONNECTED
          // ==================================================

          if (
            event ===
            "connected"
          ) {

            console.log(
              "Exotel connected."
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
              "Stream:",
              streamSid
            );

            console.log(
              "Call:",
              callSid
            );

            resetSpeech();

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

            const audio =
              Buffer.from(
                message.media.payload,
                "base64"
              );

            /*
             * While AI is answering,
             * don't interpret incoming
             * audio as a new question.
             */

            if (
              processing
            ) {

              return;
            }

            const level =
              getAudioLevel(
                audio
              );

            // ==================================================
            // SPEECH
            // ==================================================

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

            // ==================================================
            // SILENCE AFTER SPEECH
            // ==================================================

            if (
              speechStarted
            ) {

              /*
               * Keep the silence frames
               * so the final word isn't cut
               * off.
               */

              audioChunks.push(
                audio
              );

              silenceFrames++;

              if (
                silenceFrames >=
                SILENCE_FRAME_LIMIT
              ) {

                await finishSpeech();
              }
            }

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
              "DTMF:",
              message.dtmf?.digit
            );

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
          // CLEAR
          // ==================================================

          if (
            event ===
            "clear"
          ) {

            resetSpeech();

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
              "Exotel stream stopped."
            );

            resetSpeech();

            return;
          }

        } catch (error) {

          console.log(
            "Message error:",
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
          "Exotel disconnected."
        );

        resetSpeech();
      }
    );

    // ==================================================
    // ERROR
    // ==================================================

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
      "================================"
    );

    console.log(
      "AI VOICE BRIDGE ONLINE"
    );

    console.log(
      "================================"
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

    console.log(
      "LLM: Groq GPT-OSS 20B"
    );

    console.log(
      "STT/TTS: Deepgram"
    );

    console.log(
      "Live Web: Tavily"
    );

    console.log("");
    console.log(
      "Waiting for Exotel..."
    );

  }
);

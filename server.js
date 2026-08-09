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

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

if (!GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is missing");
}

if (!DEEPGRAM_API_KEY) {
  throw new Error("DEEPGRAM_API_KEY is missing");
}

if (!TAVILY_API_KEY) {
  console.warn("WARNING: TAVILY_API_KEY is missing");
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

const server = http.createServer(async (req, res) => {
  console.log("HTTP:", req.method, req.url);

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
});

// ==================================================
// WEBSOCKET SERVER
// ==================================================

const wss = new WebSocket.Server({
  server
});

// ==================================================
// AUDIO LEVEL
// ==================================================

function getAudioLevel(buffer) {
  if (!buffer || buffer.length < 2) {
    return 0;
  }

  let total = 0;

  const samples = Math.floor(buffer.length / 2);

  for (let i = 0; i < samples; i++) {
    total += Math.abs(
      buffer.readInt16LE(i * 2)
    );
  }

  return total / samples;
}

// ==================================================
// DEEPGRAM STT
// ==================================================

async function transcribeAudio(pcmBuffer) {
  console.log("");
  console.log("================================");
  console.log("DEEPGRAM STT");
  console.log("================================");

  const url =
    "https://api.deepgram.com/v1/listen" +
    "?model=nova-3" +
    "&language=en" +
    "&encoding=linear16" +
    "&sample_rate=8000" +
    "&channels=1" +
    "&smart_format=true";

  const response = await fetch(url, {
    method: "POST",

    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
      "Content-Type": "audio/raw"
    },

    body: pcmBuffer
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Deepgram STT ${response.status}: ${errorText}`
    );
  }

  const data = await response.json();

  const transcript =
    data?.results?.channels?.[0]
      ?.alternatives?.[0]
      ?.transcript || "";

  const text = String(transcript)
    .replace(/\s+/g, " ")
    .trim();

  console.log("TRANSCRIPTION:", text);

  return text;
}

// ==================================================
// DETECT WHETHER QUESTION NEEDS LIVE WEB
// ==================================================

function needsLiveWeb(question) {
  const text = String(question)
    .toLowerCase()
    .trim();

  const realtimeWords = [
    "right now",
    "currently",
    "current",
    "today",
    "tonight",
    "this morning",
    "this afternoon",
    "this evening",
    "latest",
    "recent",
    "recently",
    "news",
    "breaking",
    "live",
    "real time",
    "realtime",
    "weather",
    "temperature",
    "stock",
    "stocks",
    "share price",
    "price today",
    "crypto",
    "bitcoin",
    "ethereum",
    "exchange rate",
    "usd",
    "inr",
    "election",
    "president",
    "prime minister",
    "score",
    "match",
    "game today",
    "games today",
    "schedule",
    "traffic",
    "flight",
    "flights",
    "event",
    "events",
    "opening hours",
    "open now"
  ];

  return realtimeWords.some((word) =>
    text.includes(word)
  );
}

// ==================================================
// TAVILY WEB SEARCH
// ==================================================

async function searchWeb(question) {
  if (!TAVILY_API_KEY) {
    console.log(
      "Tavily unavailable: TAVILY_API_KEY missing"
    );

    return "";
  }

  console.log("");
  console.log("================================");
  console.log("TAVILY LIVE WEB SEARCH");
  console.log("================================");

  try {
    const response = await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          api_key: TAVILY_API_KEY,

          query: question,

          search_depth: "basic",

          topic: "general",

          max_results: 4,

          include_answer: true,

          include_raw_content: false
        })
      }
    );

    if (!response.ok) {
      const errorText =
        await response.text();

      console.error(
        "Tavily error:",
        response.status,
        errorText
      );

      return "";
    }

    const data =
      await response.json();

    const parts = [];

    if (data.answer) {
      parts.push(
        `Tavily summary: ${data.answer}`
      );
    }

    if (Array.isArray(data.results)) {
      for (const result of data.results) {
        if (!result) {
          continue;
        }

        const title =
          result.title || "";

        const content =
          result.content || "";

        const url =
          result.url || "";

        if (content) {
          parts.push(
            `Source: ${title}\n` +
            `URL: ${url}\n` +
            `Information: ${content}`
          );
        }
      }
    }

    const webContext =
      parts.join("\n\n");

    console.log(
      "Tavily results received:",
      data.results?.length || 0
    );

    return webContext;
  } catch (error) {
    console.error(
      "Tavily search failed:",
      error.message
    );

    return "";
  }
}

// ==================================================
// GROQ LLM
// ==================================================

async function askGroq(question, webContext = "") {
  console.log("");
  console.log("================================");
  console.log("GROQ GPT-OSS 20B");
  console.log("================================");

  const liveInfoAvailable =
    Boolean(webContext);

  let systemPrompt =
    "You are a fast, natural phone voice assistant. " +
    "Your response will be spoken aloud over a telephone call. " +
    "Answer directly and conversationally. " +
    "Keep answers concise, normally 1 to 4 sentences. " +
    "Do not use markdown, bullet points, emojis, citations, URLs, " +
    "or formatting that sounds unnatural when spoken. " +
    "Never say that you searched the web unless the caller asks. ";

  if (liveInfoAvailable) {
    systemPrompt +=
      "You have been given fresh web information below. " +
      "Use it when answering the caller's question. " +
      "Treat the web information as the current source of truth. " +
      "If the information is insufficient, say that you are not certain " +
      "rather than inventing a current fact.\n\n" +
      "FRESH WEB INFORMATION:\n" +
      webContext;
  } else {
    systemPrompt +=
      "For ordinary questions, answer from your knowledge. " +
      "Do not pretend that you have live information when you do not.";
  }

  let completion;

  try {
    completion =
      await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",

        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: question
          }
        ],

        temperature: 0.2,

        max_completion_tokens: 500,

        reasoning_effort: "low"
      });
  } catch (error) {
    console.error(
      "Groq request failed:",
      error
    );

    throw new Error(
      `Groq request failed: ${error.message}`
    );
  }

  const choice =
    completion?.choices?.[0];

  const finishReason =
    choice?.finish_reason;

  const rawContent =
    choice?.message?.content;

  console.log(
    "Groq finish reason:",
    finishReason
  );

  console.log(
    "Groq raw content:",
    rawContent
  );

  // ==================================================
  // NORMAL CONTENT
  // ==================================================

  if (
    typeof rawContent === "string" &&
    rawContent.trim()
  ) {
    const answer =
      rawContent
        .replace(/\s+/g, " ")
        .trim();

    console.log(
      "GROQ ANSWER:",
      answer
    );

    return answer;
  }

  // ==================================================
  // FALLBACK
  // ==================================================

  console.log(
    "Groq returned empty content."
  );

  /*
   * GPT-OSS can occasionally spend the completion
   * budget on reasoning and return no visible
   * content.
   *
   * Retry once with a larger completion budget
   * and no reasoning request.
   */

  console.log(
    "Retrying Groq..."
  );

  const retry =
    await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",

      messages: [
        {
          role: "system",
          content:
            "You are a phone voice assistant. " +
            "Give only the final spoken answer. " +
            "Do not explain your reasoning. " +
            "Keep the answer concise."
        },
        {
          role: "user",
          content:
            liveInfoAvailable
              ? (
                  question +
                  "\n\nFresh information:\n" +
                  webContext
                )
              : question
        }
      ],

      temperature: 0.2,

      max_completion_tokens: 800
    });

  const retryContent =
    retry?.choices?.[0]?.message?.content;

  console.log(
    "Groq retry finish reason:",
    retry?.choices?.[0]?.finish_reason
  );

  console.log(
    "Groq retry content:",
    retryContent
  );

  if (
    typeof retryContent === "string" &&
    retryContent.trim()
  ) {
    return retryContent
      .replace(/\s+/g, " ")
      .trim();
  }

  /*
   * Last-resort answer.
   * This prevents the phone call from becoming
   * completely silent if Groq has a temporary
   * generation problem.
   */

  return "Sorry, I had trouble generating that answer. Please try again.";
}

// ==================================================
// DEEPGRAM TTS
// ==================================================

async function synthesizeSpeech(text) {
  console.log("");
  console.log("================================");
  console.log("DEEPGRAM TTS");
  console.log("================================");

  let cleanText =
    String(text)
      .replace(/\s+/g, " ")
      .trim();

  /*
   * Keep phone responses short.
   */

  cleanText =
    cleanText.slice(0, 1200);

  const url =
    "https://api.deepgram.com/v1/speak" +
    "?model=aura-2-thalia-en" +
    "&encoding=linear16" +
    "&sample_rate=8000";

  const response = await fetch(url, {
    method: "POST",

    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      text: cleanText
    })
  });

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
    Buffer.from(arrayBuffer);

  console.log(
    "TTS audio:",
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
    ws.readyState !== WebSocket.OPEN
  ) {
    console.log(
      "Cannot send audio: WebSocket closed."
    );

    return;
  }

  /*
   * Deepgram gives:
   *
   * 8000 Hz
   * 16-bit
   * mono
   *
   * 20 ms = 320 bytes
   */

  const CHUNK_SIZE = 320;

  let sequenceNumber = 1;
  let chunkNumber = 0;
  let timestamp = 0;

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

    if (
      ws.readyState !== WebSocket.OPEN
    ) {
      break;
    }

    ws.send(
      JSON.stringify({
        event: "media",

        sequence_number:
          String(sequenceNumber),

        stream_sid:
          streamSid,

        media: {
          chunk:
            String(chunkNumber),

          timestamp:
            String(timestamp),

          payload:
            chunk.toString("base64")
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

  if (
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(
      JSON.stringify({
        event: "mark",

        stream_sid:
          streamSid,

        mark: {
          name:
            "ai_response_complete"
        }
      })
    );
  }
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
    console.log("################################");
    console.log("PROCESSING CALLER QUESTION");
    console.log("################################");

    if (
      !audioBuffer ||
      audioBuffer.length < 4000
    ) {
      console.log(
        "Audio too short."
      );

      return;
    }

    // ==================================================
    // 1. STT
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
    // 2. LIVE WEB SEARCH ONLY WHEN NEEDED
    // ==================================================

    let webContext = "";

    if (
      needsLiveWeb(question)
    ) {
      console.log(
        "Live information requested."
      );

      webContext =
        await searchWeb(
          question
        );
    } else {
      console.log(
        "No live web search needed."
      );
    }

    // ==================================================
    // 3. LLM
    // ==================================================

    const answer =
      await askGroq(
        question,
        webContext
      );

    console.log(
      "FINAL ANSWER:",
      answer
    );

    // ==================================================
    // 4. TTS
    // ==================================================

    const speech =
      await synthesizeSpeech(
        answer
      );

    // ==================================================
    // 5. SEND TO EXOTEL
    // ==================================================

    sendAudioToExotel(
      ws,
      streamSid,
      speech
    );

    console.log(
      "ANSWER SENT TO CALLER"
    );

  } catch (error) {
    console.log("");
    console.log("################################");
    console.log("VOICE PROCESSING ERROR");
    console.log("################################");

    console.error(
      error
    );

    /*
     * Do not crash Render.
     */
  }
}

// ==================================================
// EXOTEL WEBSOCKET CONNECTION
// ==================================================

wss.on(
  "connection",
  (ws) => {
    console.log("");
    console.log("================================");
    console.log("EXOTEL WEBSOCKET CONNECTED");
    console.log("================================");

    let streamSid = null;
    let callSid = null;

    let audioChunks = [];

    let speechStarted = false;
    let silenceFrames = 0;
    let processing = false;

    /*
     * Exotel audio frames are normally
     * approximately 20ms.
     *
     * 25 frames = ~500ms silence.
     */

    const SILENCE_FRAME_LIMIT = 25;

    /*
     * Adjust this if speech detection
     * is too sensitive or not sensitive enough.
     */

    const SPEECH_THRESHOLD = 350;

    // ==================================================
    // RESET SPEECH
    // ==================================================

    function resetSpeech() {
      audioChunks = [];
      speechStarted = false;
      silenceFrames = 0;
    }

    // ==================================================
    // FINISH SPEECH
    // ==================================================

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

      processing = true;

      const fullAudio =
        Buffer.concat(
          audioChunks
        );

      console.log("");
      console.log("================================");
      console.log("END OF SPEECH");
      console.log(
        "Audio:",
        fullAudio.length,
        "bytes"
      );
      console.log("================================");

      resetSpeech();

      try {
        await processQuestion(
          ws,
          streamSid,
          fullAudio
        );
      } finally {
        processing = false;
      }
    }

    // ==================================================
    // WEBSOCKET MESSAGE
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

          console.log(
            "Event:",
            event
          );

          // ============================================
          // CONNECTED
          // ============================================

          if (
            event === "connected"
          ) {
            console.log(
              "Exotel WebSocket connected."
            );

            return;
          }

          // ============================================
          // START
          // ============================================

          if (
            event === "start"
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

          // ============================================
          // MEDIA
          // ============================================

          if (
            event === "media"
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

            /*
             * Do not collect audio while the AI
             * is processing the previous question.
             */

            if (processing) {
              return;
            }

            // ==========================================
            // SPEECH START / CONTINUATION
            // ==========================================

            if (
              level >
              SPEECH_THRESHOLD
            ) {
              if (!speechStarted) {
                console.log(
                  ">>> SPEECH STARTED"
                );

                speechStarted = true;
              }

              silenceFrames = 0;

              audioChunks.push(
                audio
              );

              return;
            }

            // ==========================================
            // SILENCE AFTER SPEECH
            // ==========================================

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

          // ============================================
          // DTMF
          // ============================================

          if (
            event === "dtmf"
          ) {
            console.log(
              "DTMF:",
              message.dtmf?.digit
            );

            return;
          }

          // ============================================
          // MARK
          // ============================================

          if (
            event === "mark"
          ) {
            console.log(
              "Exotel mark:",
              message.mark?.name
            );

            return;
          }

          // ============================================
          // CLEAR
          // ============================================

          if (
            event === "clear"
          ) {
            console.log(
              "Exotel CLEAR received."
            );

            resetSpeech();

            return;
          }

          // ============================================
          // STOP
          // ============================================

          if (
            event === "stop"
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

    // ==================================================
    // CLOSE
    // ==================================================

    ws.on(
      "close",
      () => {
        console.log(
          "Exotel WebSocket disconnected."
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
          "WebSocket error:",
          error.message
        );
      }
    );
  }
);

// ==================================================
// SERVER START
// ==================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log("--------------------------------");
    console.log("AI VOICE BRIDGE");
    console.log("--------------------------------");

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
      "Deepgram: STT + TTS"
    );

    console.log(
      "Tavily: live web search"
    );

    console.log("");
    console.log(
      "Waiting for Exotel..."
    );

    console.log("");
  }
);

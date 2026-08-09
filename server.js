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
  throw new Error("TAVILY_API_KEY is missing");
}

// ==================================================
// CLIENT
// ==================================================

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

// ==================================================
// HTTP SERVER
// ==================================================

const server = http.createServer(async (req, res) => {
  console.log("HTTP request:", req.method, req.url);

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
// WEBSOCKET
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

  const samples = Math.floor(
    buffer.length / 2
  );

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
    "&channels=1";

  const response = await fetch(
    url,
    {
      method: "POST",

      headers: {
        Authorization:
          `Token ${DEEPGRAM_API_KEY}`,

        "Content-Type":
          "audio/raw"
      },

      body: pcmBuffer
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
    data?.results?.channels?.[0]
      ?.alternatives?.[0]
      ?.transcript || "";

  const text =
    transcript
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "TRANSCRIPTION:",
    text
  );

  return text;
}

// ==================================================
// DETECT LIVE INFORMATION QUESTIONS
// ==================================================

function needsWebSearch(question) {
  const text =
    question
      .toLowerCase()
      .trim();

  const livePatterns = [

    // Current / latest
    /\b(current|currently|right now|now|today|tonight|latest|recent|recently)\b/,

    // News
    /\b(news|headlines|breaking news|updates)\b/,

    // Time-sensitive verbs
    /\b(happening|happened|won|lost|released|launched|announced)\b/,

    // Weather
    /\b(weather|temperature|forecast|rain|raining|humidity)\b/,

    // Prices / markets
    /\b(price|prices|cost|worth|stock|stocks|share price|bitcoin|crypto|exchange rate|usd|inr)\b/,

    // Sports
    /\b(score|scores|match|matches|game|games|fixture|fixtures|standings|points table)\b/,

    // People / positions
    /\b(who is the current|who's the current|current president|current prime minister|current ceo)\b/,

    // Events
    /\b(schedule|scheduled|opening hours|open now|closed now)\b/,

    // Explicit web request
    /\b(search the web|search online|look online|look it up|google it)\b/
  ];

  return livePatterns.some(
    pattern => pattern.test(text)
  );
}

// ==================================================
// TAVILY WEB SEARCH
// ==================================================

async function searchWeb(question) {
  console.log("");
  console.log("================================");
  console.log("TAVILY LIVE WEB SEARCH");
  console.log("================================");

  const response =
    await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          api_key:
            TAVILY_API_KEY,

          query:
            question,

          search_depth:
            "basic",

          topic:
            "general",

          max_results:
            5,

          include_answer:
            true,

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

  console.log(
    "Tavily results:",
    data?.results?.length || 0
  );

  // ----------------------------------------------
  // Tavily's generated answer
  // ----------------------------------------------

  let answer =
    data?.answer || "";

  // ----------------------------------------------
  // Search result snippets
  // ----------------------------------------------

  const results =
    Array.isArray(data?.results)
      ? data.results
      : [];

  const sources =
    results
      .slice(0, 5)
      .map((result, index) => {

        const title =
          result?.title || "";

        const content =
          result?.content || "";

        const url =
          result?.url || "";

        return (
          `[Source ${index + 1}] ` +
          `${title}\n` +
          `${content}\n` +
          `${url}`
        );
      })
      .join("\n\n");

  if (!answer && !sources) {
    throw new Error(
      "Tavily returned no useful search results"
    );
  }

  const webContext =
    [
      answer
        ? `Tavily summary:\n${answer}`
        : "",

      sources
        ? `Search results:\n${sources}`
        : ""
    ]
      .filter(Boolean)
      .join("\n\n");

  console.log(
    "Web context prepared."
  );

  return webContext;
}

// ==================================================
// GROQ NORMAL QUESTION
// ==================================================

async function askGroq(question) {
  console.log("");
  console.log("================================");
  console.log("GROQ GPT-OSS 20B");
  console.log("================================");

  const completion =
    await groq.chat.completions.create({

      model:
        "openai/gpt-oss-20b",

      messages: [
        {
          role: "system",

          content:
            "You are a fast, natural phone voice assistant. " +
            "Answer conversationally and concisely. " +
            "Your response will be spoken aloud over a phone call. " +
            "Do not use markdown, bullet points, emojis, URLs, or citations. " +
            "Usually answer in one or two short sentences."
        },

        {
          role: "user",

          content:
            question
        }
      ],

      temperature:
        0.2,

      max_tokens:
        150
    });

  const choice =
    completion?.choices?.[0];

  let answer =
    choice?.message?.content;

  // Some models/providers may return
  // content in an unexpected structure.

  if (
    typeof answer !== "string"
  ) {

    if (
      Array.isArray(answer)
    ) {

      answer =
        answer
          .map(part => {

            if (
              typeof part === "string"
            ) {
              return part;
            }

            return (
              part?.text || ""
            );
          })
          .join(" ");
    }
  }

  const text =
    String(answer || "")
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "Groq finish reason:",
    choice?.finish_reason
  );

  console.log(
    "Groq answer:",
    text
  );

  if (!text) {

    console.log(
      "Groq returned empty content."
    );

    throw new Error(
      "Groq returned an empty answer"
    );
  }

  return text;
}

// ==================================================
// GROQ WITH WEB CONTEXT
// ==================================================

async function askGroqWithWeb(
  question,
  webContext
) {
  console.log("");
  console.log("================================");
  console.log("GROQ + TAVILY");
  console.log("================================");

  const completion =
    await groq.chat.completions.create({

      model:
        "openai/gpt-oss-20b",

      messages: [
        {
          role:
            "system",

          content:
            "You are a fast phone voice assistant. " +
            "Answer the caller using the supplied live web information. " +
            "The web information may contain multiple sources. " +
            "Use the most relevant and recent information. " +
            "Do not invent facts that are not supported by the web information. " +
            "If the information is uncertain or conflicting, say so briefly. " +
            "Your answer will be spoken aloud. " +
            "Do not use markdown, bullet points, emojis, URLs, citations, or source names unless necessary. " +
            "Keep the answer concise, usually one to three sentences."
        },

        {
          role:
            "user",

          content:
            `Caller question:\n${question}\n\n` +
            `LIVE WEB INFORMATION:\n${webContext}`
        }
      ],

      temperature:
        0.2,

      max_tokens:
        180
    });

  const choice =
    completion?.choices?.[0];

  let answer =
    choice?.message?.content;

  if (
    typeof answer !== "string"
  ) {

    if (
      Array.isArray(answer)
    ) {

      answer =
        answer
          .map(part => {

            if (
              typeof part === "string"
            ) {
              return part;
            }

            return (
              part?.text || ""
            );
          })
          .join(" ");
    }
  }

  const text =
    String(answer || "")
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "Groq web answer:",
    text
  );

  if (!text) {
    throw new Error(
      "Groq returned an empty web-search answer"
    );
  }

  return text;
}

// ==================================================
// SMART LLM
// ==================================================

async function getAIAnswer(question) {

  const shouldSearch =
    needsWebSearch(question);

  console.log("");
  console.log(
    "WEB SEARCH NEEDED:",
    shouldSearch
  );

  if (!shouldSearch) {

    return await askGroq(
      question
    );
  }

  // ----------------------------------------------
  // LIVE WEB SEARCH
  // ----------------------------------------------

  try {

    const webContext =
      await searchWeb(
        question
      );

    return await askGroqWithWeb(
      question,
      webContext
    );

  } catch (error) {

    console.error(
      "Live search failed:",
      error.message
    );

    // If web search fails,
    // still answer using Groq.

    console.log(
      "Falling back to Groq without web."
    );

    return await askGroq(
      question
    );
  }
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

  // Keep phone answers short.

  cleanText =
    cleanText.slice(0, 1000);

  const url =
    "https://api.deepgram.com/v1/speak" +
    "?model=aura-2-thalia-en" +
    "&encoding=linear16" +
    "&sample_rate=8000";

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

    ws.send(
      JSON.stringify({
        event:
          "media",

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
    "audio chunks."
  );

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
    console.log("################################");
    console.log("PROCESSING QUESTION");
    console.log("################################");

    if (
      !audioBuffer ||
      audioBuffer.length < 8000
    ) {

      console.log(
        "Audio too short."
      );

      return;
    }

    // ----------------------------------------------
    // STT
    // ----------------------------------------------

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

    // ----------------------------------------------
    // SMART AI
    // ----------------------------------------------

    const answer =
      await getAIAnswer(
        question
      );

    console.log(
      "FINAL ANSWER:",
      answer
    );

    // ----------------------------------------------
    // TTS
    // ----------------------------------------------

    const speech =
      await synthesizeSpeech(
        answer
      );

    // ----------------------------------------------
    // EXOTEL
    // ----------------------------------------------

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
  }
}

// ==================================================
// EXOTEL CONNECTION
// ==================================================

wss.on(
  "connection",
  (ws) => {

    console.log("");
    console.log("================================");
    console.log("EXOTEL WEBSOCKET CONNECTED");
    console.log("================================");

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

    // 20 ms frames

    const SILENCE_FRAME_LIMIT =
      28;

    // Slightly more responsive

    const SPEECH_THRESHOLD =
      350;

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

        processing =
          false;
      }
    }

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

          // Don't spam Render logs
          // for every audio frame.

          if (
            event !== "media"
          ) {

            console.log(
              "Event:",
              event
            );
          }

          // ========================================
          // CONNECTED
          // ========================================

          if (
            event === "connected"
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

          // ========================================
          // MEDIA
          // ========================================

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

            // Don't process new speech while
            // the previous response is being made.

            if (
              processing
            ) {

              return;
            }

            const level =
              getAudioLevel(
                audio
              );

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

              // ------------------------------------
              // SPEECH END
              // ------------------------------------

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
            event === "dtmf"
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
            event === "mark"
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
            event === "clear"
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

    ws.on(
      "close",
      () => {

        console.log(
          "Exotel WebSocket disconnected."
        );
      }
    );

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
      "Groq:",
      "openai/gpt-oss-20b"
    );

    console.log(
      "Deepgram:",
      "STT + TTS"
    );

    console.log(
      "Tavily:",
      "LIVE WEB SEARCH"
    );

    console.log("");
    console.log(
      "Waiting for Exotel..."
    );

    console.log("");
  }
);

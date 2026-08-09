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
  console.log("WARNING: TAVILY_API_KEY missing");
}

// ==================================================
// GROQ
// ==================================================

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

// ==================================================
// HTTP SERVER
// ==================================================

const server = http.createServer(
  (req, res) => {

    if (req.url === "/health") {

      res.writeHead(200, {
        "Content-Type": "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok",
          model: GROQ_MODEL
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
        websocket: WS_URL,
        model: GROQ_MODEL
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
    Math.floor(buffer.length / 2);

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

  const response =
    await fetch(
      "https://api.deepgram.com/v1/listen" +
      "?model=nova-3" +
      "&language=en" +
      "&encoding=linear16" +
      "&sample_rate=8000" +
      "&channels=1",
      {
        method: "POST",

        headers: {
          Authorization:
            "Token " +
            DEEPGRAM_API_KEY,

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
      "Deepgram STT " +
      response.status +
      ": " +
      errorText
    );
  }

  const data =
    await response.json();

  const transcript =
    data?.results?.channels?.[0]
      ?.alternatives?.[0]
      ?.transcript || "";

  return String(transcript)
    .replace(/\s+/g, " ")
    .trim();
}

// ==================================================
// FAST WEB SEARCH DETECTION
// ==================================================

function needsWebSearch(question) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

  // Current/live information
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
    "timings",
    "price",
    "prices",
    "cost",
    "stock price",
    "score",
    "schedule"
  ];

  for (
    const word of liveWords
  ) {

    if (q.includes(word)) {
      return true;
    }
  }

  // Local information
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
    "shops",
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

    if (q.includes(word)) {
      return true;
    }
  }

  return false;
}

// ==================================================
// TAVILY
// ==================================================

async function searchWeb(question) {

  if (!TAVILY_API_KEY) {
    return "";
  }

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

          body: JSON.stringify({

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
          })
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

    if (
      Array.isArray(
        data?.results
      )
    ) {

      for (
        const item of data.results
      ) {

        result +=
          (item.title || "") +
          ": " +
          (item.content || "") +
          " ";
      }
    }

    return result
      .replace(/\s+/g, " ")
      .trim();

  } catch (error) {

    console.log(
      "Tavily error:",
      error.message
    );

    return "";
  }
}

// ==================================================
// GROQ
// ==================================================

async function askGroq(
  question,
  conversationHistory,
  webInformation
) {

  const messages = [

    {
      role: "system",

      content:
        "You are a fast, friendly phone AI assistant. " +
        "Never call yourself Google Assistant, Siri or Alexa. " +
        "Speak naturally and casually. " +
        "For simple questions, answer in 1 or 2 short sentences. " +
        "For larger questions, give the important information without unnecessary detail. " +
        "Remember the conversation during this call. " +
        "Understand references like it, that, there, the first one and what about it. " +
        "Never mention internal tools or APIs. " +
        "If web information is provided, use it for current facts."
    }
  ];

  // Add conversation memory
  for (
    const message of conversationHistory
  ) {

    messages.push({
      role:
        message.role,

      content:
        message.content
    });
  }

  // Add web information only when necessary
  if (webInformation) {

    messages.push({

      role: "system",

      content:
        "Current web information: " +
        webInformation
    });
  }

  // Current question
  messages.push({

    role: "user",

    content:
      question
  });

  const completion =
    await groq.chat.completions.create({

      model:
        GROQ_MODEL,

      messages:
        messages,

      temperature:
        0.2,

      max_tokens:
        90,

      top_p:
        0.9
    });

  const answer =
    completion
      ?.choices?.[0]
      ?.message?.content || "";

  const text =
    String(answer)
      .replace(/\s+/g, " ")
      .trim();

  if (!text) {

    throw new Error(
      "Groq returned empty content"
    );
  }

  return text;
}

// ==================================================
// DEEPGRAM TTS
// ==================================================

async function synthesizeSpeech(
  text
) {

  let cleanText =
    String(text)
      .replace(/\s+/g, " ")
      .trim();

  // Shorter = faster TTS
  cleanText =
    cleanText.slice(
      0,
      500
    );

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
            "Token " +
            DEEPGRAM_API_KEY,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          text:
            cleanText
        })
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      "Deepgram TTS " +
      response.status +
      ": " +
      errorText
    );
  }

  const audio =
    await response.arrayBuffer();

  return Buffer.from(audio);
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
    return;
  }

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
          offset +
            CHUNK_SIZE,
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
}

// ==================================================
// PROCESS QUESTION
// ==================================================

async function processQuestion(
  ws,
  streamSid,
  audioBuffer,
  conversationHistory
) {

  try {

    const question =
      await transcribeAudio(
        audioBuffer
      );

    if (!question) {
      return;
    }

    console.log(
      "CALLER:",
      question
    );

    // ----------------------------------------------
    // WEB SEARCH ONLY WHEN NEEDED
    // ----------------------------------------------

    let webInformation =
      "";

    if (
      needsWebSearch(
        question
      )
    ) {

      console.log(
        "WEB SEARCH"
      );

      webInformation =
        await searchWeb(
          question
        );
    }

    // ----------------------------------------------
    // GROQ
    // ----------------------------------------------

    const answer =
      await askGroq(
        question,
        conversationHistory,
        webInformation
      );

    console.log(
      "AI:",
      answer
    );

    // ----------------------------------------------
    // MEMORY
    // ----------------------------------------------

    conversationHistory.push({

      role:
        "user",

      content:
        question
    });

    conversationHistory.push({

      role:
        "assistant",

      content:
        answer
    });

    // Keep memory small
    if (
      conversationHistory.length >
      10
    ) {

      conversationHistory.splice(
        0,
        conversationHistory.length -
          10
      );
    }

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

  } catch (error) {

    console.log(
      "VOICE ERROR:",
      error.message
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
      "EXOTEL CONNECTED"
    );

    let streamSid =
      null;

    let callSid =
      null;

    // Memory belongs to this call
    let conversationHistory =
      [];

    let audioChunks =
      [];

    let speechStarted =
      false;

    let silenceFrames =
      0;

    let processing =
      false;

    // ==================================================
    // SPEED SETTINGS
    // ==================================================

    // 20 ms per frame
    // 10 frames = approximately 200 ms
    const SILENCE_FRAME_LIMIT =
      10;

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

      resetSpeech();

      try {

        await processQuestion(
          ws,
          streamSid,
          fullAudio,
          conversationHistory
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

          // --------------------------------------------
          // CONNECTED
          // --------------------------------------------

          if (
            event ===
            "connected"
          ) {
            return;
          }

          // --------------------------------------------
          // START
          // --------------------------------------------

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
              "CALL START:",
              callSid
            );

            // New call = fresh memory
            conversationHistory =
              [];

            resetSpeech();

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

            // Ignore caller while AI is answering
            if (processing) {
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

            // ------------------------------------------
            // SPEECH
            // ------------------------------------------

            if (
              level >
              SPEECH_THRESHOLD
            ) {

              if (
                !speechStarted
              ) {

                speechStarted =
                  true;

                console.log(
                  "SPEECH START"
                );
              }

              silenceFrames =
                0;

              audioChunks.push(
                audio
              );

              return;
            }

            // ------------------------------------------
            // SILENCE
            // ------------------------------------------

            if (
              speechStarted
            ) {

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

          // --------------------------------------------
          // DTMF
          // --------------------------------------------

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

          // --------------------------------------------
          // CLEAR
          // --------------------------------------------

          if (
            event ===
            "clear"
          ) {

            resetSpeech();

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
              "CALL END"
            );

            conversationHistory =
              [];

            resetSpeech();

            return;
          }

        } catch (error) {

          console.log(
            "MESSAGE ERROR:",
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

        conversationHistory =
          [];

        resetSpeech();

        console.log(
          "EXOTEL DISCONNECTED"
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
          "WEBSOCKET ERROR:",
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

    console.log(
      "================================"
    );

    console.log(
      "AI VOICE BRIDGE READY"
    );

    console.log(
      "================================"
    );

    console.log(
      "Model:",
      GROQ_MODEL
    );

    console.log(
      "STT: Deepgram Nova-3"
    );

    console.log(
      "TTS: Deepgram Aura-2"
    );

    console.log(
      "Web: Tavily"
    );

    console.log(
      "WebSocket:",
      WS_URL
    );

    console.log(
      "================================"
    );
  }
);

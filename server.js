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
  console.log(
    "WARNING: TAVILY_API_KEY is missing. Live web search disabled."
  );
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
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok",
          service: "ai-voice-bridge",
          model: GROQ_MODEL
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
    data &&
    data.results &&
    data.results.channels &&
    data.results.channels[0] &&
    data.results.channels[0].alternatives &&
    data.results.channels[0]
      .alternatives[0]
      ? data.results.channels[0]
          .alternatives[0]
          .transcript
      : "";

  return String(
    transcript || ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

// ==================================================
// DETERMINE WHETHER WEB SEARCH IS NEEDED
// ==================================================

function needsWebSearch(
  question
) {

  const q =
    String(question)
      .toLowerCase()
      .trim();

  // ----------------------------------------------
  // LIVE INFORMATION
  // ----------------------------------------------

  const liveKeywords = [

    "today",
    "tonight",
    "tomorrow",
    "yesterday",

    "now",
    "currently",
    "current",

    "latest",
    "recent",
    "recently",

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

    "stock price",

    "score",
    "match today",
    "game today",

    "schedule"
  ];

  for (
    const keyword of liveKeywords
  ) {

    if (
      q.includes(keyword)
    ) {
      return true;
    }
  }

  // ----------------------------------------------
  // LOCAL INFORMATION
  // ----------------------------------------------

  const localKeywords = [

    "best restaurant",
    "best restaurants",

    "best cafe",
    "best cafes",

    "best hotel",
    "best hotels",

    "best place",
    "best places",

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
    const keyword of localKeywords
  ) {

    if (
      q.includes(keyword)
    ) {
      return true;
    }
  }

  // ----------------------------------------------
  // LOCATIONS
  // ----------------------------------------------

  const locations = [

    "coimbatore",
    "chennai",
    "bangalore",
    "bengaluru",
    "mumbai",
    "delhi",
    "hyderabad",
    "kochi",
    "madurai",
    "salem",
    "tiruppur",

    "tamil nadu",
    "kerala",
    "india"
  ];

  const locationWords = [

    "where",
    "best",
    "restaurant",
    "hotel",
    "cafe",
    "mall",
    "near",
    "open",
    "price",
    "weather",
    "today",
    "latest",
    "recommend",
    "located"
  ];

  for (
    const location of locations
  ) {

    if (
      q.includes(location)
    ) {

      for (
        const word of locationWords
      ) {

        if (
          q.includes(word)
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

// ==================================================
// TAVILY WEB SEARCH
// ==================================================

async function searchWeb(
  question
) {

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

            topic:
              "general",

            max_results:
              3,

            include_answer:
              true,

            include_raw_content:
              false
          })
        }
      );

    if (!response.ok) {

      console.log(
        "Tavily failed:",
        response.status
      );

      return "";
    }

    const data =
      await response.json();

    let information = "";

    if (
      data &&
      data.answer
    ) {

      information +=
        data.answer + " ";
    }

    if (
      data &&
      Array.isArray(
        data.results
      )
    ) {

      for (
        const result of
          data.results
      ) {

        if (!result) {
          continue;
        }

        information +=
          (result.title || "") +
          ": " +
          (result.content || "") +
          " ";
      }
    }

    return information
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
// GROQ LLM
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
        "You are a fast, friendly AI phone assistant. " +

        "You are NOT Google Assistant, Siri or Alexa. " +

        "Never call yourself Google Assistant. " +

        "Talk naturally like a helpful person on the phone. " +

        "Be friendly and casual, not overly formal. " +

        "Keep answers concise because they are spoken aloud. " +

        "Normally answer in 1 to 4 short sentences. " +

        "However, if the caller asks a larger question, give enough information to properly answer it. " +

        "Do not unnecessarily cut off important information. " +

        "Do not use markdown, bullet points, emojis or long introductions. " +

        "Do not mention APIs, Tavily, Groq, Deepgram or internal tools. " +

        "Remember the conversation during the current phone call. " +

        "Use previous questions and answers when the caller refers to something indirectly. " +

        "For example, understand 'what about the first one?', 'how much is it?', 'where is it?', and 'tell me more'. " +

        "If web information is provided, use it for current facts. " +

        "Never invent current prices, opening hours, locations or news. " +

        "For simple questions, answer immediately and naturally."
    }
  ];

  // ----------------------------------------------
  // MEMORY
  // ----------------------------------------------

  for (
    const message of
      conversationHistory
  ) {

    messages.push({
      role:
        message.role,

      content:
        message.content
    });
  }

  // ----------------------------------------------
  // WEB INFORMATION
  // ----------------------------------------------

  if (
    webInformation
  ) {

    messages.push({

      role:
        "system",

      content:
        "Current web information for the caller's question: " +
        webInformation
    });
  }

  // ----------------------------------------------
  // QUESTION
  // ----------------------------------------------

  messages.push({

    role:
      "user",

    content:
      question
  });

  // ----------------------------------------------
  // GROQ
  // ----------------------------------------------

  const completion =
    await groq.chat.completions.create({

      model:
        GROQ_MODEL,

      messages:
        messages,

      temperature:
        0.3,

      // ==========================================
      // 150 TOKENS
      // ==========================================

      max_tokens:
        150,

      top_p:
        0.9,

      stream:
        false
    });

  const choice =
    completion &&
    completion.choices &&
    completion.choices[0]
      ? completion.choices[0]
      : null;

  if (!choice) {

    throw new Error(
      "Groq returned no choices"
    );
  }

  const answer =
    choice.message &&
    typeof choice.message.content ===
      "string"
      ? choice.message.content
      : "";

  const text =
    answer
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "Groq finish reason:",
    choice.finish_reason
  );

  console.log(
    "AI ANSWER:",
    text
  );

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

  // Keep spoken responses reasonably short.
  cleanText =
    cleanText.slice(
      0,
      700
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

  const arrayBuffer =
    await response.arrayBuffer();

  return Buffer.from(
    arrayBuffer
  );
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
      "WebSocket closed."
    );

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

  const startTime =
    Date.now();

  try {

    console.log("");
    console.log(
      "===== PROCESSING QUESTION ====="
    );

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

    console.log(
      "STT:",
      Date.now() -
      startTime +
      "ms"
    );

    // ----------------------------------------------
    // WEB SEARCH
    // ----------------------------------------------

    let webInformation =
      "";

    if (
      needsWebSearch(
        question
      )
    ) {

      console.log(
        "WEB SEARCH: YES"
      );

      webInformation =
        await searchWeb(
          question
        );

    } else {

      console.log(
        "WEB SEARCH: NO"
      );
    }

    // ----------------------------------------------
    // LLM
    // ----------------------------------------------

    const answer =
      await askGroq(
        question,
        conversationHistory,
        webInformation
      );

    console.log(
      "LLM:",
      Date.now() -
      startTime +
      "ms"
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

    // Keep only recent conversation.
    if (
      conversationHistory.length >
      12
    ) {

      conversationHistory.splice(
        0,
        conversationHistory.length -
        12
      );
    }

    // ----------------------------------------------
    // TTS
    // ----------------------------------------------

    const speech =
      await synthesizeSpeech(
        answer
      );

    console.log(
      "TTS:",
      Date.now() -
      startTime +
      "ms"
    );

    // ----------------------------------------------
    // SEND
    // ----------------------------------------------

    sendAudioToExotel(
      ws,
      streamSid,
      speech
    );

    console.log(
      "TOTAL:",
      Date.now() -
      startTime +
      "ms"
    );

    console.log(
      "===== ANSWER SENT ====="
    );

  } catch (error) {

    console.log("");
    console.log(
      "===== VOICE PROCESSING ERROR ====="
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

    // ----------------------------------------------
    // CONVERSATION MEMORY
    // ----------------------------------------------

    let conversationHistory =
      [];

    // ----------------------------------------------
    // SPEECH BUFFER
    // ----------------------------------------------

    let audioChunks =
      [];

    let speechStarted =
      false;

    let silenceFrames =
      0;

    let processing =
      false;

    // ----------------------------------------------
    // FAST SPEECH DETECTION
    // ----------------------------------------------

    const SILENCE_FRAME_LIMIT =
      18;

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
    // EXOTEL MESSAGES
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

            console.log(
              "Exotel connected."
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

            streamSid =
              message.stream_sid ||
              (
                message.start &&
                (
                  message.start.stream_sid ||
                  message.start.streamSid
                )
              ) ||
              null;

            callSid =
              (
                message.start &&
                (
                  message.start.call_sid ||
                  message.start.callSid
                )
              ) ||
              null;

            console.log(
              "Stream SID:",
              streamSid
            );

            console.log(
              "Call SID:",
              callSid
            );

            // New call = new memory.
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
              !message.media ||
              !message.media.payload
            ) {

              return;
            }

            const audio =
              Buffer.from(
                message.media.payload,
                "base64"
              );

            // Don't listen for a new question
            // while answering the previous one.
            if (
              processing
            ) {

              return;
            }

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
                  ">>> SPEECH STARTED"
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
              message.dtmf
                ? message.dtmf.digit
                : ""
            );

            return;
          }

          // --------------------------------------------
          // MARK
          // --------------------------------------------

          if (
            event ===
            "mark"
          ) {

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
              "CALL ENDED"
            );

            conversationHistory =
              [];

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

        conversationHistory =
          [];

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
      "AI VOICE BRIDGE"
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
      "Web Search: Tavily"
    );

    console.log(
      "WebSocket:",
      WS_URL
    );

    console.log(
      "Max LLM tokens: 150"
    );

    console.log(
      "================================"
    );
  }
);

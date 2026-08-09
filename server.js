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

  const samples =
    Math.floor(buffer.length / 2);

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

  const response = await fetch(url, {
    method: "POST",

    headers: {
      Authorization:
        `Token ${DEEPGRAM_API_KEY}`,

      "Content-Type":
        "audio/raw"
    },

    body: pcmBuffer
  });

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
// DETERMINE IF WEB SEARCH IS NEEDED
// ==================================================

function needsWebSearch(question) {
  const q =
    String(question)
      .toLowerCase()
      .trim();

  const liveWords = [
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
    "live",
    "news",
    "weather",
    "temperature",
    "forecast",
    "score",
    "scores",
    "match",
    "game",
    "won",
    "winner",
    "price",
    "prices",
    "stock",
    "traffic",
    "open",
    "opening",
    "closed",
    "available",
    "availability"
  ];

  const localWords = [
    "restaurant",
    "restaurants",
    "hotel",
    "hotels",
    "mall",
    "malls",
    "shop",
    "shops",
    "store",
    "stores",
    "cafe",
    "cafes",
    "coffee",
    "hospital",
    "hospitals",
    "cinema",
    "cinemas",
    "theatre",
    "theater",
    "near me",
    "nearby",
    "in coimbatore",
    "in chennai",
    "in bangalore",
    "in bengaluru",
    "in mumbai",
    "in delhi",
    "in hyderabad"
  ];

  const currentPhrases = [
    "what is the best",
    "which is the best",
    "where is",
    "where can i find",
    "what are the best",
    "recommend",
    "recommendations",
    "look up",
    "search for",
    "find me",
    "tell me about"
  ];

  if (
    liveWords.some(word =>
      q.includes(word)
    )
  ) {
    return true;
  }

  if (
    localWords.some(word =>
      q.includes(word)
    )
  ) {
    return true;
  }

  if (
    currentPhrases.some(phrase =>
      q.includes(phrase)
    )
  ) {
    return true;
  }

  return false;
}

// ==================================================
// TAVILY WEB SEARCH
// ==================================================

async function searchWeb(question) {
  console.log("");
  console.log("================================");
  console.log("TAVILY WEB SEARCH");
  console.log("================================");

  if (!TAVILY_API_KEY) {
    console.log(
      "Tavily key missing - skipping web search."
    );

    return "";
  }

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

  let context = "";

  // Tavily's generated answer
  if (data?.answer) {
    context +=
      `Tavily answer: ${data.answer}\n\n`;
  }

  // Search results
  const results =
    Array.isArray(data?.results)
      ? data.results
      : [];

  for (
    let i = 0;
    i < results.length;
    i++
  ) {
    const result =
      results[i];

    context +=
      `SOURCE ${i + 1}\n`;

    context +=
      `Title: ${result?.title || ""}\n`;

    context +=
      `URL: ${result?.url || ""}\n`;

    context +=
      `Content: ${result?.content || ""}\n\n`;
  }

  // Prevent an enormous prompt
  context =
    context.slice(0, 12000);

  console.log(
    "Web context length:",
    context.length
  );

  return context;
}

// ==================================================
// GROQ LLM
// ==================================================

async function askGroq(
  question,
  webContext = ""
) {
  console.log("");
  console.log("================================");
  console.log("GROQ LLAMA 3.1 8B");
  console.log("================================");

  const usingWeb =
    Boolean(webContext);

  let systemPrompt;

  if (usingWeb) {
    systemPrompt =
      "You are a fast phone voice assistant. " +
      "Answer the caller using the web search information provided below. " +
      "The web information is the source of truth for current information. " +
      "Never claim you cannot access current information when web information is provided. " +
      "For local recommendations, clearly name the relevant places. " +
      "For location questions, give the location/address when available. " +
      "Do not mention Tavily, web search, APIs, prompts, or sources unless necessary. " +
      "Keep the answer short and natural because it will be spoken over a phone call. " +
      "Do not use markdown, bullet points, emojis, or long explanations.\n\n" +
      "WEB INFORMATION:\n" +
      webContext;
  } else {
    systemPrompt =
      "You are a fast phone voice assistant. " +
      "Answer naturally and conversationally. " +
      "Keep answers short because they will be spoken over a phone call. " +
      "Do not use markdown, bullet points, emojis, or long explanations. " +
      "Give the direct answer first.";
  }

  const completion =
    await groq.chat.completions.create({
      model:
        "llama-3.1-8b-instant",

      messages: [
        {
          role: "system",
          content:
            systemPrompt
        },
        {
          role: "user",
          content:
            question
        }
      ],

      temperature: 0.2,

      max_tokens: 160,

      stream: false
    });

  const choice =
    completion?.choices?.[0];

  const message =
    choice?.message;

  const rawContent =
    message?.content;

  console.log(
    "Groq finish reason:",
    choice?.finish_reason
  );

  console.log(
    "Groq raw content:",
    rawContent
  );

  let answer =
    String(
      rawContent || ""
    )
      .replace(/\s+/g, " ")
      .trim();

  // ==================================================
  // EMPTY RESPONSE PROTECTION
  // ==================================================

  if (!answer) {
    console.log(
      "Groq returned empty content."
    );

    // If Groq finishes because of token limit,
    // try one very small emergency request.
    if (
      choice?.finish_reason ===
      "length"
    ) {
      console.log(
        "Retrying Groq with smaller response..."
      );

      const retry =
        await groq.chat.completions.create({
          model:
            "llama-3.1-8b-instant",

          messages: [
            {
              role: "system",
              content:
                "Answer the caller in one short sentence. " +
                "Return ONLY the spoken answer."
            },
            {
              role: "user",
              content:
                question
            }
          ],

          temperature: 0.1,

          max_tokens: 80,

          stream: false
        });

      answer =
        String(
          retry?.choices?.[0]
            ?.message?.content || ""
        )
          .replace(/\s+/g, " ")
          .trim();
    }
  }

  if (!answer) {
    throw new Error(
      "Groq returned an empty answer"
    );
  }

  console.log(
    "FINAL AI ANSWER:",
    answer
  );

  return answer;
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

  // Keep phone answers short
  cleanText =
    cleanText.slice(0, 900);

  const url =
    "https://api.deepgram.com/v1/speak" +
    "?model=aura-2-thalia-en" +
    "&encoding=linear16" +
    "&sample_rate=8000";

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        Authorization:
          `Token ${DEEPGRAM_API_KEY}`,

        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify({
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
    "TTS bytes:",
    audioBuffer.length
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

  // 20ms at 8kHz / 16-bit mono
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
// GET AI ANSWER
// ==================================================

async function getAIAnswer(question) {
  const shouldSearch =
    needsWebSearch(question);

  console.log(
    "Web search required:",
    shouldSearch
  );

  let webContext = "";

  if (shouldSearch) {
    try {
      webContext =
        await searchWeb(question);
    } catch (error) {
      console.error(
        "Tavily search failed:",
        error.message
      );

      // Continue without web instead of
      // killing the phone call.
      webContext = "";
    }
  }

  return await askGroq(
    question,
    webContext
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
    console.log("PROCESSING CALLER QUESTION");
    console.log("################################");

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
    // WEB + LLM
    // ==================================================

    const answer =
      await getAIAnswer(
        question
      );

    // ==================================================
    // TTS
    // ==================================================

    const speech =
      await synthesizeSpeech(
        answer
      );

    // ==================================================
    // EXOTEL
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

    let streamSid = null;
    let callSid = null;

    let audioChunks = [];

    let speechStarted = false;
    let silenceFrames = 0;
    let processing = false;

    // 20ms frames
    const SILENCE_FRAME_LIMIT = 25;

    // Lower than before = faster detection
    const SPEECH_THRESHOLD = 300;

    function resetSpeech() {
      audioChunks = [];
      speechStarted = false;
      silenceFrames = 0;
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

          // ==================================================
          // CONNECTED
          // ==================================================

          if (
            event === "connected"
          ) {
            console.log(
              "Exotel WebSocket connected."
            );

            return;
          }

          // ==================================================
          // START
          // ==================================================

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

            // Don't collect audio while
            // processing the previous question.
            if (processing) {
              return;
            }

            // ==================================================
            // SPEECH START
            // ==================================================

            if (
              level >
              SPEECH_THRESHOLD
            ) {
              if (!speechStarted) {
                console.log(
                  ">>> SPEECH STARTED"
                );

                speechStarted =
                  true;
              }

              silenceFrames = 0;

              audioChunks.push(
                audio
              );

              return;
            }

            // ==================================================
            // SPEECH CONTINUATION
            // ==================================================

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

          // ==================================================
          // DTMF
          // ==================================================

          if (
            event === "dtmf"
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
            event === "mark"
          ) {
            console.log(
              "Exotel mark:",
              message.mark?.name
            );

            return;
          }

          // ==================================================
          // CLEAR
          // ==================================================

          if (
            event === "clear"
          ) {
            console.log(
              "Exotel CLEAR received."
            );

            resetSpeech();

            return;
          }

          // ==================================================
          // STOP
          // ==================================================

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
      "Groq: llama-3.1-8b-instant"
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
  }
);

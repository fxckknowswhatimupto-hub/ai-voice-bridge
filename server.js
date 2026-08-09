```javascript
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

if (!GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is missing");
}

if (!DEEPGRAM_API_KEY) {
  throw new Error("DEEPGRAM_API_KEY is missing");
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
  console.log("🎤 Deepgram STT...");

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
    data?.results
      ?.channels?.[0]
      ?.alternatives?.[0]
      ?.transcript || "";

  const text =
    transcript
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "🎤 Caller:",
    text
  );

  return text;
}

// ==================================================
// GROQ + OPTIONAL LIVE WEB SEARCH
// ==================================================

async function askGroq(question) {
  console.log("🧠 Groq GPT-OSS 20B...");

  const completion =
    await groq.chat.completions.create({

      model:
        "openai/gpt-oss-20b",

      messages: [
        {
          role: "system",

          content:
            "You are a fast, helpful phone voice assistant. " +
            "Speak naturally. " +
            "Keep answers short and easy to understand over a phone call. " +
            "Normally answer directly. " +
            "If the user asks for current, latest, recent, today's, " +
            "live, real-time, breaking, current price, current weather, " +
            "current news, current sports scores, current schedules, " +
            "or other information that may have changed recently, " +
            "use browser search before answering. " +
            "Never pretend you know current information if it requires web search. " +
            "Do not use markdown, bullet points, emojis, URLs, or citations " +
            "in the spoken answer. " +
            "Keep the final spoken answer concise."
        },

        {
          role: "user",

          content: question
        }
      ],

      // Lower reasoning = lower latency
      reasoning_effort: "low",

      temperature: 0.2,

      max_completion_tokens: 180,

      // Give GPT-OSS access to live web information.
      // It can decide when browser search is needed.
      tools: [
        {
          type: "browser_search"
        }
      ],

      tool_choice: "auto"
    });

  let answer =
    completion
      ?.choices?.[0]
      ?.message?.content || "";

  answer =
    String(answer)
      .replace(/\s+/g, " ")
      .trim();

  if (!answer) {
    throw new Error(
      "Groq returned an empty answer"
    );
  }

  // Remove common citation formats that could
  // accidentally be spoken by the TTS system.

  answer =
    answer
      .replace(/\[\d+\]/g, "")
      .replace(/【[^】]+】/g, "")
      .replace(/\([^)]*https?:\/\/[^)]*\)/gi, "")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\s+/g, " ")
      .trim();

  // Phone answers should stay short.
  answer =
    answer.slice(0, 700);

  console.log(
    "🧠 AI:",
    answer
  );

  return answer;
}

// ==================================================
// EXOTEL AUDIO SENDER
// ==================================================

function createExotelAudioSender(
  ws,
  streamSid
) {
  const CHUNK_SIZE = 320;

  let pending =
    Buffer.alloc(0);

  let sequenceNumber = 1;
  let chunkNumber = 0;
  let timestamp = 0;

  function sendChunk(chunk) {
    if (
      !ws ||
      ws.readyState !==
        WebSocket.OPEN
    ) {
      return;
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

  function push(data) {
    if (!data || data.length === 0) {
      return;
    }

    pending =
      Buffer.concat([
        pending,
        data
      ]);

    while (
      pending.length >=
      CHUNK_SIZE
    ) {
      const chunk =
        pending.subarray(
          0,
          CHUNK_SIZE
        );

      pending =
        pending.subarray(
          CHUNK_SIZE
        );

      sendChunk(chunk);
    }
  }

  function finish() {
    if (
      pending.length > 0
    ) {
      const padded =
        Buffer.alloc(
          CHUNK_SIZE
        );

      pending.copy(
        padded
      );

      sendChunk(
        padded
      );

      pending =
        Buffer.alloc(0);
    }

    if (
      ws &&
      ws.readyState ===
        WebSocket.OPEN
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

    console.log(
      "🔊 Sent",
      chunkNumber,
      "audio chunks"
    );
  }

  return {
    push,
    finish
  };
}

// ==================================================
// DEEPGRAM STREAMING TTS
// ==================================================

async function streamSpeechToExotel(
  ws,
  streamSid,
  text
) {
  console.log("🔊 Deepgram TTS...");

  let cleanText =
    String(text)
      .replace(/\s+/g, " ")
      .trim();

  cleanText =
    cleanText.slice(0, 700);

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

        body: JSON.stringify({
          text: cleanText
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

  if (!response.body) {
    throw new Error(
      "Deepgram TTS returned no audio stream"
    );
  }

  const sender =
    createExotelAudioSender(
      ws,
      streamSid
    );

  const reader =
    response.body.getReader();

  let totalBytes = 0;

  try {
    while (true) {
      const {
        value,
        done
      } =
        await reader.read();

      if (done) {
        break;
      }

      if (
        value &&
        value.length > 0
      ) {
        const chunk =
          Buffer.from(value);

        totalBytes +=
          chunk.length;

        // Send audio immediately
        // instead of waiting for the
        // entire TTS response.

        sender.push(
          chunk
        );
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  sender.finish();

  console.log(
    "🔊 TTS streamed:",
    totalBytes,
    "bytes"
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
      audioBuffer.length < 6400
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

    // ----------------------------------------------
    // GROQ
    // ----------------------------------------------

    const answer =
      await askGroq(
        question
      );

    // ----------------------------------------------
    // TTS + IMMEDIATE STREAM
    // ----------------------------------------------

    await streamSpeechToExotel(
      ws,
      streamSid,
      answer
    );

    console.log(
      "✅ ANSWER SENT"
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
      error?.message ||
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
    console.log(
      "================================"
    );
    console.log(
      "📞 EXOTEL CONNECTED"
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

    // Exotel sends 20 ms frames.
    //
    // 25 frames = approximately
    // 500 ms silence.
    //
    // This is faster than the
    // previous 700 ms setting.

    const SILENCE_FRAME_LIMIT =
      25;

    // Caller speech threshold.

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

      console.log(
        "🛑 End of speech:",
        fullAudio.length,
        "bytes"
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

            // Don't print every single
            // 20 ms frame. That creates
            // unnecessary Render log traffic.

            const level =
              getAudioLevel(
                audio
              );

            // Don't collect caller audio
            // while generating the answer.

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
                  "🎤 SPEECH STARTED"
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
              "Exotel CLEAR"
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
              "Exotel stream stopped."
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
          "📞 Exotel disconnected."
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
    console.log(
      "================================"
    );
    console.log(
      "🚀 AI VOICE BRIDGE"
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

    console.log("");
    console.log(
      "🧠 Groq: openai/gpt-oss-20b"
    );

    console.log(
      "🌐 Browser search: ENABLED"
    );

    console.log(
      "🎤 Deepgram: Nova-3 STT"
    );

    console.log(
      "🔊 Deepgram: Aura-2 TTS"
    );

    console.log("");
    console.log(
      "Waiting for Exotel..."
    );
    console.log("");
  }
);
```

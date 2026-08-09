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
// EXOTEL AUDIO
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
  console.log("DEEPGRAM SPEECH TO TEXT");
  console.log("================================");

  const response = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=linear16&sample_rate=8000&channels=1",
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
// GROQ LLM
// ==================================================

async function askGroq(question) {
  console.log("");
  console.log("================================");
  console.log("GROQ GPT-OSS 20B");
  console.log("================================");

  const completion =
    await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",

      messages: [
        {
          role: "system",
          content:
            "You are a helpful phone voice assistant. " +
            "Answer naturally and conversationally. " +
            "Keep answers concise because your response will be spoken over a phone call. " +
            "Do not use markdown, bullet points, emojis, or long explanations."
        },
        {
          role: "user",
          content: question
        }
      ],

      temperature: 0.4,

      max_tokens: 250
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
      "Groq returned an empty answer"
    );
  }

  console.log(
    "AI ANSWER:",
    text
  );

  return text;
}

// ==================================================
// DEEPGRAM TTS
// ==================================================

async function synthesizeSpeech(text) {
  console.log("");
  console.log("================================");
  console.log("DEEPGRAM TEXT TO SPEECH");
  console.log("================================");

  let cleanText =
    String(text)
      .replace(/\s+/g, " ")
      .trim();

  // Keep phone responses reasonably short.
  cleanText =
    cleanText.slice(0, 1200);

  const response = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=8000",
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
// SEND PCM AUDIO TO EXOTEL
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
   * 8000 Hz
   * 16-bit
   * mono
   *
   * 20 ms = 160 samples
   * 160 samples * 2 bytes = 320 bytes
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
    // LLM
    // ----------------------------------------------

    const answer =
      await askGroq(
        question
      );

    // ----------------------------------------------
    // TTS
    // ----------------------------------------------

    const speech =
      await synthesizeSpeech(
        answer
      );

    // ----------------------------------------------
    // SEND TO EXOTEL
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

    let streamSid = null;
    let callSid = null;

    let audioChunks = [];

    let speechStarted = false;
    let silenceFrames = 0;
    let processing = false;

    // 20 ms Exotel frames
    const SILENCE_FRAME_LIMIT = 35;

    // Adjust if needed after testing.
    const SPEECH_THRESHOLD = 350;

    function resetSpeech() {
      audioChunks = [];
      speechStarted = false;
      silenceFrames = 0;
    }

    async function finishSpeech() {
      if (processing) {
        return;
      }

      if (audioChunks.length === 0) {
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
             * Don't collect caller audio while
             * we're processing the previous
             * question / generating the answer.
             */

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
      "Groq LLM: openai/gpt-oss-20b"
    );

    console.log(
      "Deepgram: STT + TTS"
    );

    console.log("");
    console.log(
      "Waiting for Exotel..."
    );
  }
);

const http = require("http");
const WebSocket = require("ws");
const Groq = require("groq-sdk");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

// ==================================================
// CONFIG
// ==================================================

const PORT = process.env.PORT || 3000;

const PUBLIC_URL =
  "https://ai-voice-bridge-q8qv.onrender.com";

const WS_URL =
  PUBLIC_URL.replace("https://", "wss://");

// ==================================================
// ENVIRONMENT VARIABLES
// ==================================================

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

if (!GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is missing");
}

if (!N8N_WEBHOOK_URL) {
  throw new Error("N8N_WEBHOOK_URL is missing");
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
  async (req, res) => {

    console.log(
      "HTTP request:",
      req.method,
      req.url
    );

    if (req.url === "/health") {

      res.writeHead(200, {
        "Content-Type": "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok"
        })
      );

      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(
      JSON.stringify({
        url: WS_URL
      })
    );
  }
);

// ==================================================
// WEBSOCKET SERVER
// ==================================================

const wss = new WebSocket.Server({
  server
});

// ==================================================
// PCM -> WAV
// ==================================================

function pcmToWav(pcmBuffer) {

  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 16;

  const byteRate =
    sampleRate *
    channels *
    bitsPerSample /
    8;

  const blockAlign =
    channels *
    bitsPerSample /
    8;

  const wav =
    Buffer.alloc(
      44 + pcmBuffer.length
    );

  wav.write("RIFF", 0);

  wav.writeUInt32LE(
    36 + pcmBuffer.length,
    4
  );

  wav.write("WAVE", 8);

  wav.write("fmt ", 12);

  wav.writeUInt32LE(
    16,
    16
  );

  wav.writeUInt16LE(
    1,
    20
  );

  wav.writeUInt16LE(
    channels,
    22
  );

  wav.writeUInt32LE(
    sampleRate,
    24
  );

  wav.writeUInt32LE(
    byteRate,
    28
  );

  wav.writeUInt16LE(
    blockAlign,
    32
  );

  wav.writeUInt16LE(
    bitsPerSample,
    34
  );

  wav.write("data", 36);

  wav.writeUInt32LE(
    pcmBuffer.length,
    40
  );

  pcmBuffer.copy(
    wav,
    44
  );

  return wav;
}

// ==================================================
// WAV -> EXOTEL PCM
// ==================================================

function convertWavToExotelPCM(
  wavBuffer
) {

  return new Promise(
    (resolve, reject) => {

      const ffmpeg =
        spawn(
          ffmpegPath,
          [
            "-hide_banner",
            "-loglevel",
            "error",

            "-i",
            "pipe:0",

            "-f",
            "s16le",

            "-ar",
            "8000",

            "-ac",
            "1",

            "pipe:1"
          ]
        );

      const output = [];
      const errors = [];

      ffmpeg.stdout.on(
        "data",
        (chunk) => {
          output.push(chunk);
        }
      );

      ffmpeg.stderr.on(
        "data",
        (chunk) => {
          errors.push(chunk);
        }
      );

      ffmpeg.on(
        "error",
        reject
      );

      ffmpeg.on(
        "close",
        (code) => {

          if (code !== 0) {

            reject(
              new Error(
                "FFmpeg failed: " +
                Buffer
                  .concat(errors)
                  .toString()
              )
            );

            return;
          }

          resolve(
            Buffer.concat(output)
          );
        }
      );

      ffmpeg.stdin.write(
        wavBuffer
      );

      ffmpeg.stdin.end();
    }
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
      "WebSocket is not open."
    );

    return;
  }

  const CHUNK_SIZE = 320;

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
          String(
            chunkNumber + 1
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
// GROQ SPEECH TO TEXT
// ==================================================

async function transcribeAudio(
  pcmBuffer
) {

  console.log(
    "Sending caller audio to Groq Whisper..."
  );

  const wavBuffer =
    pcmToWav(
      pcmBuffer
    );

  const audioFile =
    new File(
      [
        wavBuffer
      ],
      "caller.wav",
      {
        type: "audio/wav"
      }
    );

  const transcription =
    await groq.audio.transcriptions.create(
      {
        file: audioFile,

        model:
          "whisper-large-v3-turbo",

        language:
          "en",

        response_format:
          "text"
      }
    );

  const text =
    String(
      transcription
    ).trim();

  console.log(
    "TRANSCRIPTION:",
    text
  );

  return text;
}

// ==================================================
// SEND QUESTION TO N8N
// ==================================================

async function askN8N(
  question
) {

  console.log(
    "Sending question to n8n..."
  );

  const response =
    await fetch(
      N8N_WEBHOOK_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({

            text:
              question,

            chatInput:
              question
          })
      }
    );

  if (!response.ok) {

    throw new Error(
      `n8n HTTP ${response.status}`
    );
  }

  const raw =
    await response.text();

  console.log(
    "n8n raw response:",
    raw
  );

  let data;

  try {

    data =
      JSON.parse(raw);

  } catch {

    throw new Error(
      "n8n returned invalid JSON"
    );
  }

  const answer =
    data.output ||
    data.text ||
    data["name: text"] ||
    data.response ||
    data.answer;

  if (!answer) {

    throw new Error(
      "No AI answer found in n8n response"
    );
  }

  return String(answer);
}

// ==================================================
// PROCESS SPEECH
// ==================================================

async function processSpeech(
  ws,
  streamSid,
  audioChunks
) {

  try {

    if (
      audioChunks.length === 0
    ) {
      return;
    }

    const pcmBuffer =
      Buffer.concat(
        audioChunks
      );

    console.log(
      "Speech buffer:",
      pcmBuffer.length,
      "bytes"
    );

    // Ignore extremely short audio
    if (
      pcmBuffer.length < 8000
    ) {

      console.log(
        "Speech too short."
      );

      return;
    }

    // ----------------------------------------------
    // SPEECH -> TEXT
    // ----------------------------------------------

    const question =
      await transcribeAudio(
        pcmBuffer
      );

    if (!question) {

      console.log(
        "No speech detected."
      );

      return;
    }

    console.log(
      "CALLER SAID:",
      question
    );

    // ----------------------------------------------
    // TEXT -> N8N
    // ----------------------------------------------

    const answer =
      await askN8N(
        question
      );

    console.log(
      "AI ANSWER:",
      answer
    );

    console.log(
      "================================"
    );

    console.log(
      "AI RESPONSE READY:"
    );

    console.log(
      answer
    );

    console.log(
      "================================"
    );

    /*
     * TTS intentionally disabled.
     *
     * We are NOT using:
     *
     * canopylabs/orpheus-v1-english
     *
     * because you already hit its
     * token-per-day limit.
     *
     * Once the new TTS method is chosen,
     * call speakAnswer() here.
     */

  } catch (error) {

    console.log(
      "VOICE PROCESSING ERROR:"
    );

    console.log(
      error.message
    );
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

    let streamSid = null;

    let audioChunks = [];

    let processing = false;

    let lastSpeechTime = 0;

    let speechTimer = null;

    // ----------------------------------------------
    // MESSAGE
    // ----------------------------------------------

    ws.on(
      "message",
      async (data) => {

        try {

          const message =
            JSON.parse(
              data.toString()
            );

          console.log(
            "Event:",
            message.event
          );

          // ========================================
          // CONNECTED
          // ========================================

          if (
            message.event ===
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
            message.event ===
            "start"
          ) {

            streamSid =
              message.stream_sid ||
              message.start?.stream_sid;

            console.log(
              "Stream started."
            );

            console.log(
              "Stream SID:",
              streamSid
            );

            console.log(
              "Call SID:",
              message.start?.call_sid
            );

            console.log(
              "Audio format:",
              message.start?.media_format
            );

            audioChunks = [];

            return;
          }

          // ========================================
          // MEDIA
          // ========================================

          if (
            message.event ===
            "media"
          ) {

            if (
              message.media?.payload
            ) {

              const audio =
                Buffer.from(
                  message.media.payload,
                  "base64"
                );

              audioChunks.push(
                audio
              );

              console.log(
                "Audio received:",
                audio.length,
                "bytes"
              );

              // ----------------------------------
              // Calculate audio level
              // ----------------------------------

              let sum = 0;

              for (
                let i = 0;
                i + 1 < audio.length;
                i += 2
              ) {

                const sample =
                  audio.readInt16LE(
                    i
                  );

                sum +=
                  Math.abs(
                    sample
                  );
              }

              const level =
                audio.length > 0
                  ? sum /
                    (audio.length / 2)
                  : 0;

              console.log(
                "Audio level:",
                Math.round(level)
              );

              // ----------------------------------
              // Speech detection
              // ----------------------------------

              if (
                level > 150
              ) {

                lastSpeechTime =
                  Date.now();
              }

              clearTimeout(
                speechTimer
              );

              speechTimer =
                setTimeout(
                  async () => {

                    if (
                      processing
                    ) {
                      return;
                    }

                    const silenceTime =
                      Date.now() -
                      lastSpeechTime;

                    if (
                      silenceTime <
                      900
                    ) {
                      return;
                    }

                    if (
                      audioChunks.length ===
                      0
                    ) {
                      return;
                    }

                    processing =
                      true;

                    const speech =
                      audioChunks;

                    audioChunks = [];

                    console.log(
                      "END OF SPEECH DETECTED"
                    );

                    await processSpeech(
                      ws,
                      streamSid,
                      speech
                    );

                    processing =
                      false;

                  },
                  1000
                );
            }

            return;
          }

          // ========================================
          // DTMF
          // ========================================

          if (
            message.event ===
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
            message.event ===
            "mark"
          ) {

            console.log(
              "Exotel mark:",
              message.mark?.name
            );

            return;
          }

          // ========================================
          // STOP
          // ========================================

          if (
            message.event ===
            "stop"
          ) {

            clearTimeout(
              speechTimer
            );

            console.log(
              "Stream stopped."
            );

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

    // ----------------------------------------------
    // CLOSE
    // ----------------------------------------------

    ws.on(
      "close",
      () => {

        clearTimeout(
          speechTimer
        );

        console.log(
          "Exotel WebSocket disconnected."
        );
      }
    );

    // ----------------------------------------------
    // ERROR
    // ----------------------------------------------

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
      "HTTP: http://localhost:" +
      PORT
    );

    console.log(
      "WebSocket: ws://localhost:" +
      PORT
    );

    console.log(
      "Public WebSocket:",
      WS_URL
    );

    console.log("");

    console.log(
      "Waiting for Exotel..."
    );
  }
);

<<<<<<< HEAD
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
=======
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");

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

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY;

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID ||
  "JBFqnCBsd6RMkjVDRZzb";

const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL;

// ==================================================
// CHECK ENVIRONMENT
// ==================================================

console.log("");
console.log("================================");
console.log("AI VOICE BRIDGE");
console.log("================================");

console.log(
  "ElevenLabs API:",
  ELEVENLABS_API_KEY
    ? "CONFIGURED"
    : "MISSING"
);

console.log(
  "ElevenLabs Voice:",
  ELEVENLABS_VOICE_ID
);

console.log(
  "n8n Webhook:",
  N8N_WEBHOOK_URL
    ? "CONFIGURED"
    : "MISSING"
);

console.log("");

// ==================================================
// ELEVENLABS CLIENT
// ==================================================

if (!ELEVENLABS_API_KEY) {
  console.error(
    "ERROR: ELEVENLABS_API_KEY is missing."
  );
}

const elevenlabs =
  new ElevenLabsClient({
    apiKey: ELEVENLABS_API_KEY
  });

// ==================================================
// HTTP SERVER
// ==================================================

const server =
  http.createServer(async (req, res) => {

    console.log(
      "# HTTP request:",
      req.method,
      req.url
    );

    // ----------------------------------------------
    // HEALTH CHECK
    // ----------------------------------------------

    if (req.url === "/health") {

      res.writeHead(200, {
        "Content-Type":
          "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok",
          service: "ai-voice-bridge"
        })
      );

      return;
    }

    // ----------------------------------------------
    // EXOTEL DYNAMIC WEBSOCKET URL
    // ----------------------------------------------

    res.writeHead(200, {
      "Content-Type":
        "application/json"
    });

    res.end(
      JSON.stringify({
        url: WS_URL
      })
    );
  });

// ==================================================
// WEBSOCKET SERVER
// ==================================================

const wss =
  new WebSocket.Server({
    server
  });

// ==================================================
// PCM -> WAV
// ==================================================

function pcmToWav(
  pcmBuffer,
  sampleRate = 8000
) {

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

  wav.write(
    "RIFF",
    0
  );

  wav.writeUInt32LE(
    36 + pcmBuffer.length,
    4
  );

  wav.write(
    "WAVE",
    8
  );

  wav.write(
    "fmt ",
    12
  );

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

  wav.write(
    "data",
    36
  );

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
// RESAMPLE 8KHZ PCM -> 16KHZ WAV
// ==================================================

function convertCallerAudioForSTT(
  pcmBuffer
) {

  return new Promise(
    (resolve, reject) => {

      console.log(
        "Converting caller audio 8kHz -> 16kHz..."
      );

      const inputWav =
        pcmToWav(
          pcmBuffer,
          8000
        );

      const ffmpeg =
        spawn(
          ffmpegPath,
          [
            "-hide_banner",
            "-loglevel",
            "error",

            "-i",
            "pipe:0",

            "-ar",
            "16000",

            "-ac",
            "1",

            "-f",
            "wav",

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
                "FFmpeg STT conversion failed: " +
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
        inputWav
      );

      ffmpeg.stdin.end();
    }
  );
}

// ==================================================
// ELEVENLABS SPEECH TO TEXT
// ==================================================

async function transcribeCallerAudio(
  pcmBuffer
) {

  console.log("");
  console.log(
    "================================"
  );

  console.log(
    "ELEVENLABS SPEECH TO TEXT"
  );

  console.log(
    "================================"
  );

  if (!ELEVENLABS_API_KEY) {
    throw new Error(
      "ELEVENLABS_API_KEY is missing"
    );
  }

  if (
    !pcmBuffer ||
    pcmBuffer.length < 1600
  ) {

    console.log(
      "Audio too short for transcription."
    );

    return "";
  }

  console.log(
    "Caller PCM:",
    pcmBuffer.length,
    "bytes"
  );

  // Convert Exotel 8kHz PCM
  // into 16kHz WAV for Scribe.

  const wavBuffer =
    await convertCallerAudioForSTT(
      pcmBuffer
    );

  console.log(
    "STT WAV:",
    wavBuffer.length,
    "bytes"
  );

  const audioBlob =
    new Blob(
      [wavBuffer],
      {
        type: "audio/wav"
      }
    );

  console.log(
    "Sending audio to ElevenLabs Scribe..."
  );

  const result =
    await elevenlabs.speechToText.convert(
      {
        file: audioBlob,

        modelId:
          "scribe_v2",

        languageCode:
          "eng",

        tagAudioEvents:
          false,

        diarize:
          false,

        noVerbatim:
          true
      }
    );

  const text =
    String(
      result.text || ""
    )
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "CALLER SAID:",
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

  console.log("");
  console.log(
    "Sending question to n8n..."
  );

  if (!N8N_WEBHOOK_URL) {

    throw new Error(
      "N8N_WEBHOOK_URL is missing"
    );
  }

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
            text: question,
            chatInput: question
          })
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `n8n HTTP ${response.status}: ${errorText}`
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
    data.answer ||
    data.message;

  if (!answer) {

    throw new Error(
      "No AI answer found in n8n response"
    );
  }

  const finalAnswer =
    String(answer)
      .replace(/\s+/g, " ")
      .trim();

  console.log(
    "AI ANSWER:",
    finalAnswer
  );

  return finalAnswer;
}

// ==================================================
// MU-LAW -> PCM16
// ==================================================

function muLawToPCM16(
  muLawBuffer
) {

  const pcm =
    Buffer.alloc(
      muLawBuffer.length * 2
    );

  for (
    let i = 0;
    i < muLawBuffer.length;
    i++
  ) {

    let u =
      (~muLawBuffer[i]) &
      0xff;

    const sign =
      u & 0x80;

    const exponent =
      (u >> 4) & 0x07;

    const mantissa =
      u & 0x0f;

    let sample =
      ((mantissa << 3) + 132)
      << exponent;

    sample -= 132;

    if (sign) {
      sample = -sample;
    }

    // Clamp to int16

    if (sample > 32767) {
      sample = 32767;
    }

    if (sample < -32768) {
      sample = -32768;
    }

    pcm.writeInt16LE(
      sample,
      i * 2
    );
  }

  return pcm;
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
    ws.readyState !==
      WebSocket.OPEN
  ) {

    console.log(
      "Cannot send audio: WebSocket is not open."
    );

    return;
  }

  /*
   * Exotel uses:
   *
   * 16-bit PCM
   * 8000 Hz
   * mono
   *
   * 100ms = 800 samples
   * 800 samples * 2 bytes
   * = 1600 bytes
   */

  const CHUNK_SIZE = 1600;

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

    const payload =
      chunk.toString(
        "base64"
      );

    const message = {

      event:
        "media",

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
          payload
      }
    };

    ws.send(
      JSON.stringify(
        message
      )
    );

    chunkNumber++;

    timestamp += 100;
  }

  console.log(
    "Sent",
    chunkNumber,
    "audio chunks to Exotel."
  );

  // Tell Exotel this response
  // has finished.

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
// ELEVENLABS TEXT TO SPEECH
// ==================================================

async function speakAnswer(
  ws,
  streamSid,
  answer
) {

  console.log("");
  console.log(
    "================================"
  );

  console.log(
    "ELEVENLABS TEXT TO SPEECH"
  );

  console.log(
    "================================"
  );

  if (!ELEVENLABS_API_KEY) {

    throw new Error(
      "ELEVENLABS_API_KEY is missing"
    );
  }

  let text =
    String(answer)
      .replace(/\s+/g, " ")
      .trim();

  // Keep phone answers short.

  text =
    text.slice(0, 1000);

  console.log(
    "TTS text:",
    text
  );

  console.log(
    "Generating ElevenLabs speech..."
  );

  /*
   * ulaw_8000 is a telephony format.
   *
   * We convert it to the
   * PCM16 format required by
   * Exotel.
   */

  const audio =
    await elevenlabs.textToSpeech.convert(
      ELEVENLABS_VOICE_ID,
      {

        modelId:
          "eleven_flash_v2_5",

        outputFormat:
          "ulaw_8000",

        text:

          text
      }
    );

  const chunks = [];

  for await (
    const chunk of audio
  ) {

    chunks.push(
      Buffer.from(chunk)
    );
  }

  const muLawBuffer =
    Buffer.concat(chunks);

  console.log(
    "ElevenLabs μ-law:",
    muLawBuffer.length,
    "bytes"
  );

  // Convert μ-law to PCM16

  const pcmBuffer =
    muLawToPCM16(
      muLawBuffer
    );

  console.log(
    "Converted PCM:",
    pcmBuffer.length,
    "bytes"
  );

  // Send to caller

  sendAudioToExotel(
    ws,
    streamSid,
    pcmBuffer
  );

  console.log(
    "ANSWER SENT TO CALLER"
  );
}

// ==================================================
// CALL ERROR HANDLER
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

    // ----------------------------------------------
    // SPEECH TO TEXT
    // ----------------------------------------------

    const question =
      await transcribeCallerAudio(
        audioBuffer
      );

    if (!question) {

      console.log(
        "No speech detected."
      );

      return;
    }

    // ----------------------------------------------
    // N8N
    // ----------------------------------------------

    const answer =
      await askN8N(
        question
      );

    // ----------------------------------------------
    // TEXT TO SPEECH
    // ----------------------------------------------

    await speakAnswer(
      ws,
      streamSid,
      answer
    );

  } catch (error) {

    console.log("");
    console.log(
      "################################"
    );

    console.log(
      "VOICE PROCESSING ERROR:"
    );

    console.log(
      "################################"
    );

    console.error(
      error
    );

    /*
     * Don't crash the Render server.
     */

    if (
      error?.response
    ) {

      try {

        console.error(
          await error.response.text()
        );

      } catch {}

    }
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

    // ----------------------------------------------
    // AUDIO BUFFER
    // ----------------------------------------------

    let audioChunks = [];

    // ----------------------------------------------
    // SPEECH STATE
    // ----------------------------------------------

    let speechStarted =
      false;

    let silenceFrames =
      0;

    let processing =
      false;

    /*
     * Exotel currently sends
     * 320-byte frames in your
     * connection = 20ms.
     */

    const FRAME_DURATION_MS =
      20;

    /*
     * Start speaking when audio
     * level passes this value.
     */

    const SPEECH_THRESHOLD =
      350;

    /*
     * End speech after roughly
     * 700ms of silence.
     */

    const SILENCE_FRAME_LIMIT =
      35;

    // ----------------------------------------------
    // AUDIO LEVEL
    // ----------------------------------------------

    function getAudioLevel(
      buffer
    ) {

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

        const sample =
          buffer.readInt16LE(
            i * 2
          );

        total +=
          Math.abs(sample);
      }

      return (
        total / samples
      );
    }

    // ----------------------------------------------
    // RESET AUDIO
    // ----------------------------------------------

    function resetSpeech() {

      audioChunks = [];

      speechStarted =
        false;

      silenceFrames =
        0;
    }

    // ----------------------------------------------
    // PROCESS SPEECH
    // ----------------------------------------------

    async function finishSpeech() {

      if (
        processing
      ) {

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
        "Audio buffer:",
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
              "Stream started."
            );

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
            // IF CURRENTLY PLAYING AI RESPONSE
            // --------------------------------------

            if (
              processing
            ) {

              /*
               * We still receive media
               * from Exotel while the call
               * is alive.
               *
               * Don't treat the AI's own
               * audio as a new question.
               */

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

    // ----------------------------------------------
    // CLOSE
    // ----------------------------------------------

    ws.on(
      "close",
      () => {

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
// SERVER START
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
      "Waiting for Exotel..."
    );

    console.log("");
  }
);
>>>>>>> 3fbd230 (Use ElevenLabs for TTS)

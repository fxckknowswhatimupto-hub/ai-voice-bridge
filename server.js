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

const DEEPGRAM_STT_MODEL =
  "nova-3";

const DEEPGRAM_TTS_MODEL =
  "aura-2-thalia-en";

// ==================================================
// ENVIRONMENT
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
    "WARNING: TAVILY_API_KEY is missing."
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
// EXOTEL WEBSOCKET SERVER
// ==================================================

const wss =
  new WebSocket.Server({
    server
  });

// ==================================================
// WEB SEARCH DETECTION
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
    "timing",
    "timings",
    "price",
    "prices",
    "cost",
    "score",
    "schedule"
  ];

  for (const word of liveWords) {
    if (q.includes(word)) {
      return true;
    }
  }

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

  for (const word of localWords) {
    if (q.includes(word)) {
      return true;
    }
  }

  return false;
}

// ==================================================
// TAVILY SEARCH
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

            topic:
              "general",

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

      console.log(
        "Tavily status:",
        response.status
      );

      return "";
    }

    const data =
      await response.json();

    let information =
      "";

    if (data?.answer) {
      information +=
        data.answer + " ";
    }

    if (
      Array.isArray(
        data?.results
      )
    ) {

      for (
        const result of
          data.results
      ) {

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
// CREATE DEEPGRAM STT CONNECTION
// ==================================================

function createDeepgramSTT() {

  return new Promise(
    (resolve, reject) => {

      const url =
        "wss://api.deepgram.com/v1/listen" +
        "?model=" +
        encodeURIComponent(
          DEEPGRAM_STT_MODEL
        ) +
        "&language=en-US" +
        "&encoding=linear16" +
        "&sample_rate=8000" +
        "&channels=1" +
        "&interim_results=true" +
        "&punctuate=true" +
        "&endpointing=200" +
        "&smart_format=true";

      const socket =
        new WebSocket(
          url,
          {
            headers: {
              Authorization:
                "Token " +
                DEEPGRAM_API_KEY
            }
          }
        );

      let settled =
        false;

      socket.on(
        "open",
        () => {

          settled =
            true;

          resolve(socket);
        }
      );

      socket.on(
        "error",
        (error) => {

          if (!settled) {
            reject(error);
          }
        }
      );
    }
  );
}

// ==================================================
// CREATE DEEPGRAM TTS CONNECTION
// ==================================================

function createDeepgramTTS() {

  return new Promise(
    (resolve, reject) => {

      const url =
        "wss://api.deepgram.com/v1/speak" +
        "?model=" +
        encodeURIComponent(
          DEEPGRAM_TTS_MODEL
        ) +
        "&encoding=linear16" +
        "&sample_rate=8000" +
        "&container=none";

      const socket =
        new WebSocket(
          url,
          {
            headers: {
              Authorization:
                "Token " +
                DEEPGRAM_API_KEY
            }
          }
        );

      let settled =
        false;

      socket.on(
        "open",
        () => {

          settled =
            true;

          resolve(socket);
        }
      );

      socket.on(
        "error",
        (error) => {

          if (!settled) {
            reject(error);
          }
        }
      );
    }
  );
}

// ==================================================
// EXOTEL AUDIO SENDER
// ==================================================

function createExotelAudioSender(
  ws,
  streamSid
) {

  let sequenceNumber =
    1;

  let chunkNumber =
    0;

  let timestamp =
    0;

  return function sendAudio(
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
  };
}

// ==================================================
// SEND EXOTEL MARK
// ==================================================

function sendExotelMark(
  ws,
  streamSid
) {

  if (
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
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
// STREAM GROQ
// ==================================================

async function streamGroq(
  question,
  conversationHistory,
  webInformation,
  onText
) {

  const messages = [

    {
      role: "system",

      content:
        "You are a fast, friendly phone AI assistant. " +
        "Never say you are Google Assistant, Siri or Alexa. " +
        "Speak naturally and casually. " +
        "For simple questions, use 1 or 2 short sentences. " +
        "For larger questions, give the important information. " +
        "Remember this phone call's conversation. " +
        "Understand follow-ups such as 'what about it?', 'where is it?', 'how much?', and 'tell me more'. " +
        "Do not mention internal tools, APIs or web searches."
    }
  ];

  // ----------------------------------------------
  // MEMORY
  // ----------------------------------------------

  for (
    const item of
      conversationHistory
  ) {

    messages.push({
      role:
        item.role,

      content:
        item.content
    });
  }

  // ----------------------------------------------
  // WEB INFORMATION
  // ----------------------------------------------

  if (webInformation) {

    messages.push({

      role:
        "system",

      content:
        "Use the following current web information when answering. " +
        "Do not mention that you used web search. " +
        "If the information does not answer the question, say so naturally.\n\n" +
        webInformation
    });
  }

  // ----------------------------------------------
  // USER
  // ----------------------------------------------

  messages.push({

    role:
      "user",

    content:
      question
  });

  // ----------------------------------------------
  // STREAM
  // ----------------------------------------------

  const stream =
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
        0.9,

      stream:
        true
    });

  let fullAnswer =
    "";

  let pendingText =
    "";

  for await (
    const chunk of
      stream
  ) {

    const token =
      chunk
        ?.choices?.[0]
        ?.delta
        ?.content || "";

    if (!token) {
      continue;
    }

    fullAnswer +=
      token;

    pendingText +=
      token;

    // --------------------------------------------
    // SEND TEXT TO TTS AS SOON AS A SENTENCE
    // OR USEFUL CHUNK EXISTS
    // --------------------------------------------

    const sentenceMatch =
      pendingText.match(
        /^([\s\S]*?[.!?])(?:\s+|$)/
      );

    if (
      sentenceMatch
    ) {

      const sentence =
        sentenceMatch[1]
          .trim();

      pendingText =
        pendingText
          .slice(
            sentenceMatch[0].length
          )
          .trimStart();

      if (sentence) {

        await onText(
          sentence
        );
      }
    }

    // --------------------------------------------
    // For very short answers, don't wait for
    // punctuation forever.
    // --------------------------------------------

    if (
      pendingText.length >=
      45
    ) {

      const lastSpace =
        pendingText.lastIndexOf(
          " "
        );

      if (
        lastSpace > 20
      ) {

        const chunkText =
          pendingText
            .slice(
              0,
              lastSpace
            )
            .trim();

        pendingText =
          pendingText
            .slice(
              lastSpace + 1
            )
            .trimStart();

        if (chunkText) {

          await onText(
            chunkText
          );
        }
      }
    }
  }

  // ----------------------------------------------
  // REMAINING TEXT
  // ----------------------------------------------

  if (
    pendingText.trim()
  ) {

    await onText(
      pendingText.trim()
    );
  }

  return fullAnswer
    .replace(/\s+/g, " ")
    .trim();
}

// ==================================================
// SEND TEXT TO STREAMING TTS
// ==================================================

function sendTextToTTS(
  ttsSocket,
  text
) {

  if (
    !ttsSocket ||
    ttsSocket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  ttsSocket.send(
    JSON.stringify({

      type:
        "Speak",

      text:
        text
    })
  );
}

// ==================================================
// FLUSH TTS
// ==================================================

function flushTTS(
  ttsSocket
) {

  if (
    !ttsSocket ||
    ttsSocket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  ttsSocket.send(
    JSON.stringify({
      type:
        "Flush"
    })
  );
}

// ==================================================
// CLOSE DEEPGRAM CONNECTION
// ==================================================

function closeDeepgramSocket(
  socket
) {

  if (
    socket &&
    socket.readyState ===
      WebSocket.OPEN
  ) {

    try {

      socket.send(
        JSON.stringify({
          type:
            "Close"
        })
      );

    } catch (_) {}

    try {
      socket.close();
    } catch (_) {}
  }
}

// ==================================================
// HANDLE COMPLETE QUESTION
// ==================================================

async function processQuestion(
  call,
  question
) {

  if (
    call.processing
  ) {
    return;
  }

  const cleanQuestion =
    String(question)
      .replace(/\s+/g, " ")
      .trim();

  if (!cleanQuestion) {
    return;
  }

  call.processing =
    true;

  console.log(
    "CALLER:",
    cleanQuestion
  );

  try {

    // ----------------------------------------------
    // SEARCH ONLY WHEN NECESSARY
    // ----------------------------------------------

    let webInformation =
      "";

    if (
      needsWebSearch(
        cleanQuestion
      )
    ) {

      console.log(
        "LIVE SEARCH: YES"
      );

      webInformation =
        await searchWeb(
          cleanQuestion
        );

    } else {

      console.log(
        "LIVE SEARCH: NO"
      );
    }

    // ----------------------------------------------
    // STREAMING TTS
    // ----------------------------------------------

    let ttsStarted =
      false;

    const sendText =
      async (text) => {

        if (!text) {
          return;
        }

        if (
          call.ttsSocket &&
          call.ttsSocket.readyState ===
            WebSocket.OPEN
        ) {

          ttsStarted =
            true;

          sendTextToTTS(
            call.ttsSocket,
            text
          );
        }
      };

    // ----------------------------------------------
    // STREAM GROQ
    // ----------------------------------------------

    const answer =
      await streamGroq(
        cleanQuestion,
        call.conversationHistory,
        webInformation,
        sendText
      );

    // ----------------------------------------------
    // FLUSH TTS
    // ----------------------------------------------

    if (
      ttsStarted
    ) {

      flushTTS(
        call.ttsSocket
      );
    }

    // ----------------------------------------------
    // MEMORY
    // ----------------------------------------------

    if (answer) {

      call.conversationHistory.push({

        role:
          "user",

        content:
          cleanQuestion
      });

      call.conversationHistory.push({

        role:
          "assistant",

        content:
          answer
      });

      // Keep only the latest 5 exchanges.
      if (
        call.conversationHistory.length >
        10
      ) {

        call.conversationHistory =
          call.conversationHistory.slice(
            -10
          );
      }
    }

    console.log(
      "AI:",
      answer
    );

  } catch (error) {

    console.log(
      "PROCESSING ERROR:",
      error.message
    );

    // ----------------------------------------------
    // FALLBACK
    // ----------------------------------------------

    try {

      if (
        call.ttsSocket &&
        call.ttsSocket.readyState ===
          WebSocket.OPEN
      ) {

        sendTextToTTS(
          call.ttsSocket,
          "Sorry, I had trouble answering that."
        );

        flushTTS(
          call.ttsSocket
        );
      }

    } catch (_) {}

  } finally {

    call.processing =
      false;
  }
}

// ==================================================
// EXOTEL CONNECTION
// ==================================================

wss.on(
  "connection",
  async (ws) => {

    console.log(
      "EXOTEL CONNECTED"
    );

    const call = {

      streamSid:
        null,

      callSid:
        null,

      sttSocket:
        null,

      ttsSocket:
        null,

      sttReady:
        false,

      ttsReady:
        false,

      processing:
        false,

      speechFinalParts:
        [],

      lastInterim:
        "",

      conversationHistory:
        []
    };

    // ==================================================
    // CONNECT DEEPGRAM STREAMS IMMEDIATELY
    // ==================================================

    try {

      const [sttSocket, ttsSocket] =
        await Promise.all([

          createDeepgramSTT(),

          createDeepgramTTS()

        ]);

      call.sttSocket =
        sttSocket;

      call.ttsSocket =
        ttsSocket;

      call.sttReady =
        true;

      call.ttsReady =
        true;

      console.log(
        "DEEPGRAM STREAMS READY"
      );

      // ----------------------------------------------
      // DEEPGRAM STT MESSAGES
      // ----------------------------------------------

      sttSocket.on(
        "message",
        async (raw) => {

          try {

            const message =
              JSON.parse(
                raw.toString()
              );

            const alternative =
              message
                ?.channel
                ?.alternatives?.[0];

            const transcript =
              alternative
                ?.transcript || "";

            if (!transcript) {
              return;
            }

            // ----------------------------------------
            // INTERIM
            // ----------------------------------------

            if (
              !message.is_final
            ) {

              call.lastInterim =
                transcript;

              return;
            }

            // ----------------------------------------
            // FINAL SEGMENT
            // ----------------------------------------

            call.speechFinalParts.push(
              transcript
            );

            call.lastInterim =
              "";

            // ----------------------------------------
            // END OF UTTERANCE
            // ----------------------------------------

            if (
              message.speech_final
            ) {

              const question =
                call.speechFinalParts
                  .join(" ")
                  .replace(
                    /\s+/g,
                    " "
                  )
                  .trim();

              call.speechFinalParts =
                [];

              if (
                question &&
                !call.processing
              ) {

                await processQuestion(
                  call,
                  question
                );
              }
            }

          } catch (error) {

            console.log(
              "DEEPGRAM STT MESSAGE ERROR:",
              error.message
            );
          }
        }
      );

      // ----------------------------------------------
      // DEEPGRAM TTS AUDIO
      // ----------------------------------------------

      ttsSocket.on(
        "message",
        (data, isBinary) => {

          try {

            if (
              isBinary ||
              Buffer.isBuffer(data)
            ) {

              const audio =
                Buffer.from(data);

              if (
                audio.length > 0 &&
                call.streamSid
              ) {

                if (
                  !call.sendAudio
                ) {

                  call.sendAudio =
                    createExotelAudioSender(
                      ws,
                      call.streamSid
                    );
                }

                call.sendAudio(
                  audio
                );
              }

              return;
            }

            // Deepgram may send JSON
            // metadata/control messages.
            const message =
              JSON.parse(
                data.toString()
              );

            if (
              message.type ===
              "Flushed"
            ) {

              sendExotelMark(
                ws,
                call.streamSid
              );
            }

          } catch (error) {

            console.log(
              "TTS MESSAGE ERROR:",
              error.message
            );
          }
        }
      );

      sttSocket.on(
        "close",
        () => {

          call.sttReady =
            false;

          console.log(
            "Deepgram STT closed"
          );
        }
      );

      ttsSocket.on(
        "close",
        () => {

          call.ttsReady =
            false;

          console.log(
            "Deepgram TTS closed"
          );
        }
      );

      sttSocket.on(
        "error",
        (error) => {

          console.log(
            "STT SOCKET ERROR:",
            error.message
          );
        }
      );

      ttsSocket.on(
        "error",
        (error) => {

          console.log(
            "TTS SOCKET ERROR:",
            error.message
          );
        }
      );

    } catch (error) {

      console.log(
        "DEEPGRAM CONNECTION ERROR:",
        error.message
      );
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

            return;
          }

          // --------------------------------------------
          // START
          // --------------------------------------------

          if (
            event ===
            "start"
          ) {

            call.streamSid =
              message.stream_sid ||
              message.start?.stream_sid ||
              message.start?.streamSid ||
              null;

            call.callSid =
              message.start?.call_sid ||
              message.start?.callSid ||
              null;

            console.log(
              "CALL START:",
              call.callSid
            );

            call.conversationHistory =
              [];

            call.speechFinalParts =
              [];

            call.lastInterim =
              "";

            // Create sender after stream SID exists.
            if (
              call.streamSid
            ) {

              call.sendAudio =
                createExotelAudioSender(
                  ws,
                  call.streamSid
                );
            }

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

            if (
              !call.sttSocket ||
              call.sttSocket.readyState !==
                WebSocket.OPEN
            ) {

              return;
            }

            const audio =
              Buffer.from(
                message.media.payload,
                "base64"
              );

            // ------------------------------------------
            // SEND AUDIO DIRECTLY TO STREAMING STT
            // ------------------------------------------

            call.sttSocket.send(
              audio
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

            call.speechFinalParts =
              [];

            call.lastInterim =
              "";

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
              "CALL END:",
              call.callSid
            );

            closeDeepgramSocket(
              call.sttSocket
            );

            closeDeepgramSocket(
              call.ttsSocket
            );

            call.conversationHistory =
              [];

            return;
          }

        } catch (error) {

          console.log(
            "EXOTEL MESSAGE ERROR:",
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
          "EXOTEL DISCONNECTED"
        );

        closeDeepgramSocket(
          call.sttSocket
        );

        closeDeepgramSocket(
          call.ttsSocket
        );

        call.conversationHistory =
          [];
      }
    );

    // ==================================================
    // ERROR
    // ==================================================

    ws.on(
      "error",
      (error) => {

        console.log(
          "EXOTEL WS ERROR:",
          error.message
        );
      }
    );
  }
);

// ==================================================
// START
// ==================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "======================================"
    );

    console.log(
      "FAST AI VOICE BRIDGE"
    );

    console.log(
      "======================================"
    );

    console.log(
      "Model:",
      GROQ_MODEL
    );

    console.log(
      "Streaming STT:",
      DEEPGRAM_STT_MODEL
    );

    console.log(
      "Streaming TTS:",
      DEEPGRAM_TTS_MODEL
    );

    console.log(
      "Tavily:",
      TAVILY_API_KEY
        ? "enabled"
        : "disabled"
    );

    console.log(
      "WebSocket:",
      WS_URL
    );

    console.log(
      "======================================"
    );
  }
);

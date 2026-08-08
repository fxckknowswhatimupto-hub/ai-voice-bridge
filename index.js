const http = require("http");
const WebSocket = require("ws");

const PORT = 3000;

// ------------------------------------------------------------
// BASIC HTTP SERVER
// ------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      status: "ok",
      service: "Exotel AI Voice Bridge"
    }));

    return;
  }

  res.writeHead(404);
  res.end("Not found");
});


// ------------------------------------------------------------
// WEBSOCKET SERVER
// ------------------------------------------------------------

const wss = new WebSocket.Server({
  server: server
});


console.log("----------------------------------------");
console.log("       AI VOICE BRIDGE");
console.log("----------------------------------------");


wss.on("connection", (ws) => {

  console.log("");
  console.log("========================================");
  console.log("       EXOTEL CONNECTED");
  console.log("========================================");


  ws.on("message", (data) => {

    try {

      const message =
        JSON.parse(data.toString());


      console.log(
        "Exotel event:",
        message.event
      );


      // ------------------------------------------------------
      // CONNECTED
      // ------------------------------------------------------

      if (message.event === "connected") {

        console.log(
          "WebSocket connection established."
        );

      }


      // ------------------------------------------------------
      // START
      // ------------------------------------------------------

      if (message.event === "start") {

        console.log(
          "Stream started."
        );

        console.log(
          "Stream SID:",
          message.stream_sid ||
          message.start?.stream_sid
        );

        console.log(
          "Call SID:",
          message.start?.call_sid
        );

        console.log(
          "Media format:",
          message.start?.media_format
        );

      }


      // ------------------------------------------------------
      // MEDIA
      // ------------------------------------------------------

      if (message.event === "media") {

        if (message.media?.payload) {

          const audio =
            Buffer.from(
              message.media.payload,
              "base64"
            );


          console.log(
            "Audio received:",
            audio.length,
            "bytes"
          );

        }

      }


      // ------------------------------------------------------
      // DTMF
      // ------------------------------------------------------

      if (message.event === "dtmf") {

        console.log(
          "DTMF:",
          message.dtmf?.digit
        );

      }


      // ------------------------------------------------------
      // STOP
      // ------------------------------------------------------

      if (message.event === "stop") {

        console.log(
          "Call/stream ended."
        );

      }

    } catch (error) {

      console.error(
        "Message error:",
        error.message
      );

    }

  });


  ws.on("close", () => {

    console.log(
      "Exotel disconnected."
    );

  });


  ws.on("error", (error) => {

    console.error(
      "WebSocket error:",
      error.message
    );

  });

});


// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "HTTP: http://localhost:" + PORT
    );

    console.log(
      "WebSocket: ws://localhost:" + PORT
    );

    console.log("");
    console.log(
      "Waiting for Exotel..."
    );

  }
);
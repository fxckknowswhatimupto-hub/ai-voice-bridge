function connectDeepgramSTT(call) {
  return new Promise((resolve, reject) => {

    const params = new URLSearchParams({
      model: "nova-2-phonecall",

      // Your Exotel audio is telephony audio.
      encoding: "linear16",
      sample_rate: "8000",
      channels: "1",

      // Gives us interim transcripts.
      interim_results: "true",

      // Fast speech-final detection.
      endpointing: "250",

      // Useful for detecting when speech starts.
      vad_events: "true",

      // Keep formatting simple for lower latency.
      smart_format: "false",

      // Explicit language.
      language: "en-US"
    });

    const url =
      `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    console.log(
      `[${call.id}] Connecting Deepgram STT...`
    );

    console.log(
      `[${call.id}] STT URL: ${url.replace(
        DEEPGRAM_API_KEY,
        "***"
      )}`
    );

    const socket = new WebSocket(
      url,
      {
        headers: {
          Authorization:
            `Token ${DEEPGRAM_API_KEY}`
        }
      }
    );

    let opened = false;

    socket.on("open", () => {

      opened = true;

      console.log(
        `[${call.id}] Deepgram STT connected`
      );

      resolve(socket);
    });

    socket.on("message", data => {

      if (call.destroyed) {
        return;
      }

      try {

        const msg =
          JSON.parse(data.toString());

        // --------------------------------------------------
        // SPEECH STARTED
        // --------------------------------------------------

        if (msg.type === "SpeechStarted") {

          if (call.aiSpeaking) {
            interruptAI(call);
          }

          return;
        }

        // --------------------------------------------------
        // UTTERANCE END
        // --------------------------------------------------

        if (msg.type === "UtteranceEnd") {
          return;
        }

        // --------------------------------------------------
        // TRANSCRIPT
        // --------------------------------------------------

        if (msg.type !== "Results") {
          return;
        }

        const alternative =
          msg.channel?.alternatives?.[0];

        if (!alternative) {
          return;
        }

        let transcript =
          alternative.transcript || "";

        transcript =
          transcript.trim();

        if (!transcript) {
          return;
        }

        // --------------------------------------------------
        // BARGE-IN
        // --------------------------------------------------

        if (
          !msg.is_final &&
          call.aiSpeaking &&
          transcript.split(/\s+/).length >= 2
        ) {

          console.log(
            `[${call.id}] BARGE-IN: ${transcript}`
          );

          interruptAI(call);
        }

        // --------------------------------------------------
        // FINAL USER SENTENCE
        // --------------------------------------------------

        if (
          msg.is_final &&
          msg.speech_final
        ) {

          const corrected =
            correctShoppingTranscript(
              transcript
            );

          console.log(
            `[${call.id}] CUSTOMER SAID: ${transcript}`
          );

          if (corrected !== transcript) {

            console.log(
              `[${call.id}] CORRECTED TO: ${corrected}`
            );
          }

          handleUserSpeech(
            call,
            corrected
          );
        }

      } catch (error) {

        console.error(
          `[${call.id}] STT message parsing error:`,
          error.message
        );
      }
    });

    socket.on("error", error => {

      console.error(
        `[${call.id}] Deepgram STT error:`,
        error.message
      );

      if (!opened) {
        reject(error);
      }
    });

    socket.on("close", (code, reason) => {

      console.log(
        `[${call.id}] Deepgram STT closed`,
        `code=${code}`,
        `reason=${reason?.toString() || "none"}`
      );

      if (!opened) {
        reject(
          new Error(
            `Deepgram STT closed before connection`
          )
        );
      }
    });
  });
}

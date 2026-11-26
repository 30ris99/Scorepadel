export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-telecronaca-pin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY non configurata su Vercel" });
  }

  const requiredPin = process.env.TELECRONACA_PIN;
  const sentPin = req.headers?.["x-telecronaca-pin"] || req.headers?.["X-Telecronaca-Pin"] || "";
  if (requiredPin && sentPin !== requiredPin) {
    return res.status(401).json({ error: "PIN Telecronaca non valido" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { voice = "ash", tournamentTitle = "Partita Padel", team1 = "Coppia 1", team2 = "Coppia 2", clips = [] } = body;

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "Nessuna clip inviata" });
    }

    // 1. Trascrizione in parallelo con fallback automatico gpt-4o-mini-transcribe -> whisper-1
    async function transcribeClip(clip) {
      if (!clip.rawAudioBase64) return null;
      const mime = (clip.rawAudioMime || "audio/webm").toLowerCase();
      const audioBuffer = Buffer.from(clip.rawAudioBase64, "base64");
      const ext = mime.includes("mp4") ? "m4a" : (mime.includes("ogg") ? "ogg" : "webm");

      async function callTranscribe(model) {
        const formData = new FormData();
        formData.append("file", new Blob([audioBuffer], { type: mime }), `clip.${ext}`);
        formData.append("model", model);
        formData.append("language", "it");
        const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData
        });
        const data = await resp.json().catch(() => ({}));
        return { ok: resp.ok, status: resp.status, data };
      }

      let tr = await callTranscribe("gpt-4o-mini-transcribe");
      if (!tr.ok) {
        const fb = await callTranscribe("whisper-1");
        if (fb.ok) {
          tr = fb;
        } else {
          throw new Error(`Trascrizione OpenAI: ${tr.data?.error?.message || fb.data?.error?.message || tr.status}`);
        }
      }

      const rawText = (tr.data?.text || "").trim();
      if (!rawText) return null;

      return {
        id: clip.id,
        timestamp: clip.timestamp,
        nextTimestamp: clip.nextTimestamp,
        scoreSnapshot: clip.scoreSnapshot || "",
        rawText
      };
    }

    const trResults = await Promise.all(clips.map(transcribeClip));
    const analyzed = trResults.filter(Boolean);

    if (analyzed.length === 0) {
      return res.status(400).json({ error: "Nessun parlato rilevato nelle clip registrate" });
    }

    // 2. Riscrittura naturale da telecronaca TV padel (mood spagnolo/Premier Padel in italiano)
    const rewritePrompt = `Sei un telecronista televisivo di padel di origine spagnola che commenta in italiano per una diretta stile Premier Padel.
Ricevi una lista cronologica di appunti vocali registrati durante "${tournamentTitle}" (${team1} vs ${team2}).

Per ogni intervento restituisci:
- "id": ESATTAMENTE lo stesso id ricevuto in input
- "text": frase in italiano PARLATO fluido, ritmato e naturale, coerente con gli interventi precedenti (linea narrativa unica).
- "tone": breve indicazione di mood per la voce (es. "calmo e scorrevole", "ritmo leggermente serrato, attento", "sobrio con ammirazione trattenuta").

MOOD E STILE:
- Tono da commentatore tecnico di padel: competente, caldo, spontaneo, con quel ritmo musicale tipico delle telecronache spagnole ma senza mai urlare.
- Usa frasi brevi e naturali da diretta, con pause vere usando virgole e puntini di sospensione (es. "Che mano morbida sulla chiquita... apre il campo, e chiude di volée. Trenta a quindici.").
- Puoi usare i termini autentici del padel (bandeja, víbora, chiquita, bajada, globo, salida de pared) quando coerenti con l'appunto.
- Scrivi i punteggi come si dicono a voce ("trenta a quaranta", "quaranta pari", "cinque a quattro").
- ZERO falsi entusiasmi, ZERO punti esclamativi inutili, ZERO tono da spot o audiolibro.
- Massimo 1-2 frasi per intervento, senza inventare colpi non menzionati.

Rispondi SOLO con un JSON valido nel formato: {"clips":[{"id":"...","text":"...","tone":"..."}]}`;

    const chatResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: rewritePrompt },
          { role: "user", content: JSON.stringify({ clips: analyzed }) }
        ]
      })
    });
    const chatData = await chatResp.json().catch(() => ({}));
    if (!chatResp.ok) {
      return res.status(chatResp.status).json({ error: `Riscrittura OpenAI: ${chatData.error?.message || chatResp.status}` });
    }

    const parsed = JSON.parse(chatData.choices?.[0]?.message?.content || '{"clips":[]}');
    const rawRewritten = Array.isArray(parsed.clips) ? parsed.clips : [];
    const validIds = new Set(analyzed.map(a => a.id));

    const rewrittenList = rawRewritten
      .map((item, idx) => ({
        id: (item && validIds.has(item.id)) ? item.id : (analyzed[idx]?.id || item?.id),
        text: String(item?.text || analyzed[idx]?.rawText || "").trim(),
        tone: String(item?.tone || "calmo e scorrevole").trim()
      }))
      .filter(item => item.id && item.text);

    if (rewrittenList.length === 0) {
      return res.status(500).json({ error: "OpenAI ha restituito una riscrittura vuota" });
    }

    // 3. Generazione audio studio MP3 in parallelo (accento spagnolo leggero + mood naturale)
    async function synthesizeClip(item) {
      const ttsInstructions = `Parla in italiano con un leggero e autentico accento spagnolo (come un telecronista spagnolo di padel che parla italiano in modo fluente e naturale, mai caricaturale o forzato).
Stile: commentatore sportivo televisivo in cabina (stile Premier Padel / Sky Sport), voce calda, viva e conversazionale, zero effetto robotico o da audiolibro.
Ritmo: scorrevole e leggermente musicale, con micro-pause e respiri naturali sui puntini e sulle virgole. Pronuncia con accento spagnolo autentico i termini del padel (bandeja, víbora, chiquita, bajada, globo).
Mood di questo intervento: ${item.tone}.
Resta sempre sobrio e credibile: niente urla, niente entusiasmo finto.`;

      let ttsResp = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice,
          input: item.text,
          instructions: ttsInstructions,
          response_format: "mp3"
        })
      });

      if (!ttsResp.ok) {
        const err1 = await ttsResp.json().catch(() => ({}));
        const fbVoice = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(voice) ? voice : "echo";
        const fbResp = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "tts-1",
            voice: fbVoice,
            input: item.text,
            response_format: "mp3"
          })
        });
        if (fbResp.ok) {
          ttsResp = fbResp;
        } else {
          const err2 = await fbResp.json().catch(() => ({}));
          throw new Error(`TTS OpenAI: ${err1.error?.message || err2.error?.message || ttsResp.status}`);
        }
      }

      const mp3Buf = Buffer.from(await ttsResp.arrayBuffer());
      return {
        id: item.id,
        text: item.text,
        tone: item.tone,
        audioBase64: mp3Buf.toString("base64"),
        audioMime: "audio/mpeg"
      };
    }

    const outputClips = await Promise.all(rewrittenList.map(synthesizeClip));

    return res.status(200).json({ clips: outputClips });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Errore interno" });
  }
}

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
    const {
      voice = "ash",
      accent = "spagnolo_leggero",
      mood = "sobrio",
      speed = 1.0,
      pitchSemitones = 0,
      tournamentTitle = "Partita Padel",
      team1 = "Coppia 1",
      team2 = "Coppia 2",
      clips = []
    } = body;

    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "Nessuna clip inviata" });
    }

    const safeSpeed = Math.max(0.75, Math.min(1.30, Number(speed) || 1.0));

    function isSilenceHallucination(text) {
      const clean = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim();
      if (clean.length < 3) return true;
      const noisePatterns = [
        /^sottotitoli/,
        /^grazie per la visione/,
        /^grazie per aver guardato/,
        /^iscriviti al canale/,
        /^amara org/,
        /^traduzione/,
        /^fine$/,
        /^musica$/
      ];
      return noisePatterns.some((re) => re.test(clean));
    }

    async function transcribeClip(clip) {
      if (!clip.rawAudioBase64) return null;
      const mime = (clip.rawAudioMime || "audio/webm").toLowerCase();
      const audioBuffer = Buffer.from(clip.rawAudioBase64, "base64");
      if (audioBuffer.byteLength < 800) return null;
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
      if (!rawText || isSilenceHallucination(rawText)) return null;

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
      return res.status(400).json({ error: "Nessun parlato rilevato: avvicina il microfono e riprova." });
    }

    const moodGuide = {
      sobrio: "Sobrio, asciutto e naturale.",
      dinamico: "Ritmato e scorrevole da diretta TV, senza mai urlare.",
      calmo: "Calmo, disteso e analitico."
    }[mood] || "Sobrio, asciutto e naturale.";

    const rewritePrompt = `Sei un editor di telecronaca TV di padel in italiano (${tournamentTitle}: ${team1} vs ${team2}).
Ricevi una lista di appunti vocali ("rawText") dettati dal commentatore.

COMPITO PRECISO (FEDELTÀ STRETTA):
Rifinisci leggermente "rawText" per farlo suonare naturale e scorrevole da telecronaca TV, SENZA aggiungere altro e SENZA divagare.
- Esempio: se "rawText" è "bandeja vincente Marco" -> restituisci "Grande bandeja vincente di Marco." (o "Bandeja vincente di Marco.").
- ATTIENITI STRETTAMENTE a ciò che dice il commentatore: non aggiungere commenti extra, non inventare colpi o dettagli, non allungare la frase.
- NON aggiungere il punteggio se il commentatore non lo ha nominato; se lo ha nominato, scrivilo in lettere ("trenta a quindici", "quaranta pari").
- Se "rawText" sembra solo rumore o parole senza senso non legate alla partita, restituisci "text": "".
- Elimina solo esitazioni ("ehm", "cioè", ripetizioni) e sistema la punteggiatura per una lettura fluida.
- Mood: ${moodGuide} ZERO falsi entusiasmi, ZERO punti esclamativi inutili.

GLOSSARIO PADEL (CORREGGI EVENTUALI ERRORI DI TRASCRIZIONE):
- "per tre" / "x3" / "por tres" = smash fuori lateralmente sopra la parete da 3 metri (scrivi sempre "per tre", mai "x3" e mai "tre vincenti").
- "per quattro" / "x4" / "por cuatro" = smash fuori dal vetro di fondo da 4 metri (scrivi sempre "per quattro", mai "x4").
- Correggi eventuali storpiature fonetiche nei termini del padel: bandeja, víbora, chiquita, bajada, rulo, gancho, dormilona, dejada, globo, contrapared, salida de pared, boquilla, reja, willy, tweener, nevera, punto de oro.

Per ogni intervento restituisci:
- "id": ESATTAMENTE lo stesso id ricevuto in input
- "text": la frase rifinita (oppure "" se non c'è vero parlato)
- "tone": breve indicazione di registro coerente col mood (es. "calmo e scorrevole", "asciutto e attento")

Rispondi SOLO con un JSON valido nel formato: {"clips":[{"id":"...","text":"...","tone":"..."}]}`;

    const chatResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
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
        text: String(item?.text ?? "").trim(),
        tone: String(item?.tone || "calmo e scorrevole").trim()
      }))
      .filter(item => item.id && item.text.length > 0);

    if (rewrittenList.length === 0) {
      return res.status(400).json({ error: "Nessun commento valido rilevato nelle clip." });
    }

    const accentGuide = {
      spagnolo_leggero: "Parla in italiano con un leggero e autentico accento spagnolo (come un telecronista spagnolo di padel che parla italiano in modo fluente e naturale, mai caricaturale).",
      spagnolo_madrid: "Parla in italiano con un chiaro accento spagnolo di Madrid, caldo, musicale e spontaneo da telecronista di Premier Padel.",
      argentino: "Parla in italiano con un leggero accento argentino rioplatense (caldo, ritmato e naturale, tipico dei commentatori sudamericani di padel).",
      italiano: "Parla in italiano standard da telecronista sportivo televisivo (stile Sky Sport), pulito e naturale."
    }[accent] || "Parla in italiano con un leggero e autentico accento spagnolo.";

    const pitchHint = Number(pitchSemitones) <= -1.5
      ? "Impostazione vocale: timbro leggermente più grave e profondo."
      : (Number(pitchSemitones) >= 1.5 ? "Impostazione vocale: timbro leggermente più brillante e squillante." : "");

    async function synthesizeClip(item) {
      const ttsInstructions = `${accentGuide}
Stile: commentatore sportivo televisivo in cabina (stile Premier Padel), voce calda, viva e conversazionale, zero effetto robotico o da audiolibro.
Ritmo: scorrevole e naturale, con micro-pause reali sui puntini e sulle virgole.
PRONUNCIA DEI TERMINI PADEL:
- "bandeja" si pronuncia "bandèca" / "bandèha" (J aspirata spagnola, mai "bandegia")
- "bajada" si pronuncia "bahàda"
- "reja" si pronuncia "rèha"
- "dejada" si pronuncia "dehàda"
- "chiquita" si pronuncia "cikìta"
- "víbora" si pronuncia "bìbora" (accento sulla prima sillaba)
${pitchHint}
Mood di questo intervento: ${item.tone}. Resta sempre sobrio e credibile: niente urla, niente entusiasmo finto.`;

      let ttsResp = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice,
          speed: safeSpeed,
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
            speed: safeSpeed,
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

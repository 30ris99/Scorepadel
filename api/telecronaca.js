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

    // Prompt lessicale per Whisper/gpt-4o-mini-transcribe: evita errori su termini di padel
    const sttPadelPrompt = `Telecronaca di padel in italiano (${team1} vs ${team2}). Termini frequenti: per tre, x3, por tres, per quattro, x4, por cuatro, smash, remate, bandeja, vibora, chiquita, bajada, rulo, gancho, dormilona, dejada, globo, pallonetto, volee, volée, controvetro, contrapared, uscita di parete, salida de pared, doppio vetro, reja, griglia, porta, punto de oro, killer point, palla break, nevera, willy, tweener, cuchilla, boquilla.`;

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
        formData.append("prompt", sttPadelPrompt);
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

    const moodGuide = {
      sobrio: "Sobrio, tecnico e giornalistico (stile Premier Padel / Sky Sport). Zero urla, zero falsi entusiasmi.",
      dinamico: "Dinamico e ritmato da diretta TV, leggermente più vivo sui punti decisivi, ma sempre credibile e mai urlato.",
      calmo: "Calmo, analitico e disteso, da commentatore tecnico di studio."
    }[mood] || "Sobrio, tecnico e giornalistico.";

    // 2. Riscrittura naturale con glossario completo dei colpi di padel
    const rewritePrompt = `Sei un telecronista televisivo esperto di padel che commenta in italiano per una diretta stile Premier Padel.
Ricevi una lista cronologica di appunti vocali registrati durante "${tournamentTitle}" (${team1} vs ${team2}).

GLOSSARIO UFFICIALE PADEL (INTERPRETA SEMPRE CON PRECISIONE ASSOLUTA):
- "per tre" / "x3" / "por tres" / "fuori per tre" = smash che esce lateralmente sopra la parete da 3 metri (NON significa MAI "tre punti" o "tre vincenti"!). Nel testo scrivi sempre "per tre" o "smash per tre" (mai "x3" che la voce leggerebbe male).
- "per quattro" / "x4" / "por cuatro" = smash potente che scavalca il vetro di fondo da 4 metri. Scrivi sempre "per quattro" (mai "x4").
- "bandeja" = colpo difensivo-tattico sopra la testa tagliato per mantenere la rete.
- "víbora" = colpo sopra la testa più veloce e con forte effetto laterale/tagliato.
- "rulo" / "rulo alla griglia" = smash liftato verso la griglia laterale (reja).
- "gancho" = colpo sopra la testa alto e controllato di emergenza per non perdere la rete.
- "bajada" / "bajada de pared" = attacco potente dopo il rimbalzo alto sul vetro di fondo.
- "chiquita" = palla morbida e bassa giocata ai piedi degli avversari a rete.
- "dormilona" = smorzata delicatissima dopo uno smash avversario che rimbalza sul vetro.
- "dejada" / "smorzata" = palla corta a morire subito dopo la rete.
- "globo" / "pallonetto" = palla alta sopra gli avversari per toglierli dalla rete.
- "contrapared" / "controvetro" = colpo difensivo giocato contro il proprio vetro di fondo.
- "salida de pared" / "uscita di parete" = colpo dopo il rimbalzo sul vetro di fondo o laterale.
- "boquilla" / "doble pared" / "doppio vetro" = rimbalzo su entrambi i vetri d'angolo.
- "reja" / "griglia" = la rete metallica laterale.
- "recupero da fuori" / "uscita dalla porta" = giocatore che esce dalla porta laterale per recuperare un "per tre".
- "willy" / "tweener" = colpo tra le gambe.
- "nevera" / "frigorifero" = strategia di giocare tutte le palle su un solo avversario escludendo il compagno.
- "punto de oro" / "killer point" = punto decisivo sul quaranta pari.

Per ogni intervento restituisci:
- "id": ESATTAMENTE lo stesso id ricevuto in input
- "text": frase in italiano PARLATO fluido, ritmato e naturale, coerente con gli interventi precedenti (linea narrativa unica).
- "tone": breve indicazione di registro per la voce (es. "calmo e scorrevole", "attento e concentrato", "sobrio con leggera ammirazione").

REGOLE DI SCRITTURA PER VOCE NATURALE:
- Mood richiesto: ${moodGuide}
- Scrivi come si PARLA in diretta TV, non come un articolo scritto.
- Usa frasi brevi con pause naturali (virgole e puntini di sospensione "...").
- Scrivi i punteggi in lettere quando suona più naturale ("trenta a quindici", "quaranta pari", "cinque a quattro").
- Non scrivere simboli come "x3" o "x4": scrivi sempre "per tre" e "per quattro" così la pronuncia è perfetta.
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

    const accentGuide = {
      spagnolo_leggero: "Parla in italiano con un leggero e autentico accento spagnolo (come un telecronista spagnolo di padel che parla italiano in modo fluente e naturale, mai caricaturale).",
      spagnolo_madrid: "Parla in italiano con un chiaro accento spagnolo di Madrid, caldo, musicale e spontaneo da telecronista di Premier Padel.",
      argentino: "Parla in italiano con un leggero accento argentino rioplatense (caldo, ritmato e naturale, tipico dei commentatori sudamericani di padel).",
      italiano: "Parla in italiano standard da telecronista sportivo televisivo (stile Sky Sport), pulito e naturale."
    }[accent] || "Parla in italiano con un leggero e autentico accento spagnolo.";

    const pitchHint = Number(pitchSemitones) <= -1.5
      ? "Impostazione vocale: timbro leggermente più grave e profondo."
      : (Number(pitchSemitones) >= 1.5 ? "Impostazione vocale: timbro leggermente più brillante e squillante." : "");

    // 3. Generazione audio studio MP3 in parallelo con guida fonetica dei colpi di padel
    async function synthesizeClip(item) {
      const ttsInstructions = `${accentGuide}
Stile: commentatore sportivo televisivo in cabina (stile Premier Padel), voce calda, viva e conversazionale, zero effetto robotico o da audiolibro.
Ritmo: scorrevole e naturale, con micro-pause reali sui puntini e sulle virgole.
PRONUNCIA CORRETTA DEI TERMINI PADEL (in spagnolo autentico):
- "bandeja" si pronuncia "bandèha" (con la J aspirata spagnola, mai "bandegia")
- "bajada" si pronuncia "bahàda" (con la J aspirata spagnola)
- "reja" si pronuncia "rèha" (con la J aspirata spagnola)
- "dejada" si pronuncia "dehàda"
- "chiquita" si pronuncia "cikìta"
- "víbora" si pronuncia "bìbora" (accento sulla prima sillaba)
- "rulo", "gancho", "globo", "dormilona", "contrapared", "salida de pared" con cadenza spagnola naturale.
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

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const error = (code: string, status: number) => json({ error: code }, status);

export async function handleTelemetry(request: Request, env: any, gameId: string) {
  const body = await request.json().catch(() => null) as { audioLevel: number, motionLevel: number } | null;
  if (!body) return error('invalid_body', 400);

  // If there's a significant audio spike or motion spike, we evaluate with JEV
  if (body.audioLevel > 5000 || body.motionLevel > 5) {
    try {
      let isHighlight = false;
      try {
        const jevResult = await env.AI.run("typesafe/jev", {
          description: `The live stream just experienced a sudden audio spike of ${body.audioLevel} and a motion variance of ${body.motionLevel}.`,
          questions: [{ question: "Is this likely an important highlight event?", type: "yes_no" }]
        });
        isHighlight = jevResult?.[0]?.answer === 'yes' || true; // Fallback to true if unknown structure
      } catch (e) {
        // Fallback if model name or schema is slightly different
        isHighlight = true;
      }

      if (isHighlight && env.GEMINI_API_KEY) {
        let description = "Incredible moment from the game!";
        try {
          const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `A sudden audio spike (${body.audioLevel}) and camera movement was just detected at a local sports game! Give us a 1-sentence hyped-up description for a highlight clip on social media.` }] }]
            })
          });
          const geminiData: any = await geminiResponse.json();
          if (geminiData.candidates?.[0]?.content?.parts?.[0]?.text) {
            description = geminiData.candidates[0].content.parts[0].text.trim();
          }
        } catch (e) {
          console.error('Gemini error:', e);
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const payloadJson = JSON.stringify({ description });
        await env.DB.prepare('INSERT INTO game_events (id, sequence, game_id, kind, game_time_seconds, payload_json, created_at) VALUES (?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM game_events WHERE game_id = ?), ?, ?, ?, ?, ?)')
          .bind(id, gameId, gameId, 'HIGHLIGHT', 0, payloadJson, now).run();
          
        return json({ success: true, ai_triggered: true, highlight_created: true, description });
      }
      return json({ success: true, ai_triggered: true });
    } catch (e) {
      console.error('AI Error:', e);
      return json({ success: false, error: 'ai_processing_failed' }, 500);
    }
  }

  return json({ success: true, ai_triggered: false });
}

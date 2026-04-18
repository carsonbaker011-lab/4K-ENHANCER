export const config = { maxDuration: 60 };

function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    "unknown"
  );
}

const ipLog = new Map();
function checkRateLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${ip}:${today}`;
  const count = (ipLog.get(key) || 0) + 1;
  ipLog.set(key, count);
  if (ipLog.size > 5000) for (const [k] of ipLog) { if (!k.endsWith(today)) ipLog.delete(k); }
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return { count, hoursLeft: Math.ceil((midnight - now) / 1000 / 3600) };
}

async function uploadToBlob(imageBase64, mediaType) {
  const { put } = await import("@vercel/blob");
  const buffer = Buffer.from(imageBase64, "base64");
  const ext = mediaType.split("/")[1]?.split("+")[0] || "jpg";
  const blob = await put(`enhance-${Date.now()}.${ext}`, buffer, {
    access: "public",
    contentType: mediaType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return blob.url;
}

// ── STAGE 1: Claude analyzes image and writes a rich regeneration prompt ──
function normalizeMediaType(mediaType) {
  if (!mediaType) return 'image/jpeg';
  const t = mediaType.toLowerCase().trim();
  if (t.includes('png')) return 'image/png';
  if (t.includes('gif')) return 'image/gif';
  if (t.includes('webp')) return 'image/webp';
  return 'image/jpeg'; // default everything else to jpeg
}

async function runClaudeAnalysis(imageBase64, rawMediaType, mode) {
  const mediaType = normalizeMediaType(rawMediaType);
  console.log("Claude mediaType:", mediaType);
  const modeInstructions = {
    auto: "Describe what you see accurately and completely.",
    photo: "Focus on photographic realism — lighting, depth of field, textures, skin, materials.",
    art: "Focus on artistic style, color palette, brushwork, mood, and creative elements.",
  };

  const systemPrompt = `You are an expert image analyst and prompt engineer. 
Your job is to analyze an image and return a JSON object with two things:
1. A rich, detailed regeneration prompt for Nano Banana Pro (Google's Gemini image model) that will recreate this image at 4K with maximum sharpness, texture, and detail
2. Analysis metadata about the image

Return ONLY valid JSON, no markdown, no extra text:
{
  "regeneration_prompt": "extremely detailed prompt describing every aspect of the image for perfect regeneration at 4K ultra detail",
  "quality_score": number 1-10,
  "noise_level": "low"|"medium"|"high",
  "sharpness": "soft"|"average"|"sharp",
  "subject_type": "string",
  "color_profile": "string",
  "enhancements_applied": ["detail1","detail2","detail3","detail4"],
  "upscale_recommendation": "one sentence about the regeneration approach"
}

For the regeneration_prompt: be extremely specific about subjects, colors, textures, lighting, composition, style, mood, and materials. End the prompt with: "Ultra high resolution, 4K, sharp focus, intricate detail, photorealistic textures, cinematic quality, masterpiece."

${modeInstructions[mode] || modeInstructions.auto}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: systemPrompt },
        ],
      }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content.map(i => i.text || "").join("");
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ── STAGE 2: Nano Banana Pro regenerates the image at 4K ──
async function startNanoBanana(imageUrl, prompt, resolution) {
  const resolutionMap = { "2K": "2K", "4K": "4K", "8K": "4K" }; // max is 4K
  const targetRes = resolutionMap[resolution] || "4K";

  const res = await fetch(
    "https://api.replicate.com/v1/models/google/nano-banana-pro/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          image: imageUrl,
          prompt: prompt,
          resolution: targetRes,
          aspect_ratio: "match_input_image",
          output_format: "jpg",
          allow_fallback_model: true,
        },
      }),
    }
  );
  const text = await res.text();
  console.log("NanoBanana:", res.status, text.slice(0, 500));
  if (!res.ok) throw new Error(`NanaBanana failed ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`NanaBanana error: ${data.error}`);
  console.log("NanaBanana prediction started:", data.id);
  return data.id;
}

// ── STAGE 3: Topaz final sharpening pass ──
async function startTopaz(imageUrl) {
  const res = await fetch(
    "https://api.replicate.com/v1/models/topazlabs/image-upscale/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: { image: imageUrl, scale_factor: 2 },
      }),
    }
  );
  const text = await res.text();
  console.log("Topaz:", res.status, text.slice(0, 500));
  if (!res.ok) throw new Error(`Topaz failed ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`Topaz error: ${data.error}`);
  return data.id;
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch result: ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action, imageBase64, mediaType, resolution, mode, predictionId, stage, imageUrl: inUrl } = req.body;

  // ── POLL ──
  if (action === "poll_pipeline") {
    if (!predictionId) return res.status(400).json({ error: "Missing predictionId" });
    try {
      const r = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
      });
      const p = await r.json();
      console.log(`Stage${stage} poll:`, predictionId, "->", p.status);
      if (p.status === "succeeded") {
        const url = Array.isArray(p.output) ? p.output[0] : p.output;
        return res.status(200).json({ status: "succeeded", outputUrl: url, stage });
      }
      if (p.status === "failed" || p.status === "canceled") {
        return res.status(200).json({ status: "failed", error: p.error, stage });
      }
      return res.status(200).json({ status: p.status, stage });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── ADVANCE to next stage ──
  if (action === "advance_stage") {
    try {
      let pid;
      if (stage === 3) {
        pid = await startTopaz(inUrl);
      }
      return res.status(200).json({ status: "started", predictionId: pid, stage });
    } catch (err) {
      console.error("Advance stage error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── START ──
  const ip = getIP(req);
  const { count, hoursLeft } = checkRateLimit(ip);
  if (count > 100) return res.status(429).json({ error: "daily_limit_reached", message: `You've used your 1 free enhancement today. Resets in ~${hoursLeft}h.`, resetsIn: hoursLeft });
  if (!imageBase64 || !mediaType) return res.status(400).json({ error: "Missing imageBase64 or mediaType" });

  console.log("Raw mediaType received:", mediaType);
  const normalizedType = normalizeMediaType(mediaType);
  console.log("Normalized mediaType:", normalizedType);
  try {
    // Run Claude analysis + blob upload in parallel
    console.log("Starting Claude analysis and blob upload in parallel...");
    const [analysis, imageUrl] = await Promise.all([
      runClaudeAnalysis(imageBase64, normalizedType, mode || "auto"),
      uploadToBlob(imageBase64, normalizedType),
    ]);

    console.log("Claude prompt generated:", analysis.regeneration_prompt?.slice(0, 100));
    console.log("Blob URL:", imageUrl);

    // Start Nano Banana with Claude's generated prompt
    const pid = await startNanoBanana(imageUrl, analysis.regeneration_prompt, resolution || "4K");

    return res.status(200).json({
      status: "started",
      predictionId: pid,
      stage: 2,
      result: analysis,
    });
  } catch (err) {
    console.error("Start error:", err.message);
    return res.status(500).json({ error: "Enhancement failed", message: err.message });
  }
}

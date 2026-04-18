export const config = { maxDuration: 60 };

function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    "unknown"
  );
}

// In-memory store — persists within a warm function instance
// Good enough for rate limiting: worst case a user gets 1 extra request on cold start
const ipLog = new Map();

function checkRateLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${ip}:${today}`;
  const count = (ipLog.get(key) || 0) + 1;
  ipLog.set(key, count);

  // Clean up old keys occasionally
  if (ipLog.size > 5000) {
    for (const [k] of ipLog) {
      if (!k.endsWith(today)) ipLog.delete(k);
    }
  }

  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const hoursLeft = Math.ceil((midnight - now) / 1000 / 3600);
  return { count, hoursLeft };
}

function buildDataUri(imageBase64, mediaType) {
  return `data:${mediaType};base64,${imageBase64}`;
}

async function pollPrediction(predictionId) {
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = await fetch(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      { headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` } }
    );
    const data = await res.json();
    if (data.status === "succeeded") return data.output;
    if (data.status === "failed") throw new Error(data.error || "Upscale failed");
  }
  throw new Error("Timed out waiting for upscale");
}

async function runTopazUpscale(imageUrl, scaleFactor, topazModel) {
  const res = await fetch(
    "https://api.replicate.com/v1/models/topazlabs/image-upscale/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
        Prefer: "wait=55",
      },
      body: JSON.stringify({
        input: {
          image: imageUrl,
          model: topazModel,
          scale_factor: scaleFactor,
          output_format: "jpeg",
          face_enhancement: true,
          subject_detection: "All",
        },
      }),
    }
  );
  const prediction = await res.json();
  if (prediction.error) throw new Error(prediction.error);
  if (prediction.status === "succeeded") return prediction.output;
  return await pollPrediction(prediction.id);
}

async function runClaudeAnalysis(imageBase64, mediaType, resolution, mode) {
  const resMap = { "2K": "2560x1440", "4K": "3840x2160", "8K": "7680x4320" };
  const targetRes = resMap[resolution] || "3840x2160";
  const prompt = `Analyze this image and return JSON only, no markdown, no extra text.
{
  "quality_score": number 1-10,
  "noise_level": "low" | "medium" | "high",
  "sharpness": "soft" | "average" | "sharp",
  "subject_type": "string",
  "color_profile": "string",
  "enhancements_applied": ["item1","item2","item3","item4"],
  "upscale_recommendation": "one sentence",
  "target_resolution": "${targetRes}"
}
Make enhancements_applied specific to this image upscaled to ${resolution} in ${mode} mode.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: prompt },
        ],
      }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content.map((i) => i.text || "").join("");
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch enhanced image");
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = getIP(req);
  const { count, hoursLeft } = checkRateLimit(ip);
  if (count > 1) {
    return res.status(429).json({
      error: "daily_limit_reached",
      message: `You've used your 1 free enhancement today. Resets in ~${hoursLeft}h.`,
      resetsIn: hoursLeft,
    });
  }

  const { imageBase64, mediaType, resolution, mode } = req.body;
  if (!imageBase64 || !mediaType) {
    return res.status(400).json({ error: "Missing imageBase64 or mediaType" });
  }

  const scaleMap = { "2K": 2, "4K": 4, "8K": 6 };
  const scaleFactor = scaleMap[resolution] || 4;
  const topazModelMap = { auto: "High Fidelity V2", photo: "Standard V2", art: "Low Resolution V2" };
  const topazModel = topazModelMap[mode] || "High Fidelity V2";

  try {
    const imageUrl = buildDataUri(imageBase64, mediaType);
    const [outputUrl, analysis] = await Promise.all([
      runTopazUpscale(imageUrl, scaleFactor, topazModel),
      runClaudeAnalysis(imageBase64, mediaType, resolution, mode).catch(() => null),
    ]);

    const finalUrl = Array.isArray(outputUrl) ? outputUrl[0] : outputUrl;
    const enhancedBase64 = await fetchImageAsBase64(finalUrl);

    return res.status(200).json({
      enhancedImageBase64: enhancedBase64,
      enhancedMediaType: "image/jpeg",
      result: analysis,
    });
  } catch (err) {
    console.error("Enhancement error:", err);
    return res.status(500).json({ error: "Enhancement failed", message: err.message });
  }
}

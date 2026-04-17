import { kv } from "@vercel/kv";

export const config = { maxDuration: 30 };

function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    "unknown"
  );
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const ip = getIP(req);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `ratelimit:${ip}:${today}`;

  try {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    const ttl = Math.ceil((midnight - now) / 1000);

    const count = await kv.incr(key);
    if (count === 1) await kv.expire(key, ttl);

    res.setHeader("X-RateLimit-Limit", "1");
    res.setHeader("X-RateLimit-Remaining", Math.max(0, 1 - count));

    if (count > 1) {
      const hoursLeft = Math.ceil(ttl / 3600);
      return res.status(429).json({
        error: "daily_limit_reached",
        message: `You've used your 1 free enhancement today. Resets in ~${hoursLeft}h.`,
        resetsIn: hoursLeft,
      });
    }
  } catch (kvErr) {
    console.error("KV error:", kvErr);
    // Fail open — don't block user if KV is unavailable
  }

  const { imageBase64, mediaType, resolution, mode } = req.body;

  if (!imageBase64 || !mediaType) {
    return res.status(400).json({ error: "Missing imageBase64 or mediaType" });
  }

  const resMap = { "2K": "2560×1440", "4K": "3840×2160", "8K": "7680×4320" };
  const targetRes = resMap[resolution] || "3840×2160";

  const prompt = `You are an expert image quality analyst and enhancement AI. Analyze this image in detail and produce a structured JSON response ONLY — no text before or after, no markdown fences.

Return exactly this JSON schema:
{
  "quality_score": number 1-10,
  "noise_level": "low" | "medium" | "high",
  "sharpness": "soft" | "average" | "sharp",
  "subject_type": "string (e.g. portrait, landscape, product, architecture)",
  "color_profile": "string (e.g. warm tones, neutral, high contrast)",
  "enhancements_applied": [
    "Enhancement 1 specific to this image",
    "Enhancement 2",
    "Enhancement 3",
    "Enhancement 4"
  ],
  "upscale_recommendation": "one sentence why ${resolution} is appropriate or suggest a better alternative",
  "target_resolution": "${targetRes}",
  "enhancement_mode_used": "${mode}"
}

Make the enhancements_applied array contain 4 specific, technical enhancement descriptions directly relevant to this actual image being upscaled to ${resolution} in ${mode} mode.`;

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: imageBase64 },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    const data = await anthropicRes.json();
    if (data.error) throw new Error(data.error.message);

    const rawText = data.content.map((i) => i.text || "").join("");
    const clean = rawText.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);

    return res.status(200).json({ result });
  } catch (err) {
    console.error("Anthropic error:", err);
    return res.status(500).json({ error: "Analysis failed", message: err.message });
  }
}

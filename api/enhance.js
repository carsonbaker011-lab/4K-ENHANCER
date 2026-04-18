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
  const filename = `enhance-${Date.now()}.${ext}`;
  const blob = await put(filename, buffer, {
    access: "public",
    contentType: mediaType,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return blob.url;
}

async function startTopazPrediction(imageUrl, scaleFactor, topazModel) {
  const res = await fetch(
    "https://api.replicate.com/v1/models/topazlabs/image-upscale/predictions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
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
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`Topaz error: ${data.error || res.status}`);
  console.log("Prediction started:", data.id, "status:", data.status);
  return data.id;
}

async function runClaudeAnalysis(imageBase64, mediaType, resolution, mode) {
  const resMap = { "2K": "2560x1440", "4K": "3840x2160", "8K": "7680x4320" };
  const targetRes = resMap[resolution] || "3840x2160";
  const prompt = `Analyze this image and return JSON only, no markdown.
{
  "quality_score": number 1-10,
  "noise_level": "low"|"medium"|"high",
  "sharpness": "soft"|"average"|"sharp",
  "subject_type": "string",
  "color_profile": "string",
  "enhancements_applied": ["item1","item2","item3","item4"],
  "upscale_recommendation": "one sentence",
  "target_resolution": "${targetRes}"
}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 800,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
        { type: "text", text: prompt },
      ]}],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content.map(i => i.text || "").join("");
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
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

  const { action, imageBase64, mediaType, resolution, mode, predictionId } = req.body;

  // ── POLL ──
  if (action === "poll") {
    if (!predictionId) return res.status(400).json({ error: "Missing predictionId" });
    try {
      const r = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
      });
      const p = await r.json();
      console.log("Poll:", predictionId, "->", p.status);
      if (p.status === "succeeded") {
        const url = Array.isArray(p.output) ? p.output[0] : p.output;
        return res.status(200).json({ status: "succeeded", enhancedImageBase64: await fetchImageAsBase64(url), enhancedMediaType: "image/jpeg" });
      }
      if (p.status === "failed" || p.status === "canceled") {
        return res.status(200).json({ status: "failed", error: p.error || "Prediction failed" });
      }
      return res.status(200).json({ status: p.status });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── START ──
  const ip = getIP(req);
  const { count, hoursLeft } = checkRateLimit(ip);
  if (count > 1) return res.status(429).json({ error: "daily_limit_reached", message: `You've used your 1 free enhancement today. Resets in ~${hoursLeft}h.`, resetsIn: hoursLeft });
  if (!imageBase64 || !mediaType) return res.status(400).json({ error: "Missing imageBase64 or mediaType" });

  const scaleMap = { "2K": 2, "4K": 4, "8K": 6 };
  const topazModelMap = { auto: "High Fidelity V2", photo: "Standard V2", art: "Low Resolution V2" };

  try {
    console.log("Uploading to Vercel Blob...");
    const imageUrl = await uploadToBlob(imageBase64, mediaType);
    console.log("Blob URL:", imageUrl);

    const [pid, analysis] = await Promise.all([
      startTopazPrediction(imageUrl, scaleMap[resolution] || 4, topazModelMap[mode] || "High Fidelity V2"),
      runClaudeAnalysis(imageBase64, mediaType, resolution, mode).catch(e => { console.error("Claude:", e.message); return null; }),
    ]);

    return res.status(200).json({ status: "started", predictionId: pid, result: analysis });
  } catch (err) {
    console.error("Start error:", err.message);
    return res.status(500).json({ error: "Enhancement failed", message: err.message });
  }
}

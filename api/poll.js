export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { predictionId } = req.body;
  if (!predictionId) return res.status(400).json({ error: "Missing predictionId" });

  try {
    const r = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}` },
    });
    const p = await r.json();
    if (p.status === "succeeded") {
      const url = Array.isArray(p.output) ? p.output[0] : p.output;
      return res.status(200).json({ status: "succeeded", imageUrl: url });
    }
    if (p.status === "failed" || p.status === "canceled") {
      return res.status(200).json({ status: "failed", error: p.error });
    }
    return res.status(200).json({ status: p.status });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

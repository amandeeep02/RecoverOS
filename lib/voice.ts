import { randomUUID } from "node:crypto";
import type { RecoveryEpisode } from "@/lib/domain";
import { RecoveryStore } from "@/lib/store";

export type VoiceProvider = "elevenlabs" | "browser" | "twilio";

export interface VoiceCallResult {
  callId: string;
  status: "initiated" | "simulated" | "failed";
  provider: VoiceProvider;
  audioUrl?: string;
  callSid?: string;
  error?: string;
  executedAt: string;
}

export interface PromiseToPay {
  promiseId: string;
  episodeId: string;
  promisedAmountInr: number;
  promisedAt: string;
  dueBy: string;
  status: "PENDING" | "FULFILLED" | "BROKEN" | "EXPIRED";
  customerAcknowledged: boolean;
  callId?: string;
}

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

function getElevenLabsKey(): string | null {
  return process.env.ELEVENLABS_API_KEY ?? null;
}

function getTwilioConfig(): { accountSid: string; authToken: string; fromNumber: string } | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (sid && token && from) return { accountSid: sid, authToken: token, fromNumber: from };
  return null;
}

export function generateHinglishScript(episode: RecoveryEpisode): string {
  const { event, profile } = episode;
  const amount = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(event.amountInr);
  const method = event.paymentMethod === "upi" ? "UPI" : event.paymentMethod === "card" ? "card" : "payment";
  const name = profile.customerId.slice(-4);

  const scripts = [
    `Namaste! Yeh RecoverOS calling from ${event.merchantId}. Aapka ${amount} ka ${method} payment fail ho gaya hai. Humne aapko ek secure payment link bheja hai. Kripya jaldi complete karein. Dhanyavaad.`,
    `Hello! Yahan se RecoverOS bol rahe hain. Aapka subscription payment of ${amount} fail hua hai. Koi baat nahi, humne link bhej diya hai. Aap easily pay kar sakte hain. Shukriya.`,
    `Hi! RecoverOS yahan. Aapka ${amount} ka recurring payment nahi hua. Payment method: ${method}. Humne aapko WhatsApp pe bhi link bheja hai. Please check karein. Thank you.`,
  ];

  return scripts[Math.floor(Math.random() * scripts.length)];
}

export async function generateElevenLabsAudio(text: string, voiceId = "21m00Tcm4TlvDq8ikWAM"): Promise<{ audioBase64: string; url: string } | null> {
  const apiKey = getElevenLabsKey();
  if (!apiKey) return null;

  try {
    const response = await fetch(`${ELEVENLABS_API}/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("ElevenLabs error:", err);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const url = `data:audio/mpeg;base64,${base64}`;
    return { audioBase64: base64, url };
  } catch (error) {
    console.error("ElevenLabs TTS failed:", error);
    return null;
  }
}

export async function executeVoiceCall(
  episode: RecoveryEpisode,
  recoveryStore: RecoveryStore,
  options: { provider?: VoiceProvider; promiseToPay?: { amount: number; dueBy: string } } = {}
): Promise<VoiceCallResult> {
  const callId = `call_${randomUUID()}`;
  const script = generateHinglishScript(episode);
  const provider = options.provider ?? "browser";

  if (provider === "elevenlabs") {
    const audio = await generateElevenLabsAudio(script);
    if (audio) {
      return { callId, status: "simulated", provider: "elevenlabs", audioUrl: audio.url, executedAt: new Date().toISOString() };
    }
  }

  if (provider === "browser") {
    return { callId, status: "simulated", provider: "browser", audioUrl: undefined, executedAt: new Date().toISOString() };
  }

  const twilio = getTwilioConfig();
  if (twilio && episode.profile.phone) {
    try {
      const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
      const twiml = `<Response><Say language="hi-IN">${script}</Say><Record maxLength="30" action="https://your-domain.com/webhook/voice-response" /></Response>`;
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Calls.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: episode.profile.phone, From: twilio.fromNumber, Twiml: twiml }),
      });
      const data = await response.json();
      if (data.sid) {
        return { callId, status: "initiated", provider: "twilio", callSid: data.sid, executedAt: new Date().toISOString() };
      }
    } catch (error) {
      console.error("Twilio call failed:", error);
    }
  }

  return { callId, status: "simulated", provider: "browser", error: "No voice provider configured, using browser simulation", executedAt: new Date().toISOString() };
}

export function createPromiseToPay(episode: RecoveryEpisode, amount: number, dueBy: string): PromiseToPay {
  return {
    promiseId: `promise_${randomUUID()}`,
    episodeId: episode.id,
    promisedAmountInr: amount,
    promisedAt: new Date().toISOString(),
    dueBy,
    status: "PENDING",
    customerAcknowledged: false,
  };
}

export function savePromiseToPay(recoveryStore: RecoveryStore, episodeId: string, promise: PromiseToPay) {
  const existing = recoveryStore.getPromises(episodeId);
  recoveryStore.savePromises(episodeId, [...existing, promise]);
}

export function getPromisesForEpisode(recoveryStore: RecoveryStore, episodeId: string): PromiseToPay[] {
  return recoveryStore.getPromises(episodeId);
}

export function evaluatePromiseToPay(recoveryStore: RecoveryStore, episodeId: string): PromiseToPay[] {
  const promises = recoveryStore.getPromises(episodeId);
  const now = new Date().toISOString();
  return promises.map((p) => {
    if (p.status !== "PENDING") return p;
    if (now > p.dueBy) return { ...p, status: "BROKEN" as const };
    return p;
  });
}
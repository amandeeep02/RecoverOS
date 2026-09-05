import { randomUUID } from "node:crypto";
import type { RecoveryEpisode } from "@/lib/domain";
import { RecoveryStore } from "@/lib/store";
import { formatInr } from "@/lib/domain";
import { checkVoiceCall, minimizeForAudit, runtimeComplianceConfig, type ComplianceConfig } from "@/lib/compliance";

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
  promisedAmountPaise: number;
  promisedAt: string;
  dueBy: string;
  status: "PENDING" | "FULFILLED" | "BROKEN" | "EXPIRED";
  customerAcknowledged: boolean;
  callId?: string;
}

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

/** Audio Twilio fetches mid-call via `/api/voice/audio/:id`. Keyed by call id; lives
 *  for the process, which is the lifetime of a demo call. */
const globalAudio = globalThis as unknown as { recoverOsVoiceAudio?: Map<string, Buffer> };
const voiceAudio = globalAudio.recoverOsVoiceAudio ?? (globalAudio.recoverOsVoiceAudio = new Map<string, Buffer>());
export function getCachedVoiceAudio(id: string): Buffer | undefined {
  return voiceAudio.get(id);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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
  const amount = formatInr(event.amountPaise);
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
  options: { provider?: VoiceProvider; promiseToPay?: { amount: number; dueBy: string }; nowIso?: string; complianceConfig?: ComplianceConfig } = {}
): Promise<VoiceCallResult> {
  const callId = `call_${randomUUID()}`;
  const nowIso = options.nowIso ?? new Date().toISOString();
  const complianceConfig = options.complianceConfig ?? runtimeComplianceConfig();

  // TRAI TCCCPR quiet hours + DPDP consent/opt-out gate. Checked before any
  // script is generated or provider contacted, so a non-compliant call is
  // refused rather than simulated-and-labelled-refused after the fact.
  const compliance = checkVoiceCall({
    nowIso,
    consentValid: episode.profile.consentValid,
    optedOut: episode.profile.optedOut,
    config: complianceConfig,
  });
  if (!compliance.allowed) {
    console.error(
      "Voice call refused by compliance gate:",
      minimizeForAudit({ episodeId: episode.id, phone: episode.profile.phone, violations: compliance.violations }),
    );
    return {
      callId,
      status: "failed",
      provider: "browser",
      error: `compliance_refused: ${compliance.violations.map((v) => v.code).join(",")}`,
      executedAt: nowIso,
    };
  }

  const script = generateHinglishScript(episode);
  const twilioReady = !!getTwilioConfig() && !!episode.profile.phone;
  const provider = options.provider ?? (twilioReady ? "twilio" : getElevenLabsKey() ? "elevenlabs" : "browser");

  if (provider === "elevenlabs") {
    const audio = await generateElevenLabsAudio(script);
    if (audio) {
      return { callId, status: "simulated", provider: "elevenlabs", audioUrl: audio.url, executedAt: nowIso };
    }
  }

  if (provider === "browser") {
    return { callId, status: "simulated", provider: "browser", audioUrl: undefined, executedAt: nowIso };
  }

  const twilio = getTwilioConfig();
  if (twilio && episode.profile.phone) {
    try {
      const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
      const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
      const question = "Kripya bataiye, payment fail kyun hua tha? Aap Hindi ya English mein jawab de sakte hain.";
      const say = (text: string) => `<Say voice="Polly.Aditi" language="hi-IN">${escapeXml(text)}</Say>`;
      let scriptTwiml = say(script);
      let questionTwiml = say(question);
      // ElevenLabs on the call itself: Twilio has to fetch the audio over the public
      // internet, so this needs both the key and a reachable base URL. Otherwise the
      // call still happens, in Twilio's Hindi voice.
      if (publicBase && getElevenLabsKey()) {
        const [scriptAudio, questionAudio] = await Promise.all([generateElevenLabsAudio(script), generateElevenLabsAudio(question)]);
        if (scriptAudio) {
          voiceAudio.set(callId, Buffer.from(scriptAudio.audioBase64, "base64"));
          scriptTwiml = `<Play>${publicBase}/api/voice/audio/${callId}</Play>`;
        }
        if (questionAudio) {
          voiceAudio.set(`${callId}-q`, Buffer.from(questionAudio.audioBase64, "base64"));
          questionTwiml = `<Play>${publicBase}/api/voice/audio/${callId}-q</Play>`;
        }
      }
      // The spoken answer can only come back if Twilio can reach us. `actionOnEmptyResult`
      // posts even silence, so the episode always records that the question was asked.
      const gather = publicBase
        ? `<Pause length="1"/><Gather input="speech" language="en-IN" speechTimeout="auto" actionOnEmptyResult="true" action="${publicBase}/api/voice/collect" method="POST">${questionTwiml}</Gather>${say("Dhanyavaad. Hum aapko WhatsApp par payment link bhejenge. Alvida.")}`
        : "";
      const twiml = `<Response>${scriptTwiml}${gather}</Response>`;
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Calls.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: episode.profile.phone, From: twilio.fromNumber, Twiml: twiml }),
      });
      const data = await response.json();
      if (data.sid) {
        return { callId, status: "initiated", provider: "twilio", callSid: data.sid, executedAt: nowIso };
      }
      console.error("Twilio call rejected:", data.code, data.message);
    } catch (error) {
      console.error("Twilio call failed:", error);
    }
  }

  return { callId, status: "simulated", provider: "browser", error: "No voice provider configured, using browser simulation", executedAt: nowIso };
}

export function createPromiseToPay(episode: RecoveryEpisode, amountPaise: number, dueBy: string): PromiseToPay {
  return {
    promiseId: `promise_${randomUUID()}`,
    episodeId: episode.id,
    promisedAmountPaise: amountPaise,
    promisedAt: new Date().toISOString(),
    dueBy,
    status: "PENDING",
    customerAcknowledged: false,
  };
}

export async function savePromiseToPay(recoveryStore: RecoveryStore, episodeId: string, promise: PromiseToPay) {
  const existing = await recoveryStore.getPromises(episodeId);
  await recoveryStore.savePromises(episodeId, [...existing, promise]);
}

export async function getPromisesForEpisode(recoveryStore: RecoveryStore, episodeId: string): Promise<PromiseToPay[]> {
  return recoveryStore.getPromises(episodeId);
}

export async function evaluatePromiseToPay(recoveryStore: RecoveryStore, episodeId: string): Promise<PromiseToPay[]> {
  const promises = await recoveryStore.getPromises(episodeId);
  const now = new Date().toISOString();
  return promises.map((p) => {
    if (p.status !== "PENDING") return p;
    if (now > p.dueBy) return { ...p, status: "BROKEN" as const };
    return p;
  });
}
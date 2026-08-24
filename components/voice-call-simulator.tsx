"use client";

import { useState, useRef, useEffect } from "react";
import type { RecoveryEpisode } from "@/lib/domain";
import { formatInr } from "@/lib/domain";

interface VoiceCallSimulatorProps {
  episode: RecoveryEpisode;
  onClose: () => void;
}

export function VoiceCallSimulator({ episode, onClose }: VoiceCallSimulatorProps) {
  const [stage, setStage] = useState<"idle" | "dialing" | "connected" | "recording" | "completed">("idle");
  const [transcript, setTranscript] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentScript, setCurrentScript] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const script = generateHinglishScript(episode);

  useEffect(() => {
    if (stage === "dialing") {
      setCurrentScript(script);
      timerRef.current = setTimeout(() => {
        setStage("connected");
        playAudio(script);
      }, 1500);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [stage, script]);

  const playAudio = async (text: string) => {
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        audioRef.current = new Audio(url);
        audioRef.current.play();
      } else {
        speakBrowser(text);
      }
    } catch {
      speakBrowser(text);
    }
  };

  const speakBrowser = (text: string) => {
    if ("speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "hi-IN";
      utterance.rate = 0.95;
      speechSynthesis.speak(utterance);
    }
  };

  const startCall = () => setStage("dialing");

  const simulateCustomerResponse = () => {
    setStage("recording");
    const responses = [
      "Ji, main kal payment kar dunga. Link bhej do.",
      "Haan, abhi card update karta hoon.",
      "Sorry, balance nahi tha. Friday tak ho jayega.",
      "Payment fail kyun hua? Main check karta hoon.",
    ];
    const response = responses[Math.floor(Math.random() * responses.length)];
    setTranscript(response);
    timerRef.current = setTimeout(() => setStage("completed"), 2000);
  };

  const endCall = () => {
    if (audioRef.current) audioRef.current.pause();
    onClose();
  };

  return (
    <div className="voice-modal-overlay" onClick={endCall}>
      <div className="voice-modal" onClick={(e) => e.stopPropagation()}>
        <div className="voice-header">
          <div className="caller-info">
            <div className="avatar">🤖</div>
            <div>
              <strong>RecoverOS Voice Agent</strong>
              <small>Calling {episode.event.customerId} · {formatInr(episode.event.amountInr)}</small>
            </div>
          </div>
          <button className="end-call-btn" onClick={endCall}>✕</button>
        </div>

        <div className={`voice-content ${stage}`}>
          {stage === "idle" && (
            <div className="idle-state">
              <div className="waveform"></div>
              <p>Ready to place Hinglish voice call</p>
              <pre className="script-preview">{script}</pre>
              <button className="primary-btn" onClick={startCall}>
                📞 Initiate Call
              </button>
            </div>
          )}

          {stage === "dialing" && (
            <div className="dialing-state">
              <div className="dialing-animation">
                <span></span><span></span><span></span><span></span>
              </div>
              <p>Dialing {episode.profile.phone || "customer"}…</p>
            </div>
          )}

          {stage === "connected" && (
            <div className="connected-state">
              <div className="waveform active" />
              <p className="script-text">" {currentScript} "</p>
              <div className="call-controls">
                <button className="secondary-btn" onClick={simulateCustomerResponse}>
                  🎙️ Simulate Customer Response
                </button>
                <button className="end-btn" onClick={endCall}>End Call</button>
              </div>
            </div>
          )}

          {stage === "recording" && (
            <div className="recording-state">
              <div className="recording-indicator">🔴 RECORDING</div>
              <p className="transcript">Customer: "{transcript}"</p>
              <p className="promise-note">✅ Promise-to-pay captured: Friday</p>
            </div>
          )}

          {stage === "completed" && (
            <div className="completed-state">
              <div className="success-icon">✅</div>
              <h3>Call Completed</h3>
              <p>Promise-to-pay recorded. Follow-up scheduled for Friday.</p>
              <div className="call-summary">
                <div><strong>Duration:</strong> 42s</div>
                <div><strong>Outcome:</strong> Promise to pay</div>
                <div><strong>Follow-up:</strong> Friday 10 AM</div>
              </div>
              <button className="primary-btn" onClick={endCall}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function generateHinglishScript(episode: RecoveryEpisode): string {
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
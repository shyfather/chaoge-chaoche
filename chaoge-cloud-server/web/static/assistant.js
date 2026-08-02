"use strict";
const SAMPLE_RATE = 16000;
const WS_URL = (() => {
  const p = new URLSearchParams(location.search);
  const s = p.get("server");
  if (s) return s;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
})();
const els = {
  status: document.getElementById("status"),
  canvas: document.getElementById("avatar-canvas"),
  personaBar: document.getElementById("persona-bar"),
  transcript: document.getElementById("transcript"),
  micBtn: document.getElementById("mic-btn"),
  camToggle: document.getElementById("cam-toggle"),
  camWrap: document.getElementById("cam-wrap"),
  camVideo: document.getElementById("user-cam"),
  camFallback: document.getElementById("cam-fallback"),
  avatarWrap: document.querySelector(".avatar-wrap"),
  avatarState: document.getElementById("avatar-state"),
  avatarLabel: document.getElementById("avatar-label"),
  apiIndicator: document.getElementById("api-indicator"),
};
let ws = null, mic = null, player = null, personas = [], currentPersona = null, assistantLine = null;
let isSpeaking = false, isThinking = false, camOn = false, camStream = null;
const W = 512, H = 512;
const ctx = els.canvas.getContext("2d", { alpha: false, desynchronized: true });
ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
const avatarImg = new Image();
let avatarLoaded = false, blinkState = 0, blinkTimer = 0, mouthOpen = 0, mouthTarget = 0, expression = "neutral", audioEnergy = 0, audioEnergySmooth = 0, animFrame = null;
avatarImg.src = "static/avatar.jpg";
avatarImg.onload = () => { avatarLoaded = true; startAnimLoop(); };
avatarImg.onerror = () => { avatarLoaded = false; startAnimLoop(); };
function startAnimLoop() { if (animFrame) return; const loop = () => { animFrame = requestAnimationFrame(loop); drawFrame(); updateAnimState(); }; animFrame = requestAnimationFrame(loop); }
function updateAnimState() {
  blinkTimer++;
  if (blinkState === 0 && blinkTimer > 180 + Math.random() * 180) { blinkState = 1; blinkTimer = 0; }
  else if (blinkState === 1 && blinkTimer > 3) { blinkState = 2; blinkTimer = 0; }
  else if (blinkState === 2 && blinkTimer > 2) { blinkState = 0; blinkTimer = 0; }
  audioEnergySmooth += (audioEnergy - audioEnergySmooth) * 0.15;
  mouthTarget = isSpeaking ? Math.min(1, audioEnergySmooth * 2.5 + 0.2) : 0;
  mouthOpen += (mouthTarget - mouthOpen) * 0.2;
  if (isThinking) expression = "thinking"; else if (isSpeaking) expression = "happy"; else expression = "neutral";
}
function drawFrame() {
  ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, W, H);
  if (avatarLoaded && avatarImg.complete && avatarImg.naturalWidth > 0) {
    const size = Math.min(W, H) * 0.9, cx = W / 2, cy = H / 2 - 10, s = size / 2;
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, s, 0, Math.PI * 2); ctx.clip();
    const scale = Math.max(size / avatarImg.naturalWidth, size / avatarImg.naturalHeight);
    const dx = cx - (avatarImg.naturalWidth * scale) / 2, dy = cy - (avatarImg.naturalHeight * scale) / 2;
    ctx.drawImage(avatarImg, dx, dy, avatarImg.naturalWidth * scale, avatarImg.naturalHeight * scale);
    ctx.restore();
    const imgScale = Math.max(size / avatarImg.naturalWidth, size / avatarImg.naturalHeight);
    const imgW = avatarImg.naturalWidth * imgScale, imgH = avatarImg.naturalHeight * imgScale;
    const imgX = cx - imgW / 2, imgY = cy - imgH / 2;
    const eyeY = imgY + imgH * 0.38, eyeSpacing = imgW * 0.22, mouthY = imgY + imgH * 0.68;
    if (blinkState !== 0) {
      const eyeH = blinkState === 1 ? imgH * 0.06 : imgH * 0.03;
      ctx.fillStyle = "#0d1117";
      ctx.fillRect(cx - eyeSpacing - imgW * 0.07, eyeY - eyeH / 2, imgW * 0.14, eyeH);
      ctx.fillRect(cx + eyeSpacing - imgW * 0.07, eyeY - eyeH / 2, imgW * 0.14, eyeH);
    }
    if (mouthOpen > 0.05) {
      const mw = imgW * 0.12 + mouthOpen * imgW * 0.08, mh = mouthOpen * imgH * 0.08;
      ctx.fillStyle = "#1a0a0a";
      ctx.beginPath(); ctx.ellipse(cx, mouthY + mh * 0.3, mw / 2, mh / 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#f0f0f0";
      ctx.beginPath(); ctx.ellipse(cx, mouthY - mh * 0.15, mw * 0.35, mh * 0.2, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (expression === "thinking") {
      ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx - eyeSpacing - imgW * 0.04, eyeY - imgH * 0.06);
      ctx.lineTo(cx - eyeSpacing + imgW * 0.04, eyeY - imgH * 0.03);
      ctx.moveTo(cx + eyeSpacing - imgW * 0.04, eyeY - imgH * 0.03);
      ctx.lineTo(cx + eyeSpacing + imgW * 0.04, eyeY - imgH * 0.06);
      ctx.stroke();
    }
  } else { drawFallbackAvatar(); }
}
function drawFallbackAvatar() {
  const cx = W / 2, cy = H / 2 - 10;
  ctx.fillStyle = "#d4a574"; ctx.beginPath(); ctx.arc(cx, cy, 200, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#2a2a2a"; ctx.beginPath(); ctx.ellipse(cx, cy - 110, 170, 80, 0, Math.PI, 0); ctx.fill();
  const eyeY = cy - 30, eyeSpacing = 55;
  if (blinkState === 0) {
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.ellipse(cx - eyeSpacing, eyeY, 25, 22, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + eyeSpacing, eyeY, 25, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#3a2a1a"; ctx.beginPath(); ctx.arc(cx - eyeSpacing, eyeY, 12, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + eyeSpacing, eyeY, 12, 0, Math.PI * 2); ctx.fill();
  } else {
    const eyeH = blinkState === 1 ? 12 : 6;
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(cx - eyeSpacing - 25, eyeY - eyeH / 2, 50, eyeH);
    ctx.fillRect(cx + eyeSpacing - 25, eyeY - eyeH / 2, 50, eyeH);
  }
  if (mouthOpen > 0.05) {
    const mw = 30 + mouthOpen * 20, mh = mouthOpen * 20;
    ctx.fillStyle = "#1a0a0a"; ctx.beginPath(); ctx.ellipse(cx, cy + 60 + mh * 0.3, mw / 2, mh / 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f0f0f0"; ctx.beginPath(); ctx.ellipse(cx, cy + 60 - mh * 0.15, mw * 0.35, mh * 0.2, 0, 0, Math.PI * 2); ctx.fill();
  }
}
function floatTo16BitPCM(float32) { const int16 = new Int16Array(float32.length); for (let i = 0; i < float32.length; i++) { const s = Math.max(-1, Math.min(1, float32[i])); int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return int16; }
function base64FromInt16(int16) { const bytes = new Uint8Array(int16.buffer); let binary = ""; for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]); return btoa(binary); }
function int16FromBase64(b64) { const binary = atob(b64); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return new Int16Array(bytes.buffer); }
function ensurePlayer() { if (!player) { player = { ctx: new AudioContext({ sampleRate: SAMPLE_RATE }), nextStartTime: 0 }; } if (player.ctx.state === "suspended") player.ctx.resume(); return player; }
function playPCM(int16) {
  const p = ensurePlayer();
  const buf = p.ctx.createBuffer(1, int16.length, SAMPLE_RATE);
  const data = buf.getChannelData(0);
  for (let i = 0; i < int16.length; i++) data[i] = int16[i] / 0x8000;
  const src = p.ctx.createBufferSource();
  src.buffer = buf; src.connect(p.ctx.destination);
  const start = Math.max(p.ctx.currentTime + 0.02, p.nextStartTime);
  src.start(start);
  p.nextStartTime = start + buf.duration;
}
function flushPlayback() { if (player) { player.ctx.close(); player = null; } }
const WORKLET_SRC = `class PCMCapture extends AudioWorkletProcessor { process(inputs) { const input = inputs[0]; if (input && input[0] && input[0].length > 0) { this.port.postMessage(input[0].slice(0)); } return true; } } registerProcessor("pcm-capture", PCMCapture);`;
async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" })));
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  node.port.onmessage = (e) => { if (ws && ws.readyState === WebSocket.OPEN) { const int16 = floatTo16BitPCM(e.data); ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64FromInt16(int16) })); } };
  source.connect(node);
  const gain = ctx.createGain(); gain.gain.value = 0;
  node.connect(gain); gain.connect(ctx.destination);
  mic = { ctx, stream, node };
}
function stopMic() { if (!mic) return; mic.node.disconnect(); mic.stream.getTracks().forEach(t => t.stop()); mic.ctx.close(); mic = null; }
function addLine(cls, who, text) {
  const div = document.createElement("div"); div.className = `line ${cls}`;
  if (who) { const span = document.createElement("span"); span.className = "who"; span.textContent = who; div.appendChild(span); }
  div.appendChild(document.createTextNode(text));
  els.transcript.appendChild(div); els.transcript.scrollTop = els.transcript.scrollHeight;
  return div;
}
function appendAssistantDelta(delta) {
  if (!assistantLine) { const name = (personas.find(p => p.id === currentPersona) || {}).name || "助手"; assistantLine = addLine("assistant", `${name}:`, ""); }
  assistantLine.appendChild(document.createTextNode(delta));
  els.transcript.scrollTop = els.transcript.scrollHeight;
}
function setStatus(text, cls) { els.status.textContent = text; els.status.className = `status ${cls || ""}`; }
function setAvatarState(state) { const labels = { idle: "待机中", listening: "聆听中", thinking: "思考中", speaking: "说话中" }; els.avatarState.textContent = labels[state] || state; els.avatarState.className = `avatar-state ${state}`; }
function updatePersonaBar() {
  els.personaBar.innerHTML = "";
  for (const p of personas) {
    const chip = document.createElement("button");
    chip.className = "persona-chip" + (p.id === currentPersona ? " active" : "");
    chip.textContent = p.name;
    chip.onclick = () => switchPersona(p.id);
    els.personaBar.appendChild(chip);
  }
}
function switchPersona(id) { if (!ws || ws.readyState !== WebSocket.OPEN || id === currentPersona) return; ws.send(JSON.stringify({ type: "vox.persona", persona: id })); currentPersona = id; assistantLine = null; updatePersonaBar(); }
function handleEvent(event) {
  switch (event.type) {
    case "vox.status":
      setStatus(event.status, event.status === "connected" || event.status === "idle" ? "live" : event.status === "error" ? "danger" : "warn");
      if (event.status === "connected") { currentPersona = event.persona; updatePersonaBar(); }
      if (event.status === "connected" || event.status === "idle") setAvatarState("idle");
      else if (event.status === "listening" || event.status === "transcribing") setAvatarState("listening");
      else if (event.status === "thinking") { setAvatarState("thinking"); isThinking = true; }
      else if (event.status === "speaking") { setAvatarState("speaking"); isSpeaking = true; isThinking = false; }
      else if (event.status === "error") setAvatarState("idle");
      break;
    case "vox.persona": currentPersona = event.persona.id; updatePersonaBar(); break;
    case "input_audio_buffer.speech_started": flushPlayback(); assistantLine = null; isSpeaking = false; setAvatarState("listening"); break;
    case "response.output_audio_transcript.delta": if (event.delta) appendAssistantDelta(event.delta); break;
    case "response.output_audio.delta":
      if (event.delta) {
        playPCM(int16FromBase64(event.delta));
        const samples = int16FromBase64(event.delta); let sum = 0; for (let i = 0; i < samples.length; i++) sum += Math.abs(samples[i]);
        audioEnergy = sum / samples.length / 32768;
      }
      break;
    case "response.done": assistantLine = null; isSpeaking = false; isThinking = false; audioEnergy = 0; if (!event.interrupted) setAvatarState("idle"); break;
    case "conversation.item.input_audio_transcription.completed": { const text = (event.transcript || "").trim(); if (text) addLine("user", "你:", text); break; }
    case "response.cancel": flushPlayback(); assistantLine = null; isSpeaking = false; isThinking = false; audioEnergy = 0; setAvatarState("idle"); break;
  }
}
function connectWS() {
  if (ws) try { ws.close(); } catch (_) {}
  try { ws = new WebSocket(WS_URL); } catch (_) { setStatus("连接失败", "danger"); if (els.apiIndicator) els.apiIndicator.textContent = "WS · 失败"; setTimeout(connectWS, 3000); return; }
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    setStatus("已连接", "live"); if (els.apiIndicator) els.apiIndicator.textContent = "WS · 已连接";
    els.micBtn.disabled = false; setAvatarState("idle"); addLine("sys", "", "已连接到云端服务器，点击开始对话");
    const overlay = document.getElementById("overlay"); if (overlay) overlay.classList.add("hidden");
  };
  ws.onclose = () => { setStatus("已断开", "warn"); els.micBtn.disabled = true; setAvatarState("idle"); if (els.apiIndicator) els.apiIndicator.textContent = "WS · 断开"; setTimeout(connectWS, 3000); };
  ws.onerror = () => { setStatus("连接错误", "warn"); if (els.apiIndicator) els.apiIndicator.textContent = "WS · 错误"; };
  ws.onmessage = (msg) => { if (typeof msg.data === "string") handleEvent(JSON.parse(msg.data)); };
}
async function init() {
  try {
    const res = await fetch("api/personas");
    const data = await res.json();
    personas = data.list || [];
    currentPersona = data.default || "chaoge";
    updatePersonaBar();
  } catch (e) {
    personas = [{ id: "chaoge", name: "超哥超车", description: "汽车博主" }];
    currentPersona = "chaoge";
    updatePersonaBar();
  }
  connectWS();
}
async function toggleCam() {
  if (camOn) {
    camStream.getTracks().forEach(t => t.stop()); camStream = null; camOn = false;
    els.camToggle.textContent = "📷 摄像头"; els.camToggle.classList.remove("on"); els.camWrap.classList.remove("live"); els.camVideo.srcObject = null;
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } });
    camStream = stream; camOn = true; els.camVideo.srcObject = stream;
    els.camToggle.textContent = "📷 关闭摄像头"; els.camToggle.classList.add("on"); els.camWrap.classList.add("live");
  } catch (e) { addLine("sys", "", `⚠ 摄像头不可用: ${e.message}`); }
}
els.camToggle.onclick = toggleCam;
document.addEventListener("keydown", (e) => {
  if (e.key === "m" || e.key === "M") els.micBtn.click();
  else if (e.key === "c" || e.key === "C") els.camToggle.click();
  else if (e.key === "Escape" && mic) { stopMic(); els.micBtn.textContent = "🎙 开始对话"; els.micBtn.classList.remove("live"); setStatus("已连接", "live"); setAvatarState("idle"); }
});
els.micBtn.onclick = async () => {
  if (mic) { stopMic(); els.micBtn.textContent = "🎙 开始对话"; els.micBtn.classList.remove("live"); setStatus("已连接", "live"); setAvatarState("idle"); return; }
  try {
    await startMic();
    els.micBtn.textContent = "■ 结束对话"; els.micBtn.classList.add("live");
    setStatus("聆听中", "live"); setAvatarState("listening");
  } catch (e) { addLine("sys", "", `⚠ 麦克风不可用: ${e.message}`); }
};
document.addEventListener("DOMContentLoaded", () => {
  const startBtn = document.getElementById("start-btn");
  if (startBtn) { startBtn.textContent = "连接中..."; startBtn.disabled = true; }
});
init();
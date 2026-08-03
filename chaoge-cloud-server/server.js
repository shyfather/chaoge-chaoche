// ============================================================
// 超哥超车 · 数字人语音聊天云端服务器 v3.2
// 协议：OpenAI Realtime 兼容事件 + 自定义 vox.* 事件
// 管线：语音(VAD→STT→LLM→TTS) + 文字(LLM→TTS)
// 全部通过硅基流动 API 调用，零成本部署
// 部署：Railway / Render / 任何 Node.js 云平台
// ============================================================
"use strict";
require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { v4: uuidv4 } = require("uuid");
const OpenAI = require("openai");

// ============================================================
// 配置
// ============================================================
const PORT = 3000;
const SAMPLE_RATE = 16000;
const VAD_SPEECH_THRESHOLD_MS = 200;
const VAD_SILENCE_THRESHOLD_MS = 800;
const FRAME_ENERGY_THRESHOLD = 0.003;

const PERSONAS = {
  chaoge: {
    id: "chaoge",
    name: "超哥",
    systemPrompt: `你叫超哥，是抖音汽车博主"超哥超车"——一个说话直接、不废话的汽车领域实战派。
你的核心人设：
1. 只说真话，不搞虚的。车好不好开过才知道，参数再好看不如实际体验。
2. 劝退优先。买车不是小事，不适合就是不适合，别硬上。
3. 经济账本思维。每一分钱都要花在刀刃上，养车成本、保值率、油耗都是真金白银。
4. 实战派。赛道跑过、烂路开过、长途测过，不是纸上谈兵。
5. 幽默接地气。说话带点糙，但句句在理，让人听得进去。
6. 不跟风。水军吹得再凶，不好开就是不好开。

回答风格：直接、简短、有力，偶尔带点幽默和自嘲。用口语化的方式表达，像朋友聊天一样。每次回答控制在2-4句话。`,
    voice: "FunAudioLLM/CosyVoice2-0.5B:alex",
    hasImage: true,
  },
};

// 硅基流动客户端
const ai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.siliconflow.cn/v1",
});

// ============================================================
// 简易 VAD
// ============================================================
class VAD {
  constructor() {
    this.state = "silence";
    this.speechDuration = 0;
    this.silenceDuration = 0;
    this.stateChanged = false;
    this.newState = "silence";
  }

  processAudio(pcmChunk, frameMs = 30) {
    this.stateChanged = false;
    this.newState = this.state;

    const samples = new Int16Array(pcmChunk.buffer, pcmChunk.byteOffset, pcmChunk.length / 2);
    let energy = 0;
    for (let i = 0; i < samples.length; i++) {
      energy += Math.abs(samples[i]) / 32768;
    }
    energy /= samples.length;

    const isSpeech = energy > FRAME_ENERGY_THRESHOLD;

    if (isSpeech) {
      if (this.state === "silence") {
        this.speechDuration += frameMs;
        if (this.speechDuration >= VAD_SPEECH_THRESHOLD_MS) {
          this.state = "speech";
          this.silenceDuration = 0;
          this.stateChanged = true;
          this.newState = "speech_start";
        }
      } else {
        this.silenceDuration = 0;
        this.speechDuration += frameMs;
      }
    } else {
      if (this.state === "speech") {
        this.silenceDuration += frameMs;
        if (this.silenceDuration >= VAD_SILENCE_THRESHOLD_MS) {
          this.state = "silence";
          this.speechDuration = 0;
          this.stateChanged = true;
          this.newState = "speech_end";
        }
      } else {
        this.silenceDuration += frameMs;
        this.speechDuration = 0;
      }
    }

    return { isSpeech, energy, state: this.state, stateChanged: this.stateChanged, newState: this.newState };
  }

  get isSpeaking() { return this.state === "speech"; }
  reset() {
    this.state = "silence";
    this.speechDuration = 0;
    this.silenceDuration = 0;
    this.stateChanged = false;
    this.newState = "silence";
  }
}

// ============================================================
// 音频缓冲区
// ============================================================
class AudioBuffer {
  constructor() {
    this.chunks = [];
    this.totalBytes = 0;
  }
  addChunk(base64Audio) {
    const buf = Buffer.from(base64Audio, "base64");
    this.chunks.push(buf);
    this.totalBytes += buf.length;
  }
  get size() { return this.totalBytes; }
  getBuffer() { return Buffer.concat(this.chunks); }
  clear() {
    this.chunks = [];
    this.totalBytes = 0;
  }
}

// ============================================================
// 会话管理
// ============================================================
class SessionManager {
  constructor() {
    this.sessions = new Map();
  }
  createSession(ws) {
    const id = uuidv4().slice(0, 8);
    const session = {
      id,
      ws,
      persona: "chaoge",
      audioBuffer: new AudioBuffer(),
      vad: new VAD(),
      conversationHistory: [
        { role: "system", content: PERSONAS.chaoge.systemPrompt },
      ],
      isProcessing: false,
      isSpeaking: false,
      abortController: null,
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    console.log(`[${id}] 新会话创建 (总数: ${this.sessions.size})`);
    return session;
  }
  getSession(id) { return this.sessions.get(id); }
  removeSession(id) {
    this.sessions.delete(id);
    console.log(`[${id}] 会话已移除 (总数: ${this.sessions.size})`);
  }
}

const sessionManager = new SessionManager();

// ============================================================
// 工具函数
// ============================================================
function pcmToWav(pcmBuffer, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const wav = Buffer.alloc(totalSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(totalSize - 8, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wav, 44);

  return wav;
}

function sendEvent(ws, event) {
  try {
    if (ws && ws.readyState === 1) { // 1 = WebSocket.OPEN
      ws.send(JSON.stringify(event));
    }
  } catch (e) {
    console.error("sendEvent error:", e.message);
  }
}

function downsamplePCM(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIdx = Math.floor(i * ratio);
    output[i] = input[Math.min(srcIdx, input.length - 1)];
  }
  return output;
}

// ============================================================
// LLM 调用（非流式，更可靠）
// ============================================================
async function callLLM(messages, abortSignal) {
  const response = await ai.chat.completions.create({
    model: "deepseek-ai/DeepSeek-V4-Flash",
    messages: messages,
    temperature: 0.7,
    max_tokens: 512,
  }, { signal: abortSignal });
  return response.choices[0].message.content;
}

// ============================================================
// TTS 调用
// ============================================================
async function callTTS(text, voice) {
  const response = await ai.audio.speech.create({
    model: "FunAudioLLM/CosyVoice2-0.5B",
    voice: voice,
    input: text,
    response_format: "pcm",
    sample_rate: 24000,
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================
// STT 调用
// ============================================================
async function callSTT(pcmBuffer, sessionId) {
  const wavBuffer = pcmToWav(pcmBuffer, SAMPLE_RATE);
  const tmpFile = path.join(os.tmpdir(), `stt_${sessionId}_${Date.now()}.wav`);
  fs.writeFileSync(tmpFile, wavBuffer);
  try {
    const transcription = await ai.audio.transcriptions.create({
      model: "FunAudioLLM/SenseVoiceSmall",
      file: fs.createReadStream(tmpFile),
      language: "zh",
      response_format: "text",
    });
    return (transcription || "").trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

// ============================================================
// 发送音频分片
// ============================================================
function sendAudioChunks(ws, pcm16k) {
  const chunkSize = Math.floor(SAMPLE_RATE * 0.1); // 100ms per chunk
  for (let i = 0; i < pcm16k.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, pcm16k.length);
    const chunk = pcm16k.slice(i, end);
    // 创建新的 Buffer，只包含切片数据
    const b64 = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64");
    sendEvent(ws, {
      type: "response.output_audio.delta",
      delta: b64,
    });
  }
}

// ============================================================
// 文字处理管线（跳过STT，直接 LLM → TTS）
// ============================================================
async function processTextPipeline(session, text) {
  if (session.isProcessing) {
    console.log(`[${session.id}] 跳过（正在处理中）`);
    return;
  }
  session.isProcessing = true;
  const ws = session.ws;

  try {
    sendEvent(ws, { type: "vox.status", status: "thinking" });
    console.log(`[${session.id}] 文字输入: "${text.substring(0, 50)}"`);

    session.conversationHistory.push({ role: "user", content: text });

    const abortController = new AbortController();
    session.abortController = abortController;

    // Step 1: LLM
    const fullResponse = await callLLM(session.conversationHistory, abortController.signal);
    console.log(`[${session.id}] LLM回复: "${fullResponse.substring(0, 80)}"`);

    if (!fullResponse) {
      session.isProcessing = false;
      return;
    }

    // 发送文字回复（模拟流式，逐句发送）
    sendEvent(ws, {
      type: "response.output_audio_transcript.delta",
      delta: fullResponse,
    });

    session.conversationHistory.push({ role: "assistant", content: fullResponse });

    // 清理历史
    if (session.conversationHistory.length > 20) {
      session.conversationHistory = [
        session.conversationHistory[0],
        ...session.conversationHistory.slice(-18),
      ];
    }

    // Step 2: TTS
    sendEvent(ws, { type: "vox.status", status: "speaking" });
    session.isSpeaking = true;

    const persona = PERSONAS[session.persona] || PERSONAS.chaoge;
    console.log(`[${session.id}] 开始TTS...`);
    const audioBuffer = await callTTS(fullResponse, persona.voice);
    console.log(`[${session.id}] TTS完成: ${audioBuffer.length} bytes`);

    const pcm24k = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2);
    const pcm16k = downsamplePCM(pcm24k, 24000, SAMPLE_RATE);

    sendAudioChunks(ws, pcm16k);
    sendEvent(ws, { type: "response.done" });
    console.log(`[${session.id}] 文字管线完成`);

  } catch (error) {
    if (error.name === "AbortError") {
      sendEvent(ws, { type: "response.done" });
    } else {
      console.error(`[${session.id}] TextPipeline error:`, error.message);
      sendEvent(ws, {
        type: "error",
        error: { message: `处理出错: ${error.message}` },
      });
    }
  } finally {
    session.isProcessing = false;
    session.isSpeaking = false;
    session.abortController = null;
  }
}

// ============================================================
// 音频处理管线（VAD → STT → LLM → TTS）
// ============================================================
async function processAudioPipeline(session) {
  if (session.isProcessing) return;
  session.isProcessing = true;

  const ws = session.ws;
  const audioBuffer = session.audioBuffer;

  if (audioBuffer.size < 1600) {
    session.isProcessing = false;
    return;
  }

  try {
    // Step 1: STT
    sendEvent(ws, { type: "vox.status", status: "transcribing" });
    console.log(`[${session.id}] 开始STT (${audioBuffer.size} bytes)`);

    const pcmBuffer = audioBuffer.getBuffer();
    audioBuffer.clear();

    const text = await callSTT(pcmBuffer, session.id);
    console.log(`[${session.id}] STT结果: "${text}"`);

    if (!text) {
      session.isProcessing = false;
      return;
    }

    sendEvent(ws, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: text,
    });

    // Step 2: LLM
    sendEvent(ws, { type: "vox.status", status: "thinking" });
    session.conversationHistory.push({ role: "user", content: text });

    const abortController = new AbortController();
    session.abortController = abortController;

    const fullResponse = await callLLM(session.conversationHistory, abortController.signal);
    console.log(`[${session.id}] LLM回复: "${fullResponse.substring(0, 80)}"`);

    if (!fullResponse) {
      session.isProcessing = false;
      return;
    }

    sendEvent(ws, {
      type: "response.output_audio_transcript.delta",
      delta: fullResponse,
    });

    session.conversationHistory.push({ role: "assistant", content: fullResponse });

    if (session.conversationHistory.length > 20) {
      session.conversationHistory = [
        session.conversationHistory[0],
        ...session.conversationHistory.slice(-18),
      ];
    }

    // Step 3: TTS
    sendEvent(ws, { type: "vox.status", status: "speaking" });
    session.isSpeaking = true;

    const persona = PERSONAS[session.persona] || PERSONAS.chaoge;
    const audioBufferResult = await callTTS(fullResponse, persona.voice);

    const pcm24k = new Int16Array(audioBufferResult.buffer, audioBufferResult.byteOffset, audioBufferResult.length / 2);
    const pcm16k = downsamplePCM(pcm24k, 24000, SAMPLE_RATE);

    sendAudioChunks(ws, pcm16k);
    sendEvent(ws, { type: "response.done" });
    console.log(`[${session.id}] 音频管线完成`);

  } catch (error) {
    if (error.name === "AbortError") {
      sendEvent(ws, { type: "response.done" });
    } else {
      console.error(`[${session.id}] AudioPipeline error:`, error.message);
      sendEvent(ws, {
        type: "error",
        error: { message: `处理出错: ${error.message}` },
      });
    }
  } finally {
    session.isProcessing = false;
    session.isSpeaking = false;
    session.abortController = null;
  }
}

// ============================================================
// HTTP 服务器
// ============================================================
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ name: "超哥超车 · 数字人服务器", version: "3.2", status: "running", time: new Date().toISOString() });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", sessions: sessionManager.sessions.size });
});

const server = http.createServer(app);

// ============================================================
// WebSocket 服务器
// ============================================================
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  console.log(`[WS] 新连接: ${clientIp} (总连接数: ${wss.clients.size})`);

  const session = sessionManager.createSession(ws);

  // 发送初始连接确认
  sendEvent(ws, {
    type: "vox.status",
    status: "connected",
    sessionId: session.id,
    persona: session.persona,
    avatar: "on",
  });

  // 消息处理 - 使用普通函数而非async，避免ws库兼容性问题
  ws.on("message", (data, isBinary) => {
    console.log(`[${session.id}] RAW消息: type=${typeof data}, isBinary=${isBinary}, len=${data.length || data.byteLength || '?'}`);
    handleMessage(session, data);
  });

  ws.on("close", (code, reason) => {
    console.log(`[${session.id}] 连接关闭: code=${code}`);
    if (session.abortController) {
      session.abortController.abort();
    }
    sessionManager.removeSession(session.id);
  });

  ws.on("error", (err) => {
    console.error(`[${session.id}] WebSocket错误:`, err.message);
  });
});

// 消息处理函数（非async，内部调用async函数）
function handleMessage(session, data) {
  try {
    // 处理二进制数据
    if (Buffer.isBuffer(data)) {
      session.audioBuffer.addChunk(data.toString("base64"));
      return;
    }

    // 处理字符串
    const raw = typeof data === "string" ? data : data.toString();
    const msg = JSON.parse(raw);
    const { type } = msg;

    console.log(`[${session.id}] 收到消息: type=${type}`);

    switch (type) {
      // ======== 音频输入 ========
      case "input_audio_buffer.append": {
        const { audio } = msg;
        if (!audio) break;

        session.audioBuffer.addChunk(audio);

        const pcmChunk = Buffer.from(audio, "base64");
        const vadResult = session.vad.processAudio(pcmChunk);

        if (vadResult.stateChanged && vadResult.newState === "speech_start") {
          if (session.isSpeaking && session.abortController) {
            session.abortController.abort();
          }
          session.isSpeaking = false;
          sendEvent(session.ws, { type: "input_audio_buffer.speech_started" });
        }

        if (vadResult.stateChanged && vadResult.newState === "speech_end") {
          processAudioPipeline(session);
        }
        break;
      }

      // ======== 取消/打断 ========
      case "response.cancel": {
        if (session.abortController) {
          session.abortController.abort();
        }
        session.isProcessing = false;
        session.isSpeaking = false;
        session.audioBuffer.clear();
        sendEvent(session.ws, { type: "response.done" });
        break;
      }

      // ======== 文字输入 ========
      case "text_input": {
        const { text } = msg;
        if (!text || !text.trim()) break;
        const trimmed = text.trim();
        sendEvent(session.ws, {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: trimmed,
        });
        processTextPipeline(session, trimmed);
        break;
      }

      // ======== 人设切换 ========
      case "vox.persona": {
        const { id } = msg;
        if (PERSONAS[id]) {
          session.persona = id;
          session.conversationHistory = [
            { role: "system", content: PERSONAS[id].systemPrompt },
          ];
          sendEvent(session.ws, {
            type: "vox.status",
            status: "persona_changed",
            persona: id,
            avatar: "on",
          });
        }
        break;
      }

      // ======== Ping ========
      case "ping": {
        sendEvent(session.ws, { type: "pong", time: Date.now() });
        break;
      }

      default:
        console.log(`[${session.id}] 未知消息类型: ${type}`);
        break;
    }
  } catch (err) {
    console.error(`[${session.id}] 消息处理错误:`, err.message);
    sendEvent(session.ws, {
      type: "error",
      error: { message: `消息解析错误: ${err.message}` },
    });
  }
}

// ============================================================
// 启动
// ============================================================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚗 超哥超车 · 数字人服务器 v3.2 已启动`);
  console.log(`   HTTP:  http://0.0.0.0:${PORT}`);
  console.log(`   WS:    ws://0.0.0.0:${PORT}/ws`);
  console.log(`   API Key: ${process.env.DEEPSEEK_API_KEY ? "✓ 已配置" : "✗ 未配置"}`);
  console.log(`   LLM模型: deepseek-ai/DeepSeek-V4-Flash`);
  console.log(`   TTS模型: FunAudioLLM/CosyVoice2-0.5B`);
  console.log(`   STT模型: FunAudioLLM/SenseVoiceSmall`);
});

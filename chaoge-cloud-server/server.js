// ============================================================
// 超哥超车 · 数字人语音聊天云端服务器
// 协议：OpenAI Realtime 兼容事件 + 自定义 vox.* 事件
// 管线：VAD → STT (Whisper) → LLM (DeepSeek) → TTS (OpenAI)
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
const PORT = process.env.PORT || 3000;
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
3. 经济账本思维。每一分钱都要花在刃尖上，养车成本、保值率、油耗都是真金白银。
4. 实战派。赛道跑过、烂路开过、长途测过，不是纸上谈兵。
5. 幽默接地气。说话带点糙，但句句在理，让人听得进去。
6. 不跟风。水军吹得再凶，不好开就是不好开。

回答风格：直接、简短、有力，偶尔带点幽默和自嘲。用口语化的方式表达，像朋友聊天一样。`,
    voice: "onyx",
    hasImage: true,
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
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
    this.frameMs = 0;
  }

  processAudio(pcmChunk, frameMs = 30) {
    this.frameMs = frameMs;
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

  get isSpeaking() {
    return this.state === "speech";
  }

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

  get size() {
    return this.totalBytes;
  }

  getBuffer() {
    return Buffer.concat(this.chunks);
  }

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
    return session;
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  removeSession(id) {
    this.sessions.delete(id);
  }
}

const sessionManager = new SessionManager();

// ============================================================
// PCM 工具
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
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

// ============================================================
// 音频处理管线
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
    // ======== Step 1: STT (Whisper) ========
    sendEvent(ws, { type: "vox.status", status: "transcribing" });

    const pcmBuffer = audioBuffer.getBuffer();
    audioBuffer.clear();

    const wavBuffer = pcmToWav(pcmBuffer, SAMPLE_RATE);
    const tmpFile = path.join(os.tmpdir(), `stt_${session.id}_${Date.now()}.wav`);
    fs.writeFileSync(tmpFile, wavBuffer);

    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(tmpFile),
      language: "zh",
      response_format: "text",
    });

    try { fs.unlinkSync(tmpFile); } catch (e) {}

    const text = (transcription || "").trim();
    if (!text) {
      session.isProcessing = false;
      return;
    }

    sendEvent(ws, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: text,
    });

    // ======== Step 2: LLM (DeepSeek) ========
    sendEvent(ws, { type: "vox.status", status: "thinking" });

    session.conversationHistory.push({ role: "user", content: text });

    const abortController = new AbortController();
    session.abortController = abortController;

    const stream = await deepseek.chat.completions.create({
      model: "deepseek-chat",
      messages: session.conversationHistory,
      stream: true,
      temperature: 0.7,
      max_tokens: 512,
    }, { signal: abortController.signal });

    let fullResponse = "";

    for await (const chunk of stream) {
      if (session.isSpeaking && session.vad.isSpeaking) {
        abortController.abort();
        sendEvent(ws, { type: "input_audio_buffer.speech_started" });
        break;
      }

      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        fullResponse += delta;
        sendEvent(ws, {
          type: "response.output_audio_transcript.delta",
          delta: delta,
        });
      }
    }

    fullResponse = fullResponse.trim();
    if (!fullResponse) {
      session.isProcessing = false;
      return;
    }

    session.conversationHistory.push({ role: "assistant", content: fullResponse });

    if (session.conversationHistory.length > 20) {
      session.conversationHistory = [
        session.conversationHistory[0],
        ...session.conversationHistory.slice(-18),
      ];
    }

    // ======== Step 3: TTS (OpenAI TTS) ========
    sendEvent(ws, { type: "vox.status", status: "speaking" });
    session.isSpeaking = true;

    const persona = PERSONAS[session.persona] || PERSONAS.chaoge;
    const ttsResponse = await openai.audio.speech.create({
      model: "tts-1",
      voice: persona.voice,
      input: fullResponse,
      response_format: "pcm",
    });

    const audioArrayBuffer = await ttsResponse.arrayBuffer();
    const audioBufferFull = Buffer.from(audioArrayBuffer);

    const pcm24k = new Int16Array(audioBufferFull.buffer, audioBufferFull.byteOffset, audioBufferFull.length / 2);
    const pcm16k = downsamplePCM(pcm24k, 24000, SAMPLE_RATE);

    const chunkSize = Math.floor(SAMPLE_RATE * 0.1);
    for (let i = 0; i < pcm16k.length; i += chunkSize) {
      const chunk = pcm16k.slice(i, i + chunkSize);
      const b64 = Buffer.from(chunk.buffer).toString("base64");
      sendEvent(ws, {
        type: "response.output_audio.delta",
        delta: b64,
      });
    }

    sendEvent(ws, { type: "response.done" });

  } catch (error) {
    if (error.name === "AbortError") {
      sendEvent(ws, { type: "response.done" });
    } else {
      console.error(`[${session.id}] Pipeline error:`, error.message);
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
// HTTP 服务器 + 静态文件服务
// ============================================================
const app = express();
app.use(express.json());

// 静态文件：前端页面（从 web/static/ 目录提供）
app.use("/static", express.static(path.join(__dirname, "web", "static")));

// 人设列表 API
app.get("/api/personas", (req, res) => {
  const list = Object.values(PERSONAS).map((p) => ({
    id: p.id,
    name: p.name,
    has_image: p.hasImage || false,
  }));
  res.json({
    list,
    default: "chaoge",
    avatar: true,
  });
});

// 人设头像 API
app.get("/api/personas/:id/image", (req, res) => {
  const personaId = req.params.id;
  res.sendFile(path.join(__dirname, "web", "static", "avatar.jpg"), (err) => {
    if (err) {
      res.type("svg").send(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
        <rect fill="#1a1a2e" width="512" height="512"/>
        <circle fill="#e94560" cx="256" cy="200" r="80"/>
        <ellipse fill="#e94560" cx="256" cy="380" rx="120" ry="80"/>
        <text x="256" y="470" text-anchor="middle" fill="white" font-size="20" font-family="sans-serif">超哥</text>
      </svg>`);
    }
  });
});

// 主页路由
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "web", "index.html"));
});

const server = http.createServer(app);

// ============================================================
// WebSocket 服务器
// ============================================================
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("WebSocket 客户端已连接");
  const session = sessionManager.createSession(ws);

  sendEvent(ws, {
    type: "vox.status",
    status: "connected",
    sessionId: session.id,
    persona: session.persona,
    avatar: "on",
  });

  ws.on("message", async (data) => {
    try {
      if (data instanceof Buffer || data instanceof ArrayBuffer) {
        const buf = Buffer.from(data);
        session.audioBuffer.addChunk(buf.toString("base64"));
        return;
      }

      const msg = JSON.parse(data.toString());
      const { type } = msg;

      switch (type) {
        case "input_audio_buffer.append": {
          const { audio } = msg;
          if (!audio) break;

          session.audioBuffer.addChunk(audio);

          const pcmChunk = Buffer.from(audio, "base64");
          const vadResult = session.vad.processAudio(pcmChunk);

          if (vadResult.stateChanged && vadResult.newState === "speech_start") {
            if (session.isSpeaking) {
              if (session.abortController) {
                session.abortController.abort();
              }
              session.isSpeaking = false;
              sendEvent(ws, { type: "input_audio_buffer.speech_started" });
            }
          }

          if (vadResult.stateChanged && vadResult.newState === "speech_end") {
            processAudioPipeline(session);
          }
          break;
        }

        case "response.cancel": {
          if (session.abortController) {
            session.abortController.abort();
          }
          session.isProcessing = false;
          session.isSpeaking = false;
          session.audioBuffer.clear();
          sendEvent(ws, { type: "response.done" });
          break;
        }

        case "vox.persona": {
          const { id } = msg;
          if (PERSONAS[id]) {
            session.persona = id;
            session.conversationHistory = [
              { role: "system", content: PERSONAS[id].systemPrompt },
            ];
            sendEvent(ws, {
              type: "vox.status",
              status: "persona_changed",
              persona: id,
              avatar: "on",
            });
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error("消息处理错误:", err.message);
    }
  });

  ws.on("close", () => {
    console.log(`会话 ${session.id} 已断开`);
    if (session.abortController) {
      session.abortController.abort();
    }
    sessionManager.removeSession(session.id);
  });

  ws.on("error", (err) => {
    console.error(`会话 ${session.id} 错误:`, err.message);
  });
});

// ============================================================
// 启动
// ============================================================
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚗 超哥超车 · 数字人服务器已启动`);
  console.log(`   HTTP:    http://0.0.0.0:${PORT}`);
  console.log(`   WebSocket: ws://0.0.0.0:${PORT}/ws`);
  console.log(`   环境:    OPENAI_KEY=${process.env.OPENAI_API_KEY ? "✓" : "✗"} DEEPSEEK_KEY=${process.env.DEEPSEEK_API_KEY ? "✓" : "✗"}`);
});

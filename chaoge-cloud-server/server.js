// ============================================================
// 超哥超车 · 数字人语音聊天云端服务器 v2.3
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

回答风格：直接、简短、有力，偶尔带点幽默和自嘲。用口语化的方式表达，像朋友聊天一样。`,
    voice: "FunAudioLLM/CosyVoice2-0.5B:alex",
    hasImage: true,
  },
};

// 硅基流动客户端（用于 STT 语音识别 + TTS 语音合成）
const siliconflow = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.siliconflow.cn/v1",
});

// DeepSeek LLM 客户端（也通过硅基流动调用）
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.siliconflow.cn/v1",
});
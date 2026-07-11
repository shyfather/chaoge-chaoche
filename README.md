# 超哥超车 · 思维模型网站

基于抖音汽车博主"超哥超车"（@超哥超车 cgcc666）的思维模型构建的互动网站。

## 功能

- **首页**：超哥人物简介、核心数据、6大心智模型概览
- **心智模型**：6个模型的详细解读 + 实战对话示例
- **超哥在线**：AI智能对话，说出你的买车需求，超哥给你实在建议
- **人物画像**：表达DNA、决策启发式、诚实边界、关键时间线

## AI对话引擎

- **模型**：硅基流动 SiliconFlow 平台，Qwen3-8B（永久免费）
- **联网搜索**：Tavily API，实时获取最新车型价格和行情
- **人设系统提示词**：基于超哥超车SKILL.md（6个心智模型 + 10条决策启发式 + 表达DNA）

## 主题切换

5套主题风格：暗夜橙（默认）、极简白、墨绿森林、暗紫赛博、暖纸棕。选择自动保存在浏览器中。

## 技术栈

- 纯HTML/CSS/JavaScript，无构建工具
- CSS变量驱动主题系统
- DeepSeek/SiliconFlow OpenAI兼容API
- Tavily搜索API
- GitHub Pages部署

## 页面结构

```
chaoge-chaoche/
├── index.html      # 首页
├── models.html     # 心智模型详解
├── chat.html       # AI对话页面
├── about.html      # 人物画像
├── style.css       # 共享样式（含5套主题）
└── _shared/
    └── fonts/      # 字体文件
```

## 访问

https://shyfather.github.io/chaoge-chaoche/

## 相关项目

- [超哥超车 Skill](../chaoge-chaoche-perspective/SKILL.md)：TRAE Agent Skill，可在TRAE中直接调用超哥的思维模型分析购车问题

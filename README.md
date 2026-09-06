# AI Application

浏览器内 AI 应用生成平台：用户用自然语言描述需求，Agent 在内存虚拟文件系统里生成前端代码，右侧 iframe 实时预览，支持多轮迭代修改。

当前处于 **最小 MVP** 阶段，设计依据见 [`docs/ai-app-gen-mvp/design-reference.md`](docs/ai-app-gen-mvp/design-reference.md)，实现方案见 [`docs/ai-app-gen-mvp/SDD.md`](docs/ai-app-gen-mvp/SDD.md)。

## MVP 范围

保留：Agent 主循环、虚拟文件系统工具集、上下文硬截断、代码内联后处理、iframe 预览、进度流。

不做：MCP、语音输入、BaaS、Skill、消息持久化、多会话、图片输入、plan/build 双模式、语义软压缩。

## 技术栈

React 18 + TypeScript + Vite + Zustand + Vitest

## LLM

真实 provider 走 OpenAI 兼容接口，经 Vite dev proxy 转发，API key 只存在于服务端环境变量。另提供 Mock provider，使核心逻辑在无 key、断网条件下可完整跑通与测试。

```bash
cp .env.example .env.local   # 填入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npm install
npm run dev
```

> 注：dev proxy 方案仅在开发环境有效，生产部署需要独立后端转发。

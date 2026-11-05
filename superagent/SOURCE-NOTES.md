# 实现与来源

架构参考 DeepSeek Super-agent 原型固定版本：
https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4

对照 src/core/engine.ts、intake.ts、evals.ts、tickets.ts、assignments.ts，src/app/effects.ts、delivery.ts、cards.ts、assessment.ts、sessions.ts 与 prompts/dispatch.md。当前 JavaScript/SQLite 实现是本机 Codex 适配，不是原仓库的一比一移植，也没有声称运行通过原仓库测试。

映射：事件准入/订阅→routing；批次评估→Router；工单/执行分离→Core、Executor、Scheduler；事务/持久效果→Store、Runtime；Inline & Spill / Chain of Recall→短卡片与引用分页；统一交付→Delivery；投机执行→Observer 与隔离副本；基础设施和语义恢复→watchdog-host、Watchdog、ControlServer。

复用已有本地 Telegram 适配器，保留 vendor 内许可和来源说明。上传由 Telegraf 处理，语音由既有 Whisper/FFmpeg 处理；没有重写这些现成组件。官方 Codex App Server 负责模型执行、原生上下文、权限审核和压缩；本客户端负责协调持久化。独立 Watchdog 是结合文章机制补齐的实现，不声称开源原型已经提供完全相同的恢复代码。

# Codex 会话透传补丁维护说明

此 fork 在官方 v1.1.315 基础上保留以下补丁：

- 识别 `codex-tui` 和 `Codex Desktop`，让原生客户端跳过旧版请求体适配。
- 双向透传 `x-codex-turn-state` 和 `x-codex-turn-metadata`。
- 根据 API Key 隔离账号调度标识，根据 API Key 和上游账号隔离上游会话及缓存标识。
- 客户端缺少明确标识时，根据稳定上下文生成备用缓存路由标识。
- 记录标识来源、会话和账号哈希以及轮次状态是否存在，不记录原始标识或聊天正文。

## 边界

明确的客户端会话标识优先于上下文兜底。兜底要求首条用户消息至少包含 128 个文本字符；已有 `previous_response_id` 或 `conversation` 的增量请求不使用此兜底。

上下文兜底仅用于缓存路由，不保存或复用其他请求的聊天内容、`previous_response_id` 或轮次状态。同一 API Key 下完全相同的初始上下文可能得到相同的备用标识，因此客户端应尽量发送明确的会话标识。不同使用者应分配独立 API Key。

本补丁的上游状态透传用于 `openai` 账号的 Codex 后端路径；独立的 `openai-responses` 中继实现未作同样修改。客户端白名单验证器也不属于本次路由识别修改范围。

## 合并官方更新

保留用户 fork 为 `origin`，官方仓库为 `upstream`。不要通过重置或强制同步覆盖 fork 的补丁提交。

```bash
git fetch upstream
git switch main
git merge upstream/main
npm ci
npm test -- --runInBand tests/openaiResponsesPayloadToggles.test.js tests/openaiSessionIdentity.test.js
git push origin main
```

若仓库是浅克隆且合并找不到共同祖先，先执行 `git fetch --unshallow upstream` 补齐历史。

合并可能出现冲突，尤其是 `src/routes/openaiRoutes.js`。解决冲突时应保留会话解析、隔离和请求/响应头透传调用，并重新执行上述测试。Git 合并及测试不能保证未来上游接口变化时仍然兼容。

## 部署更新

使用合并后的 fork 源码及项目标准 `Dockerfile` 构建镜像，再部署到服务器。直接拉取官方发布镜像不会包含本 fork 的补丁。

当前服务器的本地热修复 Dockerfile 和 Compose override 属于部署文件，没有纳入本补丁提交。它们基于固定的旧版官方镜像，不能作为未来自动升级的构建方式。

更换隔离算法或首次启用本补丁会改变上游标识，可能产生冷缓存。验收时使用固定账号、模型和同一客户端会话连续对话，结合 `Codex session routing` 日志及缓存读取量判断效果。

# MCP 与授权配置指南

## 一、Resend MCP（发邮件）

**远程 MCP Server**：`https://mcp.resend.com/mcp`（Streamable HTTP，无需安装本地进程）

**接入方式**（DSH 支持 MCP，配置到 ~/.dsh/settings.yaml 或会话级 MCP 配置）：
```yaml
mcp:
  servers:
    resend:
      url: https://mcp.resend.com/mcp
      transport: streamable-http
```
连接时会打开浏览器 → 登录 Resend → OAuth 授权。

**Resend 官方 Skills/Plugin**：https://github.com/resend/resend-skills
（Agent Plugins 规范，`mcp.json` 指向 `https://mcp.resend.com/mcp`）

### Resend 免费版必要前提
1. **必须验证至少一个发信域名**（Resend 不允许用共享/公共域名发信）
   - 你需要拥有一个域名，在 Resend Dashboard 添加并配置 DNS（CNAME/TXT/MX）
   - 或用 Cloudflare 托管的域名，一并完成 DNS 验证
2. 创建 API Key：`re_...`（Sending access）
3. 免费额度：3000 封/月，100 封/天（团队版）

## 二、Cloudflare Pages（后端 + D1）

**wrangler CLI** 已装在 `/tmp/cf-tools/node_modules/.bin/wrangler`

**授权**（二选一）：
```bash
# 方式A：交互登录（需你在终端执行）
cd /tmp/cf-tools && ./node_modules/.bin/wrangler login

# 方式B：API Token
export CLOUDFLARE_API_TOKEN=<你的 token>
# Dashboard → My Profile → API Tokens → Create Token
# 权限：Account:Cloudflare Pages:Edit, Account:D1:Edit
```

**部署步骤**：
```bash
cd /Users/mac/Downloads/外贸问题平台/open-import-os
export CLOUDFLARE_API_TOKEN=...
WR=/tmp/cf-tools/node_modules/.bin/wrangler

# 1) 创建 D1（免费）
$WR d1 create open-import-os
#    把返回的 database_id 填入 wrangler.toml

# 2) 应用表结构
$WR d1 execute open-import-os --file=migrations/0001_init.sql --remote

# 3) 部署（Pages）
$WR pages deploy public --project-name open-import-os --branch main

# 4) 设置密钥（不会进入 Git）
$WR pages secret put RESEND_API_KEY --project-name open-import-os
$WR pages secret put LEAD_NOTIFY_EMAIL --project-name open-import-os
$WR pages secret put LEADS_ADMIN_TOKEN --project-name open-import-os
```

## 三、密钥安全
- 所有密钥只进 Cloudflare 的 encrypted secrets，**不写入 Git、不出现在日志**
- 演示环境与生产环境分离
- LEAD_NOTIFY_EMAIL = 你接收线索通知的邮箱

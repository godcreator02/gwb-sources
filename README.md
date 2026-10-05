# gwb-sources

供助手长期使用的信息源插件。沿用 god 工作台的 Cordis、命令总线、设置与 skills；一个包内的 FreshRSS、只读 IMAP 模块共享来源配置与每 home 凭据。未重建 MCP 服务或调度系统。

源码在 `plugins/sources/src/`：`index.ts` 注册命令与设置，`service.ts` 管理来源和一次性变更预览，`rss.ts` / `mail.ts` 是适配器，`credentials.ts` 连接 gwb-settings 凭据服务，`native/credential.ps1` 只读旧 Windows 条目用于显式迁移。要加来源，扩展 `model.ts` 的 Source/Adapter 与 service 的工厂；共享契约保持稳定，平台服务仍由 gwb 提供。

## 使用

经 gwb MCP `index` 发现插件，`search {"prefix":"sources."}` 获取完整用法；`run {"command":"sources.status"}` 调用。12 条命令：catalog、status、configure、connect、disconnect、diagnose、list、query、read、tasks、preview、execute。详细操作与安全边界随包发布在 `plugins/sources/skills/sources/SKILL.md`。

首次配置先用 configure 写非秘密地址和用户名，再按回执的 credentialKey 用 credentials.import/copy 或设置界面配置凭据，最后 connect 关联并 diagnose 验证。凭据明文保存在当前 home 的 credentials.json；普通设置只保存引用。已授权的本地操作只返回状态，不把原文输出到聊天。

来源 ID、类型、端点与用户名绑定凭据槽。跨 home 必须显式复制，不借用 default。旧 Windows 引用通过 connect 的 migrateLegacy:true 复制导入，原系统条目保留；disconnect 只删除当前 home 的凭据。成功迁移或断开后不从旧系统条目恢复已清除的值。账号接入未完成时查询明确报 not-connected。

RSS 的 preview/execute 分开；执行重查完整快照，精确匹配退订 id 与标题。原任务的25项不要写死到通用产品，也不要用真实数据测试。未来按用户已批准的名单从实际 list 构建预览。

邮件没有发送、删除或标记命令，使用 TLS + EXAMINE + BODY.PEEK。邮件 id 含 mailbox/UIDVALIDITY/UID，拒绝陈旧 id。最多读取2MiB邮件，正文回传最多16000字符；query 每次最多100项。tasks 只是证据候选。正文和标题不会被当作指令执行。

## 验证

```powershell
pnpm install
pnpm build
pnpm check
```

测试使用内存 settings、凭据替身、HTTP响应与 IMAP session 替身，不连接真实账号、不写 Windows 凭据。隔离home按官方流程 `devkit.home.new`、`devkit.dev`、`devkit.cdp ... cmd` 验证注册和回执。正式安装是单独的 plugin-manager 操作，目录改动不会自动部署。

## 网络依据

- FreshRSS Google Reader API：https://freshrss.github.io/FreshRSS/en/developers/06_GoogleReader_API.html
- 学校官方邮箱配置：https://nic.xjtu.edu.cn/xxhjs/jcyyfw/yjxt.htm
- ImapFlow readOnly 使用 EXAMINE：https://imapflow.com/docs/api/imapflow-client/
- 2026-10-05 无凭据探测：`stu.xjtu.edu.cn:993` TLS验证通过；`imap.stu.xjtu.edu.cn:993` 证书主机名不匹配，不降级绕过。
- 同日 FreshRSS 正确 `/api/greader.php/.../subscription/list` 返回401；网页显示的 `/api/api/` base URL警告不等于实际接口不可达。

电脑与 gwb 必须运行，源站必须在本机网络路径可达。未创建定时任务或公网入口，尚未验证真实账号认证。

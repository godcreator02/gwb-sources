# Validation — 2026-10-05

## 每 home 凭据迁移（0.2.0）

- `pnpm build`、`pnpm check` 通过，2 个测试文件共 20 项；依赖已跟进正式发布的 `gwb-settings@0.4.0`。
- 隔离 home `stores-cred-2610052010` 实测了 configure → credentials.import → connect → status → disconnect；变更已绑定地址会被拒绝。只使用 synthetic 凭据和 `.invalid` 地址，没有连接真实来源。
- 单元测试覆盖 home 隔离、地址与用户名绑定、显式旧 Windows 凭据复制、迁移标记、删除后不复活、持久化失败后可重试、已有新值不被旧值覆盖。
- 命令回执和隔离 home 日志未出现 fixture 凭据原文。整合验收脚本与 27 项结果位于相邻仓 `../gwb-windows-backup/probes/2610052010_home-credentials/`。
- Windows 凭据桥现在只负责显式读取旧引用，迁移不删除 Windows 条目。真实 Windows 凭据迁移未执行；验收使用 fake bridge。
- 个人来源列表在 default 仍为空，本次发布阶段没有修改 default。正式版本升级由整合会话执行。
- Sources `0.2.0` 经 devkit.release 发布后已装入上述隔离 home，再跑同一套 27 项验收全部通过；插件 ACTIVE、unmetPeers 为空。原生只读桥经 PowerShell 7 AST 解析，语法错误为 0。

## 0.1.0 历史交付记录

先前的 default 安装引用本仓 `artifacts/godcreator-gwb-sources-0.1.0.tgz`；升级 default 前必须保留这份文件。它不是 0.2.0 的发布产物，不纳入 Git。

历史验证包括 16 项 mock 测试、native PowerShell 语法与 Win32 CREDENTIAL 结构检查、隔离 home 加载，以及未带凭据的 FreshRSS HTTP 401 和学校 IMAP TLS 连通性验证。当时未进行真实账号登录、来源内容读取或 RSS 写操作；这些结果不代表新版已完成真实账号认证。

当前连接流程见 README 与随包 sources 说明书：凭据保存在当前 home 的 `credentials.json`，先通过设置界面或授权的 credentials.import/copy 配置，再用 sources.connect 关联。此前需要 Windows 持久化提示框和 consent 参数的流程已退出当前协议。

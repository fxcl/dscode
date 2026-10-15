# DSCode 文档

| 文档 | 面向 | 内容 |
|------|------|------|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 所有人 | 项目定位、仓库结构、分层视图、启动链路、运行时配置模型、安全模型、持久化、Provider、子代理、Windows 沙箱、GUI、HTTP 适配器、构建发布、测试策略、已知缺口 |
| [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) | 维护者 | 模块地图、公共 API、CLI 参数面、校验模式、安全实现细节、落盘格式、MCP、上下文/预算算法、回合恢复与自调度、延迟工具与出网守卫、子代理协议、GUI RPC 线协议、环境变量总表、工程约定、测试与验证、维护指引 |
| [`WINDOWS_SANDBOX.md`](./WINDOWS_SANDBOX.md) | 维护者 | Windows 原生沙箱的安全契约、信任组件、模式契约、验收测试、上线闸门 |
| [`RELEASING.md`](./RELEASING.md) | 维护者 | 发版流程 |
| [`PRODUCT_STRATEGY.md`](./PRODUCT_STRATEGY.md) | 产品 | 产品定位与战略 |
| [`COMPARISON.md`](./COMPARISON.md) / [`COMPARISON.en.md`](./COMPARISON.en.md) | 产品 | 与同类工具的对比（中文 / 英文） |
| [`FEYNMAN_ANALYSIS.md`](./FEYNMAN_ANALYSIS.md) | 产品 | 机制拆解式分析 |

GUI 子项目另有独立文档，位于 [`gui/docs/`](../gui/docs/)：

| 文档 | 内容 |
|------|------|
| [`gui/docs/architecture.md`](../gui/docs/architecture.md) | Desktop Host 职责划分、渲染管线、错误呈现 |
| [`gui/docs/protocol-facts.md`](../gui/docs/protocol-facts.md) | 经真机验证的 RPC 协议事实 |
| [`gui/docs/security-model.md`](../gui/docs/security-model.md) | GUI 侧安全模型 |
| [`gui/docs/settings-auth.md`](../gui/docs/settings-auth.md) | 设置与认证流程 |
| [`gui/docs/deepseek-harness-adoption.md`](../gui/docs/deepseek-harness-adoption.md) | 采纳的 DeepSeek Harness 机制 |

仓库根目录另有 [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md)（产品说明）与 [`PORTING.md`](../PORTING.md)（机制移植说明）。

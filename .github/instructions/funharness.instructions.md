---
description: Fun Harness VS Code extension project rules — apply when editing files under apps/
applyTo: 'apps/**'
---

# Fun Harness 项目规则

## Webview 面板脚本安全规则

`apps/src/webviewTemplates.ts` 包含大段内联 `<script>` 模板。该脚本中的任何 JS 语法错误会导致 **全部面板按钮失效**（所有 handler 变为 undefined）。

### 强制要求

每次修改 `apps/src/webviewTemplates.ts` 后，**必须**执行 webview 校验脚本确认所有内联脚本语法正确：

```bash
cd apps
npm run validate:webview
```

或等价地运行 `npm run compile`（已通过 `postcompile` 钩子自动触发校验）。

如果校验失败（输出 ❌），必须修复后才能提交代码。

### 常见陷阱（必须避免）

1. **禁止在动态 innerHTML 中使用 `onclick="fn(\'...\')"`** — 反斜杠在模板字面量中会被消耗，生成无效 JS。应使用 `data-*` 属性 + 事件委托。
2. **`\n` 在模板字面量中会变成真实换行** — 若要在生成的单引号字符串中输出换行符，必须写 `\\n`。
3. **一处语法错误 = 全部按钮失效** — 不要假设"只影响局部"。

### 推荐做法

- 动态渲染的按钮（innerHTML 拼接）统一使用 **事件委托** (`document.addEventListener('click', ...)` + `data-*` 属性)。
- 静态 HTML 模板中的按钮可继续使用 `onclick="globalFn()"` 形式（无需嵌套引号时安全）。
- 新增任何全局函数后，确保在校验脚本的测试用例中能覆盖到对应页面。
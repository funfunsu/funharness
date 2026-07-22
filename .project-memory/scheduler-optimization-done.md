# 自动推进机制优化完成 (2026-07-22)

## 本次改进（Phase 1 + Phase 2 部分）

### 改进 1: 智能路径解析 ✅
**文件**: taskScheduler.ts `looksLikeFilePath()`

**原问题**: 
```
- 输出: apps/src/services/harnessActionsService.ts（仅新增私有方法，不改动现有方法）
↓ 整行作为单个输出项
↓ 包含中文"仅新增..."
↓ filter 掉 → 验证失败 → [failed]
```

**改进方案**:
```typescript
// 提取括号前的路径部分
let pathPart = value.split('（')[0].split('(')[0].trim();
// 只检查路径部分是否有中文，括号内允许说明
```

**效果**:
- ✅ 支持 `path（中文说明）` 格式
- ✅ 支持 `path (English remark)` 格式
- ✅ 向前兼容纯路径格式

---

### 改进 2: 验证优先级明确化 ✅
**文件**: taskScheduler.ts `handleSignal()`

**实现**:
```
1. 优先使用 tasks.md 中的 output 定义
2. 如果 output 为空，退而求其次用 signal file 的 files: 列表
3. 日志清晰标注来源 (source=tasks.md 或 source=signal file)
```

**效果**:
- 即使 tasks.md 格式不完美，signal file 作为备选
- 用户看日志能清楚了解验证流程

---

### 改进 3: 失败恢复机制 ✅
**文件**: taskScheduler.ts `handleSignal()`

**新增选项（验证失败时）**:
- `查看日志`: 帮助用户诊断问题
- `忽略并继续`: 强行推进（需要注意风险）
- `标记重试`: 恢复任务到 todo 状态，允许重新执行

**效果**:
- ❌ 不再自动关闭 autoMode
- ✅ 用户有明确的恢复路径
- ✅ 减少因格式问题导致的全局卡死

---

### 改进 4: 诊断日志改进 ✅
**文件**: taskScheduler.ts `handleSignal()`

**新增输出**:
```
source=tasks.md  ← 清晰标注数据来源
expectedOutputFiles=[...]  ← 预期的输出
signalFiles=[...]  ← Signal file 中列出的文件
missing=[...]  ← 缺失的文件（重点）
```

**效果**:
- 用户能快速看到具体缺失什么文件
- 便于调试 tasks.md 格式问题

---

## 代码变更清单
- ✅ taskScheduler.ts: 改进 `looksLikeFilePath()` 
- ✅ taskScheduler.ts: 改进 `handleSignal()` 错误处理和恢复
- ✅ tasks.md: 恢复支持中文说明的格式
- ✅ 编译验证通过

---

## 根本问题解决对标

| 问题 | 原因 | 改进方案 | 状态 |
|------|------|--------|------|
| 中文说明导致验证失败 | 正则过度严格 | 提取括号前的路径部分检查 | ✅ |
| 验证完全依赖 tasks.md | 单一数据源 | 优先级明确化 + signal file 备选 | ✅ |
| 失败后缺乏恢复 | 无选项、自动关闭 | 添加 3 个恢复选项 + 不自动关闭 | ✅ |
| 诊断困难 | 日志不清晰 | 详细的缺失文件和数据来源标注 | ✅ |

---

## 后续优化机会 (Phase 3)

- [ ] Signal file 协议标准化：统一 `files:` 格式
- [ ] 输出定义语法改进：支持 `path | description` 的显式分离
- [ ] 自动修复建议：当验证失败时，给出修复 tasks.md 的建议
- [ ] 重试机制优化：支持指定延迟重试而非立即重试


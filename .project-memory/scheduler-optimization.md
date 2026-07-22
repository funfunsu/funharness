# 自动推进机制优化方案

## 问题诊断（2026-07-22）

### 根本缺陷
1. **输出验证过度严格**
   - `looksLikeFilePath()` 拒绝中文 → 格式稍有变化就失败
   - `- 输出: path（说明）` 格式被整体过滤

2. **单一验证来源**
   - 只依赖 tasks.md output 定义
   - Signal file 的 `files:` 列表被忽视
   - 若 tasks.md 格式问题 → 推进卡死

3. **缺乏恢复机制**
   - 验证失败 → `[failed]` + autoMode off
   - 无自动重试、忽略、或手动恢复选项

## 改进实现计划

### Phase 1: 快速修复（即刻）
修改 `looksLikeFilePath()` 处理括号内说明

```typescript
private looksLikeFilePath(value: string): boolean {
  if (!value) return false;
  
  // 提取括号前的部分（支持 "path（说明）" 格式）
  let path = value.split('（')[0].split('(')[0].trim();
  
  if (!path) return false;
  if (/[\u4e00-\u9fa5]/.test(path)) return false; // 路径部分不能有中文
  if (/[\\/]/.test(path)) return true;
  return /^[\w.-]+\.[a-zA-Z0-9]+$/.test(path);
}
```

### Phase 2: 优先级验证（下阶段）
改进 handleSignal() 验证流程：

```
1. 优先验证 signal file 的 files: 列表中的文件是否存在
2. 如果 signal 中没有 files: 列表，再用 tasks.md output
3. 若都验证失败，改为 [failed] 并询问用户是否继续
```

### Phase 3: 恢复机制（未来）
- 提供 "忽略验证标记完成" 选项
- 支持手动补充输出文件列表
- 改进日志，标记具体缺失的文件

## 当前状态
- Phase 1 待实施
- Phase 2 待设计
- Phase 3 待规划

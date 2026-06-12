/**
 * 原子写入（Write 和 Edit 工具共用的底层写入逻辑）
 *
 * 三步策略：tmpfile → fsync → rename
 * 保证在任何时刻断电或崩溃，文件要么是旧内容、要么是新内容，不会出现半写状态。
 *
 * 实现细节（容易遗漏的部分）：
 * - rename 在同一文件系统内是原子操作，所以临时文件必须和目标文件同目录
 * - 保留原文件权限：覆写已有文件时 stat().mode → chmod(tmp)
 * - fsync 确保数据真正落盘，而不是停留在 OS 写缓存
 * - 原子写入失败时回退到直接写入（某些文件系统/挂载点不支持 rename 语义）
 * - 无论成功失败都清理残留的临时文件
 */

import { open, rename, stat, chmod, unlink, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });

  // 临时文件与目标同目录——rename 跨文件系统不是原子操作
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;

  // 覆写已有文件时保留其权限位
  let originalMode: number | undefined;
  try {
    originalMode = (await stat(targetPath)).mode;
  } catch {
    // 目标文件不存在（新建场景），使用默认权限
  }

  try {
    // 1. 写入临时文件并 fsync 确保落盘
    const handle = await open(tmpPath, 'w');
    try {
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (originalMode !== undefined) {
      await chmod(tmpPath, originalMode);
    }

    // 2. rename 原子替换：要么旧内容要么新内容，没有中间态
    await rename(tmpPath, targetPath);
  } catch (atomicError) {
    // 3. 清理临时文件，回退到直接写入
    try {
      await unlink(tmpPath);
    } catch {
      // 临时文件可能根本没创建成功
    }
    try {
      await writeFile(targetPath, content, 'utf-8');
    } catch {
      // 回退也失败时，抛出原始错误（信息量更大）
      throw atomicError;
    }
  }
}

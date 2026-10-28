import { z } from 'zod'

/** 主进程注入给渲染层的运行时信息（关于窗口、诊断页使用） */
export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.string(),
  isPackaged: z.boolean(),
  userDataPath: z.string(),
  appPath: z.string()
})

export type AppInfo = z.infer<typeof appInfoSchema>
export type AppPlatform = AppInfo['platform']

/** 统一的 ISO-8601 时间戳字符串（UTC，含毫秒） */
export const isoTimestampSchema = z.iso.datetime()

/** 第三方插件 manifest（asg-plugin.json）的校验。
 *
 * 这一期只负责“声明 + 安装薄层”：manifest 只描述插件身份与能力，
 * 不包含任何运行时代码，也不参与网关启动。
 */

import path from "node:path";
import { z } from "zod";

/** 插件 id：3-64 位小写字母/数字/`. _ -`，首尾必须是字母或数字。 */
export const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/;

/** 插件版本：语义化版本的主干 + 可选预发布后缀（不接受 build 元数据）。 */
export const EXTENSION_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 插件能力：search 表示搜索源，fetch 表示抓取实现。 */
export const EXTENSION_PROVIDES = ["search", "fetch"] as const;

export type ExtensionProvide = (typeof EXTENSION_PROVIDES)[number];

const manifestSchema = z
  .object({
    id: z
      .string()
      .regex(EXTENSION_ID_RE, "id 必须是 3-64 位小写字母/数字/._-，且首尾为字母或数字"),
    name: z.string().min(1, "name 不能为空").max(80, "name 最长 80 个字符"),
    version: z
      .string()
      .regex(EXTENSION_VERSION_RE, "version 必须是语义化版本，例如 1.2.3 或 1.2.3-beta.1"),
    api_version: z.literal(1, "api_version 当前只支持 1"),
    provides: z
      .array(z.enum(EXTENSION_PROVIDES, "provides 只能包含 search / fetch"))
      .min(1, "provides 至少声明一项能力")
      .refine((items) => new Set(items).size === items.length, "provides 不能包含重复项"),
    entry: z
      .string()
      .min(1, "entry 不能为空")
      .refine((value) => isValidEntryName(value), "entry 只能是单个 .mjs / .js 文件名"),
    platform: z
      .string()
      .regex(/^[a-z0-9-]+$/, "platform 只能是小写字母/数字/-")
      .optional(),
    description: z.string().optional(),
  })
  .strict();

export type ExtensionManifest = z.infer<typeof manifestSchema>;

/** manifest 解析/校验错误：消息已包含中文说明，调用方负责包装成 CLI 错误。 */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export function isValidExtensionId(value: string): boolean {
  return EXTENSION_ID_RE.test(value);
}

export function isValidExtensionVersion(value: string): boolean {
  return EXTENSION_VERSION_RE.test(value);
}

/** entry 必须是安装目录内的单个文件名，不能带路径、不能是绝对路径。 */
export function isValidEntryName(value: string): boolean {
  if (!value || value === "." || value === "..") return false;
  if (value.startsWith(".")) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
  if (value.includes("..")) return false;
  if (value.includes(":")) return false;
  if (path.isAbsolute(value)) return false;
  return value.endsWith(".mjs") || value.endsWith(".js");
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.map(String).join(".") : "(根)";
      return `${at}: ${issue.message}`;
    })
    .join("；");
}

/** 解析并校验 manifest 文本；失败抛 ManifestError（中文说明）。 */
export function parseManifest(text: string): ExtensionManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(
      `asg-plugin.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    throw new ManifestError(`asg-plugin.json 校验失败：${formatIssues(result.error)}`);
  }
  return result.data;
}

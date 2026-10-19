/**
 * `keystone model` output.
 */

import type { Catalog } from "../../types.ts";

export const model: Catalog = {
  Models: "模型",
  "none configured": "未配置",
  "[enabled]": "[已启用]",
  "[disabled]": "[已禁用]",
  "(none)": "（无）",
  "(stored)": "（已存储）",
  "(MISSING)": "（缺失）",
  "credential:": "凭据：",
  "(default)": "（默认）",
  Routes: "路由",
  "(none configured)": "（未配置）",
  "Data egress": "数据外发",
  "stays on this machine (local):": "留在本机（本地）：",
  "sends data out (cloud):": "发送数据到外部（云端）：",
  none: "无",
  'Added model "{id}" ({kind} {provider}/{modelName}).':
    '已添加模型 "{id}"（{kind} {provider}/{modelName}）。',
  "Note: prompts and context will be sent to {host}.": "注意：提示词与上下文将发送至 {host}。",
  "route {role} = {models}": "路由 {role} = {models}",
  Credentials: "凭据",
  "none stored": "未存储任何凭据",
  stored: "已存储",
  unreadable: "不可读",
  "No secret was received on stdin. Pipe one in, e.g.: `echo -n $KEY | keystone model credential set <handle>`.":
    "未从 stdin 收到密钥。请通过管道传入，例如：`echo -n $KEY | keystone model credential set <handle>`。",
  'Stored credential "{handle}" (file mode {mode}). The secret is never printed.':
    '已存储凭据 "{handle}"（文件权限 {mode}）。密钥不会被打印。',
  "Configure BYOK models, routes and credentials": "配置 BYOK 模型、路由与凭据",
};

# Windows 端部署（B2 住宅 IP 通道）

这组脚本用于在一台 Windows 机器上跑第二套通道：**SearXNG 走住宅 IP + 本地向量服务**。
它与 VPS 上的主网关同构，但出口 IP 不同，适合抓国内站点。

## 组成

| 组件 | 端口 | 作用 |
|---|---|---|
| SearXNG | 8890 | 住宅 IP 的元搜索，引擎集与 VPS 侧不同 |
| embedsvc | 8091 | 本地 bge-small-zh-v1.5（512 维），供 PC 侧网关算向量 |
| 计划任务 `SearXNG-B2` | — | Boot + SYSTEM，开机自启 |
| 计划任务 `Embedsvc-PC` | — | Boot + SYSTEM，开机自启 |

## 前置

1. **Python 3.11+**
2. **SearXNG 源码**（自行 `git clone https://github.com/searxng/searxng`，`pip install -r requirements.txt`）
3. **embedsvc 模型**：`bge-small-zh-v1.5` 的 ONNX 量化版（`onnx/model_quantized.onnx` + tokenizer 文件），
   目录结构：
   ```
   embedsvc/
   ├─ app.py
   ├─ run_service.py
   ├─ models/bge-small-zh-v1.5/{config.json,tokenizer*.json,special_tokens_map.json,onnx/model_quantized.onnx}
   └─ venv/  (onnxruntime + numpy + tokenizers)
   ```

## 安装

```powershell
# 1. 修复 SearXNG（两个幂等脚本，会自动备份原文件）
python _hermes_engines_patch.py C:\searxng\searx\settings.yml
python _hermes_proxy_patch.py   C:\searxng\searx\settings.yml

# 2. 注册开机自启
.\install-tasks.ps1 -SearxngDir C:\searxng -EmbedsvcDir C:\embedsvc
```

## 三个必踩的坑

### 1. SYSTEM 会话看不到用户级 git

SearXNG 启动时执行 `git show` 取版本号。如果 git 装在用户目录（`%LOCALAPPDATA%`），
以 SYSTEM 身份运行时会抛 `FileNotFoundError` 直接崩（源码只 catch 了 `CalledProcessError`）。

**修法**：在 `searx/` 下放 `version_frozen.py`：

```python
VERSION_STRING = "2026.11.6"
VERSION_TAG = "2026.11.6"
DOCKER_TAG = "2026.11.6"
GIT_URL = "https://github.com/searxng/searxng"
GIT_BRANCH = "master"
```

删掉该文件即恢复原行为。

### 2. Windows 路径分隔符导致模板找不到

症状：`/search?format=json` 正常，`/search`（HTML）报 `TemplateNotFound: result_templates/default.html`。

两层原因，都要修：

```yaml
# settings.yml
ui:
  templates_path: "C:/path/to/searxng/searx/templates"   # 不能留空
```

```python
# searx/webutils.py 的 get_result_templates()
f = os.path.join(directory[templates_path_length:], filename).replace(os.sep, "/")
```

`os.walk` 在 Windows 返回反斜杠，而 `get_result_template()` 拼的键是正斜杠，字符串永不相等。

### 3. 计划任务不要用 cmd.exe 包装

`cmd.exe /c pythonw.exe ...` 会因 pythonw 不退出而让 cmd 常驻，桌面多一个空控制台。
直接 `-Execute pythonw.exe -Argument script.py -WorkingDirectory <dir>` 即可。

## 验证

```powershell
Invoke-RestMethod http://127.0.0.1:8091/health
# → {"status":"ok","model":"bge-small-zh-v1.5","dim":512,...}

Invoke-RestMethod "http://127.0.0.1:8890/search?q=test&format=json"
# → results 非空

(Get-ScheduledTask -TaskName "SearXNG-B2","Embedsvc-PC").State
# → Running, Running
```

两个任务都必须是 `Boot` + `SYSTEM`：

```powershell
Get-ScheduledTask -TaskName "SearXNG-B2" | Select-Object -ExpandProperty Principal
```

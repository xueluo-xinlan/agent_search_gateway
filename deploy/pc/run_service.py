"""embedsvc 启动包装：把模型目录与端口固定下来，供计划任务直接拉起。"""
import os
import runpy
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("EMBEDSVC_DIR", os.path.join(BASE, "models", "bge-small-zh-v1.5"))
os.environ.setdefault("EMBEDSVC_PORT", "8091")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
sys.argv = [os.path.join(BASE, "app.py")]
runpy.run_path(sys.argv[0], run_name="__main__")
